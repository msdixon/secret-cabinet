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
const record = require('../public/js/record.js');

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
  await t.test('the first passage wraps the entry as freshly set before the room, using the opening arc note', () => {
    const prompt = lp.buildPassagePrompt({ entry: 'the document text', isFirst: true, wordsSpent: 0, roster: ROSTER });
    assert.match(prompt, /This has just been set before the room/);
    assert.match(prompt, /the document text/);
    assert.match(prompt, new RegExp(lp.ARC_NOTES.opening.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  await t.test('the first passage frames a transcript source differently from a fresh provocation', () => {
    const prompt = lp.buildPassagePrompt({
      entry: 'minutes text',
      isFirst: true,
      isTranscriptSource: true,
      wordsSpent: 0,
      roster: ROSTER,
    });
    assert.match(prompt, /minutes of a previous gathering/);
    assert.doesNotMatch(prompt, /just been set before the room/);
  });

  await t.test('the first passage appends an artifact hint when the artifact member resolves', () => {
    const prompt = lp.buildPassagePrompt({
      entry: 'x',
      isFirst: true,
      artifact: { memberId: 'crowley' },
      wordsSpent: 0,
      roster: ROSTER,
    });
    assert.match(prompt, /Crowley has private context from before the meeting/);
  });

  await t.test('no artifact hint when the artifact member id does not resolve', () => {
    const prompt = lp.buildPassagePrompt({
      entry: 'x',
      isFirst: true,
      artifact: { memberId: 'ghost' },
      wordsSpent: 0,
      roster: ROSTER,
    });
    assert.doesNotMatch(prompt, /private context/);
  });

  await t.test('a user-supplied meeting note overrides the arc note entirely, for the first passage too', () => {
    const prompt = lp.buildPassagePrompt({
      entry: 'x',
      isFirst: true,
      meetingNote: 'Custom tone for tonight.',
      wordsSpent: 0,
      roster: ROSTER,
    });
    assert.match(prompt, /Custom tone for tonight\./);
    assert.doesNotMatch(prompt, new RegExp(lp.ARC_NOTES.opening.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  await t.test('a later passage returns the arc note alone, no preamble', () => {
    const prompt = lp.buildPassagePrompt({ entry: 'x', isFirst: false, wordsSpent: 1500, breathBudget: 1000 });
    assert.equal(prompt, lp.ARC_NOTES.crosstalk);
  });

  await t.test('a later passage with a meeting note returns the note alone', () => {
    const prompt = lp.buildPassagePrompt({
      entry: 'x',
      isFirst: false,
      meetingNote: 'Stay on the document.',
      wordsSpent: 1500,
      breathBudget: 1000,
    });
    assert.equal(prompt, 'Stay on the document.');
  });
});

test('deriveMeetingNote', async t => {
  await t.test('prefers an explicit meetingNote', () => {
    assert.equal(
      lp.deriveMeetingNote({ meetingNote: '  Keep it sharp.  ', roundInstructions: ['old one'] }),
      'Keep it sharp.'
    );
  });

  await t.test('falls back to joining a legacy roundInstructions array', () => {
    assert.equal(lp.deriveMeetingNote({ roundInstructions: ['First.', 'Second.'] }), 'First. Second.');
  });

  await t.test('drops blank entries when joining the legacy array', () => {
    assert.equal(lp.deriveMeetingNote({ roundInstructions: ['First.', '  ', null, 'Second.'] }), 'First. Second.');
  });

  await t.test('returns null when neither field has anything usable', () => {
    assert.equal(lp.deriveMeetingNote({}), null);
    assert.equal(lp.deriveMeetingNote({ meetingNote: '   ', roundInstructions: [] }), null);
    assert.equal(lp.deriveMeetingNote(null), null);
  });
});

// #352 — the meeting-level turn ledger. Its whole contract is "read the
// record, never throw": every consumer treats a missing or partial `beats`
// as no signal, so the degradation cases below matter as much as the
// counting one.
test('turnsSoFar', async t => {
  await t.test('counts one turn per beat, per member, across every passage', () => {
    assert.deepEqual(
      lp.turnsSoFar([
        { beats: [{ memberId: 'crowley' }, { memberId: 'blavatsky' }, { memberId: 'crowley' }] },
        { beats: [{ memberId: 'crowley' }] },
      ]),
      { crowley: 3, blavatsky: 1 }
    );
  });

  await t.test('a member who never spoke has no key, which every consumer reads as zero', () => {
    const ledger = lp.turnsSoFar([{ beats: [{ memberId: 'crowley' }] }]);
    assert.equal('blavatsky' in ledger, false);
    assert.equal(ledger.blavatsky || 0, 0);
  });

  // Since #354, the player's own turn always carries a real memberId (a
  // roster id, or one of record.js's non-roster sentinels) — never null.
  // This pins the defensive fallback for a caller or an older stored beat
  // that still has one, rather than the current live behavior.
  await t.test('a beat with no memberId at all holds no seat in the ledger', () => {
    assert.deepEqual(lp.turnsSoFar([{ beats: [{ memberId: null, text: 'a human turn' }, { memberId: 'crowley' }] }]), {
      crowley: 1,
    });
  });

  // #354: a speaker who was called on and produced nothing is recorded as
  // `{ memberId, text: '', failed: true }` rather than dropped — a turn the
  // room did not actually hear, so it must not count as one that was.
  await t.test('excludes a failed turn — called on, but the room never heard from them', () => {
    assert.deepEqual(
      lp.turnsSoFar([
        { beats: [{ memberId: 'crowley', text: '', failed: true, error: 'API error' }, { memberId: 'blavatsky' }] },
      ]),
      { blavatsky: 1 }
    );
  });

  // #362: a member who was called on and deliberately passed is recorded as
  // `{ memberId, text, passed: true }` — genuinely heard from (unlike a
  // failed turn), but not fully (PASS_TURN_CREDIT is below 1).
  await t.test('credits a passed turn partially, not fully or not at all', () => {
    assert.deepEqual(lp.turnsSoFar([{ beats: [{ memberId: 'crowley', text: '*lets it go.*', passed: true }] }]), {
      crowley: 0.5,
    });
  });

  await t.test('a passed turn and a spoken turn accumulate distinctly across passages', () => {
    assert.deepEqual(
      lp.turnsSoFar([
        { beats: [{ memberId: 'crowley', text: '*lets it go.*', passed: true }] },
        { beats: [{ memberId: 'crowley', text: 'A real turn.' }] },
      ]),
      { crowley: 1.5 }
    );
  });

  await t.test('sessions predating #244 have no beats at all and reduce to an empty ledger, not an error', () => {
    assert.deepEqual(lp.turnsSoFar([{ text: 'a passage from before beats were stored' }, { text: 'another' }]), {});
  });

  await t.test('tolerates no rounds, a null rounds, and a malformed segment', () => {
    assert.deepEqual(lp.turnsSoFar([]), {});
    assert.deepEqual(lp.turnsSoFar(undefined), {});
    assert.deepEqual(lp.turnsSoFar(null), {});
    assert.deepEqual(lp.turnsSoFar([null, { beats: null }, { beats: [null, { memberId: 'crowley' }] }]), {
      crowley: 1,
    });
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

// #354: the stable identity a player's own turn is recorded under -- roster
// id when playing as a member (the fiction's speaker really is that member),
// record.js's PLAYER_SPEAKER_ID sentinel when playing under one's own name
// (no roster entry to point at), null for every other mode (nothing to
// record -- runRound never receives a precedingTurn at all).
test('resolvePlayerSpeakerId', async t => {
  await t.test('"member" mode resolves to the roster member id', () => {
    assert.equal(lp.resolvePlayerSpeakerId('member', 'crowley'), 'crowley');
  });

  await t.test('"custom" mode resolves to the non-roster sentinel', () => {
    assert.equal(lp.resolvePlayerSpeakerId('custom', null), record.PLAYER_SPEAKER_ID);
  });

  await t.test('"none" mode (or anything else) resolves to null', () => {
    assert.equal(lp.resolvePlayerSpeakerId('none', null), null);
  });
});

test('buildPrecedingTurn', async t => {
  const strip = text => text.replace(/\n{3,}/g, '\n\n');

  await t.test('builds a turn carrying speaker name, memberId, and stripped text', () => {
    const turn = lp.buildPrecedingTurn('Crowley', { text: 'A line.\n\n\n\nMore.' }, strip, 'crowley');
    assert.deepEqual(turn, { speakerName: 'Crowley', memberId: 'crowley', text: 'A line.\n\nMore.' });
  });

  await t.test('carries the non-roster sentinel for a custom-name player', () => {
    const turn = lp.buildPrecedingTurn('A Visitor', { text: 'Hello.' }, strip, record.PLAYER_SPEAKER_ID);
    assert.equal(turn.memberId, record.PLAYER_SPEAKER_ID);
  });

  await t.test('returns null when there is no speaker name', () => {
    assert.equal(lp.buildPrecedingTurn(null, { text: 'A line.' }, strip, 'crowley'), null);
  });

  await t.test('returns null when playerTurn has no text', () => {
    assert.equal(lp.buildPrecedingTurn('Crowley', null, strip, 'crowley'), null);
    assert.equal(lp.buildPrecedingTurn('Crowley', { text: '   ' }, strip, 'crowley'), null);
  });
});
