'use strict';

// #561 — offline tests for the pure parts of the live un-nudged-length
// harness. The live run itself (real API calls) is manual, not tested here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { CASES, wordCount, mean, summarize } = require('../scripts/measure-unnudged-turn-length');
const roster = require('../prompts/members/roster.json');

test('wordCount ignores extra whitespace and empty input', () => {
  assert.equal(wordCount('  one  two\nthree '), 3);
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount(undefined), 0);
});

test('mean rounds and handles empty lists', () => {
  assert.equal(mean([100, 101]), 101);
  assert.equal(mean([]), 0);
});

test('summarize averages per member and over every trial', () => {
  const { perMember, overall } = summarize({ a: [100, 120], b: [60] });
  assert.deepEqual(perMember, { a: 110, b: 60 });
  assert.equal(overall, 93);
});

test('every harness case names a real roster member', () => {
  for (const [id, topic] of CASES) {
    assert.ok(
      roster.some(m => m.id === id),
      `${id} missing from roster`
    );
    assert.ok(topic.length > 0);
  }
});
