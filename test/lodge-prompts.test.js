'use strict';

// #193 — lodge-prompts.js, extracted from server.js.
//
// Round-shape and player-seat logic; no I/O. Roster and
// stripInternalBlankLines are passed in explicitly, following roster.js's
// convention rather than reaching for module-level singletons.

const test = require('node:test');
const assert = require('node:assert/strict');

const lp = require('../lodge-prompts.js');

const ROSTER = [
  { id: 'crowley', name: 'Crowley' },
  { id: 'blavatsky', name: 'Blavatsky' },
];

test('speakerCountForRound', async t => {
  await t.test('returns the fixed count for rounds 0-2', () => {
    assert.equal(lp.speakerCountForRound(0), 5);
    assert.equal(lp.speakerCountForRound(1), 5);
    assert.equal(lp.speakerCountForRound(2), 4);
  });

  await t.test('falls back to the extra-round count beyond index 2', () => {
    assert.equal(lp.speakerCountForRound(3), lp.EXTRA_ROUND_SPEAKER_COUNT);
    assert.equal(lp.speakerCountForRound(99), lp.EXTRA_ROUND_SPEAKER_COUNT);
  });
});

test('buildRoundPrompt', async t => {
  await t.test('round 0 wraps the entry as freshly read aloud, using default instructions', () => {
    const prompt = lp.buildRoundPrompt(0, 'the document text', null, null, false, ROSTER);
    assert.match(prompt, /The document has just been read aloud/);
    assert.match(prompt, /the document text/);
    assert.match(prompt, new RegExp(lp.DEFAULT_ROUND_INSTRUCTIONS[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  await t.test('round 0 frames a transcript source differently from a fresh document', () => {
    const prompt = lp.buildRoundPrompt(0, 'minutes text', null, null, true, ROSTER);
    assert.match(prompt, /minutes of a previous gathering/);
    assert.doesNotMatch(prompt, /just been read aloud/);
  });

  await t.test('round 0 appends an artifact hint when the artifact member resolves', () => {
    const prompt = lp.buildRoundPrompt(0, 'x', null, { memberId: 'crowley' }, false, ROSTER);
    assert.match(prompt, /Crowley has private context from before the meeting/);
  });

  await t.test('no artifact hint when the artifact member id does not resolve', () => {
    const prompt = lp.buildRoundPrompt(0, 'x', null, { memberId: 'ghost' }, false, ROSTER);
    assert.doesNotMatch(prompt, /private context/);
  });

  await t.test('custom instructions override the default for that round index', () => {
    const custom = ['Custom round zero.'];
    const prompt = lp.buildRoundPrompt(0, 'x', custom, null, false, ROSTER);
    assert.match(prompt, /Custom round zero\./);
  });

  await t.test('non-zero rounds return the instruction text alone, no preamble', () => {
    const prompt = lp.buildRoundPrompt(1, 'x', null, null, false, ROSTER);
    assert.equal(prompt, lp.DEFAULT_ROUND_INSTRUCTIONS[1]);
  });

  await t.test('rounds beyond the default array fall back to the extra-round instruction', () => {
    const prompt = lp.buildRoundPrompt(5, 'x', null, null, false, ROSTER);
    assert.equal(prompt, lp.EXTRA_ROUND_INSTRUCTION);
  });
});

test('playerDirectorPool', async t => {
  await t.test('excludes the player-voiced member id in "member" mode', () => {
    const pool = lp.playerDirectorPool(['crowley', 'blavatsky'], 'member', 'crowley');
    assert.deepEqual(pool, ['blavatsky']);
  });

  await t.test('leaves the pool untouched in "custom" mode', () => {
    const pool = lp.playerDirectorPool(['crowley', 'blavatsky'], 'custom', null);
    assert.deepEqual(pool, ['crowley', 'blavatsky']);
  });

  await t.test('leaves the pool untouched when mode is "member" but no id is given', () => {
    const pool = lp.playerDirectorPool(['crowley', 'blavatsky'], 'member', null);
    assert.deepEqual(pool, ['crowley', 'blavatsky']);
  });
});

test('resolvePlayerName', async t => {
  await t.test('"member" mode resolves the roster member\'s name', () => {
    assert.equal(lp.resolvePlayerName('member', 'crowley', null, ROSTER), 'Crowley');
  });

  await t.test('"member" mode with an unresolvable id returns null', () => {
    assert.equal(lp.resolvePlayerName('member', 'ghost', null, ROSTER), null);
  });

  await t.test('"custom" mode trims and returns the given name', () => {
    assert.equal(lp.resolvePlayerName('custom', null, '  A Visitor  ', ROSTER), 'A Visitor');
  });

  await t.test('"custom" mode with a blank name returns null', () => {
    assert.equal(lp.resolvePlayerName('custom', null, '   ', ROSTER), null);
  });

  await t.test('"none" mode (or anything else) returns null', () => {
    assert.equal(lp.resolvePlayerName('none', null, null, ROSTER), null);
  });
});

test('buildPrecedingTurn', async t => {
  const strip = text => text.replace(/\n{3,}/g, '\n\n');

  await t.test('builds a turn when both a speaker name and non-empty text are present', () => {
    const turn = lp.buildPrecedingTurn('Crowley', { text: 'A line.\n\n\n\nMore.' }, strip);
    assert.deepEqual(turn, { speakerName: 'Crowley', text: 'A line.\n\nMore.' });
  });

  await t.test('returns null when there is no speaker name', () => {
    assert.equal(lp.buildPrecedingTurn(null, { text: 'A line.' }, strip), null);
  });

  await t.test('returns null when playerTurn has no text', () => {
    assert.equal(lp.buildPrecedingTurn('Crowley', null, strip), null);
    assert.equal(lp.buildPrecedingTurn('Crowley', { text: '   ' }, strip), null);
  });
});
