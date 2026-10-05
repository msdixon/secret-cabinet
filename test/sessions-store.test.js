'use strict';

// #193 — sessions-store.js (read/write/list/branch, as named in the original
// issue proposal), extracted from server.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../src/sessions-store.js');

function makeFixtureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-store-test-'));
}

test('makeSessionId', async t => {
  await t.test("embeds today's date, a slug of the entry, and a stable hash of the entry text", () => {
    const id = store.makeSessionId('The Rite of Spring, considered anew');
    assert.match(id, /^\d{4}-\d{2}-\d{2}-the-rite-of-spring-considered-anew-[0-9a-f]{6}$/);
  });

  await t.test('is deterministic for identical entry text', () => {
    const a = store.makeSessionId('Same text');
    const b = store.makeSessionId('Same text');
    assert.equal(a, b);
  });

  await t.test('strips non-alphanumeric characters and trims leading/trailing dashes from the slug', () => {
    const id = store.makeSessionId('  ¡Hola! — a test...  ');
    assert.match(id, /^\d{4}-\d{2}-\d{2}-hola-a-test-[0-9a-f]{6}$/);
  });

  await t.test('truncates a long entry to a 40-character slug', () => {
    const id = store.makeSessionId('a'.repeat(100));
    const slug = id.split('-').slice(3, -1).join('-');
    assert.ok(slug.length <= 40);
  });
});

test('makeBranchId', async t => {
  const parent = { id: 'parent-id', entry: 'The source document' };

  await t.test('embeds the parent slug and a "-branch-" marker', () => {
    const id = store.makeBranchId(parent, 1);
    assert.match(id, /^\d{4}-\d{2}-\d{2}-the-source-document-branch-[0-9a-f]{6}$/);
  });

  await t.test(
    'produces different ids across calls even for the same parent/round (mixes in wall-clock/random)',
    () => {
      const a = store.makeBranchId(parent, 1);
      const b = store.makeBranchId(parent, 1);
      assert.notEqual(a, b);
    }
  );
});

test('saveSession / loadSession', async t => {
  await t.test('round-trips a session through disk', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const session = { id: 'sess-1', entry: 'x', rounds: [] };
    store.saveSession(dir, session);
    const loaded = store.loadSession(dir, 'sess-1');
    assert.deepEqual(loaded, session);
  });

  await t.test('loadSession returns null for an id with no file on disk', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    assert.equal(store.loadSession(dir, 'nonexistent'), null);
  });

  await t.test('saveSession overwrites an existing file for the same id', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, { id: 'sess-1', v: 1 });
    store.saveSession(dir, { id: 'sess-1', v: 2 });
    assert.equal(store.loadSession(dir, 'sess-1').v, 2);
  });
});

// #595 — ownership predicates and the ownerless-session migration.
test('ownership (#595)', async t => {
  const alice = { id: 'alice' };
  const bob = { id: 'bob' };
  const local = { id: 'local' };

  await t.test('the owner reads and writes; others do not', () => {
    const s = { ownerId: 'alice' };
    assert.equal(store.canRead(s, alice), true);
    assert.equal(store.canWrite(s, alice), true);
    assert.equal(store.canRead(s, bob), false);
    assert.equal(store.canWrite(s, bob), false);
  });

  await t.test('published opens reading, never writing, to others', () => {
    const s = { ownerId: 'alice', published: true };
    assert.equal(store.canRead(s, bob), true);
    assert.equal(store.canRead(s, null), true);
    assert.equal(store.canWrite(s, bob), false);
  });

  await t.test('an ownerless session is nobody’s but the open-mode local user’s', () => {
    assert.equal(store.canWrite({}, alice), false);
    assert.equal(store.canWrite({}, local), true);
    assert.equal(store.canRead({}, null), false);
  });

  await t.test('filterReadable keeps own and published only', () => {
    const list = [{ ownerId: 'alice' }, { ownerId: 'bob' }, { ownerId: 'bob', published: true }];
    assert.equal(store.filterReadable(list, alice).length, 2);
  });

  await t.test('claimOwnerlessSessions assigns only ownerless sessions, idempotently', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, { id: 'a' });
    store.saveSession(dir, { id: 'b', ownerId: 'bob' });
    assert.equal(store.claimOwnerlessSessions(dir, 'admin'), 1);
    assert.equal(store.loadSession(dir, 'a').ownerId, 'admin');
    assert.equal(store.loadSession(dir, 'b').ownerId, 'bob');
    assert.equal(store.claimOwnerlessSessions(dir, 'admin'), 0);
  });
});
