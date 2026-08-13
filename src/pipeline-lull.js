'use strict';

// #284 seam-map, module 6 of 6 — lull notes.
//
// #244, decision 2: director-written lull notes, with a small pre-seeded
// stock rotation as fallback for when the director doesn't write one (or
// writes one that fails validation) — covers every passage-ending pause,
// not just director-judged ones, since a budget-exhausted passage reaches
// the same diegetic lull the user sees either way.

const LULL_NOTE_MAX_CHARS = 160;
const STOCK_LULL_NOTES = [
  'The room draws breath.',
  'A quiet settles over the table.',
  'Someone stirs the fire; no one speaks for a moment.',
];
// #246: memoryless over three options meant consecutive lulls repeated
// about 1 in 3 — invisible while the client had nothing rendering these
// notes, surfaced once #245 started showing them. excludePrevious lets the
// caller keep the passage before this one from picking itself again;
// falls back to the full rotation if that would leave nothing to choose from.
function pickStockLullNote(rng = Math.random, excludePrevious = null) {
  const pool = excludePrevious ? STOCK_LULL_NOTES.filter(n => n !== excludePrevious) : STOCK_LULL_NOTES;
  const options = pool.length ? pool : STOCK_LULL_NOTES;
  return options[Math.floor(rng() * options.length)];
}
function resolveLullNote(directorNote, rng = Math.random, previousLullNote = null) {
  const trimmed = (directorNote || '').trim().slice(0, LULL_NOTE_MAX_CHARS);
  return trimmed || pickStockLullNote(rng, previousLullNote);
}

module.exports = {
  LULL_NOTE_MAX_CHARS,
  STOCK_LULL_NOTES,
  pickStockLullNote,
  resolveLullNote,
};
