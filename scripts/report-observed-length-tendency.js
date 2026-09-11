'use strict';

// #542 (phase 2 of #512) — advisory report comparing each member's static
// LENGTH_TENDENCY_OVERRIDES entry (tuning.js, derived from their #187 voice
// exemplar by scripts/derive-length-tendency.js) against their *observed*
// average words-per-spoken-turn across real sessions on disk.
//
// Deliberately read-only, unlike phase 1: this does not write back into
// tuning.js. Two of #542's original three blockers turned out to be
// resolved by the time this shipped — the #539 fix clarified that
// LENGTH_TENDENCY_OVERRIDES/LENGTH_WEIGHT only weight *who* gets picked to
// speak, not how long a turn runs once picked, so deriving tendency from
// observed turn length is not circular via that mechanism; and #506 shipped
// (2026-09-10) via a client-side mechanism with no dependency on tuning.js
// staying static. The third — cold start, since a member needs a real
// sample before their observed average means anything — is still real, and
// is why this stays advisory rather than auto-applying: below
// MIN_SAMPLE_TURNS spoken turns, a member is reported as insufficient data
// rather than compared at all. Promoting some/all of this to auto-apply is
// an intentionally open question, left for a future pass (see the PR this
// shipped in) rather than decided here.
//
// A passed beat (`{ memberId, text, passed: true }`, per pipeline.js's
// beatEntry shapes) is excluded from the length signal, not counted as a
// zero-length turn: its text is the room's action-only pass idiom, not a
// spoken turn, and pipeline.js itself already treats a pass as worth less
// than a full turn (PASS_TURN_CREDIT) for the same reason. A failed beat
// has empty text and is excluded for the obvious reason. A player-authored
// beat (`playerAuthored: true`) is excluded too — it's the human's own
// words, not the model's, and would contaminate a member's register signal
// with someone else's writing.
//
// Run manually:
//   node scripts/report-observed-length-tendency.js
// Read-only: prints to stdout and writes OBSERVED-LENGTH-TENDENCY.md, same
// as scripts/rollup-metrics.js. Does not touch src/tuning.js.

const fs = require('fs');
const path = require('path');
const { loadSessions } = require('./build-citation-manifest');
const { LENGTH_TENDENCY_OVERRIDES } = require('../src/tuning');

const ROOT = path.join(__dirname, '..');
const OUTPUT_FILE = path.join(ROOT, 'OBSERVED-LENGTH-TENDENCY.md');

// Same threshold agreed for #542: below this many real spoken turns, a
// member's average is cold-start noise, not a signal worth comparing
// against the static override. No principled derivation for 20 specifically
// — it's a round number well above the handful of turns any one member
// gets in a single session, chosen so the report only speaks up once
// several sessions' worth of data has accumulated for that member.
const MIN_SAMPLE_TURNS = 20;

function lengthTendencyOf(memberId) {
  return LENGTH_TENDENCY_OVERRIDES[memberId] || 'medium';
}

function countWords(text) {
  const trimmed = (text || '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

// Same linear-interpolation percentile as derive-length-tendency.js, kept
// duplicated rather than shared — it's five lines and the two scripts
// otherwise have no runtime dependency on each other.
function percentile(sortedValues, p) {
  const idx = p * (sortedValues.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (idx - lo) * (sortedValues[hi] - sortedValues[lo]);
}

// Walks every session's rounds[].beats and sums word counts per member,
// keeping spoken-turn count separate from word count so the caller can
// compute an average and apply the sample-size gate.
function collectObservedTurns(sessions) {
  const perMember = new Map(); // memberId -> { turns, words }
  let sessionsScanned = 0;
  let sessionsWithBeats = 0;

  sessions.forEach(session => {
    sessionsScanned++;
    const rounds = session.rounds || [];
    let sawBeats = false;
    rounds.forEach(round => {
      (round.beats || []).forEach(beat => {
        sawBeats = true;
        if (beat.passed || beat.failed || beat.playerAuthored) return;
        if (!beat.memberId || !beat.text) return;
        if (!perMember.has(beat.memberId)) perMember.set(beat.memberId, { turns: 0, words: 0 });
        const entry = perMember.get(beat.memberId);
        entry.turns++;
        entry.words += countWords(beat.text);
      });
    });
    if (sawBeats) sessionsWithBeats++;
  });

  return { perMember, sessionsScanned, sessionsWithBeats };
}

// Quartile-buckets only members who cleared MIN_SAMPLE_TURNS — same
// three-bucket shape as derive-length-tendency.js's static derivation, but
// computed over the qualifying subset's own spread rather than the whole
// roster, since a member below the threshold has no trustworthy average to
// rank in the first place.
function buildReport(data) {
  const qualifying = [];
  const insufficientCount = { total: 0 };
  for (const [memberId, { turns, words }] of data.perMember) {
    if (turns < MIN_SAMPLE_TURNS) {
      insufficientCount.total++;
      continue;
    }
    qualifying.push({ memberId, turns, avg: words / turns });
  }

  const sorted = [...qualifying].sort((a, b) => a.avg - b.avg).map(r => r.avg);
  const q1 = sorted.length ? percentile(sorted, 0.25) : null;
  const q3 = sorted.length ? percentile(sorted, 0.75) : null;

  const rows = qualifying
    .map(({ memberId, turns, avg }) => {
      const observed = q1 == null ? 'medium' : avg < q1 ? 'terse' : avg > q3 ? 'expansive' : 'medium';
      const current = lengthTendencyOf(memberId);
      return { memberId, turns, avg, observed, current, match: observed === current };
    })
    .sort((a, b) => a.memberId.localeCompare(b.memberId));

  return {
    rows,
    insufficientCount: insufficientCount.total,
    q1,
    q3,
    sessionsScanned: data.sessionsScanned,
    sessionsWithBeats: data.sessionsWithBeats,
  };
}

function renderMarkdown(report) {
  const lines = [
    '# Observed Length Tendency (#542)',
    '',
    `Scanned ${report.sessionsScanned} session(s) on disk, ${report.sessionsWithBeats} with structured \`beats\`.`,
    '',
    '_Advisory only — this report does not write to src/tuning.js. See scripts/report-observed-length-tendency.js for why._',
    '',
  ];

  if (!report.sessionsWithBeats) {
    lines.push(
      '> No scanned session has any `beats` entries yet (all predate #244/#352, or `sessions/` is empty on this ' +
        'machine). Every member is cold-start until real sessions with structured beats accumulate — this is ' +
        'expected right after this script ships, not a bug.',
      ''
    );
  }

  if (report.rows.length) {
    lines.push(
      '## Members with enough data to compare',
      '',
      `Threshold: ${MIN_SAMPLE_TURNS}+ real spoken turns (passed/failed/player-authored beats excluded).`,
      '',
      '| Member | Spoken turns | Avg words/turn | Observed | Current (tuning.js) | |',
      '|---|---|---|---|---|---|',
      ...report.rows.map(
        r =>
          `| ${r.memberId} | ${r.turns} | ${r.avg.toFixed(1)} | ${r.observed} | ${r.current} | ${r.match ? 'match' : '**MISMATCH**'} |`
      ),
      ''
    );
  } else {
    lines.push(
      '## Members with enough data to compare',
      '',
      '_None yet — every member is below the sample threshold._',
      ''
    );
  }

  lines.push(
    `${report.insufficientCount} member(s) with at least one observed turn are still below the ${MIN_SAMPLE_TURNS}-turn threshold and are omitted above.`,
    ''
  );

  return lines.join('\n');
}

function main() {
  const sessionsDir = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || ROOT, 'sessions');
  const sessions = loadSessions(sessionsDir);
  const data = collectObservedTurns(sessions);
  const report = buildReport(data);
  const markdown = renderMarkdown(report);

  console.log(markdown);
  fs.writeFileSync(OUTPUT_FILE, markdown, 'utf8');
  console.log(`\nWrote ${OUTPUT_FILE} (${sessions.length} sessions scanned, from ${sessionsDir}).`);
}

module.exports = { collectObservedTurns, buildReport, renderMarkdown, MIN_SAMPLE_TURNS };

if (require.main === module) main();
