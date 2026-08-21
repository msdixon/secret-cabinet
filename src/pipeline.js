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

// #354: the record's shared vocabulary — non-roster speaker ids, segment
// kinds, the label-placement rule. Same dual Node/browser module convention
// and the same reason for it as beats.js above; see that file's own header.
const record = require('../public/js/record.js');

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
const POOL_SLACK = 1; // the director's candidate pool runs a little larger than the round's target speaker count

// #353: was 150 — a deliberately conservative placeholder that, worked
// backwards, sized every candidate pool (opening and mid-passage alike)
// larger than BREATH_BUDGET_WORDS could ever actually serve: a 7-seat pool
// (5 requested + POOL_SLACK 2) needs 14 beats to exhaust at
// MAX_TURNS_PER_POOL_MEMBER, but real passages run ~4.3. 220 is the same
// real-observed-turn-length figure test/pipeline.test.js's #352 simulation
// already uses (BREATH_BUDGET_WORDS / 220 ≈ the ~4.3 beats/passage the
// #353 issue measured) — sizing the pool against it, not the old
// placeholder, is what makes pool exhaustion reachable at all.
const WORDS_PER_BEAT_ESTIMATE = 220;

// #353: below this fraction of BREATH_BUDGET_WORDS spent since the last
// consult, don't bother the director again — 0.9 was chosen by simulating
// the real pickNextSpeaker/isPoolExhausted against realistic (varying, not
// fixed-length) beat lengths: it lands the mid-passage check-in inside the
// last tenth of a typical passage's budget, catching passages that run
// long without firing on every ordinary one (~29% of simulated passages;
// see test/pipeline.test.js's '#353' suite).
const RECONSULT_BUDGET_FRACTION = 0.9;
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
  loadRelationshipEdges,
  previousLullNote,
  meetingTurns: priorMeetingTurns,
}) {
  const presentMembers = ROSTER.filter(m => presentMemberIds.includes(m.id));
  const effectiveCount = Math.min(speakerCount, presentMembers.length);
  // #188: mutated in place through the round so a member picked twice in
  // one round (MAX_TURNS_PER_POOL_MEMBER) sees their own just-updated state
  // on the second turn, not the state from before the round started.
  const currentDisposition = { ...(priorDisposition || {}) };
  // #352: the meeting-level turn ledger the caller built from the saved
  // record (lodge-prompts.js's turnsSoFar), copied and then mutated in place
  // through the passage for the same reason as currentDisposition above —
  // "who has spoken tonight" has to include the beats *this* passage has
  // already spent, or the pool's second half would be judged against a
  // snapshot that stops at the passage boundary. Absent (the prototype
  // route, and every caller predating #352) it stays null all the way down,
  // and both consumers treat that as no signal rather than as all-zeros.
  const meetingTurns = priorMeetingTurns ? { ...priorMeetingTurns } : null;
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
  // #268: the full graph edge set doesn't vary by member or by beat, and
  // the room's present roster doesn't change mid-round — read it (at most)
  // once per round, same reasoning as exemplarCache above but with a single
  // cached value instead of one per member.
  let relationshipEdgesCache = null;
  let relationshipEdgesLoaded = false;
  const relationshipEdges = () => {
    if (!relationshipEdgesLoaded) {
      relationshipEdgesLoaded = true;
      try {
        relationshipEdgesCache = loadRelationshipEdges?.() || [];
      } catch (err) {
        // A malformed or unreadable graph must never cost a member their
        // turn — fall through to no assembled relationship data, same as a
        // pair the graph simply has no edges for.
        console.warn('[relationships]', '—', err.message);
        relationshipEdgesCache = [];
      }
    }
    return relationshipEdgesCache;
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
  // over stored sessions.
  //
  // #354: this is now the authoritative record of every turn that happened,
  // which is strictly more than roundSoFar holds. Three shapes:
  //
  //   { memberId, text }                        a turn that was spoken
  //   { memberId, speakerName, text }            ...by someone off-roster
  //   { memberId, text: '', failed: true, error} a turn that produced nothing
  //
  // A failed beat has no text and so contributes nothing to roundSoFar —
  // that asymmetry is the point. A member who was called on and produced
  // nothing used to be indistinguishable in the record from one who was
  // never called on at all, and from one who chose not to speak; a record
  // that says "they were called on and produced nothing" is honest, and
  // silence-by-omission is not. Consumers reading beats for prose must
  // therefore filter on `failed`, not assume every beat has text.
  //
  // `memberId` is a roster id, or one of record.js's non-roster sentinels
  // for a speaker who has no roster entry — never null. It used to be null
  // for the player's own turn, which left that turn attributable only by
  // display-name string match.
  const beatsList = [];
  if (precedingTurn) {
    const seed = `${precedingTurn.speakerName}\n${precedingTurn.text}`;
    onChunk?.(`${seed}\n\n`);
    // #115: worth a speaker-end signal so the live view renders this as a
    // proper attributed block instead of raw text. Still signalled with a
    // null memberId even though #354 now knows the real one: the stage
    // anchors a signalled memberId to that member's seat, and the player
    // speaking *as* a member is not the room's AI speaking — that's a
    // presentation call to make deliberately, not a side effect of fixing
    // the record. The record and the live signal disagree on purpose here.
    onSpeakerEnd?.(null, precedingTurn.speakerName, precedingTurn.text);
    roundSoFar = seed;
    beatsList.push({
      // #354: the roster id when the player plays a member, record.js's
      // PLAYER_SPEAKER_ID sentinel when they play under their own name.
      // The caller resolves which (see lodge-prompts' resolvePlayerSpeakerId);
      // the fallback keeps a caller that passes no id from reintroducing null.
      memberId: precedingTurn.memberId || record.PLAYER_SPEAKER_ID,
      speakerName: precedingTurn.speakerName,
      text: precedingTurn.text,
    });
  }

  // #353: was `effectiveCount + POOL_SLACK` alone — slack sized off the
  // round's requested speaker count with no reference to what the passage's
  // budget could actually serve, which is how the pool ended up
  // structurally larger than BREATH_BUDGET_WORDS could ever spend down. Cap
  // it at the budget's own realistic capacity (min(effectiveCount+slack,
  // capacity), floored at effectiveCount since selectSpeakers requires
  // maxCount >= minCount) — the same arithmetic the mid-passage re-consult
  // below already used, just applied to the opening consult too.
  const budgetCapacity = Math.max(1, Math.ceil(BREATH_BUDGET_WORDS / WORDS_PER_BEAT_ESTIMATE));
  const initialPoolTarget = Math.min(
    presentMembers.length,
    Math.max(effectiveCount, Math.min(effectiveCount + POOL_SLACK, budgetCapacity))
  );
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
    meetingTurns,
  });

  let pool = initialPool;
  let spokenCounts = new Map();
  let lastSpeakerId = null;
  let remainingBudget = BREATH_BUDGET_WORDS;
  // #353: replaces beatsSinceConsult. Words spent, not beats counted, since
  // a beat-count threshold has no way to track how much of the passage's
  // actual budget has gone by — see RECONSULT_BUDGET_FRACTION above for why
  // that mattered.
  let budgetAtLastConsult = remainingBudget;
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
    const budgetSpentSinceConsult = budgetAtLastConsult - remainingBudget;
    if (
      isPoolExhausted(pool, spokenCounts) ||
      budgetSpentSinceConsult >= BREATH_BUDGET_WORDS * RECONSULT_BUDGET_FRACTION
    ) {
      // Fresh director judgment: estimate how many more speakers the
      // remaining budget realistically holds, rather than re-asking for the
      // round's original count.
      const nextCount = Math.max(
        1,
        Math.min(presentMembers.length, Math.ceil(remainingBudget / WORDS_PER_BEAT_ESTIMATE))
      );
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
        meetingTurns,
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
      budgetAtLastConsult = remainingBudget;
      if (!pool.length) break;
    }

    const memberId = pickNextSpeaker({
      pool,
      spokenCounts,
      lastSpeakerId,
      remainingBudget,
      disposition: currentDisposition,
      meetingTurns,
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
      otherPresentMembers: presentMembers.filter(m => m.id !== memberId),
      relationshipEdges: relationshipEdges(),
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
      // #352: incremented here, on the success path beside the beat that
      // will actually be persisted — deliberately *not* alongside
      // spokenCounts below, which counts failed turns too. A turn that
      // produced no words is not one the room heard, and counting it here
      // would put the live ledger out of step with what turnsSoFar rebuilds
      // from `beats` on the next passage.
      if (meetingTurns) meetingTurns[memberId] = (meetingTurns[memberId] || 0) + 1;
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
      // #354: the round goes on with fewer voices, but the attempt is not
      // dropped from the record. No text (there is none — the call failed
      // after its retry), so roundSoFar and the transcript are unchanged and
      // the reader sees exactly what they saw before; the beat is what makes
      // "called on, produced nothing" recoverable afterwards.
      beatsList.push({ memberId, text: '', failed: true, error: err.message });
    }

    // Recorded whether the beat succeeded or failed — a failing member
    // still needs the recency/cap discount, or local picking would hammer
    // the same broken speaker until the round's beat safety net kicks in.
    spokenCounts.set(memberId, (spokenCounts.get(memberId) || 0) + 1);
    lastSpeakerId = memberId;
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
  POOL_SLACK,
  WORDS_PER_BEAT_ESTIMATE,
  RECONSULT_BUDGET_FRACTION,
};
