'use strict';

// #356: the project-wide bibliography — an appendix-form works-cited record
// of the project itself, as distinct from scripts/build-citation-manifest.js's
// CITATION-MANIFEST.md.
//
// The two documents read the same underlying data (citationsFor/
// flattenBeatCitations) but are shaped for different readers and organized
// on different axes:
//   - CITATION-MANIFEST.md is a review artifact: grouped "needs review"
//     first, ordered by verdict severity, aimed at spotting bad attributions
//     before they're trusted.
//   - This file's output is a bibliography: grouped by scope (works cited /
//     works referenced / the library), ordered alphabetically by work within
//     each, aimed at standing on its own as a works-cited record — the shape
//     an academic reader expects, not a QA queue.
// Grounding status is still carried on every entry either way — this file
// doesn't relax the honesty requirement, just leads with the bibliography
// framing instead of the review framing.
//
// Two tiers, per the issue's proposal:
//   - Works Cited: direct citations, each with a quote (beat.citations,
//     always-on since #355).
//   - Works Referenced: texts/authors/traditions invoked by name or
//     allusion without a supporting quote (beat.invokedWorks, #356). Labelled
//     as invoked-not-verified throughout, deliberately weaker language than
//     "works consulted" — these were never checked against anything, only
//     named.
// Plus a library appendix: the curated primary-source texts in
// prompts/library/, each already carrying a publication-ready `citation`
// string in its .md frontmatter (see src/library.js's
// loadLibraryCitationLookup) — the most directly defensible bibliographic
// asset in the project, per the issue.

const { flattenBeatCitations, flattenBeatInvokedWorks } = require('./citations');

// Same convention as build-citation-manifest.js's SOURCE_LABEL — kept as its
// own copy rather than a shared constant, matching this codebase's existing
// preference for small explicit duplication over cross-module coupling (see
// CITATION_SOURCE_LABEL's own comment in public/js/export.js).
const SOURCE_LABEL = {
  library: 'checked against curated text',
  web: 'checked via live lookup',
  'model-knowledge': "Claude's own knowledge (grounding attempted, no match)",
  ungrounded: 'captured at write time — not yet run through Verify Citations',
};
const VERDICT_LABEL = { unverified: 'unverified', uncertain: 'uncertain', verified: 'verified' };

function normalizeWorkKey(work) {
  return (work || '').replace(/[*"']/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// A session's direct citations: its grounded `citationFlags` if Verify
// Citations has ever run, else the always-on raw capture off its beats —
// same fallback build-citation-manifest.js's citationsFor uses, so a session
// that's never been through the deliberate grounding pass still contributes
// its write-time-captured citations rather than showing up empty.
function citationsForSession(session, roster) {
  if (Array.isArray(session.citationFlags)) return session.citationFlags;
  return flattenBeatCitations(session, roster);
}

// Groups a flat list of {work, ...} entries from across every session into
// one entry per distinct work, alphabetically — the bibliography's ordering
// axis, deliberately not verdict severity (see file header).
function groupByWork(sessions, roster, extractFn) {
  const works = new Map();
  sessions.forEach(session => {
    extractFn(session, roster).forEach(entry => {
      const key = normalizeWorkKey(entry.work);
      if (!key) return;
      if (!works.has(key)) works.set(key, { displayWork: entry.work, occurrences: [] });
      works.get(key).occurrences.push({
        ...entry,
        sessionId: session.id,
        date: session.date,
        speaker: (entry.speaker || '').replace(/\s*—\s*$/, '').trim(),
      });
    });
  });
  return [...works.values()].sort((a, b) => a.displayWork.localeCompare(b.displayWork));
}

function renderCitationGroup(group) {
  const n = group.occurrences.length;
  const lines = [`### ${group.displayWork}`, '', `_${n} citation${n === 1 ? '' : 's'}._`, ''];
  group.occurrences.forEach(o => {
    const verdict = VERDICT_LABEL[o.verdict] || 'uncertain';
    const source = SOURCE_LABEL[o.source || 'ungrounded'];
    const groundedIn =
      o.libraryCitation || (o.webSourceUrl ? `[${o.webSourceTitle}](${o.webSourceUrl})` : o.webSourceTitle);
    lines.push(`- **${verdict}** (${source}) — ${o.speaker}, session \`${o.sessionId}\` (${o.date})`);
    if (o.quote) lines.push(`  > "${o.quote}"`);
    const noteLine = [o.note, groundedIn ? `grounded in: ${groundedIn}` : null].filter(Boolean).join(' — ');
    if (noteLine) lines.push(`  ${noteLine}`);
    lines.push('');
  });
  return lines.join('\n');
}

function renderInvokedGroup(group) {
  const n = group.occurrences.length;
  const lines = [
    `### ${group.displayWork}`,
    '',
    `_invoked ${n} time${n === 1 ? '' : 's'} without a supporting quote — not independently verified; a record of what was invoked, not a confirmed citation._`,
    '',
  ];
  group.occurrences.forEach(o => {
    const detail = o.note ? ` — ${o.note}` : '';
    lines.push(`- ${o.speaker}, session \`${o.sessionId}\` (${o.date})${detail}`);
  });
  lines.push('');
  return lines.join('\n');
}

// libraryEntries: library.json's index, each merged with its .md
// frontmatter's `citation`/`source_url` (see src/library.js's
// loadLibraryCitationLookup) — callers assemble that merge, this module
// just renders it.
function renderLibraryAppendix(libraryEntries) {
  if (!libraryEntries.length) return '_No curated library entries yet._\n';
  const sorted = [...libraryEntries].sort((a, b) => (a.citation || a.title).localeCompare(b.citation || b.title));
  const lines = sorted.map(e => {
    const ref = e.citation || `${e.title} — *${e.source}*${e.date ? `, ${e.date}` : ''}`;
    const license = e.license ? ` (${e.license})` : '';
    const url = e.source_url ? ` — [source](${e.source_url})` : '';
    return `- ${ref}${license}${url}`;
  });
  return lines.join('\n') + '\n';
}

function buildBibliography(sessions, roster = [], libraryEntries = []) {
  const withRecord = sessions.filter(s => (s.rounds || []).some(seg => Array.isArray(seg.beats)));
  const citationGroups = groupByWork(sessions, roster, citationsForSession);
  const invokedGroups = groupByWork(sessions, roster, flattenBeatInvokedWorks);

  const lines = [
    '# Bibliography — The Secret-Cabin-et',
    '',
    "A works-cited record of the project itself, in appendix form: what was cited across every convened session, what was invoked by name or allusion without a supporting quote, and the curated primary-source library the room draws from. Citation status is carried through honestly on every entry — see each occurrence's grounding label — rather than flattened away.",
    '',
    `Generated from ${sessions.length} session(s) on disk, ${withRecord.length} with a turn-level record to cite from.`,
    '',
    '## I. Works Cited',
    '',
    'Direct citations — a quote, attributed to the speaker and session that made it.',
    '',
    citationGroups.length ? citationGroups.map(renderCitationGroup).join('') : '_No citations captured yet._\n',
    '## II. Works Referenced — Invoked, Not Quoted',
    '',
    "A member reaching for a reading without quoting it, or naming a tradition rather than a title. Weaker evidence than Works Cited: named in passing, never independently checked — kept in its own section rather than folded into the citations above, so what's confirmed and what's merely gestured at never get mistaken for each other.",
    '',
    invokedGroups.length ? invokedGroups.map(renderInvokedGroup).join('') : '_None captured yet._\n',
    "## III. Appendix: The Cabinet's Library",
    '',
    'The curated primary-source texts each member draws from, independent of any single session — the most directly defensible bibliographic asset in the project.',
    '',
    renderLibraryAppendix(libraryEntries),
  ];

  return lines.join('\n');
}

module.exports = {
  normalizeWorkKey,
  citationsForSession,
  groupByWork,
  renderLibraryAppendix,
  buildBibliography,
};
