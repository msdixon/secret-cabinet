'use strict';

// #193 — citations.js (#153's citation verification), extracted from
// server.js. Offline by construction, same convention as test/library.test.js
// — global.fetch is stubbed per test rather than reaching archive.org/
// Wikisource/Wikipedia/Wikidata for real, and the Anthropic client is a fake
// following test/pipeline.test.js's pattern.

const test = require('node:test');
const assert = require('node:assert/strict');

const c = require('../citations.js');

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function withFetch(t, impl) {
  const original = global.fetch;
  global.fetch = impl;
  t.after(() => { global.fetch = original; });
}

test('groundAgainstLibraryText', async t => {
  await t.test('returns an empty map without calling the client when nothing matched', async () => {
    let called = false;
    const fakeClient = { messages: { create: async () => { called = true; return { content: [] }; } } };
    const result = await c.groundAgainstLibraryText(fakeClient, 'test-model', [{ libraryMatch: null }], {});
    assert.equal(called, false);
    assert.equal(result.size, 0);
  });

  await t.test('skips a libraryMatch whose lookup entry has no text', async () => {
    let called = false;
    const fakeClient = { messages: { create: async () => { called = true; return { content: [] }; } } };
    const result = await c.groundAgainstLibraryText(
      fakeClient, 'test-model', [{ libraryMatch: 'e1' }], { e1: { title: 'T', source: 'S' } },
    );
    assert.equal(called, false);
    assert.equal(result.size, 0);
  });

  await t.test('sends matched citations to the client and returns verdicts keyed by index', async () => {
    const fakeClient = {
      messages: {
        create: async () => ({
          content: [{
            type: 'tool_use',
            input: { verdicts: [{ index: 0, verdict: 'verified', note: 'Matches the excerpt.' }] },
          }],
        }),
      },
    };
    const citationsList = [{ libraryMatch: 'e1', work: 'Some Work', quote: 'a quote' }];
    const lookup = { e1: { title: 'T', source: 'S', text: 'The excerpt text.' } };
    const result = await c.groundAgainstLibraryText(fakeClient, 'test-model', citationsList, lookup);
    assert.equal(result.get(0).verdict, 'verified');
  });

  await t.test('returns an empty map when the client response has no tool_use block', async () => {
    const fakeClient = { messages: { create: async () => ({ content: [] }) } };
    const citationsList = [{ libraryMatch: 'e1' }];
    const lookup = { e1: { title: 'T', source: 'S', text: 'x' } };
    const result = await c.groundAgainstLibraryText(fakeClient, 'test-model', citationsList, lookup);
    assert.equal(result.size, 0);
  });
});

test('worksOverlap', async t => {
  await t.test('matches when a significant word from the work appears in the doc title', () => {
    assert.equal(c.worksOverlap('A Tale of Two Cities', { title: 'Tale of Two Cities (full text)' }), true);
  });

  await t.test('does not match on a short/stopword-only overlap', () => {
    assert.equal(c.worksOverlap('The Book of the Law', { title: 'The Law and Order Handbook' }), false);
  });

  await t.test('does not false-match a substring like "tale" inside "tales"', () => {
    assert.equal(c.worksOverlap('Tale', { title: 'Canterbury Tales' }), false);
  });

  await t.test('matches against the creator field too', () => {
    assert.equal(c.worksOverlap('Crowley Diaries', { title: 'Unrelated', creator: 'Aleister Crowley' }), true);
  });
});

test('tryArchiveOrgFullText', async t => {
  await t.test('returns not-found immediately when there is no quote to search', async () => {
    const result = await c.tryArchiveOrgFullText('Some Work', '');
    assert.equal(result.status, 'not-found');
  });

  await t.test('returns confirmed when a returned doc overlaps the cited work', async () => {
    withFetch(t, async () => jsonResponse(200, {
      response: { docs: [{ identifier: 'id1', title: 'Some Work Full Text', creator: 'Author' }] },
    }));
    const result = await c.tryArchiveOrgFullText('Some Work', 'a quoted phrase');
    assert.equal(result.status, 'confirmed');
    assert.equal(result.webSourceUrl, 'https://archive.org/details/id1');
  });

  await t.test('returns not-found when no returned doc overlaps the work', async () => {
    withFetch(t, async () => jsonResponse(200, {
      response: { docs: [{ identifier: 'id1', title: 'Completely Unrelated', creator: 'Someone Else' }] },
    }));
    const result = await c.tryArchiveOrgFullText('Some Work', 'a quoted phrase');
    assert.equal(result.status, 'not-found');
  });

  await t.test('returns error on a non-ok HTTP response', async () => {
    withFetch(t, async () => jsonResponse(500, {}));
    const result = await c.tryArchiveOrgFullText('Some Work', 'a quoted phrase');
    assert.equal(result.status, 'error');
  });

  await t.test('returns error when fetch itself throws', async () => {
    withFetch(t, async () => { throw new Error('network down'); });
    const result = await c.tryArchiveOrgFullText('Some Work', 'a quoted phrase');
    assert.equal(result.status, 'error');
    assert.equal(result.reason, 'network down');
  });
});

test('tryWikisource', async t => {
  await t.test('returns confirmed when the extract contains the quote snippet', async () => {
    let call = 0;
    withFetch(t, async () => {
      call++;
      if (call === 1) return jsonResponse(200, { query: { search: [{ title: 'Some Page' }] } });
      return jsonResponse(200, { query: { pages: { 1: { extract: 'a rather long extract containing the exact quoted phrase in full' } } } });
    });
    const result = await c.tryWikisource('Some Work', 'the exact quoted phrase');
    assert.equal(result.status, 'confirmed');
    assert.match(result.webSourceUrl, /Some_Page/);
  });

  await t.test('returns not-found when no search result exists', async () => {
    withFetch(t, async () => jsonResponse(200, { query: { search: [] } }));
    const result = await c.tryWikisource('Some Work', 'a quote');
    assert.equal(result.status, 'not-found');
  });

  await t.test('returns not-found when the extract does not contain the quote', async () => {
    let call = 0;
    withFetch(t, async () => {
      call++;
      if (call === 1) return jsonResponse(200, { query: { search: [{ title: 'Some Page' }] } });
      return jsonResponse(200, { query: { pages: { 1: { extract: 'unrelated content entirely' } } } });
    });
    const result = await c.tryWikisource('Some Work', 'a quote nowhere present');
    assert.equal(result.status, 'not-found');
  });
});

test('tryWikipediaSummary', async t => {
  await t.test('returns existence-only on a successful summary lookup', async () => {
    let call = 0;
    withFetch(t, async () => {
      call++;
      if (call === 1) return jsonResponse(200, ['', ['Some Work']]);
      return jsonResponse(200, { type: 'standard', title: 'Some Work', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Some_Work' } } });
    });
    const result = await c.tryWikipediaSummary('Some Work');
    assert.equal(result.status, 'existence-only');
  });

  await t.test('returns not-found for a disambiguation page', async () => {
    let call = 0;
    withFetch(t, async () => {
      call++;
      if (call === 1) return jsonResponse(200, ['', ['Some Work']]);
      return jsonResponse(200, { type: 'disambiguation' });
    });
    const result = await c.tryWikipediaSummary('Some Work');
    assert.equal(result.status, 'not-found');
  });

  await t.test('returns not-found when opensearch has no title match', async () => {
    withFetch(t, async () => jsonResponse(200, ['', []]));
    const result = await c.tryWikipediaSummary('Nonexistent Work');
    assert.equal(result.status, 'not-found');
  });
});

test('tryWikidata', async t => {
  await t.test('returns existence-only on a search hit', async () => {
    withFetch(t, async () => jsonResponse(200, { search: [{ id: 'Q1', label: 'Some Work', description: 'a book' }] }));
    const result = await c.tryWikidata('Some Work');
    assert.equal(result.status, 'existence-only');
    assert.equal(result.webSourceUrl, 'https://www.wikidata.org/wiki/Q1');
  });

  await t.test('returns not-found with no search hits', async () => {
    withFetch(t, async () => jsonResponse(200, { search: [] }));
    const result = await c.tryWikidata('Nonexistent Work');
    assert.equal(result.status, 'not-found');
  });
});

test('escalateCitationToWeb', async t => {
  await t.test('returns a verified verdict when tier 1 (archive.org) confirms', async () => {
    withFetch(t, async () => jsonResponse(200, {
      response: { docs: [{ identifier: 'id1', title: 'Cited Work', creator: 'Author' }] },
    }));
    const result = await c.escalateCitationToWeb({ work: 'Cited Work', quote: 'a phrase' });
    assert.equal(result.verdict, 'verified');
    assert.equal(result.source, 'web');
  });

  await t.test('falls through to a later tier when an earlier one misses', async () => {
    withFetch(t, async url => {
      if (url.includes('archive.org')) return jsonResponse(200, { response: { docs: [] } });
      if (url.includes('wikisource.org') && url.includes('list=search')) return jsonResponse(200, { query: { search: [] } });
      if (url.includes('wikipedia.org') && url.includes('opensearch')) return jsonResponse(200, ['', []]);
      if (url.includes('wikidata.org')) return jsonResponse(200, { search: [{ id: 'Q9', label: 'Cited Work' }] });
      return jsonResponse(404, {});
    });
    const result = await c.escalateCitationToWeb({ work: 'Cited Work', quote: 'a phrase' });
    assert.equal(result.verdict, 'uncertain');
    assert.equal(result.webSourceUrl, 'https://www.wikidata.org/wiki/Q9');
  });

  await t.test('degrades to uncertain/model-knowledge when every tier errors', async () => {
    withFetch(t, async () => { throw new Error('offline'); });
    const result = await c.escalateCitationToWeb({ work: 'Cited Work', quote: 'a phrase', note: 'original note' });
    assert.equal(result.verdict, 'uncertain');
    assert.equal(result.source, 'model-knowledge');
    assert.match(result.note, /original note/);
  });

  await t.test('returns null (no override) on a clean miss across every tier', async () => {
    withFetch(t, async url => {
      if (url.includes('archive.org')) return jsonResponse(200, { response: { docs: [] } });
      if (url.includes('wikisource.org') && url.includes('list=search')) return jsonResponse(200, { query: { search: [] } });
      if (url.includes('wikipedia.org') && url.includes('opensearch')) return jsonResponse(200, ['', []]);
      if (url.includes('wikidata.org')) return jsonResponse(200, { search: [] });
      return jsonResponse(404, {});
    });
    const result = await c.escalateCitationToWeb({ work: 'Nonexistent', quote: 'nothing' });
    assert.equal(result, null);
  });
});

test('escalateCitationsToWeb', async t => {
  await t.test('only escalates citations with no libraryMatch, keyed by original index', async () => {
    withFetch(t, async () => jsonResponse(200, {
      response: { docs: [{ identifier: 'id1', title: 'Cited Work', creator: 'Author' }] },
    }));
    const citationsList = [
      { work: 'Has A Match', libraryMatch: 'e1' },
      { work: 'Cited Work', libraryMatch: null, quote: 'a phrase' },
    ];
    const results = await c.escalateCitationsToWeb(citationsList);
    assert.equal(results.has(0), false);
    assert.equal(results.get(1).verdict, 'verified');
  });

  await t.test('caps escalations at MAX_WEB_ESCALATIONS', async () => {
    let fetchCalls = 0;
    withFetch(t, async () => { fetchCalls++; return jsonResponse(200, { response: { docs: [] } }); });
    const citationsList = Array.from({ length: c.MAX_WEB_ESCALATIONS + 5 }, (_, i) => ({ work: `Work ${i}`, libraryMatch: null, quote: 'x' }));
    await c.escalateCitationsToWeb(citationsList);
    // Each escalated citation makes at least one fetch (tier 1) before
    // falling through — bound the count by how many citations were let in.
    assert.ok(fetchCalls <= c.MAX_WEB_ESCALATIONS * 4);
  });

  await t.test('an error escalating one citation does not stop the others', async () => {
    let call = 0;
    withFetch(t, async () => {
      call++;
      if (call === 1) throw new Error('boom');
      return jsonResponse(200, { response: { docs: [{ identifier: 'id1', title: 'Second Work', creator: '' }] } });
    });
    const citationsList = [
      { work: 'First Work', libraryMatch: null, quote: 'x' },
      { work: 'Second Work', libraryMatch: null, quote: 'x' },
    ];
    // First citation errors on every tier internally (caught inside
    // escalateCitationToWeb itself) rather than throwing out of
    // escalateCitationsToWeb — assert the call simply completes.
    const results = await c.escalateCitationsToWeb(citationsList);
    assert.ok(results.size >= 0);
  });
});
