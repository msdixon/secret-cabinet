'use strict';

// #193 seam-map, module 4 of 8 — round-shape and player-seat logic.
//
// The closest thing left to the original issue's "lodge/prompts module" now
// that #51's per-member architecture replaced buildSystemPrompt with
// pipeline.js's buildMemberSection + runRound. This module owns how a round
// prompt is framed and how a human player's seat is handled — logic the
// convene/round/interject routes all call identically. Roster and the
// stripInternalBlankLines helper are passed in explicitly rather than read
// from a module-level singleton, following roster.js's convention.

const DEFAULT_ROUND_INSTRUCTIONS = [
  'The room stirs. Write the first movement — initial reactions to whatever the material woke up. Not every member must engage with the document directly; some may respond to the room\'s reaction to it before responding to it themselves. 3-5 members speak. There is no author to address.',
  'The document recedes. The conversation follows what it raised. Members are now talking to each other about the actual question that has surfaced — disagreements crystallize, alliances form, citations come out, someone is irritated, someone is more interested than they wanted to be. References to the document are welcome but not required; the room is no longer obliged to it. 3-5 members speak. Receipts may be deployed. Actions in asterisks.',
  'The conversation has gone where it has gone. It may have left the document entirely. Final movement: the room arrives somewhere, or it doesn\'t. Someone may say the thing that persists as an ember. Someone may push back hard at a point that has been allowed to stand too long. Someone may simply observe the fire. 2-4 members. Let it end as it ends.',
];
const EXTRA_ROUND_INSTRUCTION = 'A thread unresolved, a silence wanting breaking, a late arrival to the argument, a member who passed earlier returning with something they have just thought of. 2-4 members speak.';

// The exact speaker count for a round is now a hard number handed to the
// director, not a range for it to interpret — these mirror the upper end of
// the prose guidance above (the prose itself is left as-is; it's now soft
// framing for the director's judgment about *who*, not an enforced count).
// #73 exposed round *count* to the user (session.roundCount, below); per-round
// speaker count remains this fixed default — still no user-facing control,
// deferred as a separate follow-up.
const SPEAKER_COUNTS = [5, 5, 4]; // rounds 1-3
const EXTRA_ROUND_SPEAKER_COUNT = 4;
const INTERJECT_SPEAKER_COUNT = 3; // today's prose only ever suggested "2-3", never enforced — a new explicit assumption

function speakerCountForRound(index) {
  return SPEAKER_COUNTS[index] || EXTRA_ROUND_SPEAKER_COUNT;
}

function buildRoundPrompt(index, entry, instructions, artifact = null, isTranscriptSource = false, roster = []) {
  const instr = instructions?.[index] || DEFAULT_ROUND_INSTRUCTIONS[index] || EXTRA_ROUND_INSTRUCTION;
  if (index === 0) {
    const artifactMember = artifact?.memberId ? roster.find(m => m.id === artifact.memberId) : null;
    const artifactHint = artifactMember
      ? `\n\n${artifactMember.name} has private context from before the meeting. They should speak in this round.`
      : '';
    const preamble = isTranscriptSource
      ? `A record has been passed around the table — minutes of a previous gathering, authorship uncertain, date unclear. The room considers it.\n\n"${entry}"`
      : `The document has just been read aloud:\n\n"${entry}"`;
    return `${preamble}\n\n${instr}${artifactHint}`;
  }
  return instr;
}

// ─── Player-as-member ─────────────────────────────────────────────────────────
// A human can write turns as one voice in the room instead of only observing.
// Mode 'member': the human stands in for an existing roster seat — that
// member is excluded from the AI director's selectable pool everywhere for
// the session (convene/round/interject), so the AI never also generates
// lines for the seat the human is voicing. Mode 'custom': a free-text
// identity, added as an *extra* voice — nothing is excluded, since it isn't
// standing in for a roster seat.

function playerDirectorPool(memberIds, playerMode, playerMemberId) {
  return (playerMode === 'member' && playerMemberId)
    ? memberIds.filter(id => id !== playerMemberId)
    : memberIds;
}

function resolvePlayerName(playerMode, playerMemberId, playerName, roster = []) {
  if (playerMode === 'member') return roster.find(m => m.id === playerMemberId)?.name || null;
  if (playerMode === 'custom') return playerName?.trim() || null;
  return null;
}

// Builds the { speakerName, text } object runRound expects, or null if no
// turn was submitted this round (the player passed, or isn't active).
function buildPrecedingTurn(speakerName, playerTurn, stripInternalBlankLines) {
  const text = playerTurn?.text?.trim();
  if (!speakerName || !text) return null;
  return { speakerName, text: stripInternalBlankLines(text) };
}

module.exports = {
  DEFAULT_ROUND_INSTRUCTIONS,
  EXTRA_ROUND_INSTRUCTION,
  SPEAKER_COUNTS,
  EXTRA_ROUND_SPEAKER_COUNT,
  INTERJECT_SPEAKER_COUNT,
  speakerCountForRound,
  buildRoundPrompt,
  playerDirectorPool,
  resolvePlayerName,
  buildPrecedingTurn,
};
