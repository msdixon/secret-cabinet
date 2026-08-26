'use strict';

// #430 — citation-grounding accuracy eval harness. Offline by construction,
// same convention as test/citations.test.js: the Anthropic client is a fake
// following test/pipeline.test.js's pattern, so this suite never spends real
// API budget. It exercises the scoring/report/plumbing logic; the golden set
// actually catching a real model regression is what the manual quarterly run
// (docs/MODEL-REVIEW.md item 3) is for, not this file.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadGoldenSet,
  buildCitationsFromGoldenSet,
  scoreVerdicts,
  buildReport,
  runEval,
} = require('../scripts/eval-citation-grounding.js');

test('loadGoldenSet', async t => {
  await t.test('loads the real golden set with well-formed entries', () => {
    const goldenSet = loadGoldenSet();
    assert.ok(goldenSet.length >= 10, 'golden set should have a meaningfully-sized curated sample');
    goldenSet.forEach(item => {
      assert.equal(typeof item.id, 'string');
      assert.equal(typeof item.libraryEntryId, 'string');
      assert.equal(typeof item.work, 'string');
      assert.equal(typeof item.quote, 'string');
      assert.ok(['verified', 'unverified', 'uncertain'].includes(item.expectedVerdict));
      assert.equal(typeof item.why, 'string');
    });
  });

  await t.test('every id is unique', () => {
    const goldenSet = loadGoldenSet();
    const ids = goldenSet.map(item => item.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  await t.test('covers all three verdicts, not just the easy case', () => {
    const goldenSet = loadGoldenSet();
    const verdicts = new Set(goldenSet.map(item => item.expectedVerdict));
    assert.deepEqual([...verdicts].sort(), ['uncertain', 'unverified', 'verified']);
  });
});

test('buildCitationsFromGoldenSet', async t => {
  await t.test('maps each golden item to a groundAgainstLibraryText citation, preserving index order', () => {
    const goldenSet = [
      { libraryEntryId: 'e1', work: 'Work A', quote: 'quote a' },
      { libraryEntryId: 'e2', work: 'Work B', quote: 'quote b' },
    ];
    const citations = buildCitationsFromGoldenSet(goldenSet);
    assert.deepEqual(citations, [
      { libraryMatch: 'e1', work: 'Work A', quote: 'quote a' },
      { libraryMatch: 'e2', work: 'Work B', quote: 'quote b' },
    ]);
  });
});

test('scoreVerdicts', async t => {
  const goldenSet = [
    { id: 'a', libraryEntryId: 'e1', quote: 'q1', expectedVerdict: 'verified', why: 'w1' },
    { id: 'b', libraryEntryId: 'e2', quote: 'q2', expectedVerdict: 'unverified', why: 'w2' },
    { id: 'c', libraryEntryId: 'e3', quote: 'q3', expectedVerdict: 'uncertain', why: 'w3' },
  ];

  await t.test('scores 100% accuracy when every prediction matches expected', () => {
    const verdicts = new Map([
      [0, { verdict: 'verified', note: 'n1' }],
      [1, { verdict: 'unverified', note: 'n2' }],
      [2, { verdict: 'uncertain', note: 'n3' }],
    ]);
    const scoring = scoreVerdicts(goldenSet, verdicts);
    assert.equal(scoring.correct, 3);
    assert.equal(scoring.accuracy, 1);
    assert.equal(scoring.missing, 0);
    assert.deepEqual(scoring.mismatches, []);
  });

  await t.test('records a mismatch with the model note when a prediction disagrees with expected', () => {
    const verdicts = new Map([
      [0, { verdict: 'unverified', note: 'model disagreed' }],
      [1, { verdict: 'unverified', note: 'n2' }],
      [2, { verdict: 'uncertain', note: 'n3' }],
    ]);
    const scoring = scoreVerdicts(goldenSet, verdicts);
    assert.equal(scoring.correct, 2);
    assert.equal(scoring.mismatches.length, 1);
    assert.equal(scoring.mismatches[0].id, 'a');
    assert.equal(scoring.mismatches[0].predicted, 'unverified');
    assert.equal(scoring.mismatches[0].modelNote, 'model disagreed');
  });

  await t.test('counts a missing verdict (index absent from the returned map) as a mismatch, not a crash', () => {
    const verdicts = new Map([
      [0, { verdict: 'verified', note: 'n1' }],
      // index 1 missing entirely — e.g. the model returned fewer verdicts than items sent
      [2, { verdict: 'uncertain', note: 'n3' }],
    ]);
    const scoring = scoreVerdicts(goldenSet, verdicts);
    assert.equal(scoring.missing, 1);
    assert.equal(scoring.correct, 2);
    assert.equal(scoring.mismatches.length, 1);
    assert.equal(scoring.mismatches[0].predicted, null);
  });

  await t.test('builds a confusion matrix keyed by expected->predicted', () => {
    const verdicts = new Map([
      [0, { verdict: 'unverified', note: 'n1' }], // expected verified, predicted unverified
      [1, { verdict: 'unverified', note: 'n2' }], // correct
      [2, { verdict: 'uncertain', note: 'n3' }], // correct
    ]);
    const scoring = scoreVerdicts(goldenSet, verdicts);
    assert.equal(scoring.confusion['verified->unverified'], 1);
    assert.equal(scoring.confusion['unverified->unverified'], 1);
    assert.equal(scoring.confusion['uncertain->uncertain'], 1);
    assert.equal(scoring.confusion['verified->verified'], 0);
  });
});

test('buildReport', async t => {
  const goldenSet = [{ id: 'a', libraryEntryId: 'e1', quote: 'q1', expectedVerdict: 'verified', why: 'w1' }];

  await t.test('reports full accuracy with no mismatch section when everything matches', () => {
    const scoring = scoreVerdicts(goldenSet, new Map([[0, { verdict: 'verified', note: 'n1' }]]));
    const report = buildReport({ model: 'test-model', goldenSet, scoring });
    assert.match(report, /1 correct \(100\.0%\)/);
    assert.match(report, /No mismatches/);
    assert.doesNotMatch(report, /Mismatches — review/);
  });

  await t.test('includes a per-mismatch section with the golden set rationale and model note', () => {
    const scoring = scoreVerdicts(goldenSet, new Map([[0, { verdict: 'unverified', note: 'model got it wrong' }]]));
    const report = buildReport({ model: 'test-model', goldenSet, scoring });
    assert.match(report, /Mismatches — review these by hand/);
    assert.match(report, /`a` \(e1\)/);
    assert.match(report, /Expected: \*\*verified\*\* — got: \*\*unverified\*\*/);
    assert.match(report, /w1/);
    assert.match(report, /model got it wrong/);
  });

  await t.test('names the model under test and links back to #430 and #141', () => {
    const scoring = scoreVerdicts(goldenSet, new Map([[0, { verdict: 'verified', note: 'n1' }]]));
    const report = buildReport({ model: 'claude-candidate', goldenSet, scoring });
    assert.match(report, /claude-candidate/);
    assert.match(report, /issues\/430/);
    assert.match(report, /issues\/141/);
  });
});

// runEval is the only piece that touches groundAgainstLibraryText (and
// therefore a client) — verified here with a fake client so the plumbing
// (citation-building -> real function -> scoring) is exercised without a
// live API call, same fake-client convention as test/citations.test.js.
test('runEval', async t => {
  await t.test('wires the golden set through groundAgainstLibraryText and scores the result', async () => {
    const goldenSet = [
      { id: 'a', libraryEntryId: 'e1', work: 'Work A', quote: 'the real quote', expectedVerdict: 'verified', why: 'w' },
      {
        id: 'b',
        libraryEntryId: 'e1',
        work: 'Work A',
        quote: 'a fabricated quote',
        expectedVerdict: 'unverified',
        why: 'w',
      },
    ];
    const libraryLookup = { e1: { title: 'T', source: 'S', text: 'The real quote appears here.' } };
    const fakeClient = {
      messages: {
        create: async () => ({
          content: [
            {
              type: 'tool_use',
              input: {
                verdicts: [
                  { index: 0, verdict: 'verified', note: 'matches' },
                  { index: 1, verdict: 'unverified', note: 'not in excerpt' },
                ],
              },
            },
          ],
        }),
      },
    };

    const scoring = await runEval({ client: fakeClient, model: 'test-model', goldenSet, libraryLookup });
    assert.equal(scoring.correct, 2);
    assert.equal(scoring.accuracy, 1);
  });
});
