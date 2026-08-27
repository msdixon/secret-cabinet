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
const { escapeHtml } = require('./transcript-format');

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

// #461 — a browsable HTML rendering of the same aggregate document, for
// GET /bibliography (see src/reading-room.js for the sibling "public page,
// server-rendered, no client JS" pattern this follows). buildBibliography
// above stays the markdown form the /api/admin/bibliography route and the
// scripts/build-bibliography.js CLI dump both still use — this doesn't
// replace it, it's a second view over the same grouped data.

function verdictClass(verdict) {
  return verdict === 'verified' ? 'bib-verified' : verdict === 'unverified' ? 'bib-unverified' : 'bib-uncertain';
}

// A grounding source, as HTML — built once here rather than inside a
// template literal so the web-source case (a link) isn't escaped twice.
function groundedInHtml(o) {
  if (o.libraryCitation) return escapeHtml(o.libraryCitation);
  if (o.webSourceUrl)
    return `<a href="${escapeHtml(o.webSourceUrl)}" rel="noopener">${escapeHtml(o.webSourceTitle || o.webSourceUrl)}</a>`;
  if (o.webSourceTitle) return escapeHtml(o.webSourceTitle);
  return null;
}

function renderCitationGroupHtml(group) {
  const n = group.occurrences.length;
  const occurrencesHtml = group.occurrences
    .map(o => {
      const verdict = VERDICT_LABEL[o.verdict] || 'uncertain';
      const source = SOURCE_LABEL[o.source || 'ungrounded'];
      const grounded = groundedInHtml(o);
      const noteLine = [o.note ? escapeHtml(o.note) : null, grounded ? `grounded in: ${grounded}` : null]
        .filter(Boolean)
        .join(' — ');
      return `<li class="bib-occurrence">
        <div class="bib-occurrence-meta"><span class="bib-verdict ${verdictClass(o.verdict)}">${verdict}</span><span class="bib-source">${escapeHtml(source)}</span><span class="bib-attrib">${escapeHtml(o.speaker)}, session <code>${escapeHtml(o.sessionId)}</code> (${escapeHtml(o.date || '')})</span></div>
        ${o.quote ? `<blockquote class="bib-quote">${escapeHtml(o.quote)}</blockquote>` : ''}
        ${noteLine ? `<p class="bib-note">${noteLine}</p>` : ''}
      </li>`;
    })
    .join('\n');
  return `<article class="bib-work">
    <h3>${escapeHtml(group.displayWork)}</h3>
    <p class="bib-count">${n} citation${n === 1 ? '' : 's'}</p>
    <ul class="bib-occurrences">${occurrencesHtml}</ul>
  </article>`;
}

function renderInvokedGroupHtml(group) {
  const n = group.occurrences.length;
  const itemsHtml = group.occurrences
    .map(o => {
      const detail = o.note ? ` — ${escapeHtml(o.note)}` : '';
      return `<li class="bib-invoked-occurrence"><span class="bib-attrib">${escapeHtml(o.speaker)}, session <code>${escapeHtml(o.sessionId)}</code> (${escapeHtml(o.date || '')})</span>${detail}</li>`;
    })
    .join('\n');
  return `<article class="bib-work bib-work-invoked">
    <h3>${escapeHtml(group.displayWork)}</h3>
    <p class="bib-count">invoked ${n} time${n === 1 ? '' : 's'} without a supporting quote — not independently verified.</p>
    <ul class="bib-occurrences">${itemsHtml}</ul>
  </article>`;
}

function renderLibraryAppendixHtml(libraryEntries) {
  if (!libraryEntries.length) return '<p class="bib-empty">No curated library entries yet.</p>';
  const sorted = [...libraryEntries].sort((a, b) => (a.citation || a.title).localeCompare(b.citation || b.title));
  const items = sorted
    .map(e => {
      const ref = e.citation
        ? escapeHtml(e.citation)
        : `${escapeHtml(e.title)} — <em>${escapeHtml(e.source)}</em>${e.date ? `, ${escapeHtml(e.date)}` : ''}`;
      const license = e.license ? ` <span class="bib-license">(${escapeHtml(e.license)})</span>` : '';
      const url = e.source_url ? ` — <a href="${escapeHtml(e.source_url)}" rel="noopener">source</a>` : '';
      return `<li>${ref}${license}${url}</li>`;
    })
    .join('\n');
  return `<ul class="bib-library">${items}</ul>`;
}

function renderBibliographyPage(sessions, roster = [], libraryEntries = []) {
  const withRecord = sessions.filter(s => (s.rounds || []).some(seg => Array.isArray(seg.beats)));
  const citationGroups = groupByWork(sessions, roster, citationsForSession);
  const invokedGroups = groupByWork(sessions, roster, flattenBeatInvokedWorks);

  const citedHtml = citationGroups.length
    ? citationGroups.map(renderCitationGroupHtml).join('\n')
    : '<p class="bib-empty">No citations captured yet.</p>';
  const referencedHtml = invokedGroups.length
    ? invokedGroups.map(renderInvokedGroupHtml).join('\n')
    : '<p class="bib-empty">None captured yet.</p>';
  const libraryHtml = renderLibraryAppendixHtml(libraryEntries);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bibliography — The Secret-Cabin-et</title>
<meta name="description" content="A cumulative works-cited record of every session convened by The Secret-Cabin-et.">
<meta name="robots" content="noindex, nofollow">
<style>
  @import url('https://fonts.googleapis.com/css2?family=UnifrakturMaguntia&family=IM+Fell+English:ital@0;1&family=Crimson+Pro:ital,wght@0,300;0,400;0,600;1,300;1,400&display=swap');
  :root {
    --bg:#0e0b08; --panel:#17120d; --border:#3a2e1e; --amber:#c8922a; --amber-dim:#7a5418;
    --cream:#e8dfc8; --muted:#c0a882; --ash:#9a8a74; --footer:#5a4a3a;
    --verified:#7a9a5a; --unverified:#a05050; --uncertain:#b08a3a;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg:#f2e8d0; --panel:#e8dcc0; --border:#cbb98f; --amber:#8a5f14; --amber-dim:#a07a2a;
      --cream:#2a2015; --muted:#4a3d28; --ash:#6a5a42; --footer:#a0906e;
      --verified:#4a6a34; --unverified:#8a3030; --uncertain:#7a5a1a;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--cream); font-family: 'Crimson Pro', Georgia, serif; font-size: 17px; line-height: 1.7; }
  a { color: var(--amber); }
  .bib-wrap { max-width: 760px; margin: 0 auto; padding: 64px 24px 96px; }
  .bib-masthead { text-align: center; margin-bottom: 8px; }
  .bib-masthead-name { font-family: 'UnifrakturMaguntia', serif; font-size: 26px; color: var(--amber); letter-spacing: 2px; }
  .bib-masthead-tag { font-family: 'IM Fell English', serif; font-style: italic; font-size: 12px; color: var(--ash); letter-spacing: 3px; text-transform: uppercase; margin-top: 6px; }
  .bib-intro { font-style: italic; color: var(--muted); text-align: center; max-width: 560px; margin: 28px auto 0; }
  .bib-meta { text-align: center; font-family: 'IM Fell English', serif; font-size: 13px; color: var(--ash); margin: 16px 0 32px; }
  .bib-toc { display: flex; justify-content: center; gap: 18px; font-family: 'IM Fell English', serif; font-size: 13px; letter-spacing: .5px; margin-bottom: 56px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
  .bib-toc a { text-decoration: none; }
  .bib-toc a:hover { text-decoration: underline; }
  section.bib-section { margin-bottom: 64px; }
  .bib-section h2 { font-family: 'IM Fell English', serif; font-size: 20px; letter-spacing: 1px; color: var(--amber); border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 8px; }
  .bib-section-note { color: var(--muted); font-size: 15px; margin-bottom: 32px; }
  .bib-work { margin-bottom: 36px; }
  .bib-work h3 { font-family: 'IM Fell English', serif; font-size: 16px; color: var(--cream); margin: 0 0 4px; }
  .bib-count { font-size: 12px; color: var(--ash); margin: 0 0 10px; text-transform: uppercase; letter-spacing: .5px; }
  .bib-occurrences { list-style: none; margin: 0; padding: 0; }
  .bib-occurrence, .bib-invoked-occurrence { padding: 10px 0 10px 16px; border-left: 2px solid var(--border); margin-bottom: 6px; }
  .bib-occurrence-meta { font-size: 12px; color: var(--ash); display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
  .bib-attrib { font-family: 'IM Fell English', serif; font-style: italic; }
  .bib-attrib code { font-family: monospace; font-style: normal; }
  .bib-verdict { text-transform: uppercase; font-size: 11px; letter-spacing: .5px; padding: 1px 6px; border-radius: 2px; border: 1px solid currentColor; }
  .bib-verified { color: var(--verified); }
  .bib-unverified { color: var(--unverified); }
  .bib-uncertain { color: var(--uncertain); }
  .bib-source { color: var(--ash); font-style: italic; }
  .bib-quote { margin: 8px 0 4px; padding-left: 12px; border-left: 2px solid var(--amber-dim); font-style: italic; color: var(--cream); }
  .bib-note { margin: 4px 0 0; font-size: 14px; color: var(--muted); }
  .bib-empty { color: var(--ash); font-style: italic; }
  .bib-library { list-style: none; margin: 0; padding: 0; }
  .bib-library li { padding: 8px 0; border-bottom: 1px solid var(--border); }
  .bib-license { color: var(--ash); font-size: 13px; }
  .bib-footer { text-align: center; margin-top: 72px; font-family: 'IM Fell English', serif; font-size: 11px; letter-spacing: 1px; color: var(--footer); line-height: 1.8; }
</style>
</head>
<body>
  <div class="bib-wrap">
    <header class="bib-masthead">
      <div class="bib-masthead-name">The Secret-Cabin-et</div>
      <div class="bib-masthead-tag">Bibliography</div>
    </header>
    <p class="bib-intro">A works-cited record of the project itself, in appendix form: what was cited across every convened session, what was invoked by name or allusion without a supporting quote, and the curated primary-source library the room draws from. Citation status is carried through honestly on every entry — see each occurrence's grounding label — rather than flattened away.</p>
    <p class="bib-meta">Generated from ${sessions.length} session${sessions.length === 1 ? '' : 's'} on disk, ${withRecord.length} with a turn-level record to cite from.</p>
    <nav class="bib-toc">
      <a href="#cited">I. Works Cited</a>
      <a href="#referenced">II. Works Referenced</a>
      <a href="#library">III. The Cabinet's Library</a>
    </nav>

    <section class="bib-section" id="cited">
      <h2>I. Works Cited</h2>
      <p class="bib-section-note">Direct citations — a quote, attributed to the speaker and session that made it.</p>
      ${citedHtml}
    </section>

    <section class="bib-section" id="referenced">
      <h2>II. Works Referenced — Invoked, Not Quoted</h2>
      <p class="bib-section-note">A member reaching for a reading without quoting it, or naming a tradition rather than a title. Weaker evidence than Works Cited: named in passing, never independently checked — kept separate so what's confirmed and what's merely gestured at never get mistaken for each other.</p>
      ${referencedHtml}
    </section>

    <section class="bib-section" id="library">
      <h2>III. Appendix: The Cabinet's Library</h2>
      <p class="bib-section-note">The curated primary-source texts each member draws from, independent of any single session — the most directly defensible bibliographic asset in the project.</p>
      ${libraryHtml}
    </section>

    <footer class="bib-footer">Compiled from every convened session of The Secret-Cabin-et.<br>An imaginative exercise, not a historical record.</footer>
  </div>
</body>
</html>`;
}

module.exports = {
  normalizeWorkKey,
  citationsForSession,
  groupByWork,
  renderLibraryAppendix,
  buildBibliography,
  renderBibliographyPage,
};
