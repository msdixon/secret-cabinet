'use strict';

// #594 chunk A — src/login-codes.js, the one-time emailed sign-in codes.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLoginCodeStore } = require('../src/login-codes.js');

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: ms => (t += ms) };
}

const wrongFor = code => (code === '000000' ? '111111' : '000000');

test('createLoginCodeStore', async t => {
  await t.test('issues a 6-digit code that verifies once for its email only', () => {
    const store = createLoginCodeStore();
    const code = store.issue('a@example.com');
    assert.match(code, /^\d{6}$/);
    assert.equal(store.verify('b@example.com', code), false);
    assert.equal(store.verify('a@example.com', code), true);
    assert.equal(store.verify('a@example.com', code), false, 'single-use');
  });

  await t.test('tolerates spaces in what was typed', () => {
    const store = createLoginCodeStore();
    const code = store.issue('a@example.com');
    assert.equal(store.verify('a@example.com', ` ${code.slice(0, 3)} ${code.slice(3)} `), true);
  });

  await t.test('expires after the TTL', () => {
    const c = clock();
    const store = createLoginCodeStore({ ttlMs: 1000, now: c.now });
    const code = store.issue('a@example.com');
    c.advance(1000);
    assert.equal(store.verify('a@example.com', code), false);
  });

  await t.test('is discarded after maxAttempts wrong guesses, even if the next guess is right', () => {
    const store = createLoginCodeStore({ maxAttempts: 3 });
    const code = store.issue('a@example.com');
    for (let i = 0; i < 3; i++) assert.equal(store.verify('a@example.com', wrongFor(code)), false);
    assert.equal(store.verify('a@example.com', code), false);
  });

  await t.test('a newly issued code replaces the previous one', () => {
    const store = createLoginCodeStore();
    const first = store.issue('a@example.com');
    let second = store.issue('a@example.com');
    while (second === first) second = store.issue('a@example.com');
    assert.equal(store.verify('a@example.com', first), false);
    assert.equal(store.verify('a@example.com', second), true);
  });

  await t.test('rejects non-string and malformed candidates without throwing', () => {
    const store = createLoginCodeStore();
    store.issue('a@example.com');
    assert.equal(store.verify('a@example.com', undefined), false);
    assert.equal(store.verify('a@example.com', ['123456']), false);
    assert.equal(store.verify('a@example.com', '12345'), false);
    assert.equal(store.verify('nobody@example.com', '123456'), false);
  });
});
