'use strict';

// #579 — confessional asides: one member stepping out of the room to think
// something through at length, with the texts and evidence the quick
// exchange leaves no room for. The fourth part of the 2026-09-13
// citation-as-combat redesign (#576/#577/#578), and the piece that answers
// its tension with #561's brevity work: the room's turns stay short, and
// the long way round gets its own beat instead of stretching every turn.
//
// Same director-proposed shape as #458's splinterPair (see
// pipeline-splinter.js), one participant instead of two. What differs is
// where the text goes. A splinter's block folds into `roundSoFar` once it
// resolves, so everyone after it is conditioned on it — the aside was
// private while it happened, but it's part of the passage's context
// afterward. A confessional never joins `roundSoFar` at all: the member
// hears the room while thinking it through, the room never hears them. It
// goes only into the record — runRound's `recordSoFar`, returned as
// `fullRoundText` for display — and `historyText` (what convene.js pushes
// into `conversationHistory`) leaves it out, so a long confessional doesn't
// inflate every later passage's context and pull the room's turns longer.
//
// First-cut scope, per the 2026-09-21 comment on #579:
//   - director-proposed only, no reactive trigger — and no rng roll on top,
//     for the reason pipeline-splinter.js's header gives for
//     canOpenDirectorSplinter;
//   - gated on something concrete, not the director's say-so alone: the
//     member must already have spoken tonight (the thing they're carrying
//     has to have come from somewhere), plus the per-passage cap and budget
//     headroom below;
//   - no new visual grammar beyond a distinct card/bubble treatment — the
//     bracketed block reads correctly in every plain-text surface, same as
//     formatSplinterBlock's.
//
// Not yet evaluated against real sessions: no post-2026-09-15 sessions were
// available locally when this shipped, so whether the director reaches for
// it at a sensible rate, and whether the prose reads as the long form the
// issue asked for, is still open.

const { MAX_CONFESSIONALS_PER_PASSAGE, CONFESSIONAL_MIN_BUDGET_WORDS } = require('./tuning');

// Whether a director-proposed `memberId` (already validated against the
// present roster by pipeline-director.js's sanitizeConfessional) may open a
// confessional right now. `hasSpoken` is the caller's to compute — runRound
// holds both tonight's meeting ledger and this passage's own speaking order.
function canOpenConfessional({ memberId, hasSpoken, confessionalCount, remainingBudget }) {
  if (!memberId) return false;
  if (!hasSpoken) return false;
  if (confessionalCount >= MAX_CONFESSIONALS_PER_PASSAGE) return false;
  if (remainingBudget < CONFESSIONAL_MIN_BUDGET_WORDS) return false;
  return true;
}

// `roundSoFarText` is the main thread's roundSoFar — unlike a splinter, the
// confessing member does hear the room. What they say back doesn't reach it.
function buildConfessionalUserMessage({ speaker, roundSoFarText }) {
  const soFar = roundSoFarText?.trim() ? `\n\n--- THE ROOM SO FAR THIS PASSAGE ---\n${roundSoFarText.trim()}\n` : '';
  return `This is a confessional, not a turn at the table. You have stepped out of the room — a window seat, the corridor, a page of your own notebook — and no one else hears this. Nothing here is addressed to anyone present, and no one will answer it.

What the quick back-and-forth left no room for, you can take the long way round with here: work the thing through properly. Go to the texts — quote them, set one against another, follow the evidence where it leads, say where it runs out. Take the length the thinking needs and no more; this is not a speech, and there is no one to perform for.${soFar}
--- YOUR CONFESSIONAL ---
Generate ${speaker.name}'s confessional now.`;
}

// The record's rendering of a confessional — the same bracketed shape as
// formatSplinterBlock, so every plain-text surface (the reading room, the
// exports, parseWitnessBlocks on reload) can tell it apart from the main
// thread without a second transcript format.
function formatConfessionalBlock(member, text) {
  return `[Confessional — ${member.name}, apart from the room]\n${member.name}\n${text}\n[/Confessional]`;
}

module.exports = {
  canOpenConfessional,
  buildConfessionalUserMessage,
  formatConfessionalBlock,
};
