'use strict';

// #514 — src/grounding.js (user-supplied grounding). Same conventions as
// test/citations.test.js: offline by construction, fake Anthropic client.
// Each test gets its own sessionId so the module's shared in-memory Map
// never leaks state between tests.

const test = require('node:test');
const assert = require('node:assert/strict');

const g = require('../src/grounding.js');
const tuning = require('../src/tuning.js');

let sidCounter = 0;
function freshSid() {
  sidCounter += 1;
  return `test-session-${sidCounter}`;
}

test('addGroundingSource / getGroundingSummary / hasGrounding', async t => {
  await t.test('starts empty for a session that never added anything', () => {
    const sid = freshSid();
    assert.equal(g.hasGrounding(sid), false);
    assert.deepEqual(g.getGroundingSummary(sid), {
      sources: [],
      totalChars: 0,
      verificationsUsed: 0,
      verificationsRemaining: tuning.MAX_GROUNDING_VERIFICATIONS_PER_SESSION,
    });
  });

  await t.test('rejects text that is empty or whitespace-only', () => {
    const sid = freshSid();
    const result = g.addGroundingSource(sid, 'blank.txt', '   \n  ');
    assert.equal(result.added, false);
    assert.equal(g.hasGrounding(sid), false);
  });

  await t.test('adds a source and reflects it in the summary', () => {
    const sid = freshSid();
    const result = g.addGroundingSource(sid, 'notes.txt', 'Some real content here.');
    assert.equal(result.added, true);
    assert.equal(g.hasGrounding(sid), true);
    const summary = g.getGroundingSummary(sid);
    assert.equal(summary.sources.length, 1);
    assert.equal(summary.sources[0].filename, 'notes.txt');
    assert.equal(summary.totalChars, 'Some real content here.'.length);
  });

  await t.test('truncates a source that would exceed the per-session char cap', () => {
    const sid = freshSid();
    const big = 'x'.repeat(tuning.MAX_GROUNDING_CHARS_PER_SESSION + 500);
    const result = g.addGroundingSource(sid, 'huge.txt', big);
    assert.equal(result.added, true);
    assert.equal(result.truncated, true);
    assert.equal(g.getGroundingSummary(sid).totalChars, tuning.MAX_GROUNDING_CHARS_PER_SESSION);
  });

  await t.test('refuses once a session is already at the size cap', () => {
    const sid = freshSid();
    g.addGroundingSource(sid, 'a.txt', 'x'.repeat(tuning.MAX_GROUNDING_CHARS_PER_SESSION));
    const second = g.addGroundingSource(sid, 'b.txt', 'more text');
    assert.equal(second.added, false);
  });

  await t.test('refuses once a session already has the max number of sources', () => {
    const sid = freshSid();
    for (let i = 0; i < tuning.MAX_GROUNDING_SOURCES_PER_SESSION; i += 1) {
      g.addGroundingSource(sid, `f${i}.txt`, `content ${i}`);
    }
    const result = g.addGroundingSource(sid, 'one-too-many.txt', 'content');
    assert.equal(result.added, false);
  });
});

test('clearGrounding', async t => {
  await t.test('removes a session\'s uploaded material entirely', () => {
    const sid = freshSid();
    g.addGroundingSource(sid, 'notes.txt', 'Some content.');
    assert.equal(g.hasGrounding(sid), true);
    g.clearGrounding(sid);
    assert.equal(g.hasGrounding(sid), false);
    assert.deepEqual(g.getGroundingSummary(sid).sources, []);
  });
});

test('buildChunks', async t => {
  await t.test('splits on paragraph boundaries and respects the chunk size', () => {
    const paragraphs = Array.from({ length: 5 }, (_, i) => `Paragraph ${i}. `.repeat(50));
    const text = paragraphs.join('\n\n');
    const chunks = g.buildChunks(text);
    assert.ok(chunks.length > 1);
    chunks.forEach(c => assert.ok(c.length <= tuning.GROUNDING_CHUNK_CHARS * 1.5));
  });

  await t.test('hard-slices a single paragraph longer than a chunk on its own', () => {
    const text = 'word '.repeat(2000);
    const chunks = g.buildChunks(text);
    assert.ok(chunks.length > 1);
  });
});

test('searchGrounding', async t => {
  await t.test('returns nothing for a session with no uploaded material', () => {
    const sid = freshSid();
    assert.deepEqual(g.searchGrounding(sid, 'anything'), []);
  });

  await t.test('returns nothing when the query has no meaningful terms', () => {
    const sid = freshSid();
    g.addGroundingSource(sid, 'notes.txt', 'The alchemical furnace burns at midnight.');
    assert.deepEqual(g.searchGrounding(sid, 'the and of'), []);
  });

  await t.test('finds a relevant passage via keyword containment below the size threshold', () => {
    const sid = freshSid();
    g.addGroundingSource(
      sid,
      'notes.txt',
      'The alchemical furnace burns at midnight in the old laboratory.\n\nUnrelated paragraph about gardening and roses.'
    );
    const hits = g.searchGrounding(sid, 'alchemical furnace midnight');
    assert.equal(hits.length, 1);
    assert.match(hits[0], /furnace/);
  });

  await t.test('uses TF-IDF ranking once the corpus crosses the keyword-search threshold', () => {
    const sid = freshSid();
    const filler = 'Generic filler paragraph about nothing in particular. '.repeat(400);
    const distinctive = 'The alchemical furnace burns at midnight in the old laboratory.';
    g.addGroundingSource(sid, 'big.txt', `${filler}\n\n${distinctive}\n\n${filler}`);
    assert.ok(g.getGroundingSummary(sid).totalChars >= tuning.GROUNDING_KEYWORD_SEARCH_CHAR_THRESHOLD);
    const hits = g.searchGrounding(sid, 'alchemical furnace midnight', 1);
    assert.equal(hits.length, 1);
    assert.match(hits[0], /furnace/);
  });
});

test('triageCheckableClaims', async t => {
  await t.test('excludes citations already matched to the curated library', () => {
    const citations = [{ libraryMatch: 'e1', quote: 'a reasonably long quote here' }];
    assert.equal(g.triageCheckableClaims(citations).length, 0);
  });

  await t.test('excludes citations with no quote or a too-short one', () => {
    const citations = [{ quote: '' }, { quote: 'short' }];
    assert.equal(g.triageCheckableClaims(citations).length, 0);
  });

  await t.test('includes a citation with no libraryMatch and a long-enough quote', () => {
    const citations = [{ quote: 'a reasonably long quote that clears the minimum' }];
    const result = g.triageCheckableClaims(citations);
    assert.equal(result.length, 1);
    assert.equal(result[0].index, 0);
  });
});

test('verifyClaimsAgainstGrounding', async t => {
  await t.test('returns an empty map when the session has no uploaded material', async () => {
    const sid = freshSid();
    const fakeClient = { messages: { create: async () => ({ content: [] }) } };
    const result = await g.verifyClaimsAgainstGrounding({
      client: fakeClient,
      model: 'test-model',
      sessionId: sid,
      citations: [{ quote: 'a reasonably long quote here', work: 'Some Work' }],
    });
    assert.equal(result.size, 0);
  });

  await t.test('does not call the client when no triaged claim gets a retrieval hit', async () => {
    const sid = freshSid();
    g.addGroundingSource(sid, 'notes.txt', 'Completely unrelated gardening content about roses.');
    let called = false;
    const fakeClient = {
      messages: {
        create: async () => {
          called = true;
          return { content: [] };
        },
      },
    };
    const result = await g.verifyClaimsAgainstGrounding({
      client: fakeClient,
      model: 'test-model',
      sessionId: sid,
      citations: [{ quote: 'the ritual dagger gleamed in candlelight', work: 'Some Work' }],
    });
    assert.equal(called, false);
    assert.equal(result.size, 0);
  });

  await t.test('sends a batched call and maps confirmed/contradicted verdicts, dropping not-addressed', async () => {
    const sid = freshSid();
    g.addGroundingSource(sid, 'notes.txt', 'The ritual dagger gleamed under candlelight in the old chapel.');
    let capturedParams = null;
    const fakeClient = {
      messages: {
        create: async params => {
          capturedParams = params;
          return {
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [
              {
                type: 'tool_use',
                input: {
                  verdicts: [
                    { index: 0, verdict: 'confirmed', note: 'Matches.' },
                    { index: 1, verdict: 'not-addressed', note: 'Unrelated passage.' },
                  ],
                },
              },
            ],
          };
        },
      },
    };
    const citationsList = [
      { quote: 'the ritual dagger gleamed under candlelight', work: 'Some Work' },
      { quote: 'a second unrelated but long-enough quote here', work: 'Other Work' },
    ];
    // Force the second citation to also retrieve a hit so it's included in
    // the batch and can be asserted as dropped via not-addressed.
    citationsList[1].quote = 'the ritual dagger gleamed under candlelight again';

    const result = await g.verifyClaimsAgainstGrounding({
      client: fakeClient,
      model: 'test-model',
      sessionId: sid,
      citations: citationsList,
    });

    assert.equal(capturedParams.thinking.type, 'disabled');
    assert.equal(result.get(0).verdict, 'verified');
    assert.equal(result.get(0).source, 'user-grounding');
    assert.equal(result.has(1), false);
  });

  await t.test('maps a contradicted verdict to unverified', async () => {
    const sid = freshSid();
    g.addGroundingSource(sid, 'notes.txt', 'The ritual dagger was in fact made of plastic, not silver.');
    const fakeClient = {
      messages: {
        create: async () => ({
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [
            {
              type: 'tool_use',
              input: { verdicts: [{ index: 0, verdict: 'contradicted', note: 'Passage disputes this.' }] },
            },
          ],
        }),
      },
    };
    const result = await g.verifyClaimsAgainstGrounding({
      client: fakeClient,
      model: 'test-model',
      sessionId: sid,
      citations: [{ quote: 'the ritual dagger gleamed silver', work: 'Some Work' }],
    });
    assert.equal(result.get(0).verdict, 'unverified');
  });

  await t.test('stops spending calls once the per-session verification cap is hit', async () => {
    const sid = freshSid();
    g.addGroundingSource(sid, 'notes.txt', 'The ritual dagger gleamed under candlelight in the old chapel.');
    const fakeClient = {
      messages: {
        create: async () => ({
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'tool_use', input: { verdicts: [{ index: 0, verdict: 'confirmed', note: 'x' }] } }],
        }),
      },
    };
    const citation = { quote: 'the ritual dagger gleamed under candlelight', work: 'Some Work' };
    for (let i = 0; i < tuning.MAX_GROUNDING_VERIFICATIONS_PER_SESSION; i += 1) {
      await g.verifyClaimsAgainstGrounding({ client: fakeClient, model: 'test-model', sessionId: sid, citations: [citation] });
    }
    assert.equal(g.getGroundingSummary(sid).verificationsRemaining, 0);
    let calledAfterCap = false;
    const guardClient = {
      messages: {
        create: async () => {
          calledAfterCap = true;
          return { content: [] };
        },
      },
    };
    const result = await g.verifyClaimsAgainstGrounding({
      client: guardClient,
      model: 'test-model',
      sessionId: sid,
      citations: [citation],
    });
    assert.equal(calledAfterCap, false);
    assert.equal(result.size, 0);
  });
});
