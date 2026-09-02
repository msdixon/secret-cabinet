'use strict';

// #513 phase 1 — "measure first" before picking a lever. Computes, per
// member and in aggregate, across every local session on disk: average
// spoken-turn length (words), the proportion of spoken turns carrying a
// citation, and the proportion of beats that resolve as a pure-action
// `passed` turn (#362) rather than actual speech. Replaces "it feels
// essayistic" with a number to move — the lever itself (a director-prompt
// nudge, widening tuning.js's LENGTH_TENDENCY_OVERRIDES, a structural
// banter beat) is explicitly deferred to a follow-up, per the issue.
//
// Data-availability caveat, discovered while building this: every local
// session predates #355 (always-on per-beat citation capture, shipped
// 2026-08-20) — the most recent local session is dated 2026-08-05, and none
// carry a `beats` array or a non-empty `citationFlags` (confirmed: only one
// session was ever run through the old Verify Citations pass, and it
// produced zero flags — see PROJECT.md's Research-grounding thread row).
// So there is no real structured citation data to read yet. This script
// prefers it when it exists (`round.beats[].citations`, the #355 shape) and
// falls back to a conservative text heuristic (looksLikeCitation below)
// only when a round has no `beats` array at all. Every session measured
// today takes the heuristic path — the citation figures below are a
// lower-bound approximation, not the real per-beat verdict, and should be
// re-run once sessions generated after 2026-08-20 accumulate; only the
// citation proportion is heuristic, turn length and passed-proportion are
// exact either way (see isPassTurn, reused verbatim from
// pipeline-speaker.js, and plain word counts).
//
// Turn parsing for the no-`beats` legacy path reproduces
// public/js/witness.js's parseWitnessBlocks / public/js/speaker.js's
// resolveMember line-by-line, name-header-driven algorithm — the same logic
// the app itself uses to replay a legacy round with no persisted `beats`
// array — rather than inventing a second, divergent parser. Ported here
// (not required from public/js/) because those files are browser IIFEs
// (`window.Speaker`, `window.Witness`) with no module.exports, following
// this repo's existing script convention of small, deliberate duplication
// over adding a browser/Node shim (see bibliography.js's SOURCE_LABEL note).
//
// Run with:
//   node scripts/measure-brevity-baseline.js
// Pure functions below are unit-tested offline in
// test/measure-brevity-baseline.test.js against inline fixtures — no API
// key needed, this script never calls the model.

const fs = require('fs');
const path = require('path');
const { isPassTurn } = require('../src/pipeline-speaker');
const { LENGTH_TENDENCY_OVERRIDES } = require('../src/tuning');

const ROOT = path.join(__dirname, '..');
const OUTPUT_FILE = path.join(ROOT, 'BREVITY-BASELINE-REPORT.md');
const ROSTER_FILE = path.join(ROOT, 'prompts', 'members', 'roster.json');

// ── Speaker-header resolution (ported from public/js/speaker.js) ───────────

const ALIAS_STOPWORDS = new Set(['of', 'the', 'van', 'der', 'de', 'la', 'lady', 'sir', 'dr', 'st']);

function normalizeSpeaker(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .toLowerCase()
    .replace(/[\s-]+/g, ' ')
    .trim();
}

// normalized alias -> member id, or null if two members derive the same
// token (e.g. "Ibn" from both Ibn Arabi and Ibn Khaldun) — an ambiguous
// alias resolves to nobody, same fail-closed rule speaker.js's own index
// uses, rather than guessing.
function buildAliasIndex(roster) {
  const index = new Map();
  const register = (key, id) => {
    const k = normalizeSpeaker(key);
    if (!k) return;
    if (index.has(k) && index.get(k) !== id) index.set(k, null);
    else if (!index.has(k)) index.set(k, id);
  };
  roster.forEach(m => {
    register(m.name, m.id);
    m.name
      .split(/[\s-]+/)
      .filter(tok => tok.length > 2 && !ALIAS_STOPWORDS.has(tok.toLowerCase()))
      .forEach(tok => register(tok, m.id));
    (m.aliases || []).forEach(a => register(a, m.id));
  });
  return index;
}

// Returns the resolved member id, or undefined if the line isn't a
// recognized speaker header at all (ambiguous aliases return null, not
// undefined — a caller checking `typeof result === 'string'` treats both
// "not a header" and "an ambiguous one" the same way, matching
// isKnownSpeakerHeader's behavior in speaker.js).
function resolveSpeakerId(line, aliasIndex) {
  const norm = normalizeSpeaker(line.replace(/:$/, ''));
  return aliasIndex.has(norm) ? aliasIndex.get(norm) : undefined;
}

// ── Legacy round-text turn parsing (ported from witness.js's parseWitnessBlocks) ──

const ASIDE_START_RE = /^\[Aside — .+ and .+, apart from the room\]$/;
const ASIDE_END = '[/Aside]';

// Splits one round's raw text blob into {memberId, text} turns. Faithful to
// the app's own replay parser: a recognized speaker-name line opens a new
// turn, a blank line is a paragraph break (keeps the same speaker), a
// standalone `*action*` line before any speaker is scene-setting rather
// than a member's beat and is dropped, and `[Aside ...]`/`[/Aside]` bracket
// markers (#457 splinter exchanges) are stripped rather than mistaken for
// prose. Unresolved lines glue onto whichever speaker is currently open,
// same as production — this is a text parser, not a structured record.
function parseLegacyRoundTurns(text, aliasIndex) {
  const lines = (text || '').split('\n');
  const turns = [];
  let speakerId = null;
  let textLines = [];

  const flush = (keepSpeaker = false) => {
    if (speakerId && textLines.length) {
      turns.push({ memberId: speakerId, text: textLines.join('\n').trim() });
    }
    if (!keepSpeaker) speakerId = null;
    textLines = [];
  };

  lines.forEach(line => {
    const t = line.trim();
    if (!t) {
      flush(true);
      return;
    }
    if (t === '---' || t === '—' || t === '--') return;
    if (ASIDE_START_RE.test(t) || t === ASIDE_END) {
      flush();
      return;
    }
    const isActionLine = /^\*[^*\n]+\*$/.test(t);
    if (isActionLine && !speakerId) return;

    const resolved = resolveSpeakerId(t, aliasIndex);
    if (typeof resolved === 'string') {
      flush();
      speakerId = resolved;
      return;
    }
    if (speakerId) textLines.push(t);
  });
  flush();
  return turns;
}

// ── Citation heuristic (legacy-path fallback only — see file header) ───────

// Deliberately conservative — a substantial quoted span, or a proper-noun
// phrase paired with an attribution verb, or "according to". Undercounts
// rather than overcounts on purpose: the point is a defensible lower bound
// to replace "it feels essayistic," not a precise reproduction of #355's
// model-judged verdicts, which this heuristic cannot substitute for.
const CITATION_QUOTE_RE = /"[^"\n]{15,}"/;
const CITATION_ATTRIBUTION_RE =
  /\b[A-Z][\p{L}.'-]+(?:\s+[A-Z][\p{L}.'-]+){0,3}\s+(?:writes|wrote|notes|records|observes|argues|claims|says|calls it|defines|translates|equates)\b/u;
const CITATION_ACCORDING_TO_RE = /\baccording to\b/i;

function looksLikeCitation(text) {
  return CITATION_QUOTE_RE.test(text) || CITATION_ATTRIBUTION_RE.test(text) || CITATION_ACCORDING_TO_RE.test(text);
}

// ── Per-round / per-session turn extraction ─────────────────────────────────

// Prefers the real #355 structured record (round.beats) when present;
// falls back to parsing round.text only when a round has no `beats` array
// at all. `passed`/word-count are exact either way; `hasCitation` is only
// as exact as its source (see the citationSource tag).
function turnsForRound(round, aliasIndex) {
  if (Array.isArray(round.beats) && round.beats.length) {
    return round.beats
      .filter(b => !b.failed && b.memberId)
      .map(b => ({
        memberId: b.memberId,
        text: b.text || '',
        passed: !!b.passed,
        citationSource: 'structured',
        hasCitation: Array.isArray(b.citations) && b.citations.length > 0,
      }));
  }
  return parseLegacyRoundTurns(round.text, aliasIndex).map(t => ({
    memberId: t.memberId,
    text: t.text,
    passed: isPassTurn(t.text),
    citationSource: 'heuristic',
    hasCitation: looksLikeCitation(t.text),
  }));
}

function turnsForSession(session, aliasIndex) {
  return (session.rounds || []).flatMap(round => turnsForRound(round, aliasIndex));
}

function collectAllTurns(sessions, roster) {
  const aliasIndex = buildAliasIndex(roster);
  return sessions.flatMap(session =>
    turnsForSession(session, aliasIndex).map(turn => ({ ...turn, sessionId: session.id }))
  );
}

// ── Stats ────────────────────────────────────────────────────────────────

function wordCount(text) {
  const t = (text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

function avg(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function median(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// A "beat" resolving as `passed` (#362's pure-action idiom) is a real
// scheduled turn that chose not to speak — excluded from the length/citation
// averages below (its "text" is a stage direction, not prose), but counted
// in passedProportion, which is exactly the "spoken vs. pure-action" split
// the issue asks for.
function summarize(turns) {
  const spoken = turns.filter(t => !t.passed);
  const wordCounts = spoken.map(t => wordCount(t.text));
  const citationBeats = spoken.filter(t => t.hasCitation).length;
  return {
    totalBeats: turns.length,
    spokenBeats: spoken.length,
    passedBeats: turns.length - spoken.length,
    passedProportion: turns.length ? (turns.length - spoken.length) / turns.length : 0,
    avgWordsSpoken: avg(wordCounts),
    medianWordsSpoken: median(wordCounts),
    citationBeats,
    citationProportion: spoken.length ? citationBeats / spoken.length : 0,
  };
}

function summarizeByMember(turns, roster) {
  const byId = new Map(roster.map(m => [m.id, m]));
  const grouped = new Map();
  turns.forEach(t => {
    if (!grouped.has(t.memberId)) grouped.set(t.memberId, []);
    grouped.get(t.memberId).push(t);
  });
  return [...grouped.entries()]
    .map(([id, memberTurns]) => ({
      memberId: id,
      name: byId.get(id)?.name || id,
      lengthTendency: LENGTH_TENDENCY_OVERRIDES[id] || 'medium',
      ...summarize(memberTurns),
    }))
    .sort((a, b) => b.totalBeats - a.totalBeats);
}

// ── Report ───────────────────────────────────────────────────────────────

function pct(n) {
  return (n * 100).toFixed(1) + '%';
}

function buildReport({ sessions, roster, turns }) {
  const overall = summarize(turns);
  const perMember = summarizeByMember(turns, roster);
  const anyStructured = turns.some(t => t.citationSource === 'structured');
  const sessionDates = sessions.map(s => s.date).sort();

  const lines = [
    '# Brevity/Tangent Baseline — #513 Phase 1',
    '',
    `[#513](https://github.com/msdixon/secret-cabinet/issues/513) phase 1 — measurement only, not the lever. ${sessions.length} local session(s) (${sessionDates[0]} to ${sessionDates[sessionDates.length - 1]}), ${overall.totalBeats} total beats, ${overall.spokenBeats} spoken.`,
    '',
  ];

  if (!anyStructured) {
    lines.push(
      '**Data-availability caveat:** every session measured here predates [#355](https://github.com/msdixon/secret-cabinet/issues/355) (always-on per-beat citation capture, shipped 2026-08-20) — none carry a `beats` array or usable `citationFlags`. Citation figures below come from a conservative text heuristic (`looksLikeCitation`), not the real per-beat model verdict — treat them as a lower bound, not an exact count. Turn length and passed-proportion are exact regardless. Re-run this script once sessions generated after 2026-08-20 accumulate — it will use the real structured data automatically wherever a round carries `beats`.',
      ''
    );
  }

  lines.push(
    '## Aggregate',
    '',
    `- Average spoken-turn length: **${overall.avgWordsSpoken.toFixed(0)} words** (median ${overall.medianWordsSpoken.toFixed(0)})`,
    `- Turns carrying a citation: **${pct(overall.citationProportion)}** of spoken turns (${overall.citationBeats}/${overall.spokenBeats})`,
    `- Beats resolving as \`passed\`/pure-action: **${pct(overall.passedProportion)}** of all beats (${overall.passedBeats}/${overall.totalBeats})`,
    '',
    '## By member',
    '',
    '| Member | Length tendency | Beats | Passed % | Avg words (spoken) | Median words | Citation % |',
    '|---|---|---|---|---|---|---|'
  );
  perMember.forEach(m => {
    lines.push(
      `| ${m.name} | ${m.lengthTendency} | ${m.totalBeats} | ${pct(m.passedProportion)} | ${m.avgWordsSpoken.toFixed(0)} | ${m.medianWordsSpoken.toFixed(0)} | ${pct(m.citationProportion)} |`
    );
  });

  lines.push(
    '',
    '---',
    '',
    '_Repeatable — run `node scripts/measure-brevity-baseline.js` again once more sessions accumulate, especially post-#355 ones with real per-beat citation data. This script does not modify `tuning.js` or any pipeline behavior; picking a lever (director-prompt nudge, widening `LENGTH_TENDENCY_OVERRIDES`, a structural banter beat) is deferred to a follow-up per the issue._'
  );

  return lines.join('\n');
}

module.exports = {
  normalizeSpeaker,
  buildAliasIndex,
  resolveSpeakerId,
  parseLegacyRoundTurns,
  looksLikeCitation,
  turnsForRound,
  turnsForSession,
  collectAllTurns,
  wordCount,
  median,
  summarize,
  summarizeByMember,
  buildReport,
};

if (require.main === module) {
  // Same DATA_DIR resolution as server.js's SESSIONS_DIR / build-citation-manifest.js's CLI entry.
  const sessionsDir = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || ROOT, 'sessions');
  const { loadSessions } = require('./build-citation-manifest');
  const sessions = loadSessions(sessionsDir);
  if (!sessions.length) {
    console.error(`No sessions found at ${sessionsDir}.`);
    process.exitCode = 1;
    return;
  }
  const roster = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));
  const turns = collectAllTurns(sessions, roster);
  const report = buildReport({ sessions, roster, turns });
  fs.writeFileSync(OUTPUT_FILE, report, 'utf8');

  const overall = summarize(turns);
  console.log(
    `${sessions.length} sessions, ${overall.totalBeats} beats. Avg spoken length ${overall.avgWordsSpoken.toFixed(0)} words, citation rate ${pct(overall.citationProportion)}, passed rate ${pct(overall.passedProportion)}. Wrote ${OUTPUT_FILE}.`
  );
}
