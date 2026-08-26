'use strict';

const { makeMetric } = require('./pipeline');

// #193 seam-map, module 5 of 8 — citation verification (#153).
//
// Originally ~250 lines with a single caller (POST
// /api/sessions/:id/verify-citations), already reading like an independent
// module that happened to live inline. client/model are passed in explicitly
// (pipeline.js's convention) rather than read from server.js's module-level
// singletons; the web-escalation tiers need nothing from server.js at all
// beyond the citation data itself.
//
// #355: extraction moved out of this route entirely, to pipeline-disposition.js's
// always-on per-beat piggyback — this file now owns only the deliberate,
// heavier grounding/verdict passes (groundAgainstLibraryText,
// escalateCitationsToWeb) plus flattenBeatCitations, which reads the
// piggyback's accumulated result back out of a session in the flat shape
// those passes (and the cumulative manifest) expect.

// #153 part 1 — for citations the extraction pass matched to a library entry,
// re-judge the verdict against that entry's actual excerpt text instead of
// trusting a title/source-only match against the model's memory. Memory can
// be wrong even when the title matches (see #157: fabricated source_urls
// slipped past exactly this kind of surface-level check). One batched call
// covering every matched citation in the round, not one call each; skipped
// entirely (no extra call) if nothing matched.
async function groundAgainstLibraryText(client, model, citations, libraryLookup, onMetric) {
  const matched = citations
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => c.libraryMatch && libraryLookup[c.libraryMatch]?.text);
  if (!matched.length) return new Map();

  const system = `You are checking whether citations from a transcript are actually supported by the real source text they were matched to. This is a stricter check than general knowledge — treat each "Excerpt" below as ground truth, not your training data.

For each numbered item, judge whether its "Transcript quote" is genuinely consistent with its "Excerpt":
- "verified": the excerpt clearly supports the quote/claim as attributed
- "unverified": the excerpt contradicts it, or doesn't contain/support what's being attributed to it
- "uncertain": the excerpt doesn't clearly settle it either way (e.g. adjacent material, but not this specific claim)`;

  const itemsText = matched
    .map(({ c, index }) => {
      const entry = libraryLookup[c.libraryMatch];
      return `### Item ${index}\nWork cited: ${c.work}\nTranscript quote: "${c.quote}"\n\nExcerpt from "${entry.title}" (${entry.source}):\n${entry.text}`;
    })
    .join('\n\n---\n\n');

  const start = Date.now();
  const response = await client.messages.create({
    model,
    max_tokens: 2000,
    // #436: same reasoning as callDirector/callDispositionUpdate (#406) --
    // tool-only output has no use for adaptive thinking, and disabling it
    // removes any risk of the reasoning budget eating into max_tokens.
    // Flagged as a likely sibling gap in #436, not itself reproduced live.
    thinking: { type: 'disabled' },
    system,
    messages: [{ role: 'user', content: itemsText }],
    tools: [
      {
        name: 'report_grounded_verdicts',
        description: 'Report a text-grounded verdict for each numbered item.',
        input_schema: {
          type: 'object',
          properties: {
            verdicts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'integer', description: 'The item number from the prompt.' },
                  verdict: { type: 'string', enum: ['verified', 'unverified', 'uncertain'] },
                  note: { type: 'string', description: 'One-sentence reasoning, referencing the excerpt directly.' },
                },
                required: ['index', 'verdict', 'note'],
              },
            },
          },
          required: ['verdicts'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'report_grounded_verdicts' },
  });
  const latencyMs = Date.now() - start;
  onMetric?.(makeMetric('citation-grounding', { usage: response.usage, latencyMs }));

  const block = response.content.find(b => b.type === 'tool_use');
  const verdicts = block?.input?.verdicts || [];
  return new Map(verdicts.map(v => [v.index, v]));
}

// #153 part 2 — for citations the extraction pass could NOT match to a
// library entry, attempt a real lookup against open-data sources before
// falling back to the model's own unconfirmed judgment. Hand-rolled fetches
// (decided 2026-08-05) rather than Anthropic's hosted web-search tool — that
// route is #111's proposal, kept open as a fallback tier, not this one.
// Tiered by closeness to primary text: archive.org full-text "search inside"
// scanned books, then Wikisource's proofread transcriptions, then Wikipedia
// (existence only, not quote-level), then Wikidata (biographical/factual
// claims). Bounded to MAX_WEB_ESCALATIONS lookups per run — these are free
// public APIs shared with everyone else using them, not something to hammer
// on a long transcript. Session-scoped only for now (v1 decision): results
// aren't written back into prompts/library/ — that stays a human-curated
// promotion step via scripts/build-citation-manifest.js, gated by
// verify-library-sources.js (#157).
const MAX_WEB_ESCALATIONS = 6;
const WEB_FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const normalizeForWebMatch = s =>
  (s || '')
    .replace(/[*"'“”‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const STOPWORDS = new Set(['the', 'and', 'of', 'a', 'an', 'to', 'in', 'on', 'by', 'or', 'from', 'with', 'his', 'her']);
const tokenizeForWebMatch = s =>
  normalizeForWebMatch(s)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
// A famous phrase can turn up verbatim inside a completely unrelated book
// that merely quotes it (found in testing: a Dickens opening line matched a
// stand-up comedy memoir that happened to quote it). Requiring at least one
// significant word from the cited work to appear in the matched doc's title
// or creator keeps a real phrase-hit from being credited to the wrong book.
// Word-set comparison, not substring — a naive .includes() lets "tale"
// false-match inside "tales" (also caught in testing).
function worksOverlap(work, doc) {
  const haystackWords = new Set(tokenizeForWebMatch(`${doc.title || ''} ${doc.creator || ''}`));
  const words = tokenizeForWebMatch(work).filter(w => w.length > 3 && !STOPWORDS.has(w));
  return words.some(w => haystackWords.has(w));
}

// Tier 1: archive.org full-text search across scanned books — the closest
// available thing to genuine quote-grounding for public-domain works. Same
// fetch pattern as scripts/verify-library-sources.js's archive.org check.
async function tryArchiveOrgFullText(work, quote) {
  if (!quote) return { status: 'not-found' };
  const q = `"${quote.replace(/"/g, '')}" AND mediatype:texts`;
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=creator&output=json&rows=5`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return { status: 'error', reason: `HTTP ${res.status}` };
    const data = await res.json();
    const docs = data?.response?.docs || [];
    const doc = docs.find(d => worksOverlap(work, d));
    if (!doc) return { status: 'not-found' };
    return {
      status: 'confirmed',
      webSourceUrl: `https://archive.org/details/${doc.identifier}`,
      webSourceTitle: doc.title || doc.identifier,
      note: `Confirmed: this phrase was found via archive.org full-text search inside "${doc.title || doc.identifier}".`,
    };
  } catch (err) {
    return { status: 'error', reason: err.message };
  }
}

// Tier 2: Wikisource — human-transcribed, proofread primary texts (already
// used for the Julian of Norwich entry via #155). Only counts as a hit if
// the quote actually appears in the page's extract, not just a title match.
async function tryWikisource(work, quote) {
  const searchUrl = `https://en.wikisource.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(work)}&srlimit=1&format=json&origin=*`;
  try {
    const searchRes = await fetchWithTimeout(searchUrl);
    if (!searchRes.ok) return { status: 'error', reason: `HTTP ${searchRes.status}` };
    const searchData = await searchRes.json();
    const title = searchData?.query?.search?.[0]?.title;
    if (!title) return { status: 'not-found' };

    const extractUrl = `https://en.wikisource.org/w/api.php?action=query&prop=extracts&explaintext=1&titles=${encodeURIComponent(title)}&format=json&origin=*`;
    const extractRes = await fetchWithTimeout(extractUrl);
    if (!extractRes.ok) return { status: 'error', reason: `HTTP ${extractRes.status}` };
    const extractData = await extractRes.json();
    const extract = Object.values(extractData?.query?.pages || {})[0]?.extract || '';
    const snippet = normalizeForWebMatch(quote).split(' ').slice(0, 8).join(' ');
    if (!snippet || !normalizeForWebMatch(extract).includes(snippet)) return { status: 'not-found' };
    return {
      status: 'confirmed',
      webSourceUrl: `https://en.wikisource.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      webSourceTitle: title,
      note: `Confirmed against Wikisource's transcription of "${title}".`,
    };
  } catch (err) {
    return { status: 'error', reason: err.message };
  }
}

// Tier 3: Wikipedia summary — confirms the work/author exists and roughly
// what it's about, not that this specific quote is accurate. A hit here
// stays "uncertain (unconfirmed)", never "verified".
async function tryWikipediaSummary(work) {
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(work)}&limit=1&format=json&origin=*`;
  try {
    const searchRes = await fetchWithTimeout(searchUrl);
    if (!searchRes.ok) return { status: 'error', reason: `HTTP ${searchRes.status}` };
    const [, titles] = await searchRes.json();
    const title = titles?.[0];
    if (!title) return { status: 'not-found' };

    const summaryRes = await fetchWithTimeout(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`
    );
    if (summaryRes.status === 404) return { status: 'not-found' };
    if (!summaryRes.ok) return { status: 'error', reason: `HTTP ${summaryRes.status}` };
    const data = await summaryRes.json();
    if (data.type === 'disambiguation') return { status: 'not-found' };
    return {
      status: 'existence-only',
      webSourceUrl:
        data.content_urls?.desktop?.page ||
        `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      webSourceTitle: data.title || title,
      note: `"${work}" exists per Wikipedia, but this specific quote/claim wasn't independently confirmed — uncertain (unconfirmed).`,
    };
  } catch (err) {
    return { status: 'error', reason: err.message };
  }
}

// Tier 4: Wikidata — narrow use for factual/biographical claims (dates,
// authorship) rather than quoted text. Same existence-only ceiling as tier 3.
async function tryWikidata(work) {
  const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(work)}&language=en&format=json&origin=*`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return { status: 'error', reason: `HTTP ${res.status}` };
    const data = await res.json();
    const hit = data?.search?.[0];
    if (!hit) return { status: 'not-found' };
    return {
      status: 'existence-only',
      webSourceUrl: `https://www.wikidata.org/wiki/${hit.id}`,
      webSourceTitle: hit.label || work,
      note: `"${work}" exists as a Wikidata entity${hit.description ? ` (${hit.description})` : ''}, but this specific quote/claim wasn't independently confirmed — uncertain (unconfirmed).`,
    };
  } catch (err) {
    return { status: 'error', reason: err.message };
  }
}

// Runs the tiers in order for one citation. A "confirmed" or "existence-only"
// hit becomes real web-grounded evidence, overriding the model's own guess.
// A clean miss across every tier (no matches, no errors) means the work
// genuinely isn't found in these open sources — falls back to the model's
// original memory-based verdict, unchanged, rather than punishing citations
// of real but un-archived modern scholarship. Only an actual technical
// failure (network error, timeout, rate-limit) on every tier degrades the
// verdict to "uncertain (unconfirmed)" — we attempted a check and couldn't
// complete it, so trusting bare memory alone would be worse than saying so.
async function escalateCitationToWeb(citation) {
  const tiers = [
    () => tryArchiveOrgFullText(citation.work, citation.quote),
    () => tryWikisource(citation.work, citation.quote),
    () => tryWikipediaSummary(citation.work),
    () => tryWikidata(citation.work),
  ];
  let sawError = false;
  for (const tier of tiers) {
    const result = await tier();
    if (result.status === 'confirmed') {
      return {
        verdict: 'verified',
        note: result.note,
        source: 'web',
        webSourceUrl: result.webSourceUrl,
        webSourceTitle: result.webSourceTitle,
      };
    }
    if (result.status === 'existence-only') {
      return {
        verdict: 'uncertain',
        note: result.note,
        source: 'web',
        webSourceUrl: result.webSourceUrl,
        webSourceTitle: result.webSourceTitle,
      };
    }
    if (result.status === 'error') sawError = true;
  }
  if (sawError) {
    return {
      verdict: 'uncertain',
      note: `${citation.note} — uncertain (unconfirmed): web verification was attempted but unavailable.`,
      source: 'model-knowledge',
    };
  }
  return null;
}

// #355: citations are now captured always-on, per beat, at write time
// (pipeline-disposition.js's piggyback on the existing disposition call) —
// this reads that accumulated result back out for a session, in the same
// flat shape /verify-citations used to build fresh with its own
// whole-transcript extraction call. `roster` resolves memberId to a display
// name; a beat from a non-roster speaker (the player, the interjecting
// presence) falls back to its own `speakerName`, though neither currently
// earns citations — the piggyback only fires on the AI speaker-turn path.
// Shared by /verify-citations (src/routes/session.js) and the cumulative
// manifest (scripts/build-citation-manifest.js) so both read the same
// accumulated data instead of each re-deriving their own view of it.
function flattenBeatCitations(session, roster = []) {
  const flat = [];
  (session.rounds || []).forEach(segment => {
    (segment.beats || []).forEach(beat => {
      if (beat.failed || !Array.isArray(beat.citations) || !beat.citations.length) return;
      const speaker = roster.find(m => m.id === beat.memberId)?.name || beat.speakerName || beat.memberId;
      beat.citations.forEach(c => flat.push({ ...c, speaker, memberId: beat.memberId }));
    });
  });
  return flat;
}

// #356: same shape and same always-on-capture story as flattenBeatCitations,
// for the weaker invoked-works tier (a text/author/tradition gestured at by
// name without a supporting quote) — see pipeline-disposition.js's
// invokedWorks tool field. Kept as its own function rather than a flag on
// flattenBeatCitations since the two tiers are deliberately never merged —
// the bibliography appendix (src/bibliography.js) keeps them in separate
// sections, and blending them here would make that separation easy to lose.
function flattenBeatInvokedWorks(session, roster = []) {
  const flat = [];
  (session.rounds || []).forEach(segment => {
    (segment.beats || []).forEach(beat => {
      if (beat.failed || !Array.isArray(beat.invokedWorks) || !beat.invokedWorks.length) return;
      const speaker = roster.find(m => m.id === beat.memberId)?.name || beat.speakerName || beat.memberId;
      beat.invokedWorks.forEach(w => flat.push({ ...w, speaker, memberId: beat.memberId }));
    });
  });
  return flat;
}

async function escalateCitationsToWeb(citations) {
  const unmatched = citations
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => !c.libraryMatch)
    .slice(0, MAX_WEB_ESCALATIONS);

  const results = new Map();
  for (const { c, index } of unmatched) {
    try {
      const outcome = await escalateCitationToWeb(c);
      if (outcome) results.set(index, outcome);
    } catch (err) {
      console.error('Web escalation error for citation', index, err);
    }
  }
  return results;
}

module.exports = {
  MAX_WEB_ESCALATIONS,
  WEB_FETCH_TIMEOUT_MS,
  groundAgainstLibraryText,
  fetchWithTimeout,
  worksOverlap,
  tryArchiveOrgFullText,
  tryWikisource,
  tryWikipediaSummary,
  tryWikidata,
  escalateCitationToWeb,
  escalateCitationsToWeb,
  flattenBeatCitations,
  flattenBeatInvokedWorks,
};
