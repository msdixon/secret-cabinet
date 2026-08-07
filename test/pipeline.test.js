'use strict';

// #137 — first test tranche for pipeline.js's pure functions, per the scope
// addition on the issue (2026-08-06 state-of-app review). These are the
// scheduling primitives #164's word-budget beat loop made load-bearing:
// no API calls, no I/O, and CI exercised none of them until now. They also
// derisk the #194 rounds spike -- any restructuring of the beat loop wants
// these pinned first.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pickNextSpeaker,
  isPoolExhausted,
  isValidSelection,
  stripInternalBlankLines,
  countWords,
  lengthTendencyOf,
  DISPOSITION_MAX_CHARS,
  buildDispositionSystemPrompt,
  buildDispositionUserMessage,
  callDispositionUpdate,
  CASTING_DOCUMENT_LIMIT,
  buildCastingToolSchema,
  buildCastingPrompt,
  proposeCast,
} = require('../pipeline.js');

// pickNextSpeaker is weighted-random. Rather than seed a PRNG, sweep rng
// deterministically across [0,1) and count outcomes -- the resulting share
// per member IS the weight distribution, so these assertions describe the
// intended behaviour ("rare but real", "expansive gets more room") in the
// units the constants are written in.
function shareOf(memberId, args, samples = 2000) {
  let hits = 0;
  for (let i = 0; i < samples; i++) {
    const rng = () => (i + 0.5) / samples;
    if (pickNextSpeaker({ ...args, rng }) === memberId) hits++;
  }
  return hits / samples;
}

const counts = pairs => new Map(pairs);

test('lengthTendencyOf', async t => {
  await t.test('returns the seeded override for the two named personas', () => {
    assert.equal(lengthTendencyOf('crowley'), 'expansive');
    assert.equal(lengthTendencyOf('yeats'), 'expansive');
  });

  await t.test('defaults to medium for everyone else', () => {
    assert.equal(lengthTendencyOf('scholem'), 'medium');
    assert.equal(lengthTendencyOf('nobody-by-this-id'), 'medium');
  });
});

test('isPoolExhausted', async t => {
  await t.test('is true only once every pool member has hit the 2-turn cap', () => {
    const pool = ['scholem', 'blavatsky'];
    assert.equal(isPoolExhausted(pool, counts([['scholem', 2], ['blavatsky', 2]])), true);
    assert.equal(isPoolExhausted(pool, counts([['scholem', 2], ['blavatsky', 1]])), false);
    assert.equal(isPoolExhausted(pool, counts([])), false);
  });

  await t.test('treats a member absent from spokenCounts as having spoken zero times', () => {
    assert.equal(isPoolExhausted(['scholem'], counts([])), false);
  });

  await t.test('counts above the cap still read as exhausted', () => {
    assert.equal(isPoolExhausted(['scholem'], counts([['scholem', 5]])), true);
  });

  await t.test('an empty pool is vacuously exhausted', () => {
    assert.equal(isPoolExhausted([], counts([])), true);
  });
});

test('pickNextSpeaker', async t => {
  await t.test('returns null when every pool member is at the cap, so the caller re-consults the director', () => {
    const picked = pickNextSpeaker({
      pool: ['scholem', 'blavatsky'],
      spokenCounts: counts([['scholem', 2], ['blavatsky', 2]]),
      lastSpeakerId: 'blavatsky',
      remainingBudget: 500,
      rng: () => 0.5,
    });
    assert.equal(picked, null);
  });

  await t.test('never picks a member already at the cap', () => {
    const args = {
      pool: ['scholem', 'blavatsky'],
      spokenCounts: counts([['scholem', 2]]),
      lastSpeakerId: null,
      remainingBudget: 500,
    };
    assert.equal(shareOf('scholem', args), 0);
    assert.equal(shareOf('blavatsky', args), 1);
  });

  await t.test('speaking back-to-back is rare but possible (~12% against one fresh voice)', () => {
    const share = shareOf('scholem', {
      pool: ['scholem', 'blavatsky'],
      spokenCounts: counts([['scholem', 1]]),
      lastSpeakerId: 'scholem',
      remainingBudget: 500,
    });
    // 0.12 / (0.12 + 1)
    assert.ok(Math.abs(share - 0.107) < 0.01, `back-to-back share was ${share}`);
    assert.ok(share > 0, 'back-to-back must stay possible, not impossible');
  });

  await t.test('an earlier turn this round discounts a repeat more than a fresh voice', () => {
    const share = shareOf('scholem', {
      pool: ['scholem', 'blavatsky'],
      spokenCounts: counts([['scholem', 1]]),
      // Someone outside the pool held the floor last, so neither candidate
      // carries the back-to-back penalty — this isolates the decay factor.
      lastSpeakerId: 'crowley',
      remainingBudget: 500,
    });
    // 0.45 / (0.45 + 1) — discounted, but far likelier than the back-to-back case
    assert.ok(Math.abs(share - 0.310) < 0.01, `repeat-after-gap share was ${share}`);
  });

  await t.test('expansive voices are favoured while there is budget to spend', () => {
    const share = shareOf('crowley', {
      pool: ['crowley', 'scholem'],
      spokenCounts: counts([]),
      lastSpeakerId: null,
      remainingBudget: 500,
    });
    // 1.35 / (1.35 + 1)
    assert.ok(Math.abs(share - 0.574) < 0.01, `expansive share was ${share}`);
  });

  await t.test('below the low-budget threshold that preference inverts, so the round can close', () => {
    const args = {
      pool: ['crowley', 'scholem'],
      spokenCounts: counts([]),
      lastSpeakerId: null,
      remainingBudget: 100, // < LOW_BUDGET_WORDS (120)
    };
    // 1.35 * 0.4 = 0.54, against a medium voice's 1
    const share = shareOf('crowley', args);
    assert.ok(Math.abs(share - 0.351) < 0.01, `low-budget expansive share was ${share}`);
    assert.ok(share < shareOf('scholem', args), 'terse-ish voices should win on a thin budget');
  });

  await t.test('always returns a member of the pool', () => {
    const pool = ['crowley', 'scholem', 'blavatsky'];
    for (let i = 0; i < 200; i++) {
      const picked = pickNextSpeaker({
        pool,
        spokenCounts: counts([['crowley', 1]]),
        lastSpeakerId: 'scholem',
        remainingBudget: 300,
        rng: () => i / 200,
      });
      assert.ok(pool.includes(picked), `picked ${picked}, which is not in the pool`);
    }
  });

  await t.test('an rng returning exactly 1 still lands on a real member (floating-point fallback)', () => {
    const picked = pickNextSpeaker({
      pool: ['crowley', 'scholem'],
      spokenCounts: counts([]),
      lastSpeakerId: null,
      remainingBudget: 500,
      rng: () => 1,
    });
    assert.equal(picked, 'scholem');
  });
});

test('countWords', async t => {
  await t.test('counts whitespace-separated words', () => {
    assert.equal(countWords('the room falls silent'), 4);
  });

  await t.test('empty and whitespace-only text is zero, not one', () => {
    assert.equal(countWords(''), 0);
    assert.equal(countWords('   \n\t  '), 0);
  });

  await t.test('collapses runs of whitespace and newlines', () => {
    assert.equal(countWords('  one   two\n\nthree\tfour  '), 4);
  });
});

test('stripInternalBlankLines', async t => {
  await t.test('collapses a blank line so a multi-paragraph turn does not fragment into unattributed bubbles', () => {
    assert.equal(
      stripInternalBlankLines('First beat.\n\nSecond beat.'),
      'First beat.\nSecond beat.',
    );
  });

  await t.test('collapses a run of blank lines, or a whitespace-only line, to one break', () => {
    assert.equal(stripInternalBlankLines('a\n\n\n\nb'), 'a\nb');
    assert.equal(stripInternalBlankLines('a\n   \nb'), 'a\nb');
    assert.equal(stripInternalBlankLines('a\n\t\nb'), 'a\nb');
  });

  await t.test('leaves single line breaks alone — those are the sanctioned pause', () => {
    assert.equal(stripInternalBlankLines('a\nb\nc'), 'a\nb\nc');
  });

  await t.test('leaves text with no blank lines untouched', () => {
    const text = '*She sets down the glass.* The point is not the ritual.';
    assert.equal(stripInternalBlankLines(text), text);
  });
});

test('isValidSelection', async t => {
  const present = ['crowley', 'scholem', 'blavatsky'];

  await t.test('accepts a distinct, in-range, all-present selection', () => {
    assert.equal(isValidSelection(['crowley', 'scholem'], present, 1, 3), true);
  });

  await t.test('rejects a non-array (the shape a malformed tool call arrives in)', () => {
    assert.equal(isValidSelection(undefined, present, 1, 3), false);
    assert.equal(isValidSelection(null, present, 1, 3), false);
    assert.equal(isValidSelection('crowley', present, 1, 3), false);
  });

  await t.test('rejects counts outside [minCount, maxCount]', () => {
    assert.equal(isValidSelection([], present, 1, 3), false);
    assert.equal(isValidSelection(['crowley', 'scholem', 'blavatsky'], present, 1, 2), false);
  });

  await t.test('rejects duplicates', () => {
    assert.equal(isValidSelection(['crowley', 'crowley'], present, 1, 3), false);
  });

  await t.test('rejects a member who is not present, even if otherwise well-formed', () => {
    assert.equal(isValidSelection(['crowley', 'yeats'], present, 1, 3), false);
  });

  await t.test('accepts an empty selection only when minCount allows it', () => {
    assert.equal(isValidSelection([], present, 0, 3), true);
  });
});

// #188 — the disposition scratchpad's pure prompt builders and the hard
// truncation cap on callDispositionUpdate. The cap is the load-bearing
// requirement from the issue ("must not balloon prompts") so it's pinned
// here rather than trusted to prompt compliance alone — same principle as
// stripInternalBlankLines not trusting the model to skip blank lines.
test('buildDispositionSystemPrompt', async t => {
  const member = { id: 'scholem', name: 'Gershom Scholem' };

  await t.test('tells a first-time reflection there is no prior state', () => {
    const prompt = buildDispositionSystemPrompt({ member, priorDisposition: null });
    assert.match(prompt, /no prior state yet/);
    assert.match(prompt, /Gershom Scholem/);
  });

  await t.test('quotes the prior disposition back and asks for an update, not a repeat', () => {
    const prompt = buildDispositionSystemPrompt({ member, priorDisposition: 'Unconvinced by Crowley\'s reading of Kabbalah.' });
    assert.match(prompt, /Unconvinced by Crowley's reading of Kabbalah\./);
    assert.match(prompt, /don't just repeat it back/);
  });

  await t.test('states the hard character cap', () => {
    const prompt = buildDispositionSystemPrompt({ member, priorDisposition: null });
    assert.match(prompt, new RegExp(`under ${DISPOSITION_MAX_CHARS} characters`));
  });
});

test('buildDispositionUserMessage', async t => {
  await t.test('includes the round context, the member\'s own turn, and their name', () => {
    const member = { id: 'yeats', name: 'W.B. Yeats' };
    const message = buildDispositionUserMessage({
      roundSoFarText: 'Crowley\nThe ritual is the point.',
      turnText: 'I take the opposite view entirely.',
      member,
    });
    assert.match(message, /Crowley\nThe ritual is the point\./);
    assert.match(message, /I take the opposite view entirely\./);
    assert.match(message, /YOU \(W\.B\. Yeats\) JUST SAID/);
  });
});

test('callDispositionUpdate', async t => {
  await t.test('hard-truncates the response to DISPOSITION_MAX_CHARS regardless of what the model returns', async () => {
    const overlong = 'x'.repeat(DISPOSITION_MAX_CHARS + 200);
    const fakeClient = {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: overlong }],
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
      },
    };
    const { text } = await callDispositionUpdate({ client: fakeClient, model: 'test-model', system: 'sys', userMessage: 'msg' });
    assert.equal(text.length, DISPOSITION_MAX_CHARS);
  });

  await t.test('trims whitespace and returns an empty string if the model returns nothing usable', async () => {
    const fakeClient = {
      messages: {
        create: async () => ({ content: [], usage: null }),
      },
    };
    const { text } = await callDispositionUpdate({ client: fakeClient, model: 'test-model', system: 'sys', userMessage: 'msg' });
    assert.equal(text, '');
  });
});

// #185 — the pre-convene casting call. The load-bearing promise here is that
// the user's regulars are *input*, not a suggestion the model is free to
// drop: proposeCast has to keep them in the cast no matter what comes back,
// and has to skip the call entirely when they already fill the room. Both are
// exactly the kind of thing that would degrade silently in production — a
// dropped regular reads as "the AI decided", not as a bug.

const LODGE = 'THE LODGE CONTEXT';
const ROSTER = [
  { id: 'crowley', name: 'Crowley', brief: 'Ceremonial magician; wrote The Book of the Law.' },
  { id: 'yeats', name: 'Yeats', brief: 'Poet; Golden Dawn initiate.' },
  { id: 'blavatsky', name: 'Blavatsky', brief: 'Founded the Theosophical Society.' },
  { id: 'jung', name: 'Jung', brief: 'Analytical psychology; alchemy as psychic process.' },
  { id: 'scholem', name: 'Scholem', brief: 'Historian of Jewish mysticism.' },
];

// A client that answers the casting tool call with whatever ids the test
// wants, and records what it was asked.
function fakeCastingClient(reply) {
  const asked = [];
  return {
    asked,
    messages: {
      create: async (req) => {
        asked.push(req);
        const r = typeof reply === 'function' ? reply(asked.length) : reply;
        if (r instanceof Error) throw r;
        return {
          content: [{ type: 'tool_use', input: r }],
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      },
    },
  };
}

test('buildCastingToolSchema', async t => {
  await t.test('constrains the enum to the candidates, not the whole roster', () => {
    const schema = buildCastingToolSchema(['jung', 'scholem'], 1, 2);
    assert.equal(schema.name, 'cast_the_evening');
    assert.deepEqual(schema.input_schema.properties.speakers.items.enum, ['jung', 'scholem']);
    assert.equal(schema.input_schema.properties.speakers.minItems, 1);
    assert.equal(schema.input_schema.properties.speakers.maxItems, 2);
    assert.equal(schema.input_schema.properties.speakers.uniqueItems, true);
  });
});

test('buildCastingPrompt', async t => {
  const candidates = ROSTER.slice(2);
  const regulars = ROSTER.slice(0, 2);

  await t.test('hands the regulars over as fixed, not as options', () => {
    const { system } = buildCastingPrompt({
      lodgeContext: LODGE, candidates, regulars,
      documentText: 'a document about alchemy', minCount: 1, maxCount: 4,
    });
    assert.match(system, /ALREADY COMING TONIGHT/);
    assert.match(system, /not yours to choose, and not yours to drop/);
    // The regulars must not also appear in the choosable list.
    const choosable = system.slice(system.indexOf('THE REST OF THE LODGE'));
    assert.equal(/- crowley —/.test(choosable), false);
    assert.match(choosable, /- jung — Jung: Analytical psychology/);
  });

  await t.test('says so plainly when nothing is pinned', () => {
    const { system } = buildCastingPrompt({
      lodgeContext: LODGE, candidates: ROSTER, regulars: [],
      documentText: 'a document', minCount: 4, maxCount: 6,
    });
    assert.match(system, /No one is fixed for tonight/);
    assert.equal(/ALREADY COMING TONIGHT/.test(system), false);
  });

  await t.test('carries the member briefs — names alone are not enough to cast on', () => {
    const { system } = buildCastingPrompt({
      lodgeContext: LODGE, candidates: ROSTER, regulars: [],
      documentText: 'a document', minCount: 4, maxCount: 6,
    });
    assert.match(system, /Historian of Jewish mysticism/);
  });

  await t.test('truncates the document rather than paying for a whole book', () => {
    const { system } = buildCastingPrompt({
      lodgeContext: LODGE, candidates: ROSTER, regulars: [],
      documentText: 'z'.repeat(CASTING_DOCUMENT_LIMIT + 500), minCount: 4, maxCount: 6,
    });
    assert.equal(new RegExp(`z{${CASTING_DOCUMENT_LIMIT}}[^z]`).test(system + '|'), true);
  });

  await t.test('asks for friction, not coverage', () => {
    const { system } = buildCastingPrompt({
      lodgeContext: LODGE, candidates: ROSTER, regulars: [],
      documentText: 'a document', minCount: 4, maxCount: 6,
    });
    assert.match(system, /Cast for friction as much as for affinity/);
    assert.match(system, /Do not choose for coverage, seniority, or roster order/);
  });
});

test('proposeCast', async t => {
  await t.test('returns regulars first, then the model\'s additions in its own order', async () => {
    const client = fakeCastingClient({ speakers: ['scholem', 'jung'], reasoning: 'Both would dispute it.' });
    const result = await proposeCast({
      client, model: 'test-model', lodgeContext: LODGE, roster: ROSTER,
      regularIds: ['yeats', 'crowley'], documentText: 'a document about the Kabbalah',
    });
    assert.deepEqual(result.cast, ['crowley', 'yeats', 'scholem', 'jung']);
    assert.deepEqual(result.additions, ['scholem', 'jung']);
    assert.deepEqual(result.regulars, ['crowley', 'yeats']);
    assert.equal(result.reasoning, 'Both would dispute it.');
    assert.equal(result.source, 'director');
  });

  await t.test('asks only for the seats the regulars leave open', async () => {
    const client = fakeCastingClient({ speakers: ['jung'], reasoning: 'r' });
    await proposeCast({
      client, model: 'test-model', lodgeContext: LODGE, roster: ROSTER,
      regularIds: ['crowley', 'yeats', 'blavatsky'], documentText: 'a document',
      targetMin: 4, targetMax: 5,
    });
    const speakers = client.asked[0].tools[0].input_schema.properties.speakers;
    assert.equal(speakers.maxItems, 2, '5 wanted, 3 already coming');
    assert.equal(speakers.minItems, 1, '4 wanted, 3 already coming');
    assert.deepEqual(speakers.items.enum, ['jung', 'scholem']);
  });

  await t.test('spends no call at all when the regulars already fill the room', async () => {
    const client = fakeCastingClient({ speakers: ['jung'], reasoning: 'r' });
    const result = await proposeCast({
      client, model: 'test-model', lodgeContext: LODGE, roster: ROSTER,
      regularIds: ['crowley', 'yeats', 'blavatsky', 'jung'], documentText: 'a document',
      targetMin: 3, targetMax: 4,
    });
    assert.equal(client.asked.length, 0);
    assert.equal(result.source, 'regulars');
    assert.deepEqual(result.cast, ['crowley', 'yeats', 'blavatsky', 'jung']);
    assert.deepEqual(result.additions, []);
    assert.equal(result.reasoning, null);
  });

  await t.test('never returns more than the target, however many regulars there are', async () => {
    const client = fakeCastingClient({ speakers: ['scholem'], reasoning: 'r' });
    const result = await proposeCast({
      client, model: 'test-model', lodgeContext: LODGE, roster: ROSTER,
      regularIds: ['crowley', 'yeats', 'blavatsky'], documentText: 'a document',
      targetMin: 4, targetMax: 4,
    });
    assert.equal(result.cast.length, 4);
  });

  await t.test('retries once on an out-of-range answer, then keeps the valid one', async () => {
    const client = fakeCastingClient(n => n === 1
      ? { speakers: ['jung', 'scholem', 'crowley'], reasoning: 'too many, and one is a regular' }
      : { speakers: ['jung'], reasoning: 'better' });
    const result = await proposeCast({
      client, model: 'test-model', lodgeContext: LODGE, roster: ROSTER,
      regularIds: ['crowley', 'yeats', 'blavatsky'], documentText: 'a document',
      targetMin: 4, targetMax: 4,
    });
    assert.equal(client.asked.length, 2);
    assert.equal(result.source, 'director-retry');
    assert.deepEqual(result.cast, ['crowley', 'yeats', 'blavatsky', 'jung']);
  });

  await t.test('falls back to a real room rather than nothing when the call fails twice', async () => {
    const client = fakeCastingClient(new Error('the fire is low'));
    const metrics = [];
    const result = await proposeCast({
      client, model: 'test-model', lodgeContext: LODGE, roster: ROSTER,
      regularIds: ['crowley'], documentText: 'a document',
      targetMin: 3, targetMax: 5, onMetric: m => metrics.push(m),
    });
    assert.equal(result.source, 'fallback');
    assert.ok(result.cast.includes('crowley'), 'the regular survives a failed call');
    assert.equal(result.cast.length, 3, 'the fallback fills to targetMin, not targetMax');
    assert.equal(metrics.at(-1).phase, 'casting');
    assert.equal(metrics.at(-1).skipped, true);
  });

  await t.test('ignores an unknown regular id instead of casting a ghost', async () => {
    const client = fakeCastingClient({ speakers: ['jung', 'scholem'], reasoning: 'r' });
    const result = await proposeCast({
      client, model: 'test-model', lodgeContext: LODGE, roster: ROSTER,
      regularIds: ['crowley', 'someone-deleted'], documentText: 'a document',
      targetMin: 3, targetMax: 3,
    });
    assert.deepEqual(result.regulars, ['crowley']);
    assert.equal(result.cast.includes('someone-deleted'), false);
  });
});
