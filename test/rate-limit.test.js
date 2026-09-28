'use strict';

// #594 — src/rate-limit.js, the sign-in failure limiter.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFailureLimiter } = require('../src/rate-limit.js');

function clock() {
  let t = 0;
  return { now: () => t, advance: ms => (t += ms) };
}

test('createFailureLimiter', async t => {
  await t.test('blocks a key once it reaches max failures, and only that key', () => {
    const c = clock();
    const limiter = createFailureLimiter({ windowMs: 1000, max: 3, now: c.now });
    limiter.recordFailure('a');
    limiter.recordFailure('a');
    assert.equal(limiter.isBlocked('a'), false);
    limiter.recordFailure('a');
    assert.equal(limiter.isBlocked('a'), true);
    assert.equal(limiter.isBlocked('b'), false);
  });

  await t.test('unblocks when the window ends', () => {
    const c = clock();
    const limiter = createFailureLimiter({ windowMs: 1000, max: 1, now: c.now });
    limiter.recordFailure('a');
    assert.equal(limiter.isBlocked('a'), true);
    c.advance(1000);
    assert.equal(limiter.isBlocked('a'), false);
  });

  await t.test('reset clears a key (a successful sign-in)', () => {
    const limiter = createFailureLimiter({ windowMs: 1000, max: 2 });
    limiter.recordFailure('a');
    limiter.reset('a');
    limiter.recordFailure('a');
    assert.equal(limiter.isBlocked('a'), false);
  });
});
