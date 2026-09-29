'use strict';

// #594 — src/users.js, the per-user identity store. Exercised against a
// tmpdir, the same pattern visits.test.js uses for visits.json.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createUserStore, normalizeEmail } = require('../src/users.js');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-users-')), 'users.json');
}

test('normalizeEmail', () => {
  assert.equal(normalizeEmail('  Rachel@Example.COM '), 'rachel@example.com');
  assert.equal(normalizeEmail(''), null);
  assert.equal(normalizeEmail(undefined), null);
});

test('createUserStore', async t => {
  await t.test('a missing file is an empty store, and creates nothing until something is saved', () => {
    const file = tmpFile();
    const store = createUserStore(file);
    assert.deepEqual(store.list(), []);
    assert.equal(store.findAdmin(), null);
    assert.equal(fs.existsSync(file), false);
  });

  await t.test('a corrupt file throws rather than looking like a fresh install', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{not json');
    assert.throws(() => createUserStore(file), /Could not read users file/);
  });

  await t.test('ensureAdmin creates one admin and persists it', () => {
    const file = tmpFile();
    const admin = createUserStore(file).ensureAdmin({ email: 'Rachel@Example.com' });
    assert.equal(admin.isAdmin, true);
    assert.equal(admin.email, 'rachel@example.com');
    assert.match(admin.id, /^[0-9a-f-]{36}$/);

    const reloaded = createUserStore(file);
    assert.deepEqual(reloaded.findAdmin(), admin);
    assert.equal(fs.existsSync(`${file}.tmp`), false, 'expected the temp file to be renamed away');
  });

  await t.test('ensureAdmin is idempotent across restarts — same id, no second admin', () => {
    const file = tmpFile();
    const first = createUserStore(file).ensureAdmin({});
    const second = createUserStore(file).ensureAdmin({ email: 'rachel@example.com' });
    assert.equal(second.id, first.id);
    assert.equal(second.email, 'rachel@example.com', 'expected a missing email to be filled in');
    assert.equal(createUserStore(file).list().length, 1);
  });

  await t.test('ensureAdmin never overwrites an email the admin already has', () => {
    const file = tmpFile();
    createUserStore(file).ensureAdmin({ email: 'first@example.com' });
    const admin = createUserStore(file).ensureAdmin({ email: 'second@example.com' });
    assert.equal(admin.email, 'first@example.com');
  });

  await t.test('findById and findByEmail (case-insensitive)', () => {
    const store = createUserStore(tmpFile());
    const admin = store.ensureAdmin({ email: 'rachel@example.com' });
    assert.equal(store.findById(admin.id), admin);
    assert.equal(store.findById('nope'), null);
    assert.equal(store.findById(undefined), null);
    assert.equal(store.findByEmail('RACHEL@example.com'), admin);
    assert.equal(store.findByEmail('someone@example.com'), null);
  });

  await t.test('recordLogin stamps lastLoginAt and persists it; unknown ids are ignored', () => {
    const file = tmpFile();
    const store = createUserStore(file);
    const admin = store.ensureAdmin({});
    assert.equal(admin.lastLoginAt, null);
    store.recordLogin(admin.id);
    store.recordLogin('nope');
    assert.ok(createUserStore(file).findAdmin().lastLoginAt);
  });
});

// #594 chunk A: the guest list's add/remove.
test('addUser / removeUser', async t => {
  await t.test('adds a non-admin guest with a normalized email, persisted', () => {
    const file = tmpFile();
    const store = createUserStore(file);
    store.ensureAdmin({ email: 'rachel@example.com' });
    const guest = store.addUser({ email: ' Friend@Example.com ', name: ' Friend ' });
    assert.equal(guest.email, 'friend@example.com');
    assert.equal(guest.name, 'Friend');
    assert.equal(guest.isAdmin, false);
    assert.equal(createUserStore(file).findByEmail('FRIEND@example.com').id, guest.id);
  });

  await t.test('defaults the name to the email local part', () => {
    const store = createUserStore(tmpFile());
    assert.equal(store.addUser({ email: 'ada@example.com' }).name, 'ada');
  });

  await t.test('rejects an invalid or duplicate email, including the admin one', () => {
    const store = createUserStore(tmpFile());
    store.ensureAdmin({ email: 'rachel@example.com' });
    assert.throws(() => store.addUser({ email: 'nope' }), /valid email/);
    assert.throws(() => store.addUser({}), /valid email/);
    assert.throws(() => store.addUser({ email: 'Rachel@example.com' }), /already on the guest list/);
    store.addUser({ email: 'friend@example.com' });
    assert.throws(() => store.addUser({ email: 'friend@example.com' }), /already on the guest list/);
  });

  await t.test('removes a guest, persisted, but never the admin', () => {
    const file = tmpFile();
    const store = createUserStore(file);
    const admin = store.ensureAdmin({ email: 'rachel@example.com' });
    const guest = store.addUser({ email: 'friend@example.com' });
    assert.equal(store.removeUser(admin.id), false);
    assert.equal(store.removeUser(guest.id), true);
    assert.equal(store.removeUser(guest.id), false);
    assert.equal(createUserStore(file).findById(guest.id), null);
    assert.ok(createUserStore(file).findById(admin.id));
  });
});
