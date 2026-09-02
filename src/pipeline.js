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
const splinter = require('./pipeline-splinter');
const {
  BREATH_BUDGET_WORDS,
  MIN_WORDS_FOR_ANOTHER_BEAT,
  POOL_SLACK,
  WORDS_PER_BEAT_ESTIMATE,
  RECONSULT_BUDGET_FRACTION,
  MAX_TOTAL_BEATS,
  PASS_BUDGET_COST,
  PASS_TURN_CREDIT,
} = require('./tuning');

const { makeMetric, withOneRetry } = core;
const { selectSpeakers } = director;
const {
  pickNextSpeaker,
  isPoolExhausted,
  countWords,
  isPassTurn,
  buildSpeakerSystemPrompt,
  buildSpeakerUserMessage,
  callSpeakerTurn,
  stripInternalBlankLines,
  mergeResidue,
} = speaker;
const { buildDispositionSystemPrompt, buildDispositionUserMessage, callDispositionUpdate } = disposition;
const { resolveLullNote } = lull;
const { shouldSplinter, canOpenDirectorSplinter, buildSplinterUserMessage, formatSplinterBlock } = splinter;

// ── Orchestrator ──────────────────────────────────────────────────────────

// #364: BREATH_BUDGET_WORDS, MIN_WORDS_FOR_ANOTHER_BEAT, POOL_SLACK,
// WORDS_PER_BEAT_ESTIMATE, RECONSULT_BUDGET_FRACTION, and MAX_TOTAL_BEATS
// live in tuning.js, alongside the rest of the pacing constants (imported
// above) — see that file for values and rationale.

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
// #521: onChunk forwards each speaker's text live as it streams, and a
// retried attempt (withOneRetry, pipeline-core.js) reuses that same onChunk
// across both the failed first try and the successful retry — so the raw
// chunk stream itself still glues the abandoned attempt's partial text to
// the retry's full text with no gap. What used to be dismissed here as
// "cosmetic, self-correcting" wasn't: a real session left a member's turn
// stuck on a blinking cursor forever, because app.js's live buffer has no
// way to tell where one attempt ends and the next begins, and the client
// never re-renders from the authoritative settled text until the *round*
// finishes, not the turn. Fixed by re-firing onSpeakerStart before each
// retry attempt (below), not just once before the first — the client
// already treats a `speaking` event as "discard whatever I had and start
// fresh" (see app.js's onSpeaking and witness.js's liveTypingStart), so
// this reuses that existing reset instead of adding a new signal.
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
  onPoolUpdate,
  onDisposition,
  onCitation,
  precedingTurn,
  disposition: priorDisposition,
  loadVoiceExemplar,
  loadSecondaryVoiceExemplars,
  loadResidue,
  loadRelationshipEdges,
  loadLibraryCitationLookup,
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

  // #370 wave 2: a member's secondary (non-exemplar) authored entries — see
  // library.js's loadSecondaryVoiceExemplars — read once per round for the
  // same reason as exemplarCache above.
  const secondaryExemplarCache = new Map();
  const secondaryExemplarsFor = memberId => {
    if (!secondaryExemplarCache.has(memberId)) {
      let entries = [];
      try {
        entries = loadSecondaryVoiceExemplars?.(memberId) || [];
      } catch (err) {
        // Same failure mode as exemplarFor above: never cost a member their
        // turn over a malformed secondary entry — fall through to none.
        console.warn('[voice-exemplar-secondary]', memberId, '—', err.message);
      }
      secondaryExemplarCache.set(memberId, entries);
    }
    return secondaryExemplarCache.get(memberId);
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

  // #355: like relationshipEdgesCache above — the archival library doesn't
  // change mid-round, so it's read (at most) once and reused across every
  // beat's piggybacked citation extraction, rather than a fresh disk read
  // per beat. `list` is the short "id: title — source" form the disposition
  // prompt shows for matching; `ids` is what callDispositionUpdate validates
  // a returned libraryMatch against, same fail-closed pattern presentIds
  // already uses for waitingOnMemberId.
  let libraryContextCache = null;
  let libraryContextLoaded = false;
  const libraryContext = () => {
    if (!libraryContextLoaded) {
      libraryContextLoaded = true;
      try {
        const lookup = loadLibraryCitationLookup?.() || {};
        const ids = Object.keys(lookup);
        const list = ids.map(id => `${id}: ${lookup[id].title} — ${lookup[id].source}`).join('\n');
        libraryContextCache = { ids, list };
      } catch (err) {
        // A malformed or unreadable library must never cost a member their
        // turn — fall through to no library context, same as a deployment
        // with no library.json at all.
        console.warn('[citations]', '—', err.message);
        libraryContextCache = { ids: [], list: '' };
      }
    }
    return libraryContextCache;
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
  // which is strictly more than roundSoFar holds. Four shapes:
  //
  //   { memberId, text }                        a turn that was spoken
  //   { memberId, speakerName, text }            ...by someone off-roster
  //   { memberId, text, passed: true }           a turn the member declined
  //   { memberId, text: '', failed: true, error} a turn that produced nothing
  //   { memberId, speakerName, text,
  //     playerAuthored: true }                   a human's own submitted turn
  //
  // #453: `playerAuthored` marks the one beat per round that came from the
  // player's own submitted text rather than the model — set here, the same
  // place `memberId` is resolved to the real roster id when playing as a
  // member (lodge-prompts' resolvePlayerSpeakerId). Without it, a beat filed
  // under a member's real id is indistinguishable in the stored record from
  // that member's own words — a misquote or misattribution during play would
  // silently read back as if the figure had said it. The client's live/export
  // marking (applyPlayerTurnMarkers, buildAnnotatedTranscript) already tracks
  // this itself round-by-round as the player submits each turn; this field is
  // the same fact recorded structurally, so a consumer reading the session
  // record directly — not just live-tracked client state — can tell honestly
  // too (see export.js's getAnnotatedPassages). Omitted rather than `false`
  // on every other beat, same convention as `failed`/`passed` above.
  //
  // #355: a spoken beat may also carry `citations` — an array, present only
  // when the piggybacked disposition call (see the try block below) both
  // succeeded and actually found something to cite; omitted rather than an
  // empty array on the (common) turn that cited nothing, same convention as
  // `failed` only appearing on a beat that actually failed.
  //
  // A failed beat has no text and so contributes nothing to roundSoFar —
  // that asymmetry is the point. A member who was called on and produced
  // nothing used to be indistinguishable in the record from one who was
  // never called on at all, and from one who chose not to speak; a record
  // that says "they were called on and produced nothing" is honest, and
  // silence-by-omission is not. Consumers reading beats for prose must
  // therefore filter on `failed`, not assume every beat has text.
  //
  // #362: a passed beat is the third state that failure used to stand in
  // for — the member was called on, produced real text (the diegetic action
  // that is a pass, per pipeline-speaker.js's isPassTurn), and it does join
  // roundSoFar exactly like any other beat. `passed` only ever appears
  // alongside real text, never alongside `failed`; the two mark opposite
  // things (a genuine choice vs. a dropped call) and a beat is never both.
  //
  // `memberId` is a roster id, or one of record.js's non-roster sentinels
  // for a speaker who has no roster entry — never null. It used to be null
  // for the player's own turn, which left that turn attributable only by
  // display-name string match.
  //
  // #196: a spoken (or failed) beat may also carry `thread: { id,
  // participants }` — present only on the two beats that make up a splinter
  // exchange (see pipeline-splinter.js), absent on every ordinary
  // main-thread beat. `participants` is always the two members' roster ids,
  // in speaking order. A splinter's own beats are folded into `roundSoFar`
  // as one bracketed block (formatSplinterBlock) rather than one `\n\n`
  // append each, which is why they're recognizable in the record even
  // without the `thread` tag — but the tag is what lets a consumer identify
  // and single out a splinter's beats without re-parsing bracket syntax out
  // of prose.
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
      playerAuthored: true,
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
  const { speakers: initialPool, splinterPair: initialSplinterPair } = await selectSpeakers({
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
  // #360: the director's candidate pool, surfaced to the client so present
  // members not in it can read as "listening" rather than the generic
  // "occupied" — same information pickNextSpeaker already draws from below,
  // just also handed outward instead of only inward.
  onPoolUpdate?.(pool);
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
  // #196: how many splinter exchanges this passage has already run — gates
  // shouldSplinter's MAX_SPLINTERS_PER_PASSAGE, same spirit as spokenCounts
  // gating MAX_TURNS_PER_POOL_MEMBER above.
  let splinterCount = 0;
  // #196: the last thing said *in front of the room* — deliberately never
  // updated by a splinter's own text, since a splinter is by definition
  // unheard by everyone but its two participants. This is what a splinter's
  // opening line answers (see buildSplinterUserMessage's triggeringText),
  // kept separate from roundSoFar because roundSoFar does end up holding a
  // resolved splinter's bracketed block too, once it's folded in below.
  let lastMainBeatText = precedingTurn?.text || '';
  // #458: the director's own proposed pairing from the opening consult, if
  // any — consumed by tryDirectorSplinter below, right before the loop
  // starts, so it can resolve as the passage's opening move ("Crowley leans
  // toward Coleman-Smith," before anyone in the room has spoken) rather
  // than waiting for a reactive trigger that may never come.
  let pendingDirectorSplinterPair = initialSplinterPair || null;

  const speakerOrder = [];

  // Generates one beat — a member's speaker turn plus its piggybacked
  // disposition update — with the same bookkeeping (metrics, beatsList,
  // meetingTurns, spokenCounts/lastSpeakerId, beats, remainingBudget)
  // regardless of whether it's an ordinary main-thread beat or one half of
  // a #196 splinter exchange. The two paths differ only in which
  // userMessage and dispositionContext they hand this — never in how a
  // beat gets recorded once it happens. `dispositionContext` is what "just
  // happened in the room" means for this beat's own private reflection —
  // the main thread's roundSoFar for an ordinary beat, the splinter's own
  // private exchange for a splinter beat (see pipeline-splinter.js's header
  // for why those must differ). `thread`, when given, is stamped onto the
  // pushed beat verbatim — see the beatsList comment above for its shape.
  async function generateBeat({ memberId, member, userMessage, dispositionContext, thread }) {
    const voiceExemplar = exemplarFor(memberId);
    const secondaryVoiceExemplars = secondaryExemplarsFor(memberId);
    const residue = residueFor(memberId);
    const system = buildSpeakerSystemPrompt({
      lodgeContext,
      member,
      artifact,
      notes,
      loadMemberFile,
      disposition: currentDisposition[memberId],
      voiceExemplar,
      secondaryVoiceExemplars,
      residue,
      otherPresentMembers: presentMembers.filter(m => m.id !== memberId),
      relationshipEdges: relationshipEdges(),
    });

    onChunk?.(`${member.name}\n`);
    onSpeakerStart?.(memberId);
    let outcome;
    try {
      // #521: withOneRetry calls this closure up to twice for one beat. The
      // first call is the attempt onSpeakerStart above already announced;
      // any call after that is a retry starting fresh after a mid-stream
      // failure, so it re-fires onSpeakerStart to tell the client to discard
      // whatever the abandoned attempt already streamed before this
      // attempt's own chunks start arriving on the same onChunk callback.
      let attemptNumber = 0;
      const { result, attempts } = await withOneRetry(() => {
        attemptNumber++;
        if (attemptNumber > 1) onSpeakerStart?.(memberId);
        return callSpeakerTurn({ client, model, system, conversationHistory, userMessage, onChunk, lodgeContext });
      });
      const settledText = stripInternalBlankLines(result.text);
      // #362: a pass is still a real, successful call — it just declined the
      // turn via the room's own action-only idiom (see isPassTurn). Detected
      // post-hoc on the settled text rather than as a separate response
      // shape, so it costs nothing extra to check and can't diverge from
      // what the transcript actually shows.
      const passed = isPassTurn(settledText);
      onMetric?.(
        makeMetric('speaker', {
          round,
          memberId,
          attempts,
          usage: result.usage,
          latencyMs: result.latencyMs,
          voiceExemplar: voiceExemplar?.id,
          voiceExemplarSecondary: secondaryVoiceExemplars?.map(e => e.id),
          ...(passed ? { passed: true } : {}),
        })
      );

      // #355: kept as a live reference so the disposition try block below
      // can attach `citations` onto this same beat once its piggybacked
      // call resolves, rather than a second pass over beatsList to find it.
      const beatEntry = {
        memberId,
        text: settledText,
        ...(passed ? { passed: true } : {}),
        ...(thread ? { thread } : {}),
      };
      beatsList.push(beatEntry);
      // #352: incremented here, on the success path beside the beat that
      // will actually be persisted — deliberately *not* alongside
      // spokenCounts below, which counts failed turns too. A turn that
      // produced no words is not one the room heard, and counting it here
      // would put the live ledger out of step with what turnsSoFar rebuilds
      // from `beats` on the next passage.
      //
      // #362: a passed beat earns partial credit, not full — the member was
      // called on (so this isn't "never heard from"), but nothing was
      // actually said (so it isn't "heard from" either). See tuning.js's
      // PASS_TURN_CREDIT for the reasoning.
      if (meetingTurns) meetingTurns[memberId] = (meetingTurns[memberId] || 0) + (passed ? PASS_TURN_CREDIT : 1);
      // #457: the 4th arg is undefined on every ordinary beat, `thread` only
      // for the two beats a splinter's own generateBeat calls pass it into —
      // same optional shape beatEntry above already carries. This is the
      // live half of the signal #456 shipped storage-only for; onSpeakerStart
      // deliberately isn't extended the same way (see convene.js's own note
      // at its onSpeakerEnd wiring) — a splinter beat generation-split across
      // more than one on-screen bubble won't tag every bubble, a named limit.
      onSpeakerEnd?.(memberId, member.name, settledText, thread);
      onChunk?.('\n\n');
      // #362: a pass's own word count is a few at most — charging only that
      // would let passing hand the round's remaining budget to whoever
      // speaks next as if the beat had never happened. Floored at
      // PASS_BUDGET_COST so a pass still spends what the smallest real beat
      // would have.
      remainingBudget -= passed ? Math.max(countWords(settledText), PASS_BUDGET_COST) : countWords(settledText);

      // #188: best-effort, isolated from the speaker try/catch above — a
      // disposition failure must not get reported as a failed speaker turn
      // that already succeeded and was already streamed to the client.
      try {
        const priorResidueText = residueFor(memberId);
        const { list: libraryList, ids: libraryIds } = libraryContext();
        const dispositionSystem = buildDispositionSystemPrompt({
          member,
          priorDisposition: currentDisposition[memberId],
          presentMembers,
          priorResidue: priorResidueText,
          libraryList,
        });
        const dispositionUserMessage = buildDispositionUserMessage({
          roundSoFarText: dispositionContext || 'Nothing yet — you are the first to speak this round.',
          turnText: settledText,
          member,
        });
        const dispositionPresentIds = presentMembers.filter(m => m.id !== memberId).map(m => m.id);
        const {
          text: updatedDisposition,
          waitingOnMemberId,
          residueNote,
          citations,
          invokedWorks,
          reaction,
          usage: dUsage,
          latencyMs: dLatencyMs,
        } = await callDispositionUpdate({
          client,
          model,
          system: dispositionSystem,
          userMessage: dispositionUserMessage,
          presentIds: dispositionPresentIds,
          libraryIds,
        });
        if (updatedDisposition) {
          currentDisposition[memberId] = { text: updatedDisposition, waitingOnMemberId, reaction };
          // #360/#451: surfaces the same waitingOnMemberId pickNextSpeaker
          // already reads (#203), plus #449's reaction tag — a member who
          // wants to jump back in reads as "waiting", and their reaction
          // sticks the same way, until their disposition next changes.
          onDisposition?.(memberId, waitingOnMemberId, reaction);
        }
        // #166: only when the beat actually earned a fragment — most beats
        // don't (see the tool schema's "most turns, nothing belongs here").
        if (residueNote) {
          const mergedResidue = mergeResidue(priorResidueText, residueNote);
          residueCache.set(memberId, mergedResidue);
          residueUpdates[memberId] = mergedResidue;
        }
        // #355: attached onto the same beat pushed above, omitted entirely
        // when the turn cited nothing — see the beats-shape comment.
        if (citations.length) beatEntry.citations = citations;
        // #34 follow-up: a live signal for the client, fired only when this
        // beat actually cited something — scene.js decides for itself
        // whether any of these quote the active provocation document (most
        // citations are of an external real work and won't), this just
        // carries the raw citations array over.
        if (citations.length) onCitation?.(memberId, citations);
        // #356: same convention, for the weaker invoked-works tier.
        if (invokedWorks.length) beatEntry.invokedWorks = invokedWorks;
        onMetric?.(
          makeMetric('disposition', {
            round,
            memberId,
            usage: dUsage,
            latencyMs: dLatencyMs,
            waitingOnMemberId,
            residueNote: residueNote || null,
            citationCount: citations.length,
            invokedCount: invokedWorks.length,
          })
        );
      } catch (err) {
        onMetric?.(makeMetric('disposition', { round, memberId, skipped: true, error: err.message }));
        // Best-effort — the member simply carries their prior disposition forward.
      }
      outcome = { failed: false, text: settledText };
    } catch (err) {
      onMetric?.(
        makeMetric('speaker', {
          round,
          memberId,
          attempts: err.attempts || 1,
          skipped: true,
          error: err.message,
          voiceExemplar: voiceExemplar?.id,
          voiceExemplarSecondary: secondaryVoiceExemplars?.map(e => e.id),
        })
      );
      // #354: the round goes on with fewer voices, but the attempt is not
      // dropped from the record. No text (there is none — the call failed
      // after its retry), so roundSoFar and the transcript are unchanged and
      // the reader sees exactly what they saw before; the beat is what makes
      // "called on, produced nothing" recoverable afterwards.
      beatsList.push({ memberId, text: '', failed: true, error: err.message, ...(thread ? { thread } : {}) });
      outcome = { failed: true };
    }

    // Recorded whether the beat succeeded or failed — a failing member
    // still needs the recency/cap discount, or local picking would hammer
    // the same broken speaker until the round's beat safety net kicks in.
    spokenCounts.set(memberId, (spokenCounts.get(memberId) || 0) + 1);
    lastSpeakerId = memberId;
    beats++;
    return outcome;
  }

  // Runs a full splinter exchange between `initiator` and `other` — the
  // opening line, then (if it landed) the reply — and folds it into
  // roundSoFar/speakerOrder/splinterCount if it produced any text at all.
  // Shared by both trigger sources: the reactive #203 interrupt-intent
  // resolution below, and #458's director-initiated pairing via
  // tryDirectorSplinter. Neither trigger differs in how a splinter actually
  // plays out once it's decided to happen — only in how that decision gets
  // made — so this is the one place either path ends up.
  async function runSplinterExchange({ initiator, other, triggeringText }) {
    const thread = { id: `splinter-${round}-${splinterCount}`, participants: [initiator.id, other.id] };

    const opening = await generateBeat({
      memberId: initiator.id,
      member: initiator,
      userMessage: buildSplinterUserMessage({ speaker: initiator, other, priorText: '', triggeringText }),
      dispositionContext: '',
      thread,
    });

    const splinterBeats = [];
    if (!opening.failed) {
      splinterBeats.push({ speakerName: initiator.name, text: opening.text });

      const priorText = `${initiator.name}\n${opening.text}`;
      const reply = await generateBeat({
        memberId: other.id,
        member: other,
        userMessage: buildSplinterUserMessage({ speaker: other, other: initiator, priorText, triggeringText: null }),
        dispositionContext: priorText,
        thread,
      });
      if (!reply.failed) splinterBeats.push({ speakerName: other.name, text: reply.text });
    }

    // A splinter that produced no text (the opening beat itself failed)
    // contributes nothing to roundSoFar, same as any other failed beat —
    // but the failed attempt is still in beatsList via generateBeat, and
    // spokenCounts/lastSpeakerId/beats were still updated, so the loop
    // doesn't retry the same broken speaker indefinitely.
    if (splinterBeats.length) {
      roundSoFar += (roundSoFar ? '\n\n' : '') + formatSplinterBlock(initiator, other, splinterBeats);
      speakerOrder.push(initiator.id, ...(splinterBeats.length > 1 ? [other.id] : []));
      splinterCount++;
    }
  }

  // #458: attempts a director-proposed `pair` (already sanitized to two
  // distinct present ids by pipeline-director.js, or null if none was
  // proposed) and consumes it either way — a proposal that didn't have room
  // this consult isn't retried later off a stale judgment. Called once
  // before the loop starts (the opening consult, so a director-initiated
  // splinter can be the passage's opening move — "Crowley leans toward
  // Coleman-Smith," before anyone has spoken, per the issue's own framing)
  // and once after every mid-passage re-consult inside the loop, so both
  // kinds of consult can open one uniformly.
  async function tryDirectorSplinter(pair) {
    if (!canOpenDirectorSplinter({ pair, splinterCount, remainingBudget })) return;
    const [aId, bId] = pair;
    const a = presentMembers.find(m => m.id === aId);
    const b = presentMembers.find(m => m.id === bId);
    if (!a || !b) return; // shouldn't happen — sanitizeSplinterPair validates against presentIds
    await runSplinterExchange({ initiator: a, other: b, triggeringText: lastMainBeatText });
  }

  await tryDirectorSplinter(pendingDirectorSplinterPair);

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
        splinterPair,
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
      // reads worse than one that stops one beat early. #458: also why this
      // is checked before tryDirectorSplinter below — a winding-down room
      // isn't a room the director is about to open a fresh private aside in.
      if (windingDown) {
        endedBy = 'lull';
        directorLullNote = lullNote;
        break;
      }
      pool = freshPool;
      onPoolUpdate?.(pool);
      spokenCounts = new Map();
      budgetAtLastConsult = remainingBudget;
      if (!pool.length) break;
      await tryDirectorSplinter(splinterPair);
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

    // #196: a splinter is the other resolution of the same interrupt-intent
    // signal INTERRUPT_INTENT_WEIGHT already biased pickNextSpeaker toward —
    // see pipeline-splinter.js's header. Only ever considered when that
    // signal is live; never a second, independent trigger. (#458 adds a
    // genuinely second, director-initiated trigger — see tryDirectorSplinter
    // above — but it resolves at consult points, not here.)
    if (interruptedMember && shouldSplinter({ interruptedMember, remainingBudget, splinterCount })) {
      await runSplinterExchange({ initiator: member, other: interruptedMember, triggeringText: lastMainBeatText });
      continue;
    }

    const unheardCount = pool.filter(id => id !== memberId && !(spokenCounts.get(id) > 0)).length;
    const userMessage = buildSpeakerUserMessage({
      roundPrompt,
      roundSoFarText: roundSoFar,
      member,
      remainingBudgetWords: remainingBudget,
      unheardCount,
      interruptingName: interruptedMember?.name || null,
    });

    const result = await generateBeat({ memberId, member, userMessage, dispositionContext: roundSoFar, thread: null });
    if (!result.failed) {
      roundSoFar += (roundSoFar ? '\n\n' : '') + `${member.name}\n${result.text}`;
      speakerOrder.push(memberId);
      lastMainBeatText = result.text;
    }
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
  ...splinter,
  splitIntoBeats,
  BEAT_WORD_THRESHOLD,
  runRound,
  BREATH_BUDGET_WORDS,
  PASSAGE_END_CAUSES,
  POOL_SLACK,
  WORDS_PER_BEAT_ESTIMATE,
  RECONSULT_BUDGET_FRACTION,
};
