'use strict';

// Per-member agent architecture (#51) — Stage 1: the director call.
//
// Express-agnostic by design: no req/res, no module-level ROSTER/client
// singletons. Everything is passed in as a parameter, so the same functions
// work in a standalone test script (Stages 1-2) and inside a live route
// (Stage 4), following the sibling-module pattern already used by dayone.js.

// #219: splitIntoBeats lives in public/beats.js, not here, because the
// browser needs it too (app.js live-streaming, witness.js replay) and
// public/ has no bundler — see that file's top-of-file comment. Required
// and re-exported here so it's tested the same way as this file's other
// pure functions (test/pipeline.test.js).
const { splitIntoBeats, BEAT_WORD_THRESHOLD } = require('../public/beats.js');

// ── Member section (shared with the legacy full-blob prompt builder) ──────

// Extracted from server.js's buildSystemPrompt so both the legacy full-blob
// builder and the new per-speaker builder (Stage 2) share identical
// artifact/session-note injection logic.
function buildMemberSection(member, artifact, notes, loadMemberFile) {
  const text = loadMemberFile(member.file);
  if (!text) return '';
  const artifactNote = (artifact?.memberId === member.id && artifact.text?.trim())
    ? `\n\n---\n\n## PRIVATE — BEFORE THE MEETING BEGAN\n\nBefore the others arrived, you were shown the following. No one else in the room has seen it. You may reference it, produce it at the right moment, withhold it entirely, or let it colour what you say without naming it. The choice is yours.\n\n${artifact.text.trim()}`
    : '';
  const sessionNote = notes[member.id]?.trim()
    ? `\n\n---\n\n## SESSION NOTE\n\n${notes[member.id].trim()}`
    : '';
  return `---\n${text}${artifactNote}${sessionNote}`;
}

// ── Metrics ─────────────────────────────────────────────────────────────────

// Cost/latency/failure observability is a first-class requirement, not an
// afterthought — every director and per-speaker call attempt (including
// retries, skips, and fallbacks) produces one of these, persisted alongside
// the session so it's reviewable after the fact, not just an ephemeral
// console line.
function makeMetric(phase, { round, memberId, attempts, usage, latencyMs, skipped, error, reasoning, voiceExemplar, waitingOnMemberId, residueNote } = {}) {
  return {
    phase, // 'director' | 'speaker' | 'casting' | 'disposition' | 'citation-extraction' | 'citation-grounding'
    round: round ?? null,
    memberId: memberId || null,
    attempts: attempts ?? 1,
    usage: usage ? {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      // #190: proof the cache breakpoints are actually paying off — a
      // non-zero read here on a repeat director/speaker call is the signal
      // to look for, not just a lower input_tokens count.
      cache_read_input_tokens: usage.cache_read_input_tokens ?? null,
    } : null,
    latencyMs: latencyMs ?? null,
    skipped: !!skipped,
    error: error || null,
    reasoning: reasoning || null,
    // #187: which library entry (if any) was injected as this speaker's
    // register exemplar. Recorded so the feature's input-token cost is
    // attributable after the fact — the same speaker with and without an
    // exemplar is the comparison, and without this field the two are
    // indistinguishable in the persisted metrics. Always null off the
    // speaker phase.
    voiceExemplar: voiceExemplar || null,
    // #203: the structured "unspent business" target a disposition update
    // resolved, if any — lets real sessions be checked for how often the
    // signal actually fires without re-parsing prose. Always null off
    // every phase but 'disposition'.
    waitingOnMemberId: waitingOnMemberId || null,
    // #166: whether this disposition beat wrote a new residue fragment —
    // lets real sessions be checked for how often cross-session residue
    // actually accrues without re-reading the residue store by hand.
    // Always null off the 'disposition' phase.
    residueNote: residueNote || null,
    timestamp: new Date().toISOString(),
  };
}

// ── Prompt caching (#190) ───────────────────────────────────────────────────
//
// Every director and speaker system prompt opens with the same lodge-context
// block (member roster, room framing), and within a round every director and
// speaker call reuses the identical conversationHistory slice. Anthropic's
// cache is prefix-based (tools -> system -> messages) — marking the end of
// each of those two stable prefixes with a cache_control breakpoint lets
// same-speaker-across-beats and director-across-rounds calls skip
// re-processing what they already sent, instead of resending the whole
// prefix at full price every time. Speaker system prompts diverge right
// after lodgeContext (each member's own file, exemplar, disposition), so the
// messages-tier breakpoint is the one shared across *every* call in a round,
// not just repeats of the same speaker.

// `system` must start with `lodgeContext` — true of every system prompt this
// module builds (buildDirectorPrompt, buildCastingPrompt,
// buildSpeakerSystemPrompt all open with it). Falls back to the plain string
// if that ever stops being true, rather than caching the wrong prefix.
function buildCachedSystem(system, lodgeContext) {
  if (!lodgeContext || !system.startsWith(lodgeContext)) return system;
  const rest = system.slice(lodgeContext.length);
  const blocks = [{ type: 'text', text: lodgeContext, cache_control: { type: 'ephemeral' } }];
  if (rest) blocks.push({ type: 'text', text: rest });
  return blocks;
}

// Marks the end of `conversationHistory` as a cache breakpoint. The same
// array is passed unmodified to every director/speaker call within a round,
// and — so long as the session's slice(-6) window hasn't dropped anything —
// across rounds too, so this is what lets those repeat calls skip
// reprocessing history they've already paid for. Returns a new array; never
// mutates the caller's.
function withHistoryCacheControl(conversationHistory) {
  if (!conversationHistory?.length) return conversationHistory || [];
  const lastIndex = conversationHistory.length - 1;
  return conversationHistory.map((message, i) => {
    if (i !== lastIndex) return message;
    const content = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }]
      : message.content;
    return { ...message, content };
  });
}

// ── Shared retry helper ──────────────────────────────────────────────────────

// Tries fn() once; on failure, tries again and reports how many attempts it
// took. If the second attempt also fails, that error is rethrown with an
// `.attempts` property attached so the caller can still report an accurate
// metric without re-deriving the count itself.
async function withOneRetry(fn) {
  try {
    const result = await fn();
    return { result, attempts: 1 };
  } catch (firstErr) {
    try {
      const result = await fn();
      return { result, attempts: 2 };
    } catch (secondErr) {
      secondErr.attempts = 2;
      throw secondErr;
    }
  }
}

// ── Director ────────────────────────────────────────────────────────────────

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
          description: 'Whether the room itself — the whole evening, not just this pool — is winding down: energy ebbing, threads settling, no one straining to speak. Usually false.',
        },
        lullNote: {
          type: 'string',
          description: 'Optional. If windingDown is true, one diegetic line marking the pause, in the room\'s register — an image or a small action, not a summary. E.g. "The fire settles; Yeats refills his glass." Leave out if nothing concrete comes to mind, or if windingDown is false.',
        },
      },
      required: ['speakers', 'reasoning', 'windingDown'],
    },
  };
}

function buildDirectorPrompt({ lodgeContext, presentMembers, instruction, minCount, maxCount, roundSoFar }) {
  const rosterLines = presentMembers.map(m => `- ${m.name}`).join('\n');

  const soFarBlock = roundSoFar?.trim()
    ? `\n\nTHE ROUND SO FAR:\n${roundSoFar.trim()}\n\nYou are being asked again mid-round — the earlier candidate pool ran dry, or the round has gone on long enough to want fresh judgment. Choose the next pool considering what's already happened above: who hasn't been heard from, who has something left to react to, whether the room needs a new voice or more from someone already in it.`
    : '';

  const system = `${lodgeContext}

---

## YOUR ROLE RIGHT NOW

You are not writing dialogue. You are proposing a candidate pool of who might speak next in this round of the salon — a shortlist and rough priority order, not a fixed cast or an exact script. You will not write any of their words.

PRESENT TONIGHT:
${rosterLines}

THIS ROUND'S INSTRUCTION:
${instruction}${soFarBlock}

Choose between ${minCount} and ${maxCount} of the present members as this round's candidate pool, ordered by priority. Not everyone in the pool is guaranteed to speak, and someone in the pool may end up speaking more than once — the room decides who actually goes, beat by beat, from among them. Base the pool on who has something to react to, who hasn't been heard from, and what this round's instruction calls for — not on alphabetical or arbitrary order.

Separately — and this is a judgment about the whole evening, not just this pool — say whether the room is winding down: energy ebbing, threads settling, no one straining to speak. This is usually false; most consults, the room still has more in it. If it is genuinely true, you may also write one diegetic line marking the pause — an image or a small action in the room's register, not a summary of what just happened.`;

  const userMessage = 'Choose this round\'s candidate pool.';

  return { system, userMessage };
}

// `tool` defaults to the per-round director's own schema; the pre-convene
// casting call (#185) passes its own so the two questions stay legible in
// the transcript of what was actually asked.
async function callDirector({ client, model, system, conversationHistory, userMessage, presentIds, minCount, maxCount, tool, lodgeContext }) {
  const schema = tool || buildDirectorToolSchema(presentIds, minCount, maxCount);
  const start = Date.now();
  const messages = [...withHistoryCacheControl(conversationHistory), { role: 'user', content: userMessage }];
  const response = await client.messages.create({
    model,
    max_tokens: 500,
    system: buildCachedSystem(system, lodgeContext),
    messages,
    tools: [schema],
    tool_choice: { type: 'tool', name: schema.name },
  });
  const latencyMs = Date.now() - start;
  const block = response.content.find(b => b.type === 'tool_use');
  // windingDown/lullNote are absent from the casting tool's schema (a
  // different question, see buildCastingToolSchema) — undefined there
  // degrades to false/null below, which proposeCast simply never reads.
  const { speakers, reasoning, windingDown, lullNote } = block?.input || {};
  return { speakers, reasoning, windingDown: !!windingDown, lullNote: lullNote || null, usage: response.usage, latencyMs };
}

function isValidSelection(speakers, presentIds, minCount, maxCount) {
  return Array.isArray(speakers)
    && speakers.length >= minCount
    && speakers.length <= maxCount
    && new Set(speakers).size === speakers.length
    && speakers.every(id => presentIds.includes(id));
}

// Retry-once + deterministic-fallback loop, shared by the per-round director
// (selectSpeakers) and the pre-convene casting call (proposeCast, #185).
// Both ask the same *shape* of question — pick between minCount and maxCount
// ids out of a fixed enum, with a rationale — so both want the same failure
// handling: one corrective retry, then a deterministic fallback, so no caller
// is ever left without a usable answer because a model call went sideways.
async function runDirectorSelection({
  client, model, system, userMessage, conversationHistory = [],
  candidateIds, minCount, maxCount, tool,
  phase = 'director', round = null, onMetric,
  invalidNote, fallbackIds, fallbackNote, lodgeContext,
}) {
  const correction = invalidNote
    || ` Your previous selection was invalid — it must be between ${minCount} and ${maxCount} present member ids, no duplicates, drawn only from: ${candidateIds.join(', ')}. Choose again.`;

  let lastReasoning = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { speakers, reasoning, windingDown, lullNote, usage, latencyMs } = await callDirector({
        client, model, system, conversationHistory,
        userMessage: userMessage + (attempt === 2 ? correction : ''),
        presentIds: candidateIds, minCount, maxCount, tool, lodgeContext,
      });
      lastReasoning = reasoning || lastReasoning;
      onMetric?.(makeMetric(phase, { round, attempts: attempt, usage, latencyMs, reasoning }));
      if (isValidSelection(speakers, candidateIds, minCount, maxCount)) {
        return { speakers, reasoning, windingDown, lullNote, source: attempt === 1 ? 'director' : 'director-retry' };
      }
    } catch (err) {
      onMetric?.(makeMetric(phase, { round, attempts: attempt, error: err.message }));
    }
  }

  onMetric?.(makeMetric(phase, { round, attempts: 2, skipped: true, error: fallbackNote, reasoning: lastReasoning }));
  // A director failure must never quietly read as an intentional lull —
  // the fallback always reports the room as not winding down.
  return { speakers: fallbackIds, reasoning: lastReasoning, windingDown: false, lullNote: null, source: 'fallback' };
}

// presentMembers must already be in roster order — the fallback pick
// (first `maxCount` present members) relies on that ordering.
async function selectSpeakers({ client, model, lodgeContext, presentMembers, instruction, conversationHistory, minCount, maxCount, round, onMetric, roundSoFar }) {
  const presentIds = presentMembers.map(m => m.id);
  const { system, userMessage } = buildDirectorPrompt({ lodgeContext, presentMembers, instruction, minCount, maxCount, roundSoFar });

  return runDirectorSelection({
    client, model, system, userMessage, conversationHistory,
    candidateIds: presentIds, minCount, maxCount,
    tool: buildDirectorToolSchema(presentIds, minCount, maxCount),
    phase: 'director', round, onMetric, lodgeContext,
    // Deterministic fallback: first `maxCount` present members, in roster order.
    fallbackIds: presentMembers.slice(0, maxCount).map(m => m.id),
    fallbackNote: 'director failed twice — used deterministic fallback',
  });
}

// ── Casting the evening (#185) ──────────────────────────────────────────────
//
// A different question from selectSpeakers'. The director asks "of the people
// already in the room, who speaks next"; casting asks "of the whole lodge,
// who turns up at all tonight" — once, before the meeting, from the document
// rather than from a round instruction.
//
// Deliberately *not* full auto-casting. The user's pinned regulars are fixed
// input, not a suggestion the model may drop: they are handed over as already
// coming, and the model only fills the rest of the room around them. Hand-
// casting from the full grid stays available either way — this proposes, it
// never applies.

// Enough of the document to cast from without paying for a whole book. The
// opening of a text is where its subject announces itself; casting doesn't
// need the argument, only the territory.
const CASTING_DOCUMENT_LIMIT = 3000;

// Same 4–6 the roster badge has always recommended (larger casts thin out
// individual voices — see updateMemberCount in app.js).
const CASTING_TARGET_MIN = 4;
const CASTING_TARGET_MAX = 6;

function buildCastingToolSchema(candidateIds, minCount, maxCount) {
  return {
    name: 'cast_the_evening',
    description: 'Choose which further members of the lodge this document would draw to the room tonight.',
    input_schema: {
      type: 'object',
      properties: {
        speakers: {
          type: 'array',
          items: { type: 'string', enum: candidateIds },
          minItems: minCount,
          maxItems: maxCount,
          uniqueItems: true,
          description: `Member ids, in order of how strongly the document draws them, from those not already coming: ${candidateIds.join(', ')}.`,
        },
        reasoning: {
          // Unlike the per-round director's rationale, this one is shown —
          // it is the proposal's whole case for itself.
          type: 'string',
          description: 'One or two sentences, in the register of the lodge, on what in this document draws these people. Shown to the user beside the proposed cast.',
        },
      },
      required: ['speakers', 'reasoning'],
    },
  };
}

function buildCastingPrompt({ lodgeContext, candidates, regulars, documentText, minCount, maxCount }) {
  const candidateLines = candidates
    .map(m => `- ${m.id} — ${m.name}${m.brief ? `: ${m.brief}` : ''}`)
    .join('\n');

  const regularsBlock = regulars.length
    ? `ALREADY COMING TONIGHT — the user's regulars. They are always drawn to this room. They are not yours to choose, and not yours to drop:\n${regulars.map(m => `- ${m.name}`).join('\n')}`
    : 'No one is fixed for tonight. The whole room is yours to propose.';

  const document = documentText.trim().slice(0, CASTING_DOCUMENT_LIMIT);

  const system = `${lodgeContext}

---

## YOUR ROLE RIGHT NOW

You are not writing dialogue, and you are not choosing who speaks within a round. You are saying who the evening's document draws to the room at all — which members of the lodge would find their way in tonight, given what is about to be read aloud.

${regularsBlock}

THE REST OF THE LODGE — anyone here may be drawn tonight:
${candidateLines}

THE DOCUMENT TO BE READ ALOUD TONIGHT:
${document}

Choose between ${minCount} and ${maxCount} further members, ordered by how strongly the document draws them. Cast for friction as much as for affinity — a room where everyone agrees has nothing to say. Consider who the document's subject belongs to, who would dispute it, and who would hear something in it nobody else would. Do not choose for coverage, seniority, or roster order.${regulars.length ? ' The regulars above are already in the room; choose people who make something of what those regulars will say, not duplicates of them.' : ''}`;

  const userMessage = 'Say who this document draws tonight.';

  return { system, userMessage };
}

// Returns { cast, additions, regulars, reasoning, source }. `cast` is the
// full proposed room — regulars first, then the model's additions in the
// order it ranked them. `source` is 'director' | 'director-retry' |
// 'fallback' | 'regulars' (the last meaning no call was made at all).
//
// roster entries are { id, name, brief? }; `brief` is a one-line sketch used
// only for casting judgment. Must be in roster order — the deterministic
// fallback relies on it, exactly as selectSpeakers' does.
async function proposeCast({
  client, model, lodgeContext, roster, regularIds = [], documentText,
  targetMin = CASTING_TARGET_MIN, targetMax = CASTING_TARGET_MAX, onMetric,
}) {
  const rosterIds = roster.map(m => m.id);
  const regulars = roster.filter(m => regularIds.includes(m.id));
  const candidates = roster.filter(m => !regularIds.includes(m.id));

  // The regulars already fill (or overfill) the evening, or there is simply
  // nobody left to add. Either way the answer is known without a call —
  // #185's "one extra cheap call per session" is a ceiling, not a quota.
  if (regulars.length >= targetMax || candidates.length === 0) {
    return {
      cast: regulars.map(m => m.id),
      additions: [],
      regulars: regulars.map(m => m.id),
      reasoning: null,
      source: 'regulars',
    };
  }

  const maxCount = Math.min(targetMax - regulars.length, candidates.length);
  const minCount = Math.min(Math.max(targetMin - regulars.length, 1), maxCount);

  const candidateIds = candidates.map(m => m.id);
  const { system, userMessage } = buildCastingPrompt({
    lodgeContext, candidates, regulars, documentText, minCount, maxCount,
  });

  const { speakers, reasoning, source } = await runDirectorSelection({
    client, model, system, userMessage,
    candidateIds, minCount, maxCount,
    tool: buildCastingToolSchema(candidateIds, minCount, maxCount),
    phase: 'casting', onMetric, lodgeContext,
    invalidNote: ` Your previous selection was invalid — it must be between ${minCount} and ${maxCount} member ids, no duplicates, drawn only from: ${candidateIds.join(', ')}. Choose again.`,
    // Deterministic fallback: the first `minCount` candidates in roster order.
    // Roster order is roughly the order the lodge was founded in, which is a
    // defensible room to open with when the model can't be reached at all.
    fallbackIds: candidateIds.slice(0, minCount),
    fallbackNote: 'casting call failed twice — used deterministic fallback',
  });

  // rosterIds guards against a fallback list going stale mid-flight; the
  // model path is already enum-constrained and validated upstream.
  const additions = speakers.filter(id => rosterIds.includes(id));

  return {
    cast: [...regulars.map(m => m.id), ...additions],
    additions,
    regulars: regulars.map(m => m.id),
    reasoning: reasoning || null,
    source,
  };
}

// ── Local hybrid speaker pacing (#164) ─────────────────────────────────────
//
// Who speaks next, beat by beat, is a cheap local weighted pick — no API
// call — drawing from the director's candidate pool. This is what makes the
// round feel like back-and-forth rather than a queue of monologues: it can
// send the same voice back in (rare, weighted low — reads as an
// interruption when it happens) and it paces against the round's remaining
// word budget rather than a fixed per-member turn count.

// Seed data, not a researched claim about every historical figure's real
// prose style — only the two personas the #164 design doc named explicitly
// as needing room to run long. Expand this as real sessions surface more
// per-member tendencies (see the 2026-08-19 follow-up).
const LENGTH_TENDENCY_OVERRIDES = {
  crowley: 'expansive',
  yeats: 'expansive',
};
const LENGTH_WEIGHT = { terse: 0.7, medium: 1, expansive: 1.35 };

function lengthTendencyOf(memberId) {
  return LENGTH_TENDENCY_OVERRIDES[memberId] || 'medium';
}

const MAX_TURNS_PER_POOL_MEMBER = 2; // a 3rd turn for anyone needs a fresh director consult, not another local pick
const REPEAT_BACK_TO_BACK_WEIGHT = 0.12; // rare but real — reads as an interruption/quick reply when it happens
const REPEAT_DECAY = 0.45; // each earlier appearance this round further discounts a repeat pick
const LOW_BUDGET_WORDS = 120; // below this, favor members who tend to land a short beat and let the round close

// #203: a member whose disposition names someone they privately have
// unspent business with should be meaningfully likelier to get the next
// beat once that person actually speaks — an interruption reading as a
// character choice, not a scheduling accident. Well above LENGTH_WEIGHT's
// ~1.35x ceiling so ordinary length-tendency variance can't swamp it, but
// still a weight, not a forced pick: other pool weighting (repeat discount,
// budget throttle) still applies on top, and the room doesn't stop for
// every unspent intention the instant it becomes eligible.
const INTERRUPT_INTENT_WEIGHT = 3;

// Returns a memberId from `pool`, or null if every pool member has already
// hit MAX_TURNS_PER_POOL_MEMBER (the caller should re-consult the director).
// `disposition`, if given, is the { [memberId]: { waitingOnMemberId } } map
// built by callDispositionUpdate (#188/#203) — read-only here.
function pickNextSpeaker({ pool, spokenCounts, lastSpeakerId, remainingBudget, disposition, rng = Math.random }) {
  const weights = pool.map(id => {
    const timesSpoken = spokenCounts.get(id) || 0;
    if (timesSpoken >= MAX_TURNS_PER_POOL_MEMBER) return 0;
    const tendency = lengthTendencyOf(id);
    let w = LENGTH_WEIGHT[tendency];
    if (id === lastSpeakerId) w *= REPEAT_BACK_TO_BACK_WEIGHT;
    else if (timesSpoken > 0) w *= Math.pow(REPEAT_DECAY, timesSpoken);
    if (remainingBudget < LOW_BUDGET_WORDS && tendency === 'expansive') w *= 0.4;
    if (lastSpeakerId && disposition?.[id]?.waitingOnMemberId === lastSpeakerId) w *= INTERRUPT_INTENT_WEIGHT;
    return w;
  });

  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;

  let roll = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0 && weights[i] > 0) return pool[i];
  }
  return pool[pool.length - 1]; // floating-point fallback
}

function isPoolExhausted(pool, spokenCounts) {
  return pool.every(id => (spokenCounts.get(id) || 0) >= MAX_TURNS_PER_POOL_MEMBER);
}

function countWords(text) {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

// ── Voice-register exemplar (#187) ──────────────────────────────────────────
//
// The library (#35a) holds a verified primary-source excerpt for 21 of the 33
// roster members, and until now that text was read only by citation
// verification (#36/#153) — never by the member whose prose it is. Each
// member's voice therefore rested entirely on their character file's
// *description* of a register rather than on evidence of one. This injects
// a trimmed slice of a member's own writing into their speaker prompt as an
// exemplar of how they actually sound on the page.
//
// The 12 members with no library entry of their own get nothing extra and
// behave exactly as before — the voice doc's description alone. That is the
// intended degradation, not a gap to paper over: a member is only ever shown
// text they actually wrote.
//
// Twelve, not the ten hard passes STATUS.md's 2026-08-07 entry names. Library
// *coverage* counts a member as covered if they appear in an entry's
// `members` list at all, which is the right measure for the graph and for
// citation matching but the wrong one here: Pamela Colman Smith is listed on
// Waite's 1911 preface and Corbin on Jung's 1916 text because those entries
// concern them, not because they wrote a word of them. Handing Waite's prose
// to Pixie as "how you actually write" would be a fabrication of exactly the
// kind this project's citation work exists to prevent — hence the explicit
// `author` field in library.json (added by this change) rather than a reuse
// of `members`.

// A few hundred words, per the issue — enough to carry a cadence, cheap
// enough to pay per speaker call (input tokens, uncached until #190). Sized
// against the real corpus: 16 of 21 entries are already under it and pass
// through whole; it only bites on the five long ones (Moina Mathers 584
// words, Porete 434, Dion Fortune 406, Lévi 302, Hildegard 301). The whole
// section costs ~550 input tokens per beat when present.
const VOICE_EXEMPLAR_WORD_BUDGET = 300;

// Trims from the top of the excerpt on the largest natural boundary that
// fits — whole paragraphs first, then whole sentences, and only as a last
// resort mid-sentence. A register exemplar cut mid-clause is a worse
// exemplar: the model reads the truncation itself as a stylistic habit.
function trimToWordBudget(text, maxWords) {
  const trimmed = (text || '').trim();
  if (!trimmed || countWords(trimmed) <= maxWords) return trimmed;

  const paragraphs = trimmed.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const kept = [];
  let used = 0;
  for (const paragraph of paragraphs) {
    const words = countWords(paragraph);
    if (used + words > maxWords) break;
    kept.push(paragraph);
    used += words;
  }
  if (kept.length) return `${kept.join('\n\n')}\n\n[…]`;

  // The opening paragraph alone overruns the budget — fall back to whole
  // sentences within it.
  const sentences = paragraphs[0].match(/[^.!?]+(?:[.!?]+|$)/g) || [];
  const keptSentences = [];
  used = 0;
  for (const sentence of sentences) {
    const words = countWords(sentence);
    if (used + words > maxWords) break;
    keptSentences.push(sentence.trim());
    used += words;
  }
  if (keptSentences.length) return `${keptSentences.join(' ')} […]`;

  // One unbroken sentence longer than the whole budget (verse without
  // terminal punctuation does this too) — hard cut.
  return `${trimmed.split(/\s+/).slice(0, maxWords).join(' ')} […]`;
}

// `exemplar` is { title, source, date, text, translated } — see server.js's
// loadVoiceExemplar. Returns '' for a member with no entry, which is what
// makes the degradation invisible rather than a hole in the prompt.
function buildVoiceExemplarSection(exemplar) {
  const text = trimToWordBudget(exemplar?.text, VOICE_EXEMPLAR_WORD_BUDGET);
  if (!text) return '';

  // Half the corpus's titles already name the work they're drawn from
  // ("The Voice of the Devil — The Marriage of Heaven and Hell", source "The
  // Marriage of Heaven and Hell"), so a naive join prints it twice. Drop the
  // redundant half rather than hand the model a line that reads like a
  // stutter — this is the one place in the prompt claiming to be evidence.
  const parts = [exemplar.title];
  if (exemplar.source && !exemplar.title?.includes(exemplar.source)) parts.push(exemplar.source);
  parts.push(exemplar.date);
  const provenance = parts.filter(Boolean).join(' — ');
  // Most of the corpus (12 of 21) is in translation, so for over half these
  // members the specific English words are a translator's choice, not
  // theirs. Naming that keeps the model from adopting Rosenthal's or Peers's
  // vocabulary as Ibn Khaldun's or Teresa's own.
  const translationNote = exemplar.translated
    ? ' The English here is a translator\'s, not yours: take the cadence, the shape of the argument, and the habits of attention as your own — not the particular vocabulary.'
    : '';

  return `\n\n---\n\n## HOW YOU ACTUALLY WRITE — A PAGE IN YOUR OWN HAND

Below is a passage of your own writing, from the lodge's archive. It is here as evidence of your register — your sentence rhythm, how you build and qualify a thought, what you reach for and what you leave alone. It is not a topic, an assignment, or a thing to bring up.

${provenance}

${text}

Let this govern *how* you speak tonight, never *what* you speak about. Do not quote it, cite it, allude to it, or steer the room toward its subject — no one here is discussing this text, and producing it would read as a non sequitur. It is also written prose, and you are speaking aloud in a room: what carries over is the mind and the movement, not the punctuation of the page.${translationNote}`;
}

// ── Cross-session residue (#166) ───────────────────────────────────────────
//
// Rung (a) of #195's amnesia ladder: members stay amnesiac — no recall of
// prior meetings — but drift the way the lodge context already licenses:
// "the meeting deposits itself in you below the threshold of conscious
// recall... a quality of readiness." Where #188's disposition is a member's
// stance *tonight*, residue is the same mechanism's slow accumulation
// *across* tonights — a small, capped, per-member store of stances,
// tendencies, warmths and grudges that outlives the session that produced
// it, read back into every future session's speaker prompt regardless of
// which room convenes it.
//
// Piggybacks on the exact disposition tool call (see callDispositionUpdate
// above) rather than adding a second one: `residueNote` is populated only
// on the rare beat that earns it. Zero added latency, zero added API calls.
//
// Voice fidelity is the paramount constraint (per #166's scoping) — see
// docs/AXES.md's Axis 4 for the drift-toward-sameness risk this format resists:
// fragments must stay short, concrete, and instance-grounded, and the
// oldest erode off the cap long before accumulated residue could ever
// outweigh the character file's fixed voice.

const RESIDUE_MAX_CHARS = 480; // same order of magnitude as disposition's 400, deliberately not larger — smaller and more conservative was the explicit mandate
const RESIDUE_NOTE_MAX_CHARS = 200; // one fragment's ceiling before it ever reaches the merge
const RESIDUE_SEPARATOR = ' · ';

// Deterministic, no model call: appends the new fragment and drops whole
// fragments from the *oldest* end until back under the cap — never a
// mid-fragment cut, same principle as #187's trimToWordBudget (a note
// sheared mid-clause reads to the model as a stylistic habit, not an
// elision). Oldest residue simply erodes off the cap as new residue
// accrues — sediment, not a narrative a second call would have to compose.
function mergeResidue(priorText, note) {
  const trimmedNote = (note || '').trim().slice(0, RESIDUE_NOTE_MAX_CHARS);
  if (!trimmedNote) return (priorText || '').trim();

  const priorFragments = (priorText || '').split(RESIDUE_SEPARATOR).map(f => f.trim()).filter(Boolean);
  const fragments = [...priorFragments, trimmedNote];

  const kept = [];
  let used = 0;
  for (let i = fragments.length - 1; i >= 0; i--) {
    const fragment = fragments[i];
    const cost = fragment.length + (kept.length ? RESIDUE_SEPARATOR.length : 0);
    if (used + cost > RESIDUE_MAX_CHARS) break;
    kept.unshift(fragment);
    used += cost;
  }
  return kept.join(RESIDUE_SEPARATOR);
}

// `residueText` is the merged, on-disk cross-session store for this member
// — see server.js's loadResidue. Empty for a member with no accumulated
// residue yet, which is what makes the degradation invisible (same contract
// as buildVoiceExemplarSection). The framing is deliberately never a claim
// of memory — rung (a) keeps the amnesia; this is instinct, not recall.
function buildResidueSection(residueText) {
  const text = (residueText || '').trim();
  if (!text) return '';

  return `\n\n---\n\n## WHAT LINGERS, THOUGH YOU COULDN'T SAY WHY

${text}

This is not memory. You have no meetings to recall, and if pressed, you would honestly deny remembering any of them — because you don't. It surfaces only as instinct: a tone you reach for without knowing its source, a wariness or a warmth that arrives ahead of any reason you could give for it. Let it color how you carry yourself tonight — never mention it, explain it, or gesture at where it comes from. As far as you know, there is nothing to gesture at.`;
}

// ── Per-speaker call ────────────────────────────────────────────────────────

// Only this member's own character file goes in — no other present members'
// files. That's the whole point: each speaker gets the model's full
// attention instead of a fraction of it split across the whole cast.
function buildSpeakerSystemPrompt({ lodgeContext, member, artifact, notes, loadMemberFile, disposition, voiceExemplar, residue }) {
  const memberSection = buildMemberSection(member, artifact, notes, loadMemberFile);
  // #187: sits directly after the character file, since it's evidence for
  // the same thing that file describes — and before the disposition, which
  // is about tonight specifically and wants to be the last thing read.
  const exemplarSection = buildVoiceExemplarSection(voiceExemplar);
  // #166: slower-moving than disposition (spans sessions, not just tonight)
  // so it sits between the exemplar and the disposition — evidence of
  // register, then accumulated drift, then tonight specifically, in that
  // order of how far back each one reaches.
  const residueSection = buildResidueSection(residue);
  // #203: disposition is now { text, waitingOnMemberId } (see the
  // disposition scratchpad section below) — only the prose goes in the
  // speaker prompt, the structured target is read by pickNextSpeaker.
  const dispositionText = disposition?.text?.trim();
  const dispositionSection = dispositionText
    ? `\n\n---\n\n## YOUR PRIVATE STATE TONIGHT (no one else in the room can see this)\n\n${dispositionText}`
    : '';

  return `${lodgeContext}

---

${memberSection}${exemplarSection}${residueSection}${dispositionSection}

---

## YOUR TURN RIGHT NOW

You are about to contribute your turn in this round of the salon. Generate only your own contribution — not other members' dialogue, not a transcript of the whole room, just what you say and do right now.

Do not sign your own name at the start of your response — that is handled automatically, outside this call. Begin directly with your action (if any) or your speech.

Write your entire turn as one continuous block — no blank line anywhere inside it, even across multiple sentences or beats. A blank line marks a change of speaker to whoever reads this afterward; leaving one in the middle of your own turn would read as someone else taking over mid-thought. If you need a pause or a shift, use a single line break, never a blank one.

There is no default length for a turn — let who you are and what's just happened decide it. Some members think out loud at length once something has actually engaged them; others cut in with a single line and let it land. Both are complete turns. If you have a lot to say, say it — but the round has a shared, finite amount of room, so notice you're leaving less of it for whoever speaks after you. A one-line interjection is not a lesser contribution than a paragraph.

Actions and stage business are written in *single asterisks* and used sparingly. The default for any contribution is no action line at all — most speech should stand without physical description. An action earns its place only when it reveals something the words cannot: a gesture that contradicts the speech, a significant silence, a physical act that changes the room's temperature. Do not describe yourself looking at fires, adjusting posture, or sitting down. One action is the maximum; zero is the norm. Do not use --- as a divider.

Be specific: cite real texts, real historical tensions, real scholarship (including post-period scholarship — the room is atemporal and the receipts are real). Do not invent citations. If you quote a text, that text must exist and the quotation must be substantively accurate.

There is no author present. The document was read aloud by no one in particular. Do not praise, critique, address, summarize, or workshop the writer — there is no writer in the room.

Do not address the user or acknowledge any observer. Proceed as if no one is watching.`;
}

// A blank line inside a speaker's own turn reads as a new, unattributed
// speaker to the client's transcript parser (a convention inherited from the
// old single-call format, where blank lines only ever appeared *between*
// speakers). The prompt instructs the model not to leave one, but that's a
// soft constraint the model doesn't always honor — this collapses any that
// slip through so a multi-paragraph turn doesn't fragment into a run of
// unattributed "—" bubbles. Same principle as selectSpeakers' validation:
// don't rely on prompt compliance alone for something structural.
function stripInternalBlankLines(text) {
  return text.replace(/\n[ \t]*\n+/g, '\n');
}

// Below this words-per-remaining-voice ratio, the round is "crowded" — there
// isn't room for everyone still waiting to get a full turn at the length
// speakers have been running. A vague "leave room for others" didn't move
// real turn length (see #164's 2026-08-06 live tests — 900-token+ turns
// regardless of how many voices were still unheard); naming the actual
// headcount is a concrete constraint the model can react to instead of an
// abstraction it can shrug off. Set above the even split for a full 5-voice
// pool on the default 1000-word budget (1000/5 = 200 words/voice) — those
// live tests were exactly that shape, and the *first* speaker (the one most
// responsible for spending the budget) needs the pressure too, not just
// whoever's left once it's already gone.
const CROWDED_WORDS_PER_VOICE = 220;

// `interruptingName`, when set, is the just-spoken member this pick's own
// disposition named as unfinished business (see pickNextSpeaker's
// INTERRUPT_INTENT_WEIGHT, #203) — told to the speaker as an option, not an
// instruction, since a real interruption is sometimes let go rather than
// taken.
function buildSpeakerUserMessage({ roundPrompt, roundSoFarText, member, remainingBudgetWords, unheardCount, interruptingName }) {
  const soFar = roundSoFarText?.trim()
    ? `\n\n--- THE ROUND SO FAR ---\n${roundSoFarText.trim()}\n`
    : '';
  let budgetHint = '';
  if (typeof remainingBudgetWords === 'number') {
    const crowded = typeof unheardCount === 'number' && unheardCount > 0
      && remainingBudgetWords / (unheardCount + 1) < CROWDED_WORDS_PER_VOICE;
    budgetHint = crowded
      ? `\n\n(Roughly ${remainingBudgetWords} words of room left in the round, and ${unheardCount} other${unheardCount === 1 ? '' : 's'} who haven't spoken yet still waiting on it. If everyone's going to fit, this is a moment where a line lands harder than a paragraph — but read the room; don't cut yourself off if something genuinely needs the space.)`
      : `\n\n(The round has roughly ${remainingBudgetWords} words of room left before it should start wrapping up — a felt sense of how much space remains, not a hard limit. A short reaction is as valid a turn as a long one.)`;
  }
  const interruptNote = interruptingName
    ? `\n\n(You have unfinished business with ${interruptingName}, who just spoke — this is your moment for it. Take the thought mid-stride if it's still hot, or let the room settle a beat first and strike after. Your call; it's fine to let it pass.)`
    : '';
  return `${roundPrompt}${soFar}${budgetHint}${interruptNote}

--- YOUR TURN ---
Generate ${member.name}'s contribution now.`;
}

// #164: still well under the pre-#164 1500-token cap, but raised from an
// initial 900 after a live convene showed 900 gets hit routinely — not just
// by designated-expansive personas (Crowley, Yeats) but by default-tendency
// members too (Waite and Lévi both hit 900 in one round of that test,
// Lévi's turn visibly cut off mid-sentence). The model's baseline verbosity
// for this salon's philosophical-debate register runs long across the
// board; 1100 buys more headroom against mid-sentence truncation while
// still sitting well below the old cap. Expect this to need more tuning at
// the 2026-08-19 follow-up.
const SPEAKER_MAX_TOKENS = 1100;

// Streams the response (same delta shape streamClaude already forwards to
// the client), and still captures usage/latency via stream.finalMessage() —
// live streaming and per-call metrics are not mutually exclusive.
async function callSpeakerTurn({ client, model, system, conversationHistory, userMessage, onChunk, lodgeContext }) {
  const start = Date.now();
  const messages = [...withHistoryCacheControl(conversationHistory), { role: 'user', content: userMessage }];
  const stream = client.messages.stream({
    model,
    max_tokens: SPEAKER_MAX_TOKENS,
    system: buildCachedSystem(system, lodgeContext),
    messages,
  });

  let text = '';
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      const chunk = event.delta.text;
      text += chunk;
      onChunk?.(chunk);
    }
  }
  const finalMessage = await stream.finalMessage();
  const latencyMs = Date.now() - start;
  return { text: text.trim(), usage: finalMessage.usage, latencyMs };
}

// ── Disposition scratchpad (#188, structured target #203) ─────────────────
//
// A per-member private note — current stance, unspent intentions, tonight's
// alignments and irritations — carried forward within the session and
// re-injected into that member's *next* speaker call via
// buildSpeakerSystemPrompt's dispositionSection. Never shown in the
// transcript. Cadence: piggybacked as a cheap follow-up call right after a
// member's own turn, not a once-per-round sweep of every present member —
// that would mean an extra call per present member per round regardless of
// whether they spoke, which cuts against the same cost discipline #164's
// word-budget work was built around. A member who sits out a round simply
// carries their prior disposition forward unchanged.
//
// #203: alongside the free prose, the model also names — as a separate
// structured field, not parsed out of the prose — which present member (if
// any) it privately has unspent business with. Real #188 sessions (see the
// issue's dependency note) showed prose is the wrong thing to key
// scheduling off of: a member's stated target is as often a bare pronoun
// ("I want to press *him* on...") as a name, and the hard truncation cap
// sometimes cuts the sentence naming the target before it arrives. A
// same-call tool field costs no extra latency and can't be misread the way
// a name-scan through freeform prose can. `disposition[memberId]` is
// therefore `{ text, waitingOnMemberId }`, not a bare string — see
// pickNextSpeaker's INTERRUPT_INTENT_WEIGHT for the consumer.

const DISPOSITION_MAX_CHARS = 400; // a few sentences — hard cap so this can't balloon a speaker prompt over a long session
const DISPOSITION_MAX_TOKENS = 280; // reflection prose plus the tool-call JSON wrapper, target field, and #166's optional residue field

function buildDispositionToolSchema(presentIds) {
  return {
    name: 'update_disposition',
    description: 'Record this member\'s private interior state after speaking, including whether they have unspent business with anyone present.',
    input_schema: {
      type: 'object',
      properties: {
        reflection: {
          type: 'string',
          description: `1-3 sentences of private thought — current stance, anything unsaid but intended, who they're aligned with or irritated by. Under ${DISPOSITION_MAX_CHARS} characters.`,
        },
        waitingOnMemberId: {
          type: 'string',
          enum: [...presentIds, 'none'],
          description: 'The one present member (by id) this member has unspent business with and would want to answer or press if that person speaks again — or "none" if that is not true right now. Most turns are "none"; only name someone when it is real.',
        },
        // #166: cross-session residue, piggybacked on this same call rather
        // than a second one — see the "Cross-session residue" section below
        // for the full mechanism. Left out of `required` on purpose: an
        // omitted field is how the model expresses "nothing belongs here",
        // which is the common case by design.
        residueNote: {
          type: 'string',
          description: `Optional, and rare. Only when this beat genuinely shifted or confirmed something that should outlast tonight — a durable turn in stance, a new alliance or grudge, a tendency proven true. One short sentence, written in your own private register, under ${RESIDUE_NOTE_MAX_CHARS} characters. Leave this out entirely on ordinary turns — most turns, nothing belongs here.`,
        },
      },
      required: ['reflection', 'waitingOnMemberId'],
    },
  };
}

function buildDispositionSystemPrompt({ member, priorDisposition, presentMembers = [], priorResidue }) {
  const priorText = priorDisposition?.text?.trim();
  const priorTarget = priorDisposition?.waitingOnMemberId
    ? presentMembers.find(m => m.id === priorDisposition.waitingOnMemberId)?.name
    : null;
  const priorTargetNote = priorTarget ? ` You were privately waiting to answer or press ${priorTarget}.` : '';
  const priorBlock = priorText
    ? `Your private state going into this turn was:\n"${priorText}"\n\nUpdate it — don't just repeat it back.${priorTargetNote}`
    : 'This is your first private reflection tonight — there is no prior state yet.';

  // #166: shown so the model doesn't re-mint a fragment that's already
  // there — the point of residue is what's new or confirmed, not a running
  // restatement of what's already settled.
  const priorResidueText = priorResidue?.trim();
  const residueContextBlock = priorResidueText
    ? `\n\nResidue already carried from other evenings, beneath this member's own conscious recall: "${priorResidueText}" Only add to it below if tonight genuinely shifted or confirmed something beyond what's already there — most turns, it didn't.`
    : '';

  return `You are privately reflecting as ${member.name}, immediately after speaking your turn in tonight's salon. This reflection is never shown to anyone — not the other members, not the transcript, not the researcher who convened the evening. It is your own unspoken interior state, carried forward to color how you show up for the rest of the evening.

${priorBlock}${residueContextBlock}

Write 1-3 sentences, as private thought rather than speech: your current stance on the evening's argument, anything you haven't yet said but intend to, who you're aligned with or irritated by tonight. Be concrete and specific to what just happened, not a generic character summary. Keep it under ${DISPOSITION_MAX_CHARS} characters — this is a scratchpad, not an essay.

Separately, name whether there is one present person you have real unspent business with — something you'd want to answer or press if they spoke again. This is the exception, not the default: most turns, there is no one.

Separately again, and rarer still: name whether tonight left something that should genuinely outlast this evening — not tonight's mood, a durable turn. Most turns, there is nothing here either.`;
}

function buildDispositionUserMessage({ roundSoFarText, turnText, member }) {
  return `--- WHAT JUST HAPPENED IN THE ROOM ---\n${roundSoFarText.trim()}\n\n--- WHAT YOU (${member.name}) JUST SAID ---\n${turnText}\n\n--- YOUR PRIVATE REFLECTION ---\nWrite your updated private disposition now.`;
}

// Deliberately no retry — this is a best-effort private-state update, not a
// user-visible turn. A failure just means the member's disposition doesn't
// move this beat; the caller keeps the prior value. `presentIds` excludes
// the reflecting member themself — waiting on yourself isn't a real state,
// and pickNextSpeaker's back-to-back weighting already covers that case.
async function callDispositionUpdate({ client, model, system, userMessage, presentIds = [] }) {
  const start = Date.now();
  const tool = buildDispositionToolSchema(presentIds);
  const response = await client.messages.create({
    model,
    max_tokens: DISPOSITION_MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: userMessage }],
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
  });
  const latencyMs = Date.now() - start;
  const block = response.content.find(b => b.type === 'tool_use');
  const { reflection, waitingOnMemberId, residueNote } = block?.input || {};
  const text = (reflection || '').trim().slice(0, DISPOSITION_MAX_CHARS);
  const target = waitingOnMemberId && waitingOnMemberId !== 'none' && presentIds.includes(waitingOnMemberId)
    ? waitingOnMemberId
    : null;
  // #166: '' rather than undefined when absent, so callers can treat "no
  // residue this beat" uniformly without an extra undefined check.
  const residue = (residueNote || '').trim().slice(0, RESIDUE_NOTE_MAX_CHARS);
  return { text, waitingOnMemberId: target, residueNote: residue, usage: response.usage, latencyMs };
}

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
async function runRound({ client, model, lodgeContext, ROSTER, loadMemberFile,
  presentMemberIds, artifact, notes, roundPrompt, conversationHistory,
  speakerCount, round, onChunk, onMetric, onSpeakerStart, onSpeakerEnd, precedingTurn,
  disposition, loadVoiceExemplar, loadResidue, previousLullNote }) {

  const presentMembers = ROSTER.filter(m => presentMemberIds.includes(m.id));
  const effectiveCount = Math.min(speakerCount, presentMembers.length);
  // #188: mutated in place through the round so a member picked twice in
  // one round (MAX_TURNS_PER_POOL_MEMBER) sees their own just-updated state
  // on the second turn, not the state from before the round started.
  const currentDisposition = { ...(disposition || {}) };
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
    client, model, lodgeContext, presentMembers, instruction: roundPrompt, conversationHistory,
    minCount: effectiveCount, maxCount: initialPoolTarget, round, onMetric,
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
      const { speakers: freshPool, windingDown, lullNote } = await selectSpeakers({
        client, model, lodgeContext, presentMembers, instruction: roundPrompt, conversationHistory,
        minCount: nextCount, maxCount: nextPoolTarget, round, onMetric, roundSoFar,
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

    const memberId = pickNextSpeaker({ pool, spokenCounts, lastSpeakerId, remainingBudget, disposition: currentDisposition });
    if (!memberId) break; // no viable candidate even after a fresh consult — end the round here

    const member = presentMembers.find(m => m.id === memberId);
    if (!member) break; // shouldn't happen — selectSpeakers validates against presentIds

    // #203: read before lastSpeakerId is reassigned below — true when this
    // pick's own disposition named the just-spoken member as unfinished
    // business, regardless of whether INTERRUPT_INTENT_WEIGHT is what
    // actually swung the roll. The framing is true either way: they did
    // want to answer that person, and that person did just speak.
    const interruptedMember = (lastSpeakerId && currentDisposition[memberId]?.waitingOnMemberId === lastSpeakerId)
      ? presentMembers.find(m => m.id === lastSpeakerId)
      : null;

    const unheardCount = pool.filter(id => id !== memberId && !(spokenCounts.get(id) > 0)).length;
    const voiceExemplar = exemplarFor(memberId);
    const residue = residueFor(memberId);
    const system = buildSpeakerSystemPrompt({ lodgeContext, member, artifact, notes, loadMemberFile, disposition: currentDisposition[memberId], voiceExemplar, residue });
    const userMessage = buildSpeakerUserMessage({ roundPrompt, roundSoFarText: roundSoFar, member, remainingBudgetWords: remainingBudget, unheardCount, interruptingName: interruptedMember?.name || null });

    onChunk?.(`${member.name}\n`);
    onSpeakerStart?.(memberId);
    try {
      const { result, attempts } = await withOneRetry(() =>
        callSpeakerTurn({ client, model, system, conversationHistory, userMessage, onChunk, lodgeContext }));
      onMetric?.(makeMetric('speaker', { round, memberId, attempts, usage: result.usage, latencyMs: result.latencyMs, voiceExemplar: voiceExemplar?.id }));

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
        const dispositionSystem = buildDispositionSystemPrompt({ member, priorDisposition: currentDisposition[memberId], presentMembers, priorResidue: priorResidueText });
        const dispositionUserMessage = buildDispositionUserMessage({
          roundSoFarText: contextBeforeTurn || 'Nothing yet — you are the first to speak this round.',
          turnText: settledText, member,
        });
        const dispositionPresentIds = presentMembers.filter(m => m.id !== memberId).map(m => m.id);
        const { text: updatedDisposition, waitingOnMemberId, residueNote, usage: dUsage, latencyMs: dLatencyMs } = await callDispositionUpdate({
          client, model, system: dispositionSystem, userMessage: dispositionUserMessage, presentIds: dispositionPresentIds,
        });
        if (updatedDisposition) currentDisposition[memberId] = { text: updatedDisposition, waitingOnMemberId };
        // #166: only when the beat actually earned a fragment — most beats
        // don't (see the tool schema's "most turns, nothing belongs here").
        if (residueNote) {
          const mergedResidue = mergeResidue(priorResidueText, residueNote);
          residueCache.set(memberId, mergedResidue);
          residueUpdates[memberId] = mergedResidue;
        }
        onMetric?.(makeMetric('disposition', { round, memberId, usage: dUsage, latencyMs: dLatencyMs, waitingOnMemberId, residueNote: residueNote || null }));
      } catch (err) {
        onMetric?.(makeMetric('disposition', { round, memberId, skipped: true, error: err.message }));
        // Best-effort — the member simply carries their prior disposition forward.
      }
    } catch (err) {
      onMetric?.(makeMetric('speaker', { round, memberId, attempts: err.attempts || 1, skipped: true, error: err.message, voiceExemplar: voiceExemplar?.id }));
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

  return { fullRoundText: roundSoFar, speakerOrder, disposition: currentDisposition, residueUpdates, beats: beatsList, endedBy, lullNote };
}

module.exports = {
  buildMemberSection,
  makeMetric,
  withOneRetry,
  buildCachedSystem,
  withHistoryCacheControl,
  buildDirectorToolSchema,
  buildDirectorPrompt,
  callDirector,
  isValidSelection,
  runDirectorSelection,
  selectSpeakers,
  CASTING_DOCUMENT_LIMIT,
  CASTING_TARGET_MIN,
  CASTING_TARGET_MAX,
  buildCastingToolSchema,
  buildCastingPrompt,
  proposeCast,
  lengthTendencyOf,
  pickNextSpeaker,
  isPoolExhausted,
  countWords,
  VOICE_EXEMPLAR_WORD_BUDGET,
  trimToWordBudget,
  buildVoiceExemplarSection,
  RESIDUE_MAX_CHARS,
  RESIDUE_NOTE_MAX_CHARS,
  RESIDUE_SEPARATOR,
  mergeResidue,
  buildResidueSection,
  buildSpeakerSystemPrompt,
  buildSpeakerUserMessage,
  stripInternalBlankLines,
  splitIntoBeats,
  BEAT_WORD_THRESHOLD,
  callSpeakerTurn,
  DISPOSITION_MAX_CHARS,
  buildDispositionToolSchema,
  buildDispositionSystemPrompt,
  buildDispositionUserMessage,
  callDispositionUpdate,
  runRound,
  BREATH_BUDGET_WORDS,
  PASSAGE_END_CAUSES,
  LULL_NOTE_MAX_CHARS,
  STOCK_LULL_NOTES,
  pickStockLullNote,
  resolveLullNote,
};
