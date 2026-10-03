'use strict';

// #595 — legacy flat residue files move to the admin's per-user directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { claimLegacyResidue } = require('../src/residue.js');

test('claimLegacyResidue', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'residue-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const adminDir = path.join(dir, 'users', 'admin');
  fs.writeFileSync(path.join(dir, 'crowley.json'), '{"text":"x"}');
  fs.mkdirSync(path.join(dir, 'users', 'bob'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'users', 'bob', 'jung.json'), '{}');

  await t.test('moves flat files, leaves other users’ directories alone', () => {
    assert.equal(claimLegacyResidue(dir, adminDir), 1);
    assert.ok(fs.existsSync(path.join(adminDir, 'crowley.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'crowley.json')));
    assert.ok(fs.existsSync(path.join(dir, 'users', 'bob', 'jung.json')));
  });

  await t.test('is idempotent', () => {
    assert.equal(claimLegacyResidue(dir, adminDir), 0);
  });

  await t.test('a missing residue dir is a no-op', () => {
    assert.equal(claimLegacyResidue(path.join(dir, 'nope'), adminDir), 0);
  });
});
