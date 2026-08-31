'use strict';

// #196 — splinter exchanges: two members trading a private aside while the
// main thread continues, the mechanic #196 named as structurally impossible
// under a single shared `roundSoFar` and cross-referenced against #194's
// rounds-vs-continuous-stream redesign as a reason to defer it. #194 has
// since shipped in full (#244/#245/#246), and its migration sketch
// explicitly reserved beat-level storage for this — "so #33's beat-level
// branching and #196's side conversations never force a later migration"
// (PROJECT.md) — which resolves the *storage* half of #196's blocker. It
// does not resolve the *generation* half: the reason every speaker call
// still shares one context isn't the passages-and-lulls shape, it's that
// runRound only ever builds one `roundSoFar` and hands it, unmodified, to
// every director/speaker/disposition call in the passage. This module is
// the generation-side fix — a splinter exchange is generated against its
// own private so-far text, not the shared one, and only folded back into
// the permanent record (and so into future context) once it resolves.
//
// First-cut scope, deliberately narrow:
//   - exactly two participants, exactly SPLINTER_EXCHANGE_BEATS (2) beats —
//     "two members trade a barbed aside," per the issue's own framing, not
//     an open-ended parallel thread;
//   - at most MAX_SPLINTERS_PER_PASSAGE (1) per passage — a horizon
//     mechanic proving itself against real sessions, not yet a structural
//     feature of every passage;
//   - triggered only off the existing #203 interrupt-intent signal
//     (disposition[memberId].waitingOnMemberId) — no new disposition
//     trigger and no director-initiated aside ("Crowley leans toward
//     Coleman-Smith," the issue's own example of a director-opened
//     splinter) — reusing the signal #188/#203 already built is the
//     minimal real version of "disposition state gives members reasons to
//     seek an aside"; a director-initiated trigger is a natural follow-up
//     once this shape is validated live, not part of this pass.
//
// Deliberately out of scope here too: the visual grammar the issue names
// (#184's stage / #257's portrait-anchored speech cards showing two
// portraits turning toward each other) — this ships the mechanic
// server-side and lets it read correctly in the existing plain-text
// transcript. formatSplinterBlock's bracketed rendering folds into
// `roundSoFar` exactly like any other beat text, so every surface that
// already renders `segment.text`/`transcriptText` (the reading room, the
// live SSE stream, Day One/Obsidian/Ulysses export) shows an aside
// correctly with no client change at all — a real visual treatment is a
// separately scoped follow-up, not a gap in this one.
//
// #458 adds the second trigger this file's own header named as deferred:
// the director opening a splinter directly ("Crowley leans toward
// Coleman-Smith") rather than only ever reinterpreting a live #203 signal.
// By the time this landed, both halves of #196's own validation condition
// were met — the reactive trigger above and its visual grammar (#457/PR
// #463) were each confirmed live against a real, organically-produced
// session (see that PR's own "Verified live" note). canOpenDirectorSplinter
// gates a director-proposed pairing with the *same* MAX_SPLINTERS_PER_PASSAGE
// cap and SPLINTER_MIN_BUDGET_WORDS headroom check as shouldSplinter above —
// one splinter budget per passage, shared across both trigger sources,
// deliberately not doubled just because there are now two ways in. It has
// no SPLINTER_CHANCE-equivalent rng roll: shouldSplinter needs one because
// the reactive path fires off a signal that exists for an unrelated reason
// (#203's interrupt-intent) and needs its own restraint layered on top; a
// director-proposed pairing is already the director's own considered
// judgment (the prompt itself asks for restraint — "leave it out almost
// every time"), so a second coin-flip on top of a deliberate choice would
// just make a rare proposal rarer for no legible reason.

const {
  MAX_SPLINTERS_PER_PASSAGE,
  SPLINTER_CHANCE,
  SPLINTER_MIN_BUDGET_WORDS,
} = require('./tuning');

// Whether the interrupt-intent pick pipeline.js's runRound just made
// resolves as a splinter instead of an ordinary front-of-room interruption.
// `interruptedMember` is the same signal pipeline-speaker.js's
// pickNextSpeaker already weighted toward (see INTERRUPT_INTENT_WEIGHT) —
// this never fires without it, so a splinter is always a *reinterpretation*
// of a real interrupt-intent pick, never a second, independent trigger.
//
// The exception, not the default: most interrupt-intent picks still resolve
// as the existing #203 path (speaking up in front of the room).
// SPLINTER_CHANCE keeps this the rarer alternative, the way the speaker
// prompt's own "it's fine to let it pass" already licenses declining even a
// real interrupt — a splinter has to earn the same restraint.
function shouldSplinter({ interruptedMember, remainingBudget, splinterCount, rng = Math.random }) {
  if (!interruptedMember) return false;
  if (splinterCount >= MAX_SPLINTERS_PER_PASSAGE) return false;
  if (remainingBudget < SPLINTER_MIN_BUDGET_WORDS) return false;
  return rng() < SPLINTER_CHANCE;
}

// #458: whether a director-proposed `pair` (already validated against the
// present roster by pipeline-director.js's sanitizeSplinterPair — this
// never re-checks membership) may open a splinter right now. Same shared
// cap and budget headroom as shouldSplinter, no rng roll — see this file's
// header for why the two trigger sources don't each need their own
// restraint layer.
function canOpenDirectorSplinter({ pair, splinterCount, remainingBudget }) {
  if (!pair) return false;
  if (splinterCount >= MAX_SPLINTERS_PER_PASSAGE) return false;
  if (remainingBudget < SPLINTER_MIN_BUDGET_WORDS) return false;
  return true;
}

// Frames the aside for whichever of the two members is about to speak.
// `priorText` is the splinter's own accumulated exchange so far — '' for
// the opening line, never the main thread's roundSoFar. That is the whole
// structural point of this module: the two participants are conditioned on
// their own private context, not on what everyone else in the room can
// hear. `triggeringText` — only meaningful on the opening line — is the
// just-spoken main-thread turn that gave the initiator something to answer
// privately instead of in front of the room.
function buildSplinterUserMessage({ speaker, other, priorText, triggeringText }) {
  const hasPriorText = !!priorText?.trim();
  const soFar = hasPriorText
    ? `\n\n--- BETWEEN YOU AND ${other.name.toUpperCase()}, SO FAR ---\n${priorText.trim()}\n`
    : '';
  const trigger =
    !hasPriorText && triggeringText?.trim()
      ? `\n\nWhat you're privately answering, unheard by the rest of the room:\n"${triggeringText.trim()}"`
      : '';
  return `You and ${other.name} have stepped a half-step apart from the table — near the sideboard, a lowered voice, whatever the room allows. The main conversation goes on without the two of you, and the rest of the room does not hear this exchange. Say only what passes between you and ${other.name} — nothing addressed to the room, nothing anyone else could overhear.${trigger}${soFar}

--- YOUR TURN ---
Generate ${speaker.name}'s side of this aside now.`;
}

// The permanent-record rendering of a resolved splinter — folded into
// `roundSoFar` (and so into future `conversationHistory`) as one bracketed
// block once the exchange concludes. Distinct enough that a reader, or a
// future passage's director/speaker call reading it back as history, can
// tell an aside from the main thread at a glance, without inventing a
// second transcript format alongside the room's existing one.
function formatSplinterBlock(initiator, other, beats) {
  const lines = beats.map(b => `${b.speakerName}\n${b.text}`).join('\n\n');
  return `[Aside — ${initiator.name} and ${other.name}, apart from the room]\n${lines}\n[/Aside]`;
}

module.exports = {
  shouldSplinter,
  canOpenDirectorSplinter,
  buildSplinterUserMessage,
  formatSplinterBlock,
};