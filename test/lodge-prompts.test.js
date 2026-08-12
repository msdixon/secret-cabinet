'use strict';

// #193 — lodge-prompts.js, extracted from server.js.
// #244 reshaped this per #194's migration sketch: round-index-keyed prompts
// become progress-keyed arc notes (passages/lulls, not rounds). Player-seat
// logic is untouched by that migration.
//
// Round-shape and player-seat logic; no I/O. Roster and
// stripInternalBlankLines are passed in explicitly, following roster.js's
// convention rather than reaching for module-level singletons.

const test = require('node:test');
const assert = require('node:assert/strict');

const lp = require('../src/lodge-prompts.js');

const ROSTER = [
  { id: 'crowley', name: 'Crowley' },
  { id: 'blavatsky', name: 'Blavatsky' },
];

test('arcNoteForProgress', async t => {
  await t.test('returns the opening note when little or nothing has been spent', () => {
    assert.equal(lp.arcNoteForProgress({ wordsSpent: 0, breathBudget: 1000 }), lp.ARC_NOTES.opening);
    assert.equal(lp.arcNoteForProgress({ wordsSpent: 999, breathBudget: 1000 }), lp.ARC_NOTES.opening);
  });

  await t.test('advances to crosstalk past one breath budget', () => {
    assert.equal(lp.arcNoteForProgress({ wordsSpent: 1000, breathBudget: 1000 }), lp.ARC_NOTES.crosstalk);
    assert.equal(lp.arcNoteForProgress({ wordsSpent: 2999, breathBudget: 1000 }), lp.ARC_NOTES.crosstalk);
  });

  await t.test('advances to embers past three breath budgets', () => {
    assert.equal(lp.arcNoteForProgress({ wordsSpent: 3000, breathBudget: 1000 }), lp.ARC_NOTES.embers);
    assert.equal(lp.arcNoteForProgress({ wordsSpent: 4999, breathBudget: 1000 }), lp.ARC_NOTES.embers);
  });

  await t.test('advances to extended past five breath budgets, and stays there', () => {
    assert.equal(lp.arcNoteForProgress({ wordsSpent: 5000, breathBudget: 1000 }), lp.ARC_NOTES.extended);
    assert.equal(lp.arcNoteForProgress({ wordsSpent: 50000, breathBudget: 1000 }), lp.ARC_NOTES.extended);
  });

  await t.test('defaults breathBudget to 1000 when not given', () => {
    assert.equal(lp.arcNoteForProgress({ wordsSpent: 0 }), lp.ARC_NOTES.opening);
    assert.equal(lp.arcNoteForProgress(), lp.ARC_NOTES.opening);
  });
});

test('buildPassagePrompt', async t => {
  await t.test('the first passage wraps the entry as freshly read aloud, using the opening arc note', () => {
    const prompt = lp.buildPassagePrompt({ entry: 'the document text', isFirst: true, wordsSpent: 0, roster: ROSTER });
    assert.match(prompt, /The document has just been read aloud/);
    assert.match(prompt, /the document text/);
    assert.match(prompt, new RegExp(lp.ARC_NOTES.opening.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  await t.test('the first passage frames a transcript source differently from a fresh document', () => {
    const prompt = lp.buildPassagePrompt({ entry: 'minutes text', isFirst: true, isTranscriptSource: true, wordsSpent: 0, roster: ROSTER });
    assert.match(prompt, /minutes of a previous gathering/);
    assert.doesNotMatch(prompt, /just been read aloud/);
  });

  await t.test('the first passage appends an artifact hint when the artifact member resolves', () => {
    const prompt = lp.buildPassagePrompt({ entry: 'x', isFirst: true, artifact: { memberId: 'crowley' }, wordsSpent: 0, roster: ROSTER });
    assert.match(prompt, /Crowley has private context from before the meeting/);
  });

  await t.test('no artifact hint when the artifact member id does not resolve', () => {
    const prompt = lp.buildPassagePrompt({ entry: 'x', isFirst: true, artifact: { memberId: 'ghost' }, wordsSpent: 0, roster: ROSTER });
    assert.doesNotMatch(prompt, /private context/);
  });

  await t.test('a user-supplied meeting note overrides the arc note entirely, for the first passage too', () => {
    const prompt = lp.buildPassagePrompt({ entry: 'x', isFirst: true, meetingNote: 'Custom tone for tonight.', wordsSpent: 0, roster: ROSTER });
    assert.match(prompt, /Custom tone for tonight\./);
    assert.doesNotMatch(prompt, new RegExp(lp.ARC_NOTES.opening.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  await t.test('a later passage returns the arc note alone, no preamble', () => {
    const prompt = lp.buildPassagePrompt({ entry: 'x', isFirst: false, wordsSpent: 1500, breathBudget: 1000 });
    assert.equal(prompt, lp.ARC_NOTES.crosstalk);
  });

  await t.test('a later passage with a meeting note returns the note alone', () => {
    const prompt = lp.buildPassagePrompt({ entry: 'x', isFirst: false, meetingNote: 'Stay on the document.', wordsSpent: 1500, breathBudget: 1000 });
    assert.equal(prompt, 'Stay on the document.');
  });
});

test('deriveMeetingNote', async t => {
  await t.test('prefers an explicit meetingNote', () => {
    assert.equal(lp.deriveMeetingNote({ meetingNote: '  Keep it sharp.  ', roundInstructions: ['old one'] }), 'Keep it sharp.');
  });

  await t.test('falls back to joining a legacy roundInstructions array', () => {
    assert.equal(
      lp.deriveMeetingNote({ roundInstructions: ['First.', 'Second.'] }),
      'First. Second.',
    );
  });

  await t.test('drops blank entries when joining the legacy array', () => {
    assert.equal(
      lp.deriveMeetingNote({ roundInstructions: ['First.', '  ', null, 'Second.'] }),
      'First. Second.',
    );
  });

  await t.test('returns null when neither field has anything usable', () => {
    assert.equal(lp.deriveMeetingNote({}), null);
    assert.equal(lp.deriveMeetingNote({ meetingNote: '   ', roundInstructions: [] }), null);
    assert.equal(lp.deriveMeetingNote(null), null);
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
