'use strict';

// #284 seam-map, module 1 of 6 — shared low-level helpers with no
// dependency on any other pipeline-* module. Split out so pipeline-director,
// pipeline-casting, and pipeline-speaker (which all need these) can require
// this file without creating a cycle back through pipeline.js, which is
// itself a caller of theirs (see pipeline.js's own top-of-file comment).

// ── Metrics ─────────────────────────────────────────────────────────────────

// Cost/latency/failure observability is a first-class requirement, not an
// afterthought — every director and per-speaker call attempt (including
// retries, skips, and fallbacks) produces one of these, persisted alongside
// the session so it's reviewable after the fact, not just an ephemeral
// console line.
function makeMetric(
  phase,
  {
    round,
    memberId,
    attempts,
    usage,
    latencyMs,
    skipped,
    error,
    reasoning,
    voiceExemplar,
    waitingOnMemberId,
    residueNote,
    citationCount,
  } = {}
) {
  return {
    phase, // 'director' | 'speaker' | 'casting' | 'disposition' | 'citation-grounding'
    round: round ?? null,
    memberId: memberId || null,
    attempts: attempts ?? 1,
    usage: usage
      ? {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          // #190: proof the cache breakpoints are actually paying off — a
          // non-zero read here on a repeat director/speaker call is the signal
          // to look for, not just a lower input_tokens count.
          cache_read_input_tokens: usage.cache_read_input_tokens ?? null,
        }
      : null,
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
    // #355: how many citations this beat's piggybacked extraction found —
    // 0 is the ordinary case, not an absence; distinct from `null` so a
    // real session can be checked for extraction volume without re-reading
    // beats[].citations by hand. Always null off every phase but 'disposition'.
    citationCount: citationCount ?? null,
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
    const content =
      typeof message.content === 'string'
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

module.exports = {
  makeMetric,
  buildCachedSystem,
  withHistoryCacheControl,
  withOneRetry,
};
