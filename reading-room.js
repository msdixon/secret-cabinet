'use strict';

// #193 seam-map, module 3 of 8 — the public reading room (#38).
//
// A session explicitly marked published renders at /reading-room/:id with no
// login and no client JS: just the source document and the transcript,
// typeset. Whole-session only for this MVP — no per-round curation, no
// portraits, no annotations (matches the issue's "no generation controls, no
// member grid"). Pure HTML templating, no I/O — depends on transcript-format.js
// for speaker-header recognition and escaping, following the sibling-module
// pattern pipeline.js already uses for dayone.js.

const { escapeHtml, buildSpeakerHeaderSet, normalizeSpeaker } = require('./transcript-format');

// Mirrors public/app.js's renderTranscriptInto parsing (same speaker-header
// heuristics, via the same buildSpeakerHeaderSet/normalizeSpeaker used above)
// but emits static server-rendered HTML — this page ships with no client JS.
function renderRoundHtml(text, roster) {
  const headers = buildSpeakerHeaderSet(roster);
  const lines = (text || '').split('\n');
  let speaker = null, textLines = [];
  let html = '';

  const renderSpeechHtml = body => escapeHtml(body)
    .split('\n')
    .map(line => {
      const t = line.trim();
      const m = t.match(/^\*(.+)\*$/);
      if (m && !m[1].includes('*')) return `<p class="rr-action">${m[1]}</p>`;
      return line.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
    })
    .join('<br>');

  const flush = () => {
    if (!speaker || !textLines.length) return;
    const body = textLines.join('\n').trim();
    html += `<div class="rr-turn"><div class="rr-speaker">${escapeHtml(speaker)}</div><div class="rr-speech">${renderSpeechHtml(body)}</div></div>\n`;
    speaker = null; textLines = [];
  };

  lines.forEach(line => {
    const t = line.trim();
    if (!t) { flush(); return; }
    if (t === '---' || t === '—' || t === '--') return;
    const isAction = /^\*[^*\n]+\*$/.test(t);
    if (isAction && !speaker) {
      html += `<p class="rr-stage-action">${escapeHtml(t.slice(1, -1))}</p>\n`;
      return;
    }
    const bare = t.replace(/:$/, '');
    const isKnownName = headers.has(normalizeSpeaker(bare));
    const looksLikeName = !t.includes(' ') && t.length < 30 && /^[A-Z]/.test(t) && !t.includes('*');
    if (isKnownName || looksLikeName) { flush(); speaker = bare; textLines = []; }
    else if (speaker) textLines.push(t);
  });
  flush();
  return html;
}

function renderReadingRoomPage(session, roster) {
  const members = (session.members || [])
    .map(id => roster.find(m => m.id === id))
    .filter(Boolean);
  const title = (session.entry || 'A meeting').trim().slice(0, 80);
  // #245: `endedBy` (written only since #244) separates a segment whose label
  // opens it -- an old round header -- from one whose label is the lull that
  // ended it, which belongs after the passage. Same discriminator the record
  // and the stage use; see public/sessions.js's restore loop.
  const roundsHtml = (session.rounds || []).map(r =>
    r.endedBy
      ? `<section class="rr-round">${renderRoundHtml(r.text, roster)}<div class="rr-lull">${escapeHtml(r.label)}</div></section>`
      : `<section class="rr-round"><h2 class="rr-round-label">${escapeHtml(r.label)}</h2>${renderRoundHtml(r.text, roster)}</section>`
  ).join('\n');
  // Portraits are AI-generated placeholders, disclosed in docs/MANIFEST.md; not
  // every roster entry has one yet (see #80), so a broken image just hides
  // itself rather than showing a placeholder icon — same convention as the
  // dossier drawer's portrait (public/app.js).
  const membersHtml = members.map(m => `<span class="rr-member">
      <img class="rr-portrait" src="/portraits/${escapeHtml(m.id)}.png" alt="" loading="lazy" onerror="this.style.display='none'">
      <span class="rr-member-name">${escapeHtml(m.name)}</span>
    </span>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — The Secret-Cabin-et</title>
<meta name="description" content="A published salon transcript from The Secret-Cabin-et.">
<meta name="robots" content="noindex, follow">
<style>
  @import url('https://fonts.googleapis.com/css2?family=UnifrakturMaguntia&family=IM+Fell+English:ital@0;1&family=Crimson+Pro:ital,wght@0,300;0,400;0,600;1,300;1,400&display=swap');
  :root {
    --bg:#0e0b08; --panel:#17120d; --border:#3a2e1e; --amber:#c8922a; --amber-dim:#7a5418;
    --cream:#e8dfc8; --muted:#c0a882; --ash:#9a8a74; --footer:#5a4a3a;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg:#f2e8d0; --panel:#e8dcc0; --border:#cbb98f; --amber:#8a5f14; --amber-dim:#a07a2a;
      --cream:#2a2015; --muted:#4a3d28; --ash:#6a5a42; --footer:#a0906e;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--cream); font-family: 'Crimson Pro', Georgia, serif; font-size: 18px; line-height: 1.75; }
  .rr-wrap { max-width: 680px; margin: 0 auto; padding: 64px 24px 96px; }
  .rr-masthead { text-align: center; margin-bottom: 8px; }
  .rr-masthead-name { font-family: 'UnifrakturMaguntia', serif; font-size: 26px; color: var(--amber); letter-spacing: 2px; }
  .rr-masthead-tag { font-family: 'IM Fell English', serif; font-style: italic; font-size: 12px; color: var(--ash); letter-spacing: 3px; text-transform: uppercase; margin-top: 6px; }
  .rr-meta { text-align: center; font-family: 'IM Fell English', serif; font-size: 13px; color: var(--ash); margin: 28px 0 4px; }
  .rr-members { display: flex; flex-wrap: wrap; justify-content: center; gap: 18px 22px; margin-bottom: 40px; }
  .rr-member { display: flex; flex-direction: column; align-items: center; gap: 6px; width: 68px; }
  .rr-portrait { width: 56px; height: 56px; border-radius: 50%; object-fit: cover; border: 1px solid var(--amber-dim); }
  .rr-member-name { font-family: 'IM Fell English', serif; font-style: italic; font-size: 12px; color: var(--muted); text-align: center; line-height: 1.3; }
  .rr-source { border-left: 3px solid var(--amber-dim); background: var(--panel); padding: 18px 22px; margin-bottom: 48px; font-style: italic; color: var(--muted); white-space: pre-wrap; }
  .rr-round { margin-bottom: 48px; }
  .rr-round-label { font-family: 'IM Fell English', serif; font-size: 13px; letter-spacing: 3px; text-transform: uppercase; color: var(--ash); text-align: center; margin-bottom: 28px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
  .rr-lull { font-family: 'IM Fell English', serif; font-style: italic; font-size: 13px; color: var(--ash); text-align: center; margin-top: 34px; padding-top: 22px; border-top: 1px solid var(--border); }
  .rr-turn { margin-bottom: 28px; }
  .rr-speaker { font-family: 'IM Fell English', serif; font-size: 14px; letter-spacing: 1px; color: var(--amber); margin-bottom: 4px; }
  .rr-speech { color: var(--cream); }
  .rr-speech .rr-action { font-style: italic; color: var(--ash); margin: 4px 0; }
  .rr-stage-action { font-style: italic; color: var(--ash); text-align: center; margin: 20px 0; }
  .rr-footer { text-align: center; margin-top: 72px; font-family: 'IM Fell English', serif; font-size: 11px; letter-spacing: 1px; color: var(--footer); line-height: 1.8; }
</style>
</head>
<body>
  <div class="rr-wrap">
    <header class="rr-masthead">
      <div class="rr-masthead-name">The Secret-Cabin-et</div>
      <div class="rr-masthead-tag">Reading Room</div>
    </header>
    <div class="rr-meta">${escapeHtml(session.date || '')}</div>
    <div class="rr-members">${membersHtml}</div>
    <div class="rr-source">${escapeHtml(session.entry || '')}</div>
    ${roundsHtml}
    <footer class="rr-footer">Published from a private session of The Secret-Cabin-et.<br>An imaginative exercise, not a historical record.</footer>
  </div>
</body>
</html>`;
}

module.exports = { renderRoundHtml, renderReadingRoomPage };
