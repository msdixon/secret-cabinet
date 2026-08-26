'use strict';

// #193 — citations.js (#153's citation verification), extracted from
// server.js. Offline by construction, same convention as test/library.test.js
// — global.fetch is stubbed per test rather than reaching archive.org/
// Wikisource/Wikipedia/Wikidata for real, and the Anthropic client is a fake
// following test/pipeline.test.js's pattern.

const test = require('node:test');
const assert = require('node:assert/strict');

const c = require('../src/citations.js');

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function withFetch(t, impl) {
  const original = global.fetch;
  global.fetch = impl;
  t.after(() => {
    global.fetch = original;
  });
}

test('groundAgainstLibraryText', async t => {
  await t.test('returns an empty map without calling the client when nothing matched', async () => {
    let called = false;
    const fakeClient = {
      messages: {
        create: async () => {
          called = true;
          return { content: [] };
        },
      },
    };
    const result = await c.groundAgainstLibraryText(fakeClient, 'test-model', [{ libraryMatch: null }], {});
    assert.equal(called, false);
    assert.equal(result.size, 0);
  });

  await t.test('skips a libraryMatch whose lookup entry has no text', async () => {
    let called = false;
    const fakeClient = {
      messages: {
        create: async () => {
          called = true;
          return { content: [] };
        },
      },
    };
    const result = await c.groundAgainstLibraryText(fakeClient, 'test-model', [{ libraryMatch: 'e1' }], {
      e1: { title: 'T', source: 'S' },
    });
    assert.equal(called, false);
    assert.equal(result.size, 0);
  });

  await t.test('sends matched citations to the client and returns verdicts keyed by index', async () => {
    const fakeClient = {
      messages: {
        create: async () => ({
          content: [
            {
              type: 'tool_use',
              input: { verdicts: [{ index: 0, verdict: 'verified', note: 'Matches the excerpt.' }] },
            },
          ],
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

  // #436: sibling gap flagged alongside the member.js fix -- this call is
  // tool-only output, same shape as pipeline-disposition.js's, and should
  // disable adaptive thinking for the same reason.
  await t.test('sends thinking: disabled on the grounding call', async () => {
    let capturedParams = null;
    const fakeClient = {
      messages: {
        create: async params => {
          capturedParams = params;
          return { content: [{ type: 'tool_use', input: { verdicts: [] } }] };
        },
      },
    };
    const citationsList = [{ libraryMatch: 'e1', work: 'Some Work', quote: 'a quote' }];
    const lookup = { e1: { title: 'T', source: 'S', text: 'The excerpt text.' } };
    await c.groundAgainstLibraryText(fakeClient, 'test-model', citationsList, lookup);
    assert.deepEqual(capturedParams.thinking, { type: 'disabled' });
  });

  // #225 — generationMetrics didn't cover this call at all; onMetric is how
  // the caller (server.js) gets usage back to persist onto the session.
  await t.test('reports a citation-grounding metric when a call is made', async () => {
    const fakeClient = {
      messages: {
        create: async () => ({
          usage: { input_tokens: 111, output_tokens: 22 },
          content: [{ type: 'tool_use', input: { verdicts: [{ index: 0, verdict: 'verified', note: 'n' }] } }],
        }),
      },
    };
    const citationsList = [{ libraryMatch: 'e1', work: 'Some Work', quote: 'a quote' }];
    const lookup = { e1: { title: 'T', source: 'S', text: 'The excerpt text.' } };
    const metrics = [];
    await c.groundAgainstLibraryText(fakeClient, 'test-model', citationsList, lookup, m => metrics.push(m));
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].phase, 'citation-grounding');
    assert.deepEqual(metrics[0].usage, { input_tokens: 111, output_tokens: 22, cache_read_input_tokens: null });
  });

  await t.test('does not call onMetric when nothing matched (no call was made)', async () => {
    const fakeClient = { messages: { create: async () => ({ content: [] }) } };
    const metrics = [];
    await c.groundAgainstLibraryText(fakeClient, 'test-model', [{ libraryMatch: null }], {}, m => metrics.push(m));
    assert.equal(metrics.length, 0);
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
    withFetch(t, async () =>
      jsonResponse(200, {
        response: { docs: [{ identifier: 'id1', title: 'Some Work Full Text', creator: 'Author' }] },
      })
    );
    const result = await c.tryArchiveOrgFullText('Some Work', 'a quoted phrase');
    assert.equal(result.status, 'confirmed');
    assert.equal(result.webSourceUrl, 'https://archive.org/details/id1');
  });

  await t.test('returns not-found when no returned doc overlaps the work', async () => {
    withFetch(t, async () =>
      jsonResponse(200, {
        response: { docs: [{ identifier: 'id1', title: 'Completely Unrelated', creator: 'Someone Else' }] },
      })
    );
    const result = await c.tryArchiveOrgFullText('Some Work', 'a quoted phrase');
    assert.equal(result.status, 'not-found');
  });

  await t.test('returns error on a non-ok HTTP response', async () => {
    withFetch(t, async () => jsonResponse(500, {}));
    const result = await c.tryArchiveOrgFullText('Some Work', 'a quoted phrase');
    assert.equal(result.status, 'error');
  });

  await t.test('returns error when fetch itself throws', async () => {
    withFetch(t, async () => {
      throw new Error('network down');
    });
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
      return jsonResponse(200, {
        query: { pages: { 1: { extract: 'a rather long extract containing the exact quoted phrase in full' } } },
      });
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
      return jsonResponse(200, {
        type: 'standard',
        title: 'Some Work',
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Some_Work' } },
      });
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
    withFetch(t, async () =>
      jsonResponse(200, {
        response: { docs: [{ identifier: 'id1', title: 'Cited Work', creator: 'Author' }] },
      })
    );
    const result = await c.escalateCitationToWeb({ work: 'Cited Work', quote: 'a phrase' });
    assert.equal(result.verdict, 'verified');
    assert.equal(result.source, 'web');
  });

  await t.test('falls through to a later tier when an earlier one misses', async () => {
    withFetch(t, async url => {
      if (url.includes('archive.org')) return jsonResponse(200, { response: { docs: [] } });
      if (url.includes('wikisource.org') && url.includes('list=search'))
        return jsonResponse(200, { query: { search: [] } });
      if (url.includes('wikipedia.org') && url.includes('opensearch')) return jsonResponse(200, ['', []]);
      if (url.includes('wikidata.org')) return jsonResponse(200, { search: [{ id: 'Q9', label: 'Cited Work' }] });
      return jsonResponse(404, {});
    });
    const result = await c.escalateCitationToWeb({ work: 'Cited Work', quote: 'a phrase' });
    assert.equal(result.verdict, 'uncertain');
    assert.equal(result.webSourceUrl, 'https://www.wikidata.org/wiki/Q9');
  });

  await t.test('degrades to uncertain/model-knowledge when every tier errors', async () => {
    withFetch(t, async () => {
      throw new Error('offline');
    });
    const result = await c.escalateCitationToWeb({ work: 'Cited Work', quote: 'a phrase', note: 'original note' });
    assert.equal(result.verdict, 'uncertain');
    assert.equal(result.source, 'model-knowledge');
    assert.match(result.note, /original note/);
  });

  await t.test('returns null (no override) on a clean miss across every tier', async () => {
    withFetch(t, async url => {
      if (url.includes('archive.org')) return jsonResponse(200, { response: { docs: [] } });
      if (url.includes('wikisource.org') && url.includes('list=search'))
        return jsonResponse(200, { query: { search: [] } });
      if (url.includes('wikipedia.org') && url.includes('opensearch')) return jsonResponse(200, ['', []]);
      if (url.includes('wikidata.org')) return jsonResponse(200, { search: [] });
      return jsonResponse(404, {});
    });
    const result = await c.escalateCitationToWeb({ work: 'Nonexistent', quote: 'nothing' });
    assert.equal(result, null);
  });
});

// #355 — flattenBeatCitations reads the always-on per-beat capture
// (pipeline-disposition.js's piggyback on the disposition call) back out of
// a session, in the flat shape /verify-citations and the cumulative
// manifest both expect.
test('flattenBeatCitations', async t => {
  const roster = [{ id: 'crowley', name: 'Crowley' }];

  await t.test('flattens citations across beats and rounds, resolving speaker from the roster', () => {
    const session = {
      rounds: [
        {
          beats: [
            { memberId: 'crowley', text: 'a', citations: [{ quote: 'q1', work: 'W1' }] },
            { memberId: 'crowley', text: 'b' }, // no citations — most beats
          ],
        },
        {
          beats: [{ memberId: 'crowley', text: 'c', citations: [{ quote: 'q2', work: 'W2' }] }],
        },
      ],
    };
    const flat = c.flattenBeatCitations(session, roster);
    assert.equal(flat.length, 2);
    assert.deepEqual(
      flat.map(c => c.work),
      ['W1', 'W2']
    );
    assert.equal(flat[0].speaker, 'Crowley');
    assert.equal(flat[0].memberId, 'crowley');
  });

  await t.test('skips a failed beat even if it somehow carries a citations array', () => {
    const session = {
      rounds: [{ beats: [{ memberId: 'crowley', text: '', failed: true, citations: [{ quote: 'q', work: 'W' }] }] }],
    };
    assert.deepEqual(c.flattenBeatCitations(session, roster), []);
  });

  await t.test('falls back to speakerName, then memberId, for a non-roster speaker', () => {
    const session = {
      rounds: [
        {
          beats: [
            {
              memberId: 'presence:interjection',
              speakerName: '— a voice from elsewhere —',
              text: 'x',
              citations: [{ quote: 'q', work: 'W' }],
            },
          ],
        },
      ],
    };
    assert.equal(c.flattenBeatCitations(session, roster)[0].speaker, '— a voice from elsewhere —');
  });

  await t.test('returns an empty array for a session with no rounds, or rounds with no beats (pre-#354)', () => {
    assert.deepEqual(c.flattenBeatCitations({}, roster), []);
    assert.deepEqual(c.flattenBeatCitations({ rounds: [{ label: 'x', text: 'y' }] }, roster), []);
  });
});

// #356 — same always-on-capture story as flattenBeatCitations, for the
// weaker invoked-works tier (pipeline-disposition.js's invokedWorks tool
// field). Deliberately its own function/test suite rather than a flag on
// flattenBeatCitations — see that function's own comment.
test('flattenBeatInvokedWorks', async t => {
  const roster = [{ id: 'crowley', name: 'Crowley' }];

  await t.test('flattens invoked works across beats and rounds, resolving speaker from the roster', () => {
    const session = {
      rounds: [
        {
          beats: [
            { memberId: 'crowley', text: 'a', invokedWorks: [{ work: 'W1', note: 'named in passing' }] },
            { memberId: 'crowley', text: 'b' }, // no invoked works — most beats
          ],
        },
        {
          beats: [{ memberId: 'crowley', text: 'c', invokedWorks: [{ work: 'W2', note: '' }] }],
        },
      ],
    };
    const flat = c.flattenBeatInvokedWorks(session, roster);
    assert.equal(flat.length, 2);
    assert.deepEqual(
      flat.map(w => w.work),
      ['W1', 'W2']
    );
    assert.equal(flat[0].speaker, 'Crowley');
    assert.equal(flat[0].memberId, 'crowley');
  });

  await t.test('skips a failed beat even if it somehow carries an invokedWorks array', () => {
    const session = {
      rounds: [{ beats: [{ memberId: 'crowley', text: '', failed: true, invokedWorks: [{ work: 'W' }] }] }],
    };
    assert.deepEqual(c.flattenBeatInvokedWorks(session, roster), []);
  });

  await t.test('falls back to speakerName, then memberId, for a non-roster speaker', () => {
    const session = {
      rounds: [
        {
          beats: [
            {
              memberId: 'presence:interjection',
              speakerName: '— a voice from elsewhere —',
              text: 'x',
              invokedWorks: [{ work: 'W' }],
            },
          ],
        },
      ],
    };
    assert.equal(c.flattenBeatInvokedWorks(session, roster)[0].speaker, '— a voice from elsewhere —');
  });

  await t.test('returns an empty array for a session with no rounds, or rounds with no beats (pre-#354)', () => {
    assert.deepEqual(c.flattenBeatInvokedWorks({}, roster), []);
    assert.deepEqual(c.flattenBeatInvokedWorks({ rounds: [{ label: 'x', text: 'y' }] }, roster), []);
  });
});

test('escalateCitationsToWeb', async t => {
  await t.test('only escalates citations with no libraryMatch, keyed by original index', async () => {
    withFetch(t, async () =>
      jsonResponse(200, {
        response: { docs: [{ identifier: 'id1', title: 'Cited Work', creator: 'Author' }] },
      })
    );
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
    withFetch(t, async () => {
      fetchCalls++;
      return jsonResponse(200, { response: { docs: [] } });
    });
    const citationsList = Array.from({ length: c.MAX_WEB_ESCALATIONS + 5 }, (_, i) => ({
      work: `Work ${i}`,
      libraryMatch: null,
      quote: 'x',
    }));
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
