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
//
// #244 (per #194's migration sketch): a meeting is now a sequence of
// passages separated by lulls, not a preordained count of rounds. The old
// per-round instructions indexed by round number become a continuous "arc
// note" keyed to meeting progress instead — see arcNoteForProgress below.

// #194 touchpoint 2: the three-part arc (reactions -> unbound cross-talk ->
// embers) survives as *tendency*, not boundary. The old prose's explicit
// speaker-count hints ("3-5 members speak") are dropped here — pool sizing
// is handed to the director programmatically (minCount/maxCount), not
// threaded through instruction prose anymore.
const ARC_NOTES = {
  opening:
    "The room stirs. Initial reactions to whatever the material woke up — not every member need engage with the document directly; some may respond to the room's reaction to it before responding to it themselves. There is no author to address.",
  crosstalk:
    'The document recedes. The conversation follows what it raised. Members are now talking to each other about the actual question that has surfaced — disagreements crystallize, alliances form, citations come out, someone is irritated, someone is more interested than they wanted to be. References to the document are welcome but not required; the room is no longer obliged to it. Receipts may be deployed. Actions in asterisks.',
  embers:
    'The conversation has gone where it has gone. It may have left the document entirely. The room may be arriving somewhere, or it may not. Someone may say the thing that persists as an ember. Someone may push back hard at a point that has been allowed to stand too long. Someone may simply observe the fire.',
  extended:
    'A thread unresolved, a silence wanting breaking, a late arrival to the argument, a member who passed earlier returning with something they have just thought of.',
};

// Multiples of the breath budget (pipeline.js's BREATH_BUDGET_WORDS) at
// which the arc note advances to the next stage. Starting calibration, not
// tuned — due for review alongside the breath budget itself at the
// 2026-08-19 pacing follow-up, now folded into #244's combined
// passage-length/lull-cadence review.
const ARC_STAGE_BOUNDARIES = { crosstalk: 1, embers: 3, extended: 5 };

// Replaces DEFAULT_ROUND_INSTRUCTIONS[index] lookups: continuous instead of
// switched at round boundaries, keyed on words spent so far this meeting
// rather than a round counter that no longer exists.
function arcNoteForProgress({ wordsSpent = 0, breathBudget } = {}) {
  const budget = breathBudget || 1000;
  const ratio = wordsSpent / budget;
  if (ratio < ARC_STAGE_BOUNDARIES.crosstalk) return ARC_NOTES.opening;
  if (ratio < ARC_STAGE_BOUNDARIES.embers) return ARC_NOTES.crosstalk;
  if (ratio < ARC_STAGE_BOUNDARIES.extended) return ARC_NOTES.embers;
  return ARC_NOTES.extended;
}

// #194 touchpoint 2: SPEAKER_COUNTS/speakerCountForRound retire — pool
// sizing beyond the opening consult is already dynamic on re-consult
// (pipeline.js's selectSpeakers mid-passage re-ask). The opening consult of
// any passage just needs one flat default now, not a per-round taper.
const DEFAULT_POOL_SIZE = 5;
const INTERJECT_SPEAKER_COUNT = 3; // today's prose only ever suggested "2-3", never enforced — a new explicit assumption

// Replaces buildRoundPrompt. `isFirst` replaces the old `index === 0` check
// (the only place round position mattered structurally — the document-read
// preamble); the arc note itself is now progress-keyed instead of
// index-keyed. `meetingNote`, if the user supplied one, overrides the arc
// note entirely for the whole meeting — same override semantics the old
// per-round `instructions[index]` had, just collapsed from an array to one
// free-text field (#194 touchpoint 2).
function buildPassagePrompt({
  entry,
  meetingNote,
  isFirst = false,
  artifact = null,
  isTranscriptSource = false,
  roster = [],
  wordsSpent = 0,
  breathBudget,
}) {
  const instr = meetingNote?.trim() || arcNoteForProgress({ wordsSpent, breathBudget });
  if (isFirst) {
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

// #194 touchpoint 2: legacy sessions carry a `roundInstructions` array
// (indexed by round); continuing one joins it into a single note rather
// than migrating the field. "Not worth more cleverness than that" — the
// field was rarely used past session creation.
function deriveMeetingNote(session) {
  if (session?.meetingNote?.trim()) return session.meetingNote.trim();
  const legacy = session?.roundInstructions;
  if (Array.isArray(legacy) && legacy.length) {
    const joined = legacy
      .filter(Boolean)
      .map(s => s.trim())
      .filter(Boolean)
      .join(' ');
    return joined || null;
  }
  return null;
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
  return playerMode === 'member' && playerMemberId ? memberIds.filter(id => id !== playerMemberId) : memberIds;
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
  ARC_NOTES,
  ARC_STAGE_BOUNDARIES,
  arcNoteForProgress,
  DEFAULT_POOL_SIZE,
  INTERJECT_SPEAKER_COUNT,
  buildPassagePrompt,
  deriveMeetingNote,
  playerDirectorPool,
  resolvePlayerName,
  buildPrecedingTurn,
};
