'use strict';

// #284 seam-map, module 2 of 6 — director selection.

const { makeMetric, buildCachedSystem, withHistoryCacheControl } = require('./pipeline-core');

// #164: the director no longer casts an exact, ordered roster for the whole
// round. It proposes a candidate POOL — between minCount and maxCount present
// members, ordered by priority — that the local hybrid selector (see
// pickNextSpeaker below) draws from beat by beat. This keeps the director's
// per-round API cost the same (still one call, absent a mid-round
// re-consult) while letting who-actually-speaks-next respond to pacing that
// only exists once the round is underway.
function buildDirectorToolSchema(presentIds, minCount, maxCount) {
  return {
    name: 'select_speakers',
    description: 'Choose a candidate pool of present lodge members who may speak this round, ordered by priority.',
    input_schema: {
      type: 'object',
      properties: {
        speakers: {
          type: 'array',
          items: { type: 'string', enum: presentIds },
          minItems: minCount,
          maxItems: maxCount,
          uniqueItems: true,
          description: `Member ids, in priority order, drawn only from the present roster: ${presentIds.join(', ')}.`,
        },
        reasoning: {
          type: 'string',
          description: 'Brief internal rationale for this pool — not shown to users, for review/logging only.',
        },
        // #244: the exhaustion signal. A judgment about the whole evening,
        // not just this pool — separate from whether the caller ends up
        // acting on it (only the mid-passage re-consult path in runRound
        // does, today).
        windingDown: {
          type: 'boolean',
          description:
            'Whether the room itself — the whole evening, not just this pool — is winding down: energy ebbing, threads settling, no one straining to speak. Usually false.',
        },
        lullNote: {
          type: 'string',
          description:
            'Optional. If windingDown is true, one diegetic line marking the pause, in the room\'s register — an image or a small action, not a summary. E.g. "The fire settles; Yeats refills his glass." Leave out if nothing concrete comes to mind, or if windingDown is false.',
        },
        // #458: the director opening a splinter directly, independent of
        // whatever either member currently carries privately — a second,
        // proactive trigger alongside the reactive #203-signal one
        // pipeline-splinter.js's shouldSplinter already covers. Optional and
        // rare by design; see the description below and buildDirectorPrompt's
        // matching paragraph for the restraint this asks for.
        splinterPair: {
          type: 'array',
          items: { type: 'string', enum: presentIds },
          minItems: 2,
          maxItems: 2,
          description:
            'Optional. Two present member ids you are opening a private aside between right now, apart from the room — "Crowley leans toward Coleman-Smith" as an opening move, not a reaction to anything either has said. Leave out almost every time; this is a rare directorial choice, not a per-passage default.',
        },
      },
      required: ['speakers', 'reasoning', 'windingDown'],
    },
  };
}

// #458: sanitizes the director's optional splinterPair proposal. Unlike
// `speakers`, an invalid value here isn't worth a corrective retry — this is
// a rare bonus judgment, not the call's core question — so a malformed
// shape (wrong length, the same id twice, an id outside the present roster)
// is simply dropped rather than corrected. `presentIds` is redundant with
// the schema's own per-item enum in practice, but kept as a real check
// rather than trusting the model's tool call was actually schema-valid.
function sanitizeSplinterPair(pair, presentIds) {
  if (!Array.isArray(pair) || pair.length !== 2) return null;
  const [a, b] = pair;
  if (a === b) return null;
  if (!presentIds.includes(a) || !presentIds.includes(b)) return null;
  return [a, b];
}

// #352: the director's prompt has always asked it to weigh "who hasn't been
// heard from," and until now handed it nothing to answer with — on a
// mid-passage re-consult, `roundSoFar` plus `conversationHistory.slice(-6)`,
// three passages of raw prose to infer from; on a passage's opening consult,
// not even that. This states it outright instead.
//
// Omitted entirely when the ledger is empty — the meeting's very first
// consult, or a session predating #244's `beats` — where a column of zeros
// would read as a claim that nobody has spoken rather than as an absence of
// data.
function buildTurnLedgerBlock(presentMembers, meetingTurns) {
  if (!meetingTurns) return '';
  const counted = presentMembers.map(m => ({ name: m.name, turns: meetingTurns[m.id] || 0 }));
  if (!counted.some(c => c.turns > 0)) return '';

  const lines = counted
    .map(c => `- ${c.name}: ${c.turns === 0 ? 'not once' : `${c.turns} turn${c.turns === 1 ? '' : 's'}`}`)
    .join('\n');
  const silent = counted.filter(c => c.turns === 0).map(c => c.name);
  const silentLine = silent.length
    ? `\n\n${silent.length === 1 ? `${silent[0]} has` : `${silent.slice(0, -1).join(', ')} and ${silent[silent.length - 1]} have`} not spoken at all tonight. That is not automatically wrong — a member may be listening on purpose, and the room is not a rota — but by now it should be a choice you are making, not an accident of who kept getting the floor.`
    : '';

  return `\n\nTURNS TAKEN TONIGHT (the whole meeting so far, not only this passage):\n${lines}${silentLine}`;
}

function buildDirectorPrompt({
  lodgeContext,
  presentMembers,
  instruction,
  minCount,
  maxCount,
  roundSoFar,
  meetingTurns,
}) {
  const rosterLines = presentMembers.map(m => `- ${m.name}`).join('\n');
  const turnLedgerBlock = buildTurnLedgerBlock(presentMembers, meetingTurns);

  const soFarBlock = roundSoFar?.trim()
    ? `\n\nTHE ROUND SO FAR:\n${roundSoFar.trim()}\n\nYou are being asked again mid-round — the earlier candidate pool ran dry, or the round has gone on long enough to want fresh judgment. Choose the next pool considering what's already happened above: who hasn't been heard from, who has something left to react to, whether the room needs a new voice or more from someone already in it.`
    : '';

  const system = `${lodgeContext}

---

## YOUR ROLE RIGHT NOW

You are not writing dialogue. You are proposing a candidate pool of who might speak next in this round of the salon — a shortlist and rough priority order, not a fixed cast or an exact script. You will not write any of their words.

PRESENT TONIGHT:
${rosterLines}${turnLedgerBlock}

THIS ROUND'S INSTRUCTION:
${instruction}${soFarBlock}

Choose between ${minCount} and ${maxCount} of the present members as this round's candidate pool, ordered by priority. Not everyone in the pool is guaranteed to speak, and someone in the pool may end up speaking more than once — the room decides who actually goes, beat by beat, from among them. Base the pool on who has something to react to, who hasn't been heard from, and what this round's instruction calls for — not on alphabetical or arbitrary order.

Separately — and this is a judgment about the whole evening, not just this pool — say whether the room is winding down: energy ebbing, threads settling, no one straining to speak. This is usually false; most consults, the room still has more in it. If it is genuinely true, you may also write one diegetic line marking the pause — an image or a small action in the room's register, not a summary of what just happened.

Separately again: you may name a splinterPair — two present members you are opening a private aside between right now, apart from the room, independent of anything either has said or currently carries. This is the rare exception, not a per-passage habit — leave it out almost every time. Reach for it only when a pairing would read as genuinely alive right now: who they evidently are to each other, not a habit of pairing off whoever is present. It can be the opening move of the passage, before anyone has spoken at all.`;

  const userMessage = "Choose this round's candidate pool.";

  return { system, userMessage };
}

// `tool` defaults to the per-round director's own schema; the pre-convene
// casting call (#185) passes its own so the two questions stay legible in
// the transcript of what was actually asked.
async function callDirector({
  client,
  model,
  system,
  conversationHistory,
  userMessage,
  presentIds,
  minCount,
  maxCount,
  tool,
  lodgeContext,
}) {
  const schema = tool || buildDirectorToolSchema(presentIds, minCount, maxCount);
  const start = Date.now();
  const messages = [...withHistoryCacheControl(conversationHistory), { role: 'user', content: userMessage }];
  const response = await client.messages.create({
    model,
    max_tokens: 500,
    // #406: adaptive thinking (on by default for claude-sonnet-5 when
    // `thinking` is omitted) needs headroom this call's 500-token budget
    // doesn't have to spare.
    thinking: { type: 'disabled' },
    system: buildCachedSystem(system, lodgeContext),
    messages,
    tools: [schema],
    tool_choice: { type: 'tool', name: schema.name },
  });
  const latencyMs = Date.now() - start;
  const block = response.content.find(b => b.type === 'tool_use');
  // windingDown/lullNote/splinterPair are absent from the casting tool's
  // schema (a different question, see buildCastingToolSchema) — undefined
  // there degrades to false/null/null below, which proposeCast simply never
  // reads.
  const { speakers, reasoning, windingDown, lullNote, splinterPair } = block?.input || {};
  return {
    speakers,
    reasoning,
    windingDown: !!windingDown,
    lullNote: lullNote || null,
    // #458: sanitized here, once, against this call's own present-roster
    // enum — every caller downstream (runDirectorSelection, selectSpeakers,
    // runRound) can treat a non-null splinterPair as already valid.
    splinterPair: sanitizeSplinterPair(splinterPair, presentIds),
    usage: response.usage,
    latencyMs,
  };
}

function isValidSelection(speakers, presentIds, minCount, maxCount) {
  return (
    Array.isArray(speakers) &&
    speakers.length >= minCount &&
    speakers.length <= maxCount &&
    new Set(speakers).size === speakers.length &&
    speakers.every(id => presentIds.includes(id))
  );
}

// Retry-once + deterministic-fallback loop, shared by the per-round director
// (selectSpeakers) and the pre-convene casting call (proposeCast, #185).
// Both ask the same *shape* of question — pick between minCount and maxCount
// ids out of a fixed enum, with a rationale — so both want the same failure
// handling: one corrective retry, then a deterministic fallback, so no caller
// is ever left without a usable answer because a model call went sideways.
async function runDirectorSelection({
  client,
  model,
  system,
  userMessage,
  conversationHistory = [],
  candidateIds,
  minCount,
  maxCount,
  tool,
  phase = 'director',
  round = null,
  onMetric,
  invalidNote,
  fallbackIds,
  fallbackNote,
  lodgeContext,
}) {
  const correction =
    invalidNote ||
    ` Your previous selection was invalid — it must be between ${minCount} and ${maxCount} present member ids, no duplicates, drawn only from: ${candidateIds.join(', ')}. Choose again.`;

  let lastReasoning = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { speakers, reasoning, windingDown, lullNote, splinterPair, usage, latencyMs } = await callDirector({
        client,
        model,
        system,
        conversationHistory,
        userMessage: userMessage + (attempt === 2 ? correction : ''),
        presentIds: candidateIds,
        minCount,
        maxCount,
        tool,
        lodgeContext,
      });
      lastReasoning = reasoning || lastReasoning;
      onMetric?.(makeMetric(phase, { round, attempts: attempt, usage, latencyMs, reasoning }));
      if (isValidSelection(speakers, candidateIds, minCount, maxCount)) {
        return {
          speakers,
          reasoning,
          windingDown,
          lullNote,
          splinterPair,
          source: attempt === 1 ? 'director' : 'director-retry',
        };
      }
    } catch (err) {
      onMetric?.(makeMetric(phase, { round, attempts: attempt, error: err.message }));
    }
  }

  onMetric?.(makeMetric(phase, { round, attempts: 2, skipped: true, error: fallbackNote, reasoning: lastReasoning }));
  // A director failure must never quietly read as an intentional lull —
  // the fallback always reports the room as not winding down, and never
  // proposes a splinter (#458): a deterministic fallback pool is not the
  // director exercising judgment, so it gets no discretionary calls at all.
  return {
    speakers: fallbackIds,
    reasoning: lastReasoning,
    windingDown: false,
    lullNote: null,
    splinterPair: null,
    source: 'fallback',
  };
}

// presentMembers must already be in roster order — the fallback pick
// (first `maxCount` present members) relies on that ordering.
async function selectSpeakers({
  client,
  model,
  lodgeContext,
  presentMembers,
  instruction,
  conversationHistory,
  minCount,
  maxCount,
  round,
  onMetric,
  roundSoFar,
  meetingTurns,
}) {
  const presentIds = presentMembers.map(m => m.id);
  const { system, userMessage } = buildDirectorPrompt({
    lodgeContext,
    presentMembers,
    instruction,
    minCount,
    maxCount,
    roundSoFar,
    meetingTurns,
  });

  return runDirectorSelection({
    client,
    model,
    system,
    userMessage,
    conversationHistory,
    candidateIds: presentIds,
    minCount,
    maxCount,
    tool: buildDirectorToolSchema(presentIds, minCount, maxCount),
    phase: 'director',
    round,
    onMetric,
    lodgeContext,
    // Deterministic fallback: first `maxCount` present members, in roster order.
    fallbackIds: presentMembers.slice(0, maxCount).map(m => m.id),
    fallbackNote: 'director failed twice — used deterministic fallback',
  });
}

module.exports = {
  buildDirectorToolSchema,
  buildDirectorPrompt,
  buildTurnLedgerBlock,
  sanitizeSplinterPair,
  callDirector,
  isValidSelection,
  runDirectorSelection,
  selectSpeakers,
};
