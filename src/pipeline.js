'use strict';

// Per-member agent architecture (#51) — Stage 1: the director call.
//
// Express-agnostic by design: no req/res, no module-level ROSTER/client
// singletons. Everything is passed in as a parameter, so the same functions
// work in a standalone test script (Stages 1-2) and inside a live route
// (Stage 4), following the sibling-module pattern already used by dayone.js.

// #284: split along the seams #275 identified, into sibling pipeline-*.js
// modules — director selection, casting, the speaker turn, the disposition
// scratchpad, and lull notes — following the explicit-deps, no-logic-change
// convention #193 used on server.js. This file now holds only the
// orchestrator (runRound, which composes all five) and re-exports every
// module's surface flat, so this remains the one require() path for every
// existing caller (server.js, citations.js, test/pipeline.test.js) — a pure
// move, not an API change.

// #219: splitIntoBeats lives in public/js/beats.js, not here, because the
// browser needs it too (app.js live-streaming, witness.js replay) and
// public/ has no bundler — see that file's top-of-file comment. Required
// and re-exported here so it's tested the same way as this file's other
// pure functions (test/pipeline.test.js).
const { splitIntoBeats, BEAT_WORD_THRESHOLD } = require('../public/js/beats.js');

const core = require('./pipeline-core');
const director = require('./pipeline-director');
const casting = require('./pipeline-casting');
const speaker = require('./pipeline-speaker');
const disposition = require('./pipeline-disposition');
const lull = require('./pipeline-lull');

const { makeMetric, withOneRetry } = core;
const { selectSpeakers } = director;
const {
  pickNextSpeaker,
  isPoolExhausted,
  countWords,
  buildSpeakerSystemPrompt,
  buildSpeakerUserMessage,
  callSpeakerTurn,
  stripInternalBlankLines,
  mergeResidue,
} = speaker;
const { buildDispositionSystemPrompt, buildDispositionUserMessage, callDispositionUpdate } = disposition;
const { resolveLullNote } = lull;

// ── Orchestrator ──────────────────────────────────────────────────────────

// #164: total words a round budgeted for itself. #244 reframes it, per
// #194's migration sketch: not "the size of a round" any more (rounds are
// gone) but the breath budget per passage — how long the room goes between
// chances to draw breath. Same starting number, different meaning. Rachel's
// original calibration: "about the length of a writer's morning pages." A
// starting number, not a hard requirement — due for review against real
// sessions at the 2026-08-19 follow-up, now folded into a combined
// passage-length/lull-cadence calibration review (see #244).
const BREATH_BUDGET_WORDS = 1000;
const MIN_WORDS_FOR_ANOTHER_BEAT = 40; // below this, not enough room left for a meaningful beat
const POOL_SLACK = 2; // the director's candidate pool runs a little larger than the round's target speaker count
const MAX_TOTAL_BEATS = 16; // hard safety net — budget/pool logic should always end the round before this binds

// #244: a passage's stored `endedBy`. 'budget' — the breath budget ran out
// (including the MAX_TOTAL_BEATS safety net, which should never actually
// bind); 'lull' — the director explicitly judged the room winding down.
// 'closed' isn't produced here at all: it's the outcome of the user
// declining to continue *after* a lull, which #245's client-side "let it
// end" action will be what actually sets it — this phase just keeps the
// value out of runRound's own vocabulary so a future caller can't collide
// with it.
const PASSAGE_END_CAUSES = ['budget', 'lull', 'closed'];

// Ties the director and per-speaker calls together into one round. Returns
// { fullRoundText, speakerOrder } in the exact shape the caller already
// persists today (one rolled-up round of text) — this function is the only
// thing that changes about *how* that text gets generated. Also returns
// `residueUpdates` (#166) — a sparse map of only the members who wrote a
// new cross-session residue fragment this round, for the caller to persist.
//
// `roundSoFar` is local to this call only — it is never persisted on its
// own, only as the finished `fullRoundText`. Each per-speaker call still
// receives the same `conversationHistory` slice (prior rounds); roundSoFar
// is threaded separately via buildSpeakerUserMessage so a mid-round retry
// can't contaminate the across-round history.
//
// #164: speakers are no longer a fixed, director-ordered roster played
// straight through once each. The director proposes a candidate pool once
// (same API cost as before, absent a re-consult); after every beat,
// pickNextSpeaker() draws the next speaker from that pool locally — no API
// call — weighted by recency and length tendency, against a shrinking round
// word budget. The director is only re-consulted mid-round if the pool
// runs dry before the budget is spent, or the round has gone on long
// enough to want fresh judgment.
//
// Known accepted risk: onChunk forwards each speaker's text live as it
// streams. If a first attempt fails partway through (after some chunks
// already reached the client) and the retry succeeds, the live view during
// generation could show a garbled interleaving of the failed attempt's
// partial text and the successful retry's full text. The *stored* result
// is unaffected (each attempt's `text` is self-contained, not accumulated
// across attempts), and the client's existing finalize() flow re-renders
// from that authoritative stored text once the round completes — so this
// is a cosmetic, self-correcting glitch during live viewing only, not a
// data-integrity issue. Not solving for it now; revisit if it's ever
// actually visible in practice.
async function runRound({
  client,
  model,
  lodgeContext,
  ROSTER,
  loadMemberFile,
  presentMemberIds,
  artifact,
  notes,
  roundPrompt,
  conversationHistory,
  speakerCount,
  round,
  onChunk,
  onMetric,
  onSpeakerStart,
  onSpeakerEnd,
  precedingTurn,
  disposition: priorDisposition,
  loadVoiceExemplar,
  loadResidue,
  previousLullNote,
}) {
  const presentMembers = ROSTER.filter(m => presentMemberIds.includes(m.id));
  const effectiveCount = Math.min(speakerCount, presentMembers.length);
  // #188: mutated in place through the round so a member picked twice in
  // one round (MAX_TURNS_PER_POOL_MEMBER) sees their own just-updated state
  // on the second turn, not the state from before the round started.
  const currentDisposition = { ...(priorDisposition || {}) };
  // #187: the library doesn't change mid-round, and a member can take more
  // than one beat in a round — read each member's exemplar off disk once.
  const exemplarCache = new Map();
  const exemplarFor = memberId => {
    if (!exemplarCache.has(memberId)) {
      let entry = null;
      try {
        entry = loadVoiceExemplar?.(memberId) || null;
      } catch (err) {
        // A missing or malformed library entry must never cost a member
        // their turn — fall through to the no-exemplar path, same as a
        // member who simply has no entry.
        console.warn('[voice-exemplar]', memberId, '—', err.message);
      }
      exemplarCache.set(memberId, entry);
    }
    return exemplarCache.get(memberId);
  };

  // #166: like exemplarCache, but mutated in place through the round (same
  // reason as currentDisposition) — a member picked twice in one round
  // should see their own just-written residue fragment on the second turn,
  // not the stale on-disk value from before the round started.
  const residueCache = new Map();
  const residueFor = memberId => {
    if (!residueCache.has(memberId)) {
      let text = '';
      try {
        text = loadResidue?.(memberId) || '';
      } catch (err) {
        // A missing or malformed residue file must never cost a member
        // their turn — fall through to the no-residue path, same as a
        // member who simply hasn't accrued any yet.
        console.warn('[residue]', memberId, '—', err.message);
      }
      residueCache.set(memberId, text);
    }
    return residueCache.get(memberId);
  };
  // Only entries a member actually wrote to this round — most rounds this
  // stays empty (see buildDispositionToolSchema's residueNote: "most turns,
  // nothing belongs here"). The caller persists exactly what's here.
  const residueUpdates = {};

  // A human-written turn (player-as-member) seeded before the director
  // decides — streamed immediately so it appears in the live view before
  // the AI speakers even start, and folded into roundSoFar so every
  // subsequent speaker this round reacts to it exactly as they would react
  // to another AI speaker, via the same "THE ROUND SO FAR" mechanism.
  let roundSoFar = '';
  // #244: beats: [{memberId, text}] alongside the rolled-up roundSoFar —
  // persisted forward-provision for beat-level branching (#33 v2) and side
  // conversations (#196), so neither ever needs a second migration pass
  // over stored sessions. Mirrors roundSoFar's content exactly (only
  // successful, actually-spoken beats), including the player's own turn
  // below.
  const beatsList = [];
  if (precedingTurn) {
    const seed = `${precedingTurn.speakerName}\n${precedingTurn.text}`;
    onChunk?.(`${seed}\n\n`);
    // No memberId to offer here -- precedingTurn only ever carries a display
    // name (see server.js's buildPrecedingTurn), same as the final settled
    // parse today, which resolves the player's turn by name match rather
    // than a stored id. #115: still worth a speaker-end signal so the live
    // view renders it as a proper attributed block instead of raw text.
    onSpeakerEnd?.(null, precedingTurn.speakerName, precedingTurn.text);
    roundSoFar = seed;
    beatsList.push({ memberId: null, text: precedingTurn.text });
  }

  const initialPoolTarget = Math.min(presentMembers.length, effectiveCount + POOL_SLACK);
  const { speakers: initialPool } = await selectSpeakers({
    client,
    model,
    lodgeContext,
    presentMembers,
    instruction: roundPrompt,
    conversationHistory,
    minCount: effectiveCount,
    maxCount: initialPoolTarget,
    round,
    onMetric,
  });

  let pool = initialPool;
  let spokenCounts = new Map();
  let lastSpeakerId = null;
  let beatsSinceConsult = 0;
  let remainingBudget = BREATH_BUDGET_WORDS;
  let beats = 0;
  // #244: why the passage ended. Defaults to 'budget' — every exit from
  // this loop other than the director's explicit wind-down judgment below
  // (pool/budget exhaustion, the MAX_TOTAL_BEATS safety net, a dry
  // fallback) is some flavor of "ran out of room," so one default covers
  // them all without a switch per exit point.
  let endedBy = 'budget';
  let directorLullNote = null;

  const speakerOrder = [];

  while (remainingBudget >= MIN_WORDS_FOR_ANOTHER_BEAT && beats < MAX_TOTAL_BEATS) {
    if (isPoolExhausted(pool, spokenCounts) || beatsSinceConsult >= pool.length + 3) {
      // Fresh director judgment: estimate how many more speakers the
      // remaining budget realistically holds (a rough 150 words/beat
      // assumption), rather than re-asking for the round's original count.
      const nextCount = Math.max(1, Math.min(presentMembers.length, Math.ceil(remainingBudget / 150)));
      const nextPoolTarget = Math.min(presentMembers.length, nextCount + POOL_SLACK);
      const {
        speakers: freshPool,
        windingDown,
        lullNote,
      } = await selectSpeakers({
        client,
        model,
        lodgeContext,
        presentMembers,
        instruction: roundPrompt,
        conversationHistory,
        minCount: nextCount,
        maxCount: nextPoolTarget,
        round,
        onMetric,
        roundSoFar,
      });
      // #244: the exhaustion signal. The director judging the room itself
      // winding down ends the passage right here, before drawing from the
      // fresh pool it just proposed — a passage that stops mid-thought
      // reads worse than one that stops one beat early.
      if (windingDown) {
        endedBy = 'lull';
        directorLullNote = lullNote;
        break;
      }
      pool = freshPool;
      spokenCounts = new Map();
      beatsSinceConsult = 0;
      if (!pool.length) break;
    }

    const memberId = pickNextSpeaker({
      pool,
      spokenCounts,
      lastSpeakerId,
      remainingBudget,
      disposition: currentDisposition,
    });
    if (!memberId) break; // no viable candidate even after a fresh consult — end the round here

    const member = presentMembers.find(m => m.id === memberId);
    if (!member) break; // shouldn't happen — selectSpeakers validates against presentIds

    // #203: read before lastSpeakerId is reassigned below — true when this
    // pick's own disposition named the just-spoken member as unfinished
    // business, regardless of whether INTERRUPT_INTENT_WEIGHT is what
    // actually swung the roll. The framing is true either way: they did
    // want to answer that person, and that person did just speak.
    const interruptedMember =
      lastSpeakerId && currentDisposition[memberId]?.waitingOnMemberId === lastSpeakerId
        ? presentMembers.find(m => m.id === lastSpeakerId)
        : null;

    const unheardCount = pool.filter(id => id !== memberId && !(spokenCounts.get(id) > 0)).length;
    const voiceExemplar = exemplarFor(memberId);
    const residue = residueFor(memberId);
    const system = buildSpeakerSystemPrompt({
      lodgeContext,
      member,
      artifact,
      notes,
      loadMemberFile,
      disposition: currentDisposition[memberId],
      voiceExemplar,
      residue,
    });
    const userMessage = buildSpeakerUserMessage({
      roundPrompt,
      roundSoFarText: roundSoFar,
      member,
      remainingBudgetWords: remainingBudget,
      unheardCount,
      interruptingName: interruptedMember?.name || null,
    });

    onChunk?.(`${member.name}\n`);
    onSpeakerStart?.(memberId);
    try {
      const { result, attempts } = await withOneRetry(() =>
        callSpeakerTurn({ client, model, system, conversationHistory, userMessage, onChunk, lodgeContext })
      );
      onMetric?.(
        makeMetric('speaker', {
          round,
          memberId,
          attempts,
          usage: result.usage,
          latencyMs: result.latencyMs,
          voiceExemplar: voiceExemplar?.id,
        })
      );

      const contextBeforeTurn = roundSoFar;
      const settledText = stripInternalBlankLines(result.text);
      roundSoFar += (roundSoFar ? '\n\n' : '') + `${member.name}\n${settledText}`;
      speakerOrder.push(memberId);
      beatsList.push({ memberId, text: settledText });
      onSpeakerEnd?.(memberId, member.name, settledText);
      onChunk?.('\n\n');
      remainingBudget -= countWords(settledText);

      // #188: best-effort, isolated from the speaker try/catch above — a
      // disposition failure must not get reported as a failed speaker turn
      // that already succeeded and was already streamed to the client.
      try {
        const priorResidueText = residueFor(memberId);
        const dispositionSystem = buildDispositionSystemPrompt({
          member,
          priorDisposition: currentDisposition[memberId],
          presentMembers,
          priorResidue: priorResidueText,
        });
        const dispositionUserMessage = buildDispositionUserMessage({
          roundSoFarText: contextBeforeTurn || 'Nothing yet — you are the first to speak this round.',
          turnText: settledText,
          member,
        });
        const dispositionPresentIds = presentMembers.filter(m => m.id !== memberId).map(m => m.id);
        const {
          text: updatedDisposition,
          waitingOnMemberId,
          residueNote,
          usage: dUsage,
          latencyMs: dLatencyMs,
        } = await callDispositionUpdate({
          client,
          model,
          system: dispositionSystem,
          userMessage: dispositionUserMessage,
          presentIds: dispositionPresentIds,
        });
        if (updatedDisposition) currentDisposition[memberId] = { text: updatedDisposition, waitingOnMemberId };
        // #166: only when the beat actually earned a fragment — most beats
        // don't (see the tool schema's "most turns, nothing belongs here").
        if (residueNote) {
          const mergedResidue = mergeResidue(priorResidueText, residueNote);
          residueCache.set(memberId, mergedResidue);
          residueUpdates[memberId] = mergedResidue;
        }
        onMetric?.(
          makeMetric('disposition', {
            round,
            memberId,
            usage: dUsage,
            latencyMs: dLatencyMs,
            waitingOnMemberId,
            residueNote: residueNote || null,
          })
        );
      } catch (err) {
        onMetric?.(makeMetric('disposition', { round, memberId, skipped: true, error: err.message }));
        // Best-effort — the member simply carries their prior disposition forward.
      }
    } catch (err) {
      onMetric?.(
        makeMetric('speaker', {
          round,
          memberId,
          attempts: err.attempts || 1,
          skipped: true,
          error: err.message,
          voiceExemplar: voiceExemplar?.id,
        })
      );
      // Skip this speaker, keep the round going with fewer voices.
    }

    // Recorded whether the beat succeeded or failed — a failing member
    // still needs the recency/cap discount, or local picking would hammer
    // the same broken speaker until the round's beat safety net kicks in.
    spokenCounts.set(memberId, (spokenCounts.get(memberId) || 0) + 1);
    lastSpeakerId = memberId;
    beatsSinceConsult++;
    beats++;
  }

  if (!roundSoFar) {
    throw new Error('Every speaker failed this round — nothing to save.');
  }

  // #244: every passage-ending pause gets a diegetic label — the director's
  // own note when it judged the wind-down, a stock line otherwise (budget
  // exhaustion reaches the same lull from the user's side; it just wasn't
  // an authored moment).
  const lullNote = resolveLullNote(directorLullNote, undefined, previousLullNote);

  return {
    fullRoundText: roundSoFar,
    speakerOrder,
    disposition: currentDisposition,
    residueUpdates,
    beats: beatsList,
    endedBy,
    lullNote,
  };
}

module.exports = {
  ...core,
  ...director,
  ...casting,
  ...speaker,
  ...disposition,
  ...lull,
  splitIntoBeats,
  BEAT_WORD_THRESHOLD,
  runRound,
  BREATH_BUDGET_WORDS,
  PASSAGE_END_CAUSES,
};
