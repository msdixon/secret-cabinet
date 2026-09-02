'use strict';

// #513 phase 1 — offline unit tests for the brevity/tangent baseline
// measurement script, against inline fixtures. No API key, no real session
// data required — the real 11 local sessions are exercised by actually
// running the script (see scripts/measure-brevity-baseline.js's CLI entry),
// not by this suite, same split as eval-citation-grounding's golden-set
// tests vs. its manual quarterly run.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSpeaker,
  buildAliasIndex,
  resolveSpeakerId,
  parseLegacyRoundTurns,
  looksLikeCitation,
  turnsForRound,
  turnsForSession,
  wordCount,
  median,
  summarize,
  summarizeByMember,
} = require('../scripts/measure-brevity-baseline.js');

const ROSTER = [
  { id: 'crowley', name: 'Aleister Crowley', aliases: ['Crowley', 'AC'] },
  { id: 'yeats', name: 'W.B. Yeats', aliases: ['Yeats'] },
  { id: 'khaldun', name: 'Ibn Khaldun', aliases: [] },
  { id: 'arabi', name: 'Ibn Arabi', aliases: [] },
];

test('normalizeSpeaker', async t => {
  await t.test('lowercases, strips accents/apostrophes, collapses whitespace/hyphens', () => {
    assert.equal(normalizeSpeaker('W.B. Yeats'), 'w.b. yeats');
    assert.equal(normalizeSpeaker("O'Brien-Smith"), 'obrien smith');
    assert.equal(normalizeSpeaker('  Crowley  '), 'crowley');
  });
});

test('buildAliasIndex', async t => {
  await t.test('resolves full names and declared aliases', () => {
    const index = buildAliasIndex(ROSTER);
    assert.equal(index.get(normalizeSpeaker('Aleister Crowley')), 'crowley');
    assert.equal(index.get(normalizeSpeaker('AC')), 'crowley');
    assert.equal(index.get(normalizeSpeaker('Yeats')), 'yeats');
  });

  await t.test('an ambiguous shared token resolves to null, not a guess', () => {
    const index = buildAliasIndex(ROSTER);
    assert.equal(index.get(normalizeSpeaker('Ibn')), null);
  });

  await t.test('drops stopword tokens like "of"/"the" from single-word alias registration', () => {
    const index = buildAliasIndex(ROSTER);
    assert.equal(index.has(normalizeSpeaker('of')), false);
  });
});

test('resolveSpeakerId', async t => {
  const index = buildAliasIndex(ROSTER);

  await t.test('resolves a known header, trailing colon included', () => {
    assert.equal(resolveSpeakerId('Aleister Crowley:', index), 'crowley');
    assert.equal(resolveSpeakerId('Yeats', index), 'yeats');
  });

  await t.test('returns undefined for an unrecognized line', () => {
    assert.equal(resolveSpeakerId('The wind moved through the room.', index), undefined);
  });

  await t.test('returns null for an ambiguous alias', () => {
    assert.equal(resolveSpeakerId('Ibn', index), null);
  });
});

test('parseLegacyRoundTurns', async t => {
  const index = buildAliasIndex(ROSTER);

  await t.test('splits a round blob into per-speaker turns on recognized name headers', () => {
    const text = ['Aleister Crowley', 'The Beast speaks first.', '', 'W.B. Yeats', 'And the poet answers.'].join('\n');
    const turns = parseLegacyRoundTurns(text, index);
    assert.deepEqual(turns, [
      { memberId: 'crowley', text: 'The Beast speaks first.' },
      { memberId: 'yeats', text: 'And the poet answers.' },
    ]);
  });

  await t.test('a multi-line paragraph under one speaker stays one turn', () => {
    const text = ['Yeats', 'Line one.', 'Line two.'].join('\n');
    const turns = parseLegacyRoundTurns(text, index);
    assert.deepEqual(turns, [{ memberId: 'yeats', text: 'Line one.\nLine two.' }]);
  });

  await t.test('drops a leading scene-setting action line before any speaker', () => {
    const text = ['*A candle gutters.*', 'Yeats', 'I speak.'].join('\n');
    const turns = parseLegacyRoundTurns(text, index);
    assert.deepEqual(turns, [{ memberId: 'yeats', text: 'I speak.' }]);
  });

  await t.test("a pure-action turn under a known speaker is kept as that speaker's turn", () => {
    const text = ['Yeats', '*He falls silent.*'].join('\n');
    const turns = parseLegacyRoundTurns(text, index);
    assert.deepEqual(turns, [{ memberId: 'yeats', text: '*He falls silent.*' }]);
  });

  await t.test('strips separator lines and Aside brackets without treating them as prose', () => {
    const text = [
      'Yeats',
      'Before the aside.',
      '[Aside — Yeats and Crowley, apart from the room]',
      'Crowley',
      'Inside the aside.',
      '[/Aside]',
      '---',
      'Yeats',
      'After the aside.',
    ].join('\n');
    const turns = parseLegacyRoundTurns(text, index);
    assert.deepEqual(turns, [
      { memberId: 'yeats', text: 'Before the aside.' },
      { memberId: 'crowley', text: 'Inside the aside.' },
      { memberId: 'yeats', text: 'After the aside.' },
    ]);
  });
});

test('looksLikeCitation', async t => {
  await t.test('flags a substantial quoted span', () => {
    assert.equal(looksLikeCitation('As it says, "the will alone is the whole of the law of magick."'), true);
  });

  await t.test('flags a proper-noun attribution verb pattern', () => {
    assert.equal(looksLikeCitation('Ibn Khaldun writes that history repeats its own forms.'), true);
  });

  await t.test('flags "according to"', () => {
    assert.equal(looksLikeCitation('According to Ibn Arabi, the heart takes every form.'), true);
  });

  await t.test('does not flag ordinary prose', () => {
    assert.equal(looksLikeCitation('The room falls quiet for a moment.'), false);
  });
});

test('turnsForRound', async t => {
  const index = buildAliasIndex(ROSTER);

  await t.test('prefers structured beats when present', () => {
    const round = {
      text: 'ignored',
      beats: [
        { memberId: 'crowley', text: 'A grand pronouncement.', passed: false, citations: [{ quote: 'x' }] },
        { memberId: 'yeats', text: '*nods*', passed: true },
        { memberId: 'khaldun', failed: true, text: 'should be excluded' },
      ],
    };
    const turns = turnsForRound(round, index);
    assert.deepEqual(turns, [
      {
        memberId: 'crowley',
        text: 'A grand pronouncement.',
        passed: false,
        citationSource: 'structured',
        hasCitation: true,
      },
      { memberId: 'yeats', text: '*nods*', passed: true, citationSource: 'structured', hasCitation: false },
    ]);
  });

  await t.test('falls back to text parsing when no beats array is present', () => {
    const round = { text: ['Crowley', 'According to legend, the will is law.'].join('\n') };
    const turns = turnsForRound(round, index);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].memberId, 'crowley');
    assert.equal(turns[0].citationSource, 'heuristic');
    assert.equal(turns[0].hasCitation, true);
    assert.equal(turns[0].passed, false);
  });

  await t.test('a legacy pure-action-only turn is marked passed via isPassTurn', () => {
    const round = { text: ['Yeats', '*He says nothing.*'].join('\n') };
    const turns = turnsForRound(round, index);
    assert.equal(turns[0].passed, true);
  });
});

test('turnsForSession', async t => {
  await t.test('flattens turns across every round in a session', () => {
    const index = buildAliasIndex(ROSTER);
    const session = {
      rounds: [{ text: ['Crowley', 'First.'].join('\n') }, { text: ['Yeats', 'Second.'].join('\n') }],
    };
    const turns = turnsForSession(session, index);
    assert.equal(turns.length, 2);
    assert.deepEqual(
      turns.map(t => t.memberId),
      ['crowley', 'yeats']
    );
  });
});

test('wordCount', async t => {
  await t.test('counts whitespace-separated words', () => {
    assert.equal(wordCount('one two three'), 3);
    assert.equal(wordCount('  padded   text  '), 2);
    assert.equal(wordCount(''), 0);
  });
});

test('median', async t => {
  await t.test('handles odd and even length arrays, and empty', () => {
    assert.equal(median([1, 3, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([]), 0);
  });
});

test('summarize', async t => {
  await t.test('separates spoken from passed beats and computes proportions/averages', () => {
    const turns = [
      { text: 'one two three four', passed: false, hasCitation: true },
      { text: 'one two', passed: false, hasCitation: false },
      { text: '*silent*', passed: true, hasCitation: false },
    ];
    const stats = summarize(turns);
    assert.equal(stats.totalBeats, 3);
    assert.equal(stats.spokenBeats, 2);
    assert.equal(stats.passedBeats, 1);
    assert.equal(stats.passedProportion, 1 / 3);
    assert.equal(stats.avgWordsSpoken, 3);
    assert.equal(stats.medianWordsSpoken, 3);
    assert.equal(stats.citationBeats, 1);
    assert.equal(stats.citationProportion, 0.5);
  });

  await t.test('handles an empty turn list without dividing by zero', () => {
    const stats = summarize([]);
    assert.equal(stats.totalBeats, 0);
    assert.equal(stats.passedProportion, 0);
    assert.equal(stats.citationProportion, 0);
    assert.equal(stats.avgWordsSpoken, 0);
  });
});

test('summarizeByMember', async t => {
  await t.test('groups by memberId, tags each with roster name and length tendency, sorted by volume', () => {
    const turns = [
      { memberId: 'crowley', text: 'a b c', passed: false, hasCitation: false },
      { memberId: 'crowley', text: 'a b', passed: false, hasCitation: false },
      { memberId: 'yeats', text: 'a', passed: false, hasCitation: false },
    ];
    const rows = summarizeByMember(turns, ROSTER);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].memberId, 'crowley');
    assert.equal(rows[0].name, 'Aleister Crowley');
    assert.equal(rows[0].totalBeats, 2);
    assert.equal(rows[1].memberId, 'yeats');
  });
});
