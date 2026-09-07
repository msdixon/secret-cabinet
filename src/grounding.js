'use strict';

// #514 — user-supplied grounding (Zotero/bibliography upload). Decided
// 2026-09-03 on the issue: guardrail-by-default, not contextmax. A
// researcher's own uploaded material is used to verify/constrain a citation
// the model already made in a beat — pipeline-disposition.js's existing
// always-on per-beat extraction (#355), the same source citations.js's
// groundAgainstLibraryText (curated #35a library) and escalateCitationsToWeb
// (open web) already re-check — never to hand the model more raw material to
// draw new, unconstrained voice from. Nothing here is fed into a member's
// speaking-turn prompt; this module only ever runs after a beat, judging
// text the model already spoke against text the researcher already
// supplied.
//
// Session-scoped and ephemeral by construction: everything lives in an
// in-memory Map, keyed by session id, that this module owns exclusively.
// It is never written to a session's persisted JSON (sessions-store.js), the
// curated library (library.js, prompts/library/), or anywhere any of the
// scripts/build-*.js promotion tooling reads from — there is no code path by
// which an upload here can reach the shared library #356/#35a's trust model
// depends on. It disappears on server restart, and src/routes/session.js
// clears it explicitly when a session is deleted; nothing else keeps it
// alive.
//
// See tuning.js's "User-supplied grounding" section for the five cost-lever
// constants this module applies (verify claims not documents; triage before
// spending a call; a hard per-session cap on verification calls; a
// session-scoped ephemeral index as the large-corpus fallback; size-gated
// retrieval).

const {
  MAX_GROUNDING_CHARS_PER_SESSION,
  MAX_GROUNDING_SOURCES_PER_SESSION,
  GROUNDING_KEYWORD_SEARCH_CHAR_THRESHOLD,
  GROUNDING_CHUNK_CHARS,
  GROUNDING_RETRIEVAL_TOP_K,
  GROUNDING_MIN_QUOTE_CHARS_FOR_CHECK,
  MAX_GROUNDING_VERIFICATIONS_PER_SESSION,
  MAX_GROUNDING_RESULTS_PER_VERIFY_CALL,
} = require('./tuning');
const { makeMetric } = require('./pipeline');

const store = new Map();

function getOrInit(sessionId) {
  let entry = store.get(sessionId);
  if (!entry) {
    entry = { sources: [], text: '', index: null, verificationsUsed: 0 };
    store.set(sessionId, entry);
  }
  return entry;
}

function summarize(entry) {
  return {
    sources: entry.sources.map(s => ({ filename: s.filename, chars: s.chars, truncated: !!s.truncated })),
    totalChars: entry.text.length,
    verificationsUsed: entry.verificationsUsed,
    verificationsRemaining: Math.max(0, MAX_GROUNDING_VERIFICATIONS_PER_SESSION - entry.verificationsUsed),
  };
}

const EMPTY_SUMMARY = {
  sources: [],
  totalChars: 0,
  verificationsUsed: 0,
  verificationsRemaining: MAX_GROUNDING_VERIFICATIONS_PER_SESSION,
};

// Adds one uploaded/pasted source's text to a session's corpus. Trims to
// whatever room is left under MAX_GROUNDING_CHARS_PER_SESSION rather than
// rejecting the whole file outright — a partial add of a huge PDF is more
// useful than none of it, and the caller is told it was truncated.
function addGroundingSource(sessionId, filename, text) {
  const clean = (text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!clean) return { added: false, error: 'No readable text found' };

  const entry = getOrInit(sessionId);
  if (entry.sources.length >= MAX_GROUNDING_SOURCES_PER_SESSION) {
    return { added: false, error: `This session already has ${MAX_GROUNDING_SOURCES_PER_SESSION} sources — that's the cap` };
  }
  const remaining = MAX_GROUNDING_CHARS_PER_SESSION - entry.text.length;
  if (remaining <= 0) {
    return { added: false, error: 'This session\'s uploaded material is already at its size cap' };
  }

  const truncated = clean.length > remaining;
  const kept = truncated ? clean.slice(0, remaining) : clean;
  entry.text += (entry.text ? '\n\n' : '') + kept;
  entry.sources.push({
    filename: (filename || 'pasted text').slice(0, 200),
    chars: kept.length,
    truncated,
    addedAt: new Date().toISOString(),
  });
  entry.index = null; // corpus changed — rebuilt lazily on next search
  return { added: true, truncated, summary: summarize(entry) };
}

function getGroundingSummary(sessionId) {
  const entry = store.get(sessionId);
  return entry ? summarize(entry) : EMPTY_SUMMARY;
}

function hasGrounding(sessionId) {
  const entry = store.get(sessionId);
  return !!entry && entry.text.length > 0;
}

function clearGrounding(sessionId) {
  store.delete(sessionId);
}

// ── Chunking + size-gated retrieval (cost levers 4 and 5) ──────────────────

// Splits on paragraph boundaries first (keeps a chunk's text coherent),
// falling back to a hard slice for any one paragraph longer than a chunk on
// its own (a PDF extraction can legitimately produce one giant run-on block).
function buildChunks(text) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean);
  const chunks = [];
  let current = '';
  for (const p of paragraphs) {
    if (current && current.length + p.length + 2 > GROUNDING_CHUNK_CHARS) {
      chunks.push(current);
      current = '';
    }
    current = current ? `${current}\n\n${p}` : p;
    while (current.length > GROUNDING_CHUNK_CHARS * 1.5) {
      chunks.push(current.slice(0, GROUNDING_CHUNK_CHARS));
      current = current.slice(GROUNDING_CHUNK_CHARS);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

const STOPWORDS = new Set([
  'the', 'and', 'of', 'a', 'an', 'to', 'in', 'on', 'by', 'or', 'from', 'with',
  'his', 'her', 'their', 'is', 'was', 'were', 'that', 'this', 'as', 'at', 'it',
  'be', 'are', 'for', 'not', 'but', 'had', 'has', 'have',
]);
function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

// Below-threshold tier: plain containment scoring, no precomputation — how
// many distinct query terms does each chunk contain. Cheap, and sufficient
// when the whole corpus is small enough that a handful of chunks won't
// tie.
function rankByContainment(chunks, queryWords, topK) {
  return chunks
    .map(text => {
      const words = new Set(tokenize(text));
      let hits = 0;
      queryWords.forEach(w => {
        if (words.has(w)) hits += 1;
      });
      return { text, score: hits };
    })
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(c => c.text);
}

// At/above-threshold tier: build the index once (per-chunk term frequencies,
// per-term document frequencies across the whole corpus), then score each
// claim's query by TF-IDF. Rarer terms across the corpus count for more,
// which is what plain containment above can't express once most chunks
// contain at least one of the query's common words.
function buildIndex(chunks) {
  const tokenized = chunks.map(tokenize);
  const df = new Map();
  tokenized.forEach(words => {
    new Set(words).forEach(w => df.set(w, (df.get(w) || 0) + 1));
  });
  return { chunks, tokenized, df, docCount: chunks.length };
}

function rankByTfIdf(index, queryWords, topK) {
  return index.chunks
    .map((text, i) => {
      const tf = new Map();
      index.tokenized[i].forEach(w => tf.set(w, (tf.get(w) || 0) + 1));
      let score = 0;
      queryWords.forEach(w => {
        const termFreq = tf.get(w) || 0;
        if (!termFreq) return;
        const idf = Math.log((index.docCount + 1) / ((index.df.get(w) || 0) + 1)) + 1;
        score += termFreq * idf;
      });
      return { text, score };
    })
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(c => c.text);
}

// Returns up to `topK` passages from this session's uploaded corpus most
// relevant to `queryText` (typically a claim's cited work + quote). Empty
// array means no session material, or nothing in it plausibly relevant —
// both are treated identically by the caller (no verification call spent).
function searchGrounding(sessionId, queryText, topK = GROUNDING_RETRIEVAL_TOP_K) {
  const entry = store.get(sessionId);
  if (!entry || !entry.text) return [];
  const queryWords = new Set(tokenize(queryText));
  if (!queryWords.size) return [];

  if (entry.text.length < GROUNDING_KEYWORD_SEARCH_CHAR_THRESHOLD) {
    return rankByContainment(buildChunks(entry.text), queryWords, topK);
  }
  if (!entry.index) entry.index = buildIndex(buildChunks(entry.text));
  return rankByTfIdf(entry.index, queryWords, topK);
}

// ── Triage + guardrail verification (cost levers 1, 2, 3) ──────────────────

// #514 cost lever 2 — only a citation with a real quote is checkable at all
// (nothing to search retrieval against without one), and a citation already
// matched to the curated library is skipped — that's a stronger, already-run
// tier (citations.js's groundAgainstLibraryText), and spending a call to
// second-guess it against a researcher's own unvetted upload would be
// backwards.
function triageCheckableClaims(citations) {
  return citations
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => !c.libraryMatch && (c.quote || '').trim().length >= GROUNDING_MIN_QUOTE_CHARS_FOR_CHECK);
}

// #514 cost lever 1 — verifies the specific claims the model already
// extracted against retrieved passages, never the whole uploaded document at
// once. One batched call per invocation (same "one call covering every
// matched item, not one each" discipline as citations.js's
// groundAgainstLibraryText), covering only claims that both passed triage and
// turned up a retrieval hit — a claim with no hit costs nothing further, same
// as escalateCitationToWeb's clean-miss handling.
async function verifyClaimsAgainstGrounding({ client, model, sessionId, citations, onMetric }) {
  const entry = store.get(sessionId);
  if (!entry || !entry.text) return new Map();

  const budgetLeft = MAX_GROUNDING_VERIFICATIONS_PER_SESSION - entry.verificationsUsed;
  if (budgetLeft <= 0) return new Map();

  const withHits = triageCheckableClaims(citations)
    .map(({ c, index }) => ({ c, index, passages: searchGrounding(sessionId, `${c.work} ${c.quote}`) }))
    .filter(({ passages }) => passages.length)
    .slice(0, Math.min(budgetLeft, MAX_GROUNDING_RESULTS_PER_VERIFY_CALL));

  if (!withHits.length) return new Map();

  // Spent regardless of what the model concludes — a retrieval hit that
  // turns out not to address the claim still cost a real call.
  entry.verificationsUsed += withHits.length;

  const system = `You are checking whether citations from a transcript are supported by passages from a researcher's own uploaded material (not a vetted archival library — treat it as real but unverified evidence, same as you would a colleague's own working files).

For each numbered item, judge whether its "Transcript quote" is addressed by its "Retrieved passage(s)":
- "confirmed": the passage clearly supports the quote/claim as attributed
- "contradicted": the passage clearly disputes or contradicts it
- "not-addressed": the passage doesn't clearly settle this specific claim either way — including if it's merely adjacent material. This is the common case; retrieval is keyword-based and often surfaces something related but not conclusive. Don't stretch a loose match into "confirmed."`;

  const itemsText = withHits
    .map(
      ({ c, index, passages }) =>
        `### Item ${index}\nWork cited: ${c.work}\nTranscript quote: "${c.quote}"\n\nRetrieved passage(s):\n${passages.join('\n\n---\n\n')}`
    )
    .join('\n\n===\n\n');

  const start = Date.now();
  const response = await client.messages.create({
    model,
    max_tokens: 2000,
    thinking: { type: 'disabled' },
    system,
    messages: [{ role: 'user', content: itemsText }],
    tools: [
      {
        name: 'report_grounding_verdicts',
        description: 'Report a verdict for each numbered item, judged only against its retrieved passage(s).',
        input_schema: {
          type: 'object',
          properties: {
            verdicts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'integer', description: 'The item number from the prompt.' },
                  verdict: { type: 'string', enum: ['confirmed', 'contradicted', 'not-addressed'] },
                  note: { type: 'string', description: 'One-sentence reasoning, referencing the passage directly.' },
                },
                required: ['index', 'verdict', 'note'],
              },
            },
          },
          required: ['verdicts'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'report_grounding_verdicts' },
  });
  const latencyMs = Date.now() - start;
  onMetric?.(makeMetric('grounding-verify', { usage: response.usage, latencyMs }));

  const block = response.content.find(b => b.type === 'tool_use');
  const verdicts = block?.input?.verdicts || [];
  const sourceTitle = entry.sources.map(s => s.filename).join(', ');

  const results = new Map();
  verdicts.forEach(v => {
    // "not-addressed" means the retrieval hit didn't actually settle
    // anything — leave the citation's own verdict unchanged rather than
    // downgrading a confident self-judgment on a merely-adjacent keyword
    // match. Same "clean miss leaves the prior verdict alone" philosophy as
    // citations.js's escalateCitationToWeb.
    if (v.verdict === 'not-addressed') return;
    results.set(v.index, {
      verdict: v.verdict === 'confirmed' ? 'verified' : 'unverified',
      note: v.note,
      source: 'user-grounding',
      groundingSourceTitle: sourceTitle,
    });
  });
  return results;
}

module.exports = {
  addGroundingSource,
  getGroundingSummary,
  hasGrounding,
  clearGrounding,
  searchGrounding,
  triageCheckableClaims,
  verifyClaimsAgainstGrounding,
  // exported for tests
  buildChunks,
  tokenize,
};
