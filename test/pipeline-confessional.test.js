'use strict';

// Confessional asides (src/pipeline-confessional.js). Split out of pipeline.test.js for #629.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDirectorPrompt,
  runRound,
  canOpenConfessional,
  sanitizeConfessional,
  buildConfessionalUserMessage,
  formatConfessionalBlock,
} = require('../src/pipeline.js');
const {
  MAX_CONFESSIONALS_PER_PASSAGE,
  CONFESSIONAL_MIN_BUDGET_WORDS,
  CONFESSIONAL_MAX_TOKENS,
} = require('../src/tuning.js');
const { clampedAt, fakeConsultClient } = require('./helpers/fake-anthropic.js');
const {
  LODGE,
  SPLINTER_ROSTER,
  loadSplinterMemberFile,
  withScriptedRandom,
} = require('./helpers/pipeline-fixtures.js');

// #579 — confessional asides. Pure pieces first, then runRound end to end
// with a director that proposes a confessional per consult.
test('canOpenConfessional — gates a director-proposed confessional on something concrete (#579)', () => {
  const ok = {
    memberId: 'crowley',
    hasSpoken: true,
    confessionalCount: 0,
    remainingBudget: CONFESSIONAL_MIN_BUDGET_WORDS,
  };
  assert.equal(canOpenConfessional(ok), true);
  assert.equal(canOpenConfessional({ ...ok, memberId: null }), false);
  assert.equal(canOpenConfessional({ ...ok, hasSpoken: false }), false, 'must already have spoken tonight');
  assert.equal(canOpenConfessional({ ...ok, confessionalCount: MAX_CONFESSIONALS_PER_PASSAGE }), false);
  assert.equal(canOpenConfessional({ ...ok, remainingBudget: CONFESSIONAL_MIN_BUDGET_WORDS - 1 }), false);
});

test('sanitizeConfessional — keeps only a present member id (#579)', () => {
  assert.equal(sanitizeConfessional('crowley', ['crowley', 'scholem']), 'crowley');
  assert.equal(sanitizeConfessional('dee', ['crowley', 'scholem']), null);
  assert.equal(sanitizeConfessional(undefined, ['crowley']), null);
  assert.equal(sanitizeConfessional(['crowley'], ['crowley']), null);
});

test('buildConfessionalUserMessage — hears the room, addresses no one (#579)', () => {
  const withRoom = buildConfessionalUserMessage({ speaker: { name: 'Crowley' }, roundSoFarText: 'Scholem\nA point.' });
  assert.match(withRoom, /--- THE ROOM SO FAR THIS PASSAGE ---\nScholem\nA point\./);
  assert.match(withRoom, /Generate Crowley's confessional now\.$/);
  const empty = buildConfessionalUserMessage({ speaker: { name: 'Crowley' }, roundSoFarText: '  ' });
  assert.doesNotMatch(empty, /THE ROOM SO FAR/);
});

test('formatConfessionalBlock — the bracketed record shape parseWitnessBlocks reads back (#579)', () => {
  assert.equal(
    formatConfessionalBlock({ name: 'Crowley' }, 'Long thought.'),
    '[Confessional — Crowley, apart from the room]\nCrowley\nLong thought.\n[/Confessional]'
  );
});

test('buildDirectorPrompt — offers the confessional option (#579)', () => {
  const prompt = buildDirectorPrompt({
    lodgeContext: LODGE,
    presentMembers: SPLINTER_ROSTER,
    instruction: 'Opening prompt',
    minCount: 1,
    maxCount: 2,
  });
  assert.match(prompt.system, /you may name a confessional/);
});

// #579 — per-consult confessional on the select_speakers response; also
// exposes each speaker stream's max_tokens so the larger confessional
// ceiling is observable.
function fakeDirectorConfessionalClient({ confessionalOnConsult = [], windingDownOnConsult = [false, true] } = {}) {
  const client = fakeConsultClient({
    speakers: ['crowley', 'scholem'],
    windingDownOnConsult,
    lullNote: 'A note.',
    consultExtras: i => {
      const confessional = clampedAt(confessionalOnConsult, i);
      return confessional ? { confessional } : {};
    },
  });
  return { client, streamMaxTokens: client.streamMaxTokens };
}

function confessionalRound(client, extra = {}) {
  return runRound({
    client,
    model: 'test-model',
    lodgeContext: LODGE,
    ROSTER: SPLINTER_ROSTER,
    loadMemberFile: loadSplinterMemberFile,
    presentMemberIds: ['crowley', 'scholem'],
    artifact: null,
    notes: {},
    roundPrompt: 'Opening prompt',
    conversationHistory: [],
    speakerCount: 2,
    round: 0,
    disposition: {},
    ...extra,
  });
}

test('runRound — director-proposed confessionals (#579)', async t => {
  await t.test('a mid-passage confessional reaches the record but never the room', async () => {
    const { client, streamMaxTokens } = fakeDirectorConfessionalClient({
      windingDownOnConsult: [false, false, true],
      confessionalOnConsult: [null, 'crowley'],
    });
    const result = await withScriptedRandom([0, 0, 0, 0, 0, 0], () => confessionalRound(client));

    const confessionals = result.beats.filter(b => b.thread?.kind === 'confessional');
    assert.equal(confessionals.length, 1);
    assert.equal(confessionals[0].memberId, 'crowley');
    assert.deepEqual(confessionals[0].thread.participants, ['crowley']);

    assert.match(
      result.fullRoundText,
      /\[Confessional — Crowley, apart from the room\]\nCrowley\nA turn\.\n\[\/Confessional\]/
    );
    assert.doesNotMatch(result.historyText, /Confessional/);
    // Everything else in the record is also in history — only the block differs.
    assert.equal(result.fullRoundText.replace(/\n*\[Confessional[\s\S]*?\[\/Confessional\]/, ''), result.historyText);

    // Exactly one speaker call ran with the larger ceiling.
    assert.equal(streamMaxTokens.filter(n => n === CONFESSIONAL_MAX_TOKENS).length, 1);
    assert.ok(streamMaxTokens.some(n => n !== CONFESSIONAL_MAX_TOKENS));
  });

  await t.test('an opening proposal for someone who has not spoken yet tonight is dropped', async () => {
    const { client } = fakeDirectorConfessionalClient({ confessionalOnConsult: ['crowley', null] });
    const result = await withScriptedRandom([0, 0], () => confessionalRound(client));
    assert.ok(result.beats.every(b => b.thread?.kind !== 'confessional'));
    assert.equal(result.fullRoundText, result.historyText);
  });

  await t.test('…but opens at the passage start for someone who already spoke earlier tonight', async () => {
    const { client } = fakeDirectorConfessionalClient({ confessionalOnConsult: ['scholem', null] });
    const result = await withScriptedRandom([0, 0], () => confessionalRound(client, { meetingTurns: { scholem: 2 } }));
    assert.equal(result.beats[0].thread?.kind, 'confessional');
    assert.equal(result.beats[0].memberId, 'scholem');
    assert.match(result.fullRoundText, /^\[Confessional — Scholem, apart from the room\]/);
    assert.doesNotMatch(result.historyText, /Confessional/);
  });

  await t.test('the once-per-passage cap holds across consults', async () => {
    const { client } = fakeDirectorConfessionalClient({
      windingDownOnConsult: [false, false, false, true],
      confessionalOnConsult: ['scholem', 'crowley', 'scholem'],
    });
    const result = await withScriptedRandom([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], () =>
      confessionalRound(client, { meetingTurns: { scholem: 1 } })
    );
    assert.equal(result.beats.filter(b => b.thread?.kind === 'confessional').length, MAX_CONFESSIONALS_PER_PASSAGE);
  });
});
