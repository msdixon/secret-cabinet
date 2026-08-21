'use strict';

// Aggregates citations across every session into one cumulative,
// human-reviewable manifest — a periodic checkpoint (every ~20 sessions or so)
// to verify attribution, tune the citation-extraction prompt if needed, and
// keep a running bibliography of works cited while working on the novel.
// No test framework/scripts runner exists in this repo — matches its existing
// ad hoc script style (see scripts/test-director.js). Run with:
//   node scripts/build-citation-manifest.js
//
// #355: used to filter to `sessions.filter(s => Array.isArray(s.citationFlags))`
// — the cumulative manifest was only ever as complete as remembering to click
// Verify Citations (1 of 11 sessions, at the review that filed the issue).
// Citations are now captured always-on, per beat, at write time
// (pipeline-disposition.js) — every session with beats contributes its raw
// captured citations here whether or not anyone ever ran the deliberate
// grounding pass. A session that *has* been through Verify Citations
// contributes its grounded `citationFlags` instead (richer: library/web
// verdicts, not just the model's own turn-time judgment) — see `citationsFor`.
const fs = require('fs');
const path = require('path');
const { flattenBeatCitations } = require('../src/citations');

const ROOT = path.join(__dirname, '..');
const OUTPUT_FILE = path.join(ROOT, 'CITATION-MANIFEST.md');

const VERDICT_SEVERITY = { unverified: 2, uncertain: 1, verified: 0 };
const VERDICT_LABEL = { unverified: 'unverified', uncertain: 'uncertain', verified: 'verified' };
// #153 part 3 — same convention as public/app.js's CITATION_SOURCE_LABEL.
// #355 adds 'ungrounded': a citation flag always carried an explicit
// `source` once the old whole-transcript extraction ran (defaulting to
// 'model-knowledge' when nothing else applied) — so a *missing* `source`
// now means something more specific: this citation was captured always-on
// but has never been through the deliberate grounding pass at all, not that
// grounding ran and simply found no match.
const SOURCE_LABEL = {
  library: 'checked against curated text',
  web: 'checked via live lookup',
  'model-knowledge': "Claude's own knowledge (grounding attempted, no match)",
  ungrounded: 'captured at write time — not yet run through Verify Citations',
};

function normalizeWorkKey(work) {
  return work.replace(/[*"']/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// sessionsDir is passed in explicitly rather than read from a module-level
// constant, same convention as sessions-store.js/graph.js — this function is
// also called from src/routes/session.js's admin route (#153 check-in),
// which must point at the real RAILWAY_VOLUME_MOUNT_PATH-based dir server.js
// resolves, not a path this module would otherwise have to guess at.
function loadSessions(sessionsDir) {
  if (!fs.existsSync(sessionsDir)) return [];
  return fs
    .readdirSync(sessionsDir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8'));
      } catch (e) {
        console.warn(`Skipping unreadable session file: ${f}`);
        return null;
      }
    })
    .filter(Boolean);
}

// #355: a session's citations come from its grounded `citationFlags` if
// Verify Citations has ever run (richer — library/web verdicts on top of
// the model's own turn-time judgment), else from flattening the always-on
// raw capture straight off its beats — which exists for every session with
// beats, whether or not anyone has ever clicked the button.
function citationsFor(session, roster) {
  if (Array.isArray(session.citationFlags)) return { citations: session.citationFlags, grounded: true };
  return { citations: flattenBeatCitations(session, roster), grounded: false };
}

function buildManifest(sessions, roster = []) {
  const sourced = sessions.map(session => ({ session, ...citationsFor(session, roster) }));
  const withCitations = sourced.filter(s => s.citations.length);
  const ungroundedCount = sourced.filter(s => s.citations.length && !s.grounded).length;
  const emptyCount = sourced.length - withCitations.length;

  const works = new Map(); // normalized key -> { displayWork, occurrences: [] }

  withCitations.forEach(({ session, citations }) => {
    citations.forEach(flag => {
      const key = normalizeWorkKey(flag.work);
      if (!works.has(key)) works.set(key, { displayWork: flag.work, occurrences: [] });
      works.get(key).occurrences.push({
        sessionId: session.id,
        date: session.date,
        speaker: (flag.speaker || '').replace(/\s*—\s*$/, '').trim(),
        verdict: flag.verdict,
        note: flag.note,
        quote: flag.quote,
        libraryCitation: flag.libraryCitation || null,
        webSourceUrl: flag.webSourceUrl || null,
        webSourceTitle: flag.webSourceTitle || null,
        // #355: only an explicit `source` (written by the grounding pass —
        // see SOURCE_LABEL's 'ungrounded' entry) means "checked and this is
        // what it found." Its absence means "never checked," not
        // "model-knowledge" — those used to be the same bucket.
        source: flag.source || 'ungrounded',
      });
    });
  });

  const groups = [...works.values()].map(w => ({
    ...w,
    worstSeverity: Math.max(...w.occurrences.map(o => VERDICT_SEVERITY[o.verdict] ?? 0)),
  }));

  const needsReview = groups
    .filter(g => g.worstSeverity > 0)
    .sort((a, b) => b.worstSeverity - a.worstSeverity || a.displayWork.localeCompare(b.displayWork));
  const verified = groups.filter(g => g.worstSeverity === 0).sort((a, b) => a.displayWork.localeCompare(b.displayWork));

  const totalCitations = groups.reduce((n, g) => n + g.occurrences.length, 0);
  const verdictCounts = { verified: 0, unverified: 0, uncertain: 0 };
  const sourceCounts = { library: 0, web: 0, 'model-knowledge': 0, ungrounded: 0 };
  groups.forEach(g =>
    g.occurrences.forEach(o => {
      verdictCounts[o.verdict]++;
      sourceCounts[o.source]++;
    })
  );

  const renderGroup = g => {
    const lines = [`### ${g.displayWork}`, ''];
    g.occurrences.forEach(o => {
      const groundedIn =
        o.libraryCitation || (o.webSourceUrl ? `[${o.webSourceTitle}](${o.webSourceUrl})` : o.webSourceTitle);
      const grounding = groundedIn ? ` — grounded in: ${groundedIn}` : '';
      lines.push(
        `- **${VERDICT_LABEL[o.verdict]}** (${SOURCE_LABEL[o.source]}) — ${o.speaker}, session \`${o.sessionId}\` (${o.date})`
      );
      lines.push(`  > "${o.quote}"`);
      lines.push(`  ${o.note}${grounding}`);
      lines.push('');
    });
    return lines.join('\n');
  };

  const lines = [
    '# Citation Manifest',
    '',
    // #355: every session with beats now contributes its always-on captured
    // citations, whether or not Verify Citations has ever run on it — the
    // count below is who's contributed a *grounded* pass on top of that.
    `Generated from ${sessions.length} session(s) on disk, ${withCitations.length} with captured citations. ` +
      `${sourced.filter(s => s.grounded).length} have been run through Verify Citations' grounding pass.`,
    '',
    `**${groups.length}** distinct works cited, **${totalCitations}** total citations — ` +
      `${verdictCounts.verified} verified, ${verdictCounts.unverified} unverified, ${verdictCounts.uncertain} uncertain.`,
    '',
    `**Grounding:** ${sourceCounts.library} checked against curated library text, ${sourceCounts.web} via live lookup, ` +
      `${sourceCounts['model-knowledge']} from Claude's own knowledge with grounding attempted, ${sourceCounts.ungrounded} captured but not yet run through Verify Citations — ` +
      `the volume signal #153's scheduled check-in (~2026-08-19) uses to weigh manual vs. automated library promotion.`,
    '',
  ];

  if (ungroundedCount) {
    lines.push(
      `_${ungroundedCount} session(s) below have citations captured at write time but haven't been run through Verify Citations' grounding pass yet — verdicts are the model's own turn-time judgment only._`,
      ''
    );
  }
  if (emptyCount) {
    lines.push(
      `_${emptyCount} session(s) on disk cite nothing (predate #355's capture, or genuinely made no citations) and aren't reflected below._`,
      ''
    );
  }

  if (needsReview.length) {
    lines.push('## ⚠ Needs review', '', ...needsReview.map(renderGroup));
  }
  if (verified.length) {
    lines.push('## ✓ Verified', '', ...verified.map(renderGroup));
  }
  if (!groups.length) {
    lines.push('_No citations found yet — convene a session, or run Verify Citations on an older one._', '');
  }

  return lines.join('\n');
}

module.exports = { loadSessions, buildManifest };

// CLI entry point only — the admin route (src/routes/session.js) calls
// loadSessions/buildManifest directly instead of shelling out to this file.
if (require.main === module) {
  // Same DATA_DIR resolution as server.js's SESSIONS_DIR: previously this
  // script hardcoded ROOT/sessions unconditionally, which silently scanned
  // the repo checkout's own (usually empty) sessions/ dir even when run on
  // a deployed instance with a real volume mounted elsewhere.
  const sessionsDir = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || ROOT, 'sessions');
  const sessions = loadSessions(sessionsDir);
  // #355: speaker display names for the always-on raw citations, same
  // roster server.js loads at startup (reloadRoster backfills glyphs and
  // drops entries whose character file is gone — harmless here, just name
  // resolution for the manifest).
  const rosterModule = require('../src/roster');
  const membersDir = path.join(ROOT, 'prompts', 'members');
  const rosterFile = path.join(membersDir, 'roster.json');
  const roster = fs.existsSync(rosterFile) ? rosterModule.reloadRoster(rosterFile, membersDir) : [];
  const manifest = buildManifest(sessions, roster);
  fs.writeFileSync(OUTPUT_FILE, manifest, 'utf8');
  console.log(`Wrote ${OUTPUT_FILE} (${sessions.length} sessions scanned, from ${sessionsDir}).`);
}
