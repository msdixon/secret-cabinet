'use strict';

// Ad hoc validation for #153 part 2 (web-escalation): for citations with no
// library match, does a real lookup against open-data sources actually
// confirm/deny rather than just trusting the model's memory? No Anthropic
// call involved here — this exercises pure fetch logic, duplicated from
// server.js's escalateCitationToWeb() rather than required from it (server.js
// calls app.listen() on require, same reasoning as test-library-grounding.js
// keeping its own copy of groundAgainstLibraryText()).
// No test framework exists in this repo — matches its existing ad hoc
// script style (see scripts/test-director.js). Run with:
//   node scripts/test-web-escalation.js

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

function worksOverlap(work, doc) {
  const haystackWords = new Set(tokenizeForWebMatch(`${doc.title || ''} ${doc.creator || ''}`));
  const words = tokenizeForWebMatch(work).filter(w => w.length > 3 && !STOPWORDS.has(w));
  return words.some(w => haystackWords.has(w));
}

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

async function main() {
  const cases = [
    {
      label: 'real quote, correctly-named work — should confirm via some tier, never wrongly land on the wrong book',
      work: 'The Interpretation of Dreams',
      quote: 'the interpretation of dreams is the royal road to a knowledge of the unconscious',
      note: 'orig note',
      check: r => r && r.source === 'web',
    },
    {
      label:
        'famous phrase misattributed to an unrelated invented work — must NOT confirm just because the phrase exists somewhere',
      work: 'Some Unrelated Nonexistent Treatise on Bee Farming',
      quote: 'it was the best of times, it was the worst of times',
      note: 'orig note',
      check: r => !r || r.verdict !== 'verified',
    },
    {
      label: 'real historical figure, general claim — existence-only tier, must stay uncertain not verified',
      work: 'Jacob Boehme',
      quote: 'the fire is the father of light',
      note: 'orig note',
      check: r => r && r.source === 'web' && r.verdict === 'uncertain',
    },
    {
      label:
        'wholly fabricated work and quote — clean miss (falls back to model verdict) or graceful error-degrade, never falsely verified',
      work: 'Xyzzptlk Fnord Grimoire of Nonexistence',
      quote: 'this quote does not exist anywhere at all zzz999',
      note: 'orig note',
      check: r => !r || r.verdict !== 'verified',
    },
  ];

  let allPass = true;
  for (const c of cases) {
    const result = await escalateCitationToWeb(c);
    const pass = c.check(result);
    allPass = allPass && pass;
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${c.label}`);
    console.log(
      `  result: ${result ? JSON.stringify({ verdict: result.verdict, source: result.source, webSourceTitle: result.webSourceTitle }) : 'null (clean miss)'}\n`
    );
  }

  console.log(allPass ? 'All cases behaved as expected.' : 'Some cases did not behave as expected — see above.');
  process.exitCode = allPass ? 0 : 1;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
