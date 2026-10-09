'use strict';

// #580 v1 — a researcher's personal note on one citation, shown on the
// bibliography. Stored on the session (`session.citationNotes`, keyed by
// the citationKey flattenBeatCitations stamps on each citation) so it
// inherits #595's ownership: only the owner writes it, and only the owner
// ever sees it — a published session's notes are the owner's marginalia,
// not part of what publishing shares.

const MAX_NOTE_LENGTH = 2000;
const KEY_PATTERN = /^\d+\.\d+\.\d+$/;

function isValidKey(key) {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}

// Upserts one note (or deletes it when `note` trims to empty). Returns the
// notes object to store, or null if it ends up empty so the field can be
// dropped from the session rather than left as `{}`.
function applyNote(existing, key, note, now = new Date()) {
  const next = { ...(existing || {}) };
  const text = (note || '').trim();
  if (text) next[key] = { note: text, updatedAt: now.toISOString() };
  else delete next[key];
  return Object.keys(next).length ? next : null;
}

// Notes are private to the session's owner: everyone else gets the session
// without them.
function withoutCitationNotes(session) {
  if (!session || !session.citationNotes) return session;
  const { citationNotes: _private, ...rest } = session;
  return rest;
}

module.exports = { MAX_NOTE_LENGTH, isValidKey, applyNote, withoutCitationNotes };
