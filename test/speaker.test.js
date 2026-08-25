'use strict';

// #285 — speaker.js, extracted from app.js's "Speaker attribution" block.
// Pure text matching (module-convention.test.js covers the #142 shape); this
// covers the matching logic itself, previously untested directly.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadPublicModule } = require('./helpers/dom.js');

const ROSTER = [
  { id: 'crowley', name: 'Aleister Crowley', aliases: ['Beast'] },
  { id: 'blavatsky', name: 'Blavatsky' },
  { id: 'ibn-arabi', name: 'Ibn Arabi' },
  { id: 'ibn-khaldun', name: 'Ibn Khaldun' },
];

function boot(t, { playerSpeakerName = null } = {}) {
  const loaded = loadPublicModule('speaker.js');
  t.after(loaded.cleanup);
  loaded.module.configure({ getPlayerSpeakerName: () => playerSpeakerName });
  return loaded.module;
}

test('normalizeSpeaker', async t => {
  const Speaker = boot(t);
  await t.test('lowercases, strips diacritics and apostrophes, collapses whitespace/hyphens', () => {
    assert.equal(Speaker.normalizeSpeaker("Ibn 'Arabi"), 'ibn arabi');
    assert.equal(Speaker.normalizeSpeaker('  Multiple   Spaces  '), 'multiple spaces');
  });
});

test('resolveMember', async t => {
  const Speaker = boot(t);

  await t.test('resolves a full name', () => {
    assert.equal(Speaker.resolveMember('Blavatsky', ROSTER)?.id, 'blavatsky');
  });

  await t.test('resolves a surname token', () => {
    assert.equal(Speaker.resolveMember('Crowley', ROSTER)?.id, 'crowley');
  });

  await t.test('resolves an alias', () => {
    assert.equal(Speaker.resolveMember('Beast', ROSTER)?.id, 'crowley');
  });

  await t.test(
    'leaves an ambiguous shared token unresolved via the alias index, but still catches the full name',
    () => {
      // "Ibn" alone collides between Ibn Arabi and Ibn Khaldun and drops out of
      // the index; the full names stay distinct and still resolve.
      assert.equal(Speaker.resolveMember('Ibn Arabi', ROSTER)?.id, 'ibn-arabi');
      assert.equal(Speaker.resolveMember('Ibn Khaldun', ROSTER)?.id, 'ibn-khaldun');
    }
  );

  await t.test('returns undefined for no match', () => {
    assert.equal(Speaker.resolveMember('A Stranger', ROSTER), undefined);
  });
});

test('isKnownSpeakerHeader', async t => {
  await t.test('recognizes a roster name or alias, with or without a trailing colon', () => {
    const Speaker = boot(t);
    assert.equal(Speaker.isKnownSpeakerHeader('Blavatsky', ROSTER), true);
    assert.equal(Speaker.isKnownSpeakerHeader('Beast:', ROSTER), true);
  });

  await t.test('rejects a non-roster line', () => {
    const Speaker = boot(t);
    assert.equal(Speaker.isKnownSpeakerHeader('A Stranger', ROSTER), false);
  });

  await t.test('recognizes the live player-as-member identity via deps, not a roster entry', () => {
    const Speaker = boot(t, { playerSpeakerName: 'Custom Player Name' });
    assert.equal(Speaker.isKnownSpeakerHeader('Custom Player Name', ROSTER), true);
  });

  await t.test('does not recognize the player identity when none is set', () => {
    const Speaker = boot(t, { playerSpeakerName: null });
    assert.equal(Speaker.isKnownSpeakerHeader('Custom Player Name', ROSTER), false);
  });
});
