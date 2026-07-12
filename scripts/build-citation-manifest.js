'use strict';

// Aggregates session.citationFlags across every session into one cumulative,
// human-reviewable manifest — a periodic checkpoint (every ~20 sessions or so)
// to verify attribution, tune the citation-verification prompt if needed, and
// keep a running bibliography of works cited while working on the novel.
// No test framework/scripts runner exists in this repo — matches its existing
// ad hoc script style (see scripts/test-director.js). Run with:
//   node scripts/build-citation-manifest.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SESSIONS_DIR = path.join(ROOT, 'sessions');
const OUTPUT_FILE = path.join(ROOT, 'CITATION-MANIFEST.md');

const VERDICT_SEVERITY = { unverified: 2, uncertain: 1, verified: 0 };
const VERDICT_LABEL = { unverified: 'unverified', uncertain: 'uncertain', verified: 'verified' };

function normalizeWorkKey(work) {
  return work.replace(/[*"']/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function loadSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      } catch (e) {
        console.warn(`Skipping unreadable session file: ${f}`);
        return null;
      }
    })
    .filter(Boolean);
}

function buildManifest(sessions) {
  const verifiedSessions = sessions.filter(s => Array.isArray(s.citationFlags));
  const works = new Map(); // normalized key -> { displayWork, occurrences: [] }

  verifiedSessions.forEach(session => {
    (session.citationFlags || []).forEach(flag => {
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
      });
    });
  });

  const groups = [...works.values()].map(w => ({
    ...w,
    worstSeverity: Math.max(...w.occurrences.map(o => VERDICT_SEVERITY[o.verdict] ?? 0)),
  }));

  const needsReview = groups.filter(g => g.worstSeverity > 0).sort((a, b) =>
    b.worstSeverity - a.worstSeverity || a.displayWork.localeCompare(b.displayWork));
  const verified = groups.filter(g => g.worstSeverity === 0).sort((a, b) =>
    a.displayWork.localeCompare(b.displayWork));

  const totalCitations = groups.reduce((n, g) => n + g.occurrences.length, 0);
  const verdictCounts = { verified: 0, unverified: 0, uncertain: 0 };
  groups.forEach(g => g.occurrences.forEach(o => verdictCounts[o.verdict]++));

  const renderGroup = g => {
    const lines = [`### ${g.displayWork}`, ''];
    g.occurrences.forEach(o => {
      const grounding = o.libraryCitation ? ` — grounded in: ${o.libraryCitation}` : '';
      lines.push(`- **${VERDICT_LABEL[o.verdict]}** — ${o.speaker}, session \`${o.sessionId}\` (${o.date})`);
      lines.push(`  > "${o.quote}"`);
      lines.push(`  ${o.note}${grounding}`);
      lines.push('');
    });
    return lines.join('\n');
  };

  const lines = [
    '# Citation Manifest',
    '',
    `Generated from ${sessions.length} session(s) on disk, ${verifiedSessions.length} of which have been run through Verify Citations.`,
    '',
    `**${groups.length}** distinct works cited, **${totalCitations}** total citations — ` +
      `${verdictCounts.verified} verified, ${verdictCounts.unverified} unverified, ${verdictCounts.uncertain} uncertain.`,
    '',
  ];

  if (sessions.length > verifiedSessions.length) {
    lines.push(`_${sessions.length - verifiedSessions.length} session(s) haven't been run through Verify Citations yet and aren't reflected below._`, '');
  }

  if (needsReview.length) {
    lines.push('## ⚠ Needs review', '', ...needsReview.map(renderGroup));
  }
  if (verified.length) {
    lines.push('## ✓ Verified', '', ...verified.map(renderGroup));
  }
  if (!groups.length) {
    lines.push('_No citations found yet — run Verify Citations on a session first._', '');
  }

  return lines.join('\n');
}

const sessions = loadSessions();
const manifest = buildManifest(sessions);
fs.writeFileSync(OUTPUT_FILE, manifest, 'utf8');
console.log(`Wrote ${OUTPUT_FILE} (${sessions.length} sessions scanned).`);
