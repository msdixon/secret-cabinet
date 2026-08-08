'use strict';

// #193 seam-map, module 2 of 8 — transcript text formatting.
//
// Pure string transforms with no I/O, shared by the reading room, the
// Obsidian exporter, and the annotated-transcript route. Speaker-header
// recognition takes the roster as a parameter rather than reaching for a
// module-level ROSTER singleton, following roster.js's convention.

// ── Speaker header recognition (mirrors public/app.js's alias index) ──────
// Members sign with a short form (surname, first name, or nickname), not
// their full roster name — see roster.json's `aliases` field and the
// comment above buildAliasIndex in public/app.js for the full rationale.
// Kept in sync with that client-side logic; if one changes, change both.
const ALIAS_STOPWORDS = new Set(['of', 'the', 'van', 'der', 'de', 'la', 'lady', 'sir', 'dr', 'st']);

function normalizeSpeaker(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '').toLowerCase().replace(/[\s-]+/g, ' ').trim();
}

function buildSpeakerHeaderSet(roster) {
  const owner = new Map(); // normalized key -> member id, or null if ambiguous
  const register = (key, id) => {
    const k = normalizeSpeaker(key);
    if (!k) return;
    if (owner.has(k) && owner.get(k) !== id) owner.set(k, null);
    else if (!owner.has(k)) owner.set(k, id);
  };
  roster.forEach(m => {
    register(m.name, m.id);
    m.name.split(/[\s-]+/)
      .filter(tok => tok.length > 2 && !ALIAS_STOPWORDS.has(tok.toLowerCase()))
      .forEach(tok => register(tok, m.id));
    (m.aliases || []).forEach(a => register(a, m.id));
  });
  const set = new Set();
  owner.forEach((id, k) => { if (id != null) set.add(k); });
  return set;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Post-process raw Claude transcript text: append ' —' after speaker name lines
// so plain-text exports clearly distinguish speakers from speech.
function formatTranscriptText(text, roster) {
  const headers = buildSpeakerHeaderSet(roster);
  return text.split('\n').map(line => {
    const t = line.trim();
    const bare = t.endsWith(':') ? t.slice(0, -1) : t;
    return headers.has(normalizeSpeaker(bare)) ? `${bare} —` : line;
  }).join('\n');
}

function buildTranscriptHeader(entry, memberIds, date, roster) {
  const names = memberIds.map(id => roster.find(m => m.id === id)?.name).filter(Boolean).join(', ');
  return `THE SECRET-CABIN-ET\nMeeting Notes — ${date}\nAssembled: ${names}\n\nSource material:\n${entry}\n`;
}

module.exports = {
  ALIAS_STOPWORDS,
  normalizeSpeaker,
  buildSpeakerHeaderSet,
  escapeHtml,
  formatTranscriptText,
  buildTranscriptHeader,
};
