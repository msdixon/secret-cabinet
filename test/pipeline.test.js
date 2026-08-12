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
  splitIntoBeats,
  BEAT_WORD_THRESHOLD,
  countWords,
  lengthTendencyOf,
  DISPOSITION_MAX_CHARS,
  buildDispositionToolSchema,
  buildDispositionSystemPrompt,
  buildDispositionUserMessage,
  callDispositionUpdate,
  CASTING_DOCUMENT_LIMIT,
  buildCastingToolSchema,
  buildCastingPrompt,
  proposeCast,
  VOICE_EXEMPLAR_WORD_BUDGET,
  trimToWordBudget,
  buildVoiceExemplarSection,
  RESIDUE_MAX_CHARS,
  RESIDUE_NOTE_MAX_CHARS,
  RESIDUE_SEPARATOR,
  mergeResidue,
  buildResidueSection,
  buildSpeakerSystemPrompt,
  buildSpeakerUserMessage,
  makeMetric,
  buildCachedSystem,
  withHistoryCacheControl,
  callDirector,
  callSpeakerTurn,
  runRound,
  BREATH_BUDGET_WORDS,
  LULL_NOTE_MAX_CHARS,
  STOCK_LULL_NOTES,
  pickStockLullNote,
  resolveLullNote,
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

  await t.test('an rng returning exactly 0 skips a first candidate already at the cap (#201)', () => {
    const picked = pickNextSpeaker({
      pool: ['scholem', 'blavatsky'],
      spokenCounts: counts([['scholem', 2]]), // scholem is at MAX_TURNS_PER_POOL_MEMBER, weight 0
      lastSpeakerId: null,
      remainingBudget: 500,
      rng: () => 0,
    });
    assert.equal(picked, 'blavatsky');
  });

  // #203: a member privately waiting on the person who just spoke should be
  // meaningfully likelier to get the next beat — an interruption reading as
  // a character choice, not a scheduling accident.
  await t.test('a member waiting on the last speaker is weighted up by INTERRUPT_INTENT_WEIGHT (3x)', () => {
    const args = {
      pool: ['scholem', 'blavatsky'],
      spokenCounts: counts([]),
      lastSpeakerId: 'crowley',
      remainingBudget: 500,
      disposition: { scholem: { waitingOnMemberId: 'crowley' } },
    };
    // 3 / (3 + 1)
    const share = shareOf('scholem', args);
    assert.ok(Math.abs(share - 0.75) < 0.02, `waiting-on share was ${share}`);
  });

  await t.test('the boost only applies when the target actually just spoke', () => {
    const withoutMatch = shareOf('scholem', {
      pool: ['scholem', 'blavatsky'],
      spokenCounts: counts([]),
      lastSpeakerId: 'yeats', // not who scholem is waiting on
      remainingBudget: 500,
      disposition: { scholem: { waitingOnMemberId: 'crowley' } },
    });
    assert.ok(Math.abs(withoutMatch - 0.5) < 0.02, `unmatched-target share was ${withoutMatch}`);
  });

  await t.test('is a no-op with no disposition map, and tolerant of a member missing from it', () => {
    const args = {
      pool: ['scholem', 'blavatsky'],
      spokenCounts: counts([]),
      lastSpeakerId: 'crowley',
      remainingBudget: 500,
    };
    assert.ok(Math.abs(shareOf('scholem', args) - 0.5) < 0.02);
    assert.ok(Math.abs(shareOf('scholem', { ...args, disposition: {} }) - 0.5) < 0.02);
  });

  await t.test('a null lastSpeakerId (round-opening pick) never triggers the boost', () => {
    // A waitingOnMemberId can never equal null, but this guards the
    // `lastSpeakerId &&` short-circuit explicitly rather than by accident.
    const share = shareOf('scholem', {
      pool: ['scholem', 'blavatsky'],
      spokenCounts: counts([]),
      lastSpeakerId: null,
      remainingBudget: 500,
      disposition: { scholem: { waitingOnMemberId: null } },
    });
    assert.ok(Math.abs(share - 0.5) < 0.02);
  });
});

test('buildSpeakerUserMessage', async t => {
  const member = { id: 'yeats', name: 'W.B. Yeats' };

  await t.test('adds no interruption note when interruptingName is absent', () => {
    const message = buildSpeakerUserMessage({ roundPrompt: 'Discuss.', roundSoFarText: '', member });
    assert.doesNotMatch(message, /unfinished business/);
  });

  await t.test('tells the speaker they are cutting in, and leaves the choice open', () => {
    const message = buildSpeakerUserMessage({
      roundPrompt: 'Discuss.', roundSoFarText: 'Crowley\nSome point.', member,
      interruptingName: 'Aleister Crowley',
    });
    assert.match(message, /unfinished business with Aleister Crowley, who just spoke/);
    assert.match(message, /mid-stride/);
    assert.match(message, /fine to let it pass/);
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

// #219 — the delivery-pacing split. Reuses the words(n) deterministic
// n-word-span helper defined below (with #187's trimToWordBudget tests) so
// the threshold crossing lands exactly where each test wants it, rather
// than relying on prose that happens to be the right length.
test('splitIntoBeats', async t => {
  await t.test('empty or whitespace-only text is no beats', () => {
    assert.deepEqual(splitIntoBeats(''), []);
    assert.deepEqual(splitIntoBeats('   \n\t  '), []);
  });

  await t.test('a short turn under the threshold is a single beat, unchanged', () => {
    const text = 'A short reactive line.';
    assert.deepEqual(splitIntoBeats(text), [text]);
  });

  await t.test('multiple short lines whose combined count stays under the threshold merge into one beat', () => {
    const line1 = 'First short line.';
    const line2 = 'Second short line.';
    assert.deepEqual(splitIntoBeats(`${line1}\n${line2}`), [`${line1}\n${line2}`]);
  });

  await t.test('a beat closes at the next line break once the threshold is crossed, not mid-line', () => {
    const line1 = `${words(30)}.`; // under threshold alone
    const line2 = `${words(15)}.`; // combined with line1: 45, crosses threshold
    const line3 = `${words(5)}.`;  // starts the next beat
    const beats = splitIntoBeats([line1, line2, line3].join('\n'));
    assert.deepEqual(beats, [`${line1}\n${line2}`, line3]);
  });

  await t.test('a single line with no internal breaks that alone overruns the threshold falls back to sentence boundaries', () => {
    const s1 = `${words(20)}.`;
    const s2 = `${words(20)}.`;
    const s3 = `${words(10)}.`;
    const line = `${s1} ${s2} ${s3}`; // one line, 50 words, no \n at all
    const beats = splitIntoBeats(line);
    assert.deepEqual(beats, [`${s1} ${s2}`, s3]);
  });

  await t.test('a blank line is dropped, same treatment as stripInternalBlankLines', () => {
    assert.deepEqual(splitIntoBeats('First.\n\nSecond.'), ['First.\nSecond.']);
  });

  await t.test('never loses, duplicates, or reorders a word across the split', () => {
    const s1 = `${words(20)}.`;
    const s2 = `${words(20)}.`;
    const line1 = `${words(10)}.`;
    const text = `${line1}\n${s1} ${s2} ${words(15)}.`;
    const beats = splitIntoBeats(text);
    assert.deepEqual(
      beats.flatMap(b => b.split(/\s+/)),
      text.trim().split(/\s+/),
    );
  });

  await t.test('BEAT_WORD_THRESHOLD is a sane positive tuning constant', () => {
    assert.equal(typeof BEAT_WORD_THRESHOLD, 'number');
    assert.ok(BEAT_WORD_THRESHOLD > 0);
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
    const prompt = buildDispositionSystemPrompt({
      member, priorDisposition: { text: 'Unconvinced by Crowley\'s reading of Kabbalah.', waitingOnMemberId: null },
    });
    assert.match(prompt, /Unconvinced by Crowley's reading of Kabbalah\./);
    assert.match(prompt, /don't just repeat it back/);
  });

  await t.test('states the hard character cap', () => {
    const prompt = buildDispositionSystemPrompt({ member, priorDisposition: null });
    assert.match(prompt, new RegExp(`under ${DISPOSITION_MAX_CHARS} characters`));
  });

  // #203: the structured "unspent business" target — real #188 sessions
  // showed free text is the wrong thing to key scheduling off (pronoun
  // references, truncation cutting the naming clause), so the prior
  // target is surfaced by resolved name, not re-parsed from prose.
  await t.test('names the prior waiting-on target by resolved name when one was set', () => {
    const presentMembers = [{ id: 'waite', name: 'A.E. Waite' }, { id: 'yeats', name: 'W.B. Yeats' }];
    const prompt = buildDispositionSystemPrompt({
      member, presentMembers,
      priorDisposition: { text: 'Still turning over the Kabbalah point.', waitingOnMemberId: 'waite' },
    });
    assert.match(prompt, /You were privately waiting to answer or press A\.E\. Waite\./);
  });

  await t.test('says nothing extra when there was no prior target', () => {
    const presentMembers = [{ id: 'waite', name: 'A.E. Waite' }];
    const prompt = buildDispositionSystemPrompt({
      member, presentMembers,
      priorDisposition: { text: 'Still turning over the Kabbalah point.', waitingOnMemberId: null },
    });
    assert.doesNotMatch(prompt, /privately waiting to answer or press/);
  });

  await t.test('asks for the unspent-business target as the exception, not the default', () => {
    const prompt = buildDispositionSystemPrompt({ member, priorDisposition: null });
    assert.match(prompt, /unspent business with/);
    assert.match(prompt, /most turns, there is no one/i);
  });

  // #166 — cross-session residue piggybacked on this same call.
  await t.test('says nothing about prior residue when there is none yet', () => {
    const prompt = buildDispositionSystemPrompt({ member, priorDisposition: null });
    assert.doesNotMatch(prompt, /Residue already carried/);
  });

  await t.test('quotes prior residue back and asks only for something genuinely new', () => {
    const prompt = buildDispositionSystemPrompt({
      member, priorDisposition: null, priorResidue: 'Grew wary of Crowley\'s charm.',
    });
    assert.match(prompt, /Residue already carried from other evenings.*Grew wary of Crowley's charm\./s);
    assert.match(prompt, /most turns, it didn't/);
  });

  await t.test('asks for the residue fragment as rare, on top of the unspent-business ask', () => {
    const prompt = buildDispositionSystemPrompt({ member, priorDisposition: null });
    assert.match(prompt, /outlast this evening/);
    assert.match(prompt, /most turns, there is nothing here either/i);
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

// #203: the disposition update is now a forced tool call (reflection prose
// + a structured waitingOnMemberId), not a plain text response — see the
// disposition scratchpad section's comment for why free text turned out to
// be the wrong thing to key scheduling off of.
function fakeDispositionClient(input) {
  return {
    messages: {
      create: async () => ({
        content: [{ type: 'tool_use', input }],
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    },
  };
}

test('callDispositionUpdate', async t => {
  await t.test('hard-truncates the reflection to DISPOSITION_MAX_CHARS regardless of what the model returns', async () => {
    const overlong = 'x'.repeat(DISPOSITION_MAX_CHARS + 200);
    const fakeClient = fakeDispositionClient({ reflection: overlong, waitingOnMemberId: 'none' });
    const { text } = await callDispositionUpdate({ client: fakeClient, model: 'test-model', system: 'sys', userMessage: 'msg', presentIds: ['waite'] });
    assert.equal(text.length, DISPOSITION_MAX_CHARS);
  });

  await t.test('trims whitespace and returns an empty string if the model returns nothing usable', async () => {
    const fakeClient = { messages: { create: async () => ({ content: [], usage: null }) } };
    const { text } = await callDispositionUpdate({ client: fakeClient, model: 'test-model', system: 'sys', userMessage: 'msg' });
    assert.equal(text, '');
  });

  await t.test('resolves a valid, present waitingOnMemberId', async () => {
    const fakeClient = fakeDispositionClient({ reflection: 'Still turning this over.', waitingOnMemberId: 'waite' });
    const { waitingOnMemberId } = await callDispositionUpdate({ client: fakeClient, model: 'test-model', system: 'sys', userMessage: 'msg', presentIds: ['waite', 'yeats'] });
    assert.equal(waitingOnMemberId, 'waite');
  });

  await t.test('treats the "none" sentinel as null', async () => {
    const fakeClient = fakeDispositionClient({ reflection: 'Nothing pending.', waitingOnMemberId: 'none' });
    const { waitingOnMemberId } = await callDispositionUpdate({ client: fakeClient, model: 'test-model', system: 'sys', userMessage: 'msg', presentIds: ['waite'] });
    assert.equal(waitingOnMemberId, null);
  });

  await t.test('ignores a target that is not in presentIds — a hallucinated or stale id must not silently pass through', async () => {
    const fakeClient = fakeDispositionClient({ reflection: 'Still turning this over.', waitingOnMemberId: 'not-present-tonight' });
    const { waitingOnMemberId } = await callDispositionUpdate({ client: fakeClient, model: 'test-model', system: 'sys', userMessage: 'msg', presentIds: ['waite'] });
    assert.equal(waitingOnMemberId, null);
  });

  await t.test('defaults to no target when the tool call is missing or malformed', async () => {
    const fakeClient = { messages: { create: async () => ({ content: [], usage: null }) } };
    const { waitingOnMemberId } = await callDispositionUpdate({ client: fakeClient, model: 'test-model', system: 'sys', userMessage: 'msg', presentIds: ['waite'] });
    assert.equal(waitingOnMemberId, null);
  });

  // #166 — the optional residueNote field, piggybacked on this same call.
  await t.test('returns an empty residueNote when the model leaves the field out — the common case', async () => {
    const fakeClient = fakeDispositionClient({ reflection: 'Still turning this over.', waitingOnMemberId: 'none' });
    const { residueNote } = await callDispositionUpdate({ client: fakeClient, model: 'test-model', system: 'sys', userMessage: 'msg', presentIds: ['waite'] });
    assert.equal(residueNote, '');
  });

  await t.test('trims and returns a residueNote when the model writes one', async () => {
    const fakeClient = fakeDispositionClient({ reflection: 'Still turning this over.', waitingOnMemberId: 'none', residueNote: '  Grew certain of it.  ' });
    const { residueNote } = await callDispositionUpdate({ client: fakeClient, model: 'test-model', system: 'sys', userMessage: 'msg', presentIds: ['waite'] });
    assert.equal(residueNote, 'Grew certain of it.');
  });

  await t.test('hard-truncates residueNote to RESIDUE_NOTE_MAX_CHARS regardless of what the model returns', async () => {
    const overlong = 'x'.repeat(RESIDUE_NOTE_MAX_CHARS + 200);
    const fakeClient = fakeDispositionClient({ reflection: 'ok', waitingOnMemberId: 'none', residueNote: overlong });
    const { residueNote } = await callDispositionUpdate({ client: fakeClient, model: 'test-model', system: 'sys', userMessage: 'msg', presentIds: ['waite'] });
    assert.equal(residueNote.length, RESIDUE_NOTE_MAX_CHARS);
  });
});

test('buildDispositionToolSchema', async t => {
  await t.test('constrains the target enum to present ids plus the "none" sentinel', () => {
    const schema = buildDispositionToolSchema(['waite', 'yeats']);
    assert.equal(schema.name, 'update_disposition');
    assert.deepEqual(schema.input_schema.properties.waitingOnMemberId.enum, ['waite', 'yeats', 'none']);
    assert.deepEqual(schema.input_schema.required, ['reflection', 'waitingOnMemberId']);
  });

  // #166 — residueNote must stay optional so an omitted field is how the
  // model expresses "nothing belongs here," the common case by design.
  await t.test('offers residueNote but does not require it', () => {
    const schema = buildDispositionToolSchema(['waite']);
    assert.equal(schema.input_schema.properties.residueNote.type, 'string');
    assert.ok(!schema.input_schema.required.includes('residueNote'));
  });
});

// #187 — the voice-register exemplar. Two things are load-bearing and both
// are pinned here rather than trusted to prompt compliance: the word budget
// (this text is paid for in input tokens on every speaker beat) and the
// graceful-degradation path (12 of 33 members have no authored library
// entry, and their prompt must come out byte-identical to the pre-#187 one).

const words = n => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

test('trimToWordBudget', async t => {
  await t.test('returns text under budget untouched, with no elision marker', () => {
    const text = 'Energy is Eternal Delight.';
    assert.equal(trimToWordBudget(text, 300), text);
  });

  await t.test('handles empty, whitespace-only, and missing input', () => {
    assert.equal(trimToWordBudget('', 300), '');
    assert.equal(trimToWordBudget('   \n\n  ', 300), '');
    assert.equal(trimToWordBudget(undefined, 300), '');
    assert.equal(trimToWordBudget(null, 300), '');
  });

  await t.test('keeps whole paragraphs and marks the elision', () => {
    const text = `${words(10)}\n\n${words(10)}\n\n${words(10)}`;
    const trimmed = trimToWordBudget(text, 25);
    assert.equal(trimmed, `${words(10)}\n\n${words(10)}\n\n[…]`);
  });

  await t.test('never exceeds the budget in words (excluding the marker)', () => {
    const text = `${words(40)}\n\n${words(40)}\n\n${words(40)}`;
    const trimmed = trimToWordBudget(text, 100).replace('[…]', '');
    assert.ok(countWords(trimmed) <= 100, `${countWords(trimmed)} words > 100`);
  });

  await t.test('falls back to whole sentences when the first paragraph alone overruns', () => {
    const text = 'One two three. Four five six. Seven eight nine.';
    assert.equal(trimToWordBudget(text, 7), 'One two three. Four five six. […]');
  });

  await t.test('hard-cuts a single sentence longer than the whole budget', () => {
    // Verse without terminal punctuation reaches this path too.
    const trimmed = trimToWordBudget(words(50), 10);
    assert.equal(trimmed, `${words(10)} […]`);
  });
});

test('buildVoiceExemplarSection', async t => {
  const exemplar = {
    id: 'blake-voice-of-the-devil-1790',
    title: 'The Voice of the Devil',
    source: 'The Marriage of Heaven and Hell',
    date: '1790',
    translated: false,
    text: 'Energy is the only life and is from the Body.',
  };

  await t.test('returns an empty string for a member with no entry', () => {
    assert.equal(buildVoiceExemplarSection(null), '');
    assert.equal(buildVoiceExemplarSection(undefined), '');
    assert.equal(buildVoiceExemplarSection({ title: 'Untitled', text: '' }), '');
    assert.equal(buildVoiceExemplarSection({ title: 'Untitled', text: '   ' }), '');
  });

  await t.test('carries the excerpt and its provenance', () => {
    const section = buildVoiceExemplarSection({ ...exemplar, source: 'Complete Writings' });
    assert.match(section, /Energy is the only life and is from the Body\./);
    assert.match(section, /The Voice of the Devil — Complete Writings — 1790/);
  });

  await t.test('does not print the source twice when the title already names it', () => {
    // True of 11 of the 21 real entries — e.g. title "The Voice of the Devil
    // — The Marriage of Heaven and Hell" over source "The Marriage of Heaven
    // and Hell".
    const section = buildVoiceExemplarSection({
      ...exemplar,
      title: 'The Voice of the Devil — The Marriage of Heaven and Hell',
    });
    assert.match(section, /The Voice of the Devil — The Marriage of Heaven and Hell — 1790/);
    assert.equal(section.match(/The Marriage of Heaven and Hell/g).length, 1);
  });

  await t.test('frames it as register, not subject matter', () => {
    const section = buildVoiceExemplarSection(exemplar);
    assert.match(section, /govern \*how\* you speak tonight, never \*what\*/);
    assert.match(section, /Do not quote it, cite it, allude to it/);
  });

  await t.test('adds the translator caveat only when the entry is a translation', () => {
    assert.doesNotMatch(buildVoiceExemplarSection(exemplar), /translator's/);
    assert.match(buildVoiceExemplarSection({ ...exemplar, translated: true }), /The English here is a translator's, not yours/);
  });

  await t.test('trims an over-budget excerpt to the shared budget', () => {
    const section = buildVoiceExemplarSection({ ...exemplar, text: words(VOICE_EXEMPLAR_WORD_BUDGET + 200) });
    assert.match(section, /\[…\]/);
    assert.ok(countWords(section) < VOICE_EXEMPLAR_WORD_BUDGET + 200);
  });
});

// #166 — cross-session residue. mergeResidue is the load-bearing piece: it's
// the only thing standing between "small, capped drift" and an unbounded
// per-member file that grows for the life of the app, so its cap behaviour
// and its never-cut-mid-fragment guarantee are pinned here rather than
// trusted to review. See docs/AXES.md's Axis 4 for why the cap is deliberately
// not larger than #188's disposition cap.
test('mergeResidue', async t => {
  await t.test('starts fresh residue from a first note when there is no prior text', () => {
    assert.equal(mergeResidue('', 'Grew wary of Crowley.'), 'Grew wary of Crowley.');
    assert.equal(mergeResidue(null, 'Grew wary of Crowley.'), 'Grew wary of Crowley.');
    assert.equal(mergeResidue(undefined, 'Grew wary of Crowley.'), 'Grew wary of Crowley.');
  });

  await t.test('is a no-op that returns the prior text untouched when there is no new note', () => {
    assert.equal(mergeResidue('Grew wary of Crowley.', ''), 'Grew wary of Crowley.');
    assert.equal(mergeResidue('Grew wary of Crowley.', null), 'Grew wary of Crowley.');
    assert.equal(mergeResidue('Grew wary of Crowley.', '   '), 'Grew wary of Crowley.');
  });

  await t.test('appends a new fragment onto prior residue, separated', () => {
    const merged = mergeResidue('Grew wary of Crowley.', 'Warmed to Yeats.');
    assert.equal(merged, `Grew wary of Crowley.${RESIDUE_SEPARATOR}Warmed to Yeats.`);
  });

  await t.test('hard-truncates an over-long single note before it ever reaches the merge', () => {
    const overlong = 'x'.repeat(RESIDUE_NOTE_MAX_CHARS + 100);
    const merged = mergeResidue('', overlong);
    assert.equal(merged.length, RESIDUE_NOTE_MAX_CHARS);
  });

  await t.test('never exceeds RESIDUE_MAX_CHARS, dropping whole fragments from the oldest end', () => {
    let residue = '';
    for (let i = 0; i < 20; i++) {
      residue = mergeResidue(residue, `Fragment number ${i}, concrete and specific to that evening.`);
      assert.ok(residue.length <= RESIDUE_MAX_CHARS, `over cap at i=${i}: ${residue.length} chars`);
    }
  });

  await t.test('keeps only whole fragments — never cuts one mid-sentence to fit the cap', () => {
    let residue = '';
    for (let i = 0; i < 20; i++) {
      residue = mergeResidue(residue, `Fragment number ${i}, concrete and specific to that evening.`);
    }
    for (const fragment of residue.split(RESIDUE_SEPARATOR)) {
      assert.match(fragment, /^Fragment number \d+, concrete and specific to that evening\.$/);
    }
  });

  await t.test('keeps the most recent fragments, not the oldest, once the cap is hit', () => {
    let residue = '';
    for (let i = 0; i < 20; i++) {
      residue = mergeResidue(residue, `Fragment number ${i}, concrete and specific to that evening.`);
    }
    assert.match(residue, /Fragment number 19,/);
    assert.doesNotMatch(residue, /Fragment number 0,/);
  });
});

test('buildResidueSection', async t => {
  await t.test('returns an empty string for a member with no residue yet', () => {
    assert.equal(buildResidueSection(''), '');
    assert.equal(buildResidueSection(null), '');
    assert.equal(buildResidueSection(undefined), '');
    assert.equal(buildResidueSection('   '), '');
  });

  await t.test('carries the residue text', () => {
    const section = buildResidueSection('Grew wary of Crowley\'s charm.');
    assert.match(section, /Grew wary of Crowley's charm\./);
  });

  // Rung (a) of #195's ladder: no claim of recall may ever reach the
  // prompt, or this stops being residue and becomes rung (b) dream-memory.
  await t.test('frames it explicitly as not-memory, never a claim of recall', () => {
    const section = buildResidueSection('Grew wary of Crowley.');
    assert.match(section, /This is not memory\./);
    assert.match(section, /you would honestly deny remembering any of them/);
    assert.match(section, /never mention it, explain it, or gesture at where it comes from/);
  });
});

test('buildSpeakerSystemPrompt — voice exemplar wiring', async t => {
  const base = {
    lodgeContext: 'LODGE CONTEXT',
    member: { id: 'william-blake', name: 'Blake', file: 'william-blake.md' },
    artifact: null,
    notes: {},
    loadMemberFile: () => '# BLAKE\n\n## HOW YOU SPEAK\n\nAphoristic.',
  };
  const exemplar = {
    id: 'blake-voice-of-the-devil-1790',
    title: 'The Voice of the Devil',
    source: 'The Marriage of Heaven and Hell',
    date: '1790',
    translated: false,
    text: 'Energy is Eternal Delight.',
  };

  await t.test('a member without an entry gets the exact pre-#187 prompt', () => {
    const withoutArg = buildSpeakerSystemPrompt(base);
    assert.equal(buildSpeakerSystemPrompt({ ...base, voiceExemplar: null }), withoutArg);
    assert.doesNotMatch(withoutArg, /HOW YOU ACTUALLY WRITE/);
  });

  await t.test('a member with an entry gets the exemplar section', () => {
    const prompt = buildSpeakerSystemPrompt({ ...base, voiceExemplar: exemplar });
    assert.match(prompt, /HOW YOU ACTUALLY WRITE — A PAGE IN YOUR OWN HAND/);
    assert.match(prompt, /Energy is Eternal Delight\./);
  });

  await t.test('the exemplar sits after the character file and before tonight\'s disposition', () => {
    const prompt = buildSpeakerSystemPrompt({
      ...base, voiceExemplar: exemplar, disposition: { text: 'Irritated by Crowley.', waitingOnMemberId: null },
    });
    assert.ok(prompt.indexOf('HOW YOU SPEAK') < prompt.indexOf('HOW YOU ACTUALLY WRITE'));
    assert.ok(prompt.indexOf('HOW YOU ACTUALLY WRITE') < prompt.indexOf('YOUR PRIVATE STATE TONIGHT'));
    assert.ok(prompt.indexOf('YOUR PRIVATE STATE TONIGHT') < prompt.indexOf('YOUR TURN RIGHT NOW'));
  });

  // #166 — residue wiring, extending the same ordering test.
  await t.test('a member without residue gets the exact pre-#166 prompt', () => {
    const withoutArg = buildSpeakerSystemPrompt(base);
    assert.equal(buildSpeakerSystemPrompt({ ...base, residue: '' }), withoutArg);
    assert.equal(buildSpeakerSystemPrompt({ ...base, residue: null }), withoutArg);
    assert.doesNotMatch(withoutArg, /WHAT LINGERS/);
  });

  await t.test('a member with residue gets the residue section', () => {
    const prompt = buildSpeakerSystemPrompt({ ...base, residue: 'Grew wary of Crowley\'s charm.' });
    assert.match(prompt, /WHAT LINGERS, THOUGH YOU COULDN'T SAY WHY/);
    assert.match(prompt, /Grew wary of Crowley's charm\./);
  });

  await t.test('residue sits after the exemplar and before tonight\'s disposition — slower-moving evidence in between', () => {
    const prompt = buildSpeakerSystemPrompt({
      ...base, voiceExemplar: exemplar, residue: 'Grew wary of Crowley.',
      disposition: { text: 'Irritated by Crowley.', waitingOnMemberId: null },
    });
    assert.ok(prompt.indexOf('HOW YOU ACTUALLY WRITE') < prompt.indexOf('WHAT LINGERS'));
    assert.ok(prompt.indexOf('WHAT LINGERS') < prompt.indexOf('YOUR PRIVATE STATE TONIGHT'));
  });
});

test('makeMetric — voiceExemplar attribution', async t => {
  await t.test('records the injected entry id on a speaker metric', () => {
    const metric = makeMetric('speaker', { round: 0, memberId: 'william-blake', voiceExemplar: 'blake-voice-of-the-devil-1790' });
    assert.equal(metric.voiceExemplar, 'blake-voice-of-the-devil-1790');
  });

  await t.test('is null when no exemplar was injected and on non-speaker phases', () => {
    assert.equal(makeMetric('speaker', { memberId: 'scholem' }).voiceExemplar, null);
    assert.equal(makeMetric('director', { round: 0 }).voiceExemplar, null);
  });
});

// #203: without this, whether the interruption signal is firing in real
// sessions is unobservable except by re-reading disposition prose by hand.
test('makeMetric — waitingOnMemberId attribution', async t => {
  await t.test('records the resolved target on a disposition metric', () => {
    const metric = makeMetric('disposition', { round: 0, memberId: 'yeats', waitingOnMemberId: 'waite' });
    assert.equal(metric.waitingOnMemberId, 'waite');
  });

  await t.test('is null when there is no target', () => {
    assert.equal(makeMetric('disposition', { memberId: 'yeats' }).waitingOnMemberId, null);
    assert.equal(makeMetric('speaker', { memberId: 'yeats' }).waitingOnMemberId, null);
  });
});

// #166 — same observability rationale as #203's waitingOnMemberId above,
// for how often cross-session residue actually accrues in real sessions.
test('makeMetric — residueNote attribution', async t => {
  await t.test('records the residue fragment written on a disposition metric', () => {
    const metric = makeMetric('disposition', { round: 0, memberId: 'yeats', residueNote: 'Grew wary of Crowley.' });
    assert.equal(metric.residueNote, 'Grew wary of Crowley.');
  });

  await t.test('is null when no fragment was written', () => {
    assert.equal(makeMetric('disposition', { memberId: 'yeats' }).residueNote, null);
    assert.equal(makeMetric('speaker', { memberId: 'yeats' }).residueNote, null);
  });
});

// #190 — the signal that a cache breakpoint actually paid off on a given
// call, not just a lower input_tokens count (which caching also produces,
// but which is indistinguishable from "this call was just smaller").
test('makeMetric — cache_read_input_tokens attribution', async t => {
  await t.test('captures cache_read_input_tokens off usage when present', () => {
    const metric = makeMetric('speaker', { usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 3200 } });
    assert.equal(metric.usage.cache_read_input_tokens, 3200);
  });

  await t.test('is null when usage does not carry it (no caching involved, or not yet GA in the response)', () => {
    const metric = makeMetric('speaker', { usage: { input_tokens: 50, output_tokens: 10 } });
    assert.equal(metric.usage.cache_read_input_tokens, null);
  });

  await t.test('usage itself stays null when no usage is given at all', () => {
    assert.equal(makeMetric('speaker', {}).usage, null);
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

// #190 — prompt caching on the two prefixes every director/speaker call
// shares: the lodge-context system block, and (within a round, or across
// rounds until the session's slice(-6) window drops something) the
// conversation history. These pin the shape actually sent to the API, not
// just the pure split logic — a cache_control breakpoint in the wrong spot
// silently caches nothing rather than erroring.

test('buildCachedSystem', async t => {
  await t.test('splits into a cached lodge-context block and an uncached rest', () => {
    const blocks = buildCachedSystem(`${LODGE}\n\n---\n\nrest of the prompt`, LODGE);
    assert.deepEqual(blocks, [
      { type: 'text', text: LODGE, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '\n\n---\n\nrest of the prompt' },
    ]);
  });

  await t.test('returns just the cached block when the prefix is the whole string', () => {
    const blocks = buildCachedSystem(LODGE, LODGE);
    assert.deepEqual(blocks, [{ type: 'text', text: LODGE, cache_control: { type: 'ephemeral' } }]);
  });

  await t.test('falls back to the plain string when lodgeContext is not actually the prefix', () => {
    assert.equal(buildCachedSystem('something else entirely', LODGE), 'something else entirely');
  });

  await t.test('falls back to the plain string when no lodgeContext is given', () => {
    assert.equal(buildCachedSystem('a system prompt', undefined), 'a system prompt');
  });
});

test('withHistoryCacheControl', async t => {
  await t.test('marks only the last message, wrapping its string content as a cached text block', () => {
    const history = [
      { role: 'user', content: 'round 1 prompt' },
      { role: 'assistant', content: 'round 1 text' },
    ];
    const result = withHistoryCacheControl(history);
    assert.equal(result[0], history[0], 'earlier messages are untouched, not just equal');
    assert.deepEqual(result[1], {
      role: 'assistant',
      content: [{ type: 'text', text: 'round 1 text', cache_control: { type: 'ephemeral' } }],
    });
  });

  await t.test('does not mutate the caller\'s array or its messages', () => {
    const history = [{ role: 'user', content: 'hello' }];
    const original = JSON.parse(JSON.stringify(history));
    withHistoryCacheControl(history);
    assert.deepEqual(history, original);
  });

  await t.test('is a no-op on empty or missing history', () => {
    assert.deepEqual(withHistoryCacheControl([]), []);
    assert.deepEqual(withHistoryCacheControl(undefined), []);
  });

  await t.test('leaves already-structured content alone rather than double-wrapping it', () => {
    const history = [{ role: 'assistant', content: [{ type: 'text', text: 'already a block' }] }];
    const result = withHistoryCacheControl(history);
    assert.deepEqual(result[0].content, [{ type: 'text', text: 'already a block' }]);
  });
});

// Mirrors fakeCastingClient's "record what it was asked" pattern, generic
// enough for callDirector's tool-call shape.
function fakeToolCallClient(reply) {
  const asked = [];
  return {
    asked,
    messages: {
      create: async (req) => {
        asked.push(req);
        return { content: [{ type: 'tool_use', input: reply }], usage: { input_tokens: 100, output_tokens: 20 } };
      },
    },
  };
}

test('callDirector — cache_control wiring', async t => {
  await t.test('caches the lodge-context prefix of the system prompt', async () => {
    const client = fakeToolCallClient({ speakers: ['crowley'], reasoning: 'r' });
    await callDirector({
      client, model: 'test-model',
      system: `${LODGE}\n\n---\n\nround instructions`,
      conversationHistory: [], userMessage: 'go',
      presentIds: ['crowley'], minCount: 1, maxCount: 1, lodgeContext: LODGE,
    });
    assert.deepEqual(client.asked[0].system, [
      { type: 'text', text: LODGE, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '\n\n---\n\nround instructions' },
    ]);
  });

  await t.test('caches the tail of a shared conversation history', async () => {
    const client = fakeToolCallClient({ speakers: ['crowley'], reasoning: 'r' });
    const history = [{ role: 'user', content: 'prior round' }, { role: 'assistant', content: 'prior text' }];
    await callDirector({
      client, model: 'test-model', system: LODGE, conversationHistory: history, userMessage: 'go',
      presentIds: ['crowley'], minCount: 1, maxCount: 1, lodgeContext: LODGE,
    });
    assert.deepEqual(client.asked[0].messages[1], {
      role: 'assistant',
      content: [{ type: 'text', text: 'prior text', cache_control: { type: 'ephemeral' } }],
    });
    assert.deepEqual(history[1], { role: 'assistant', content: 'prior text' }, 'the caller\'s history is untouched');
  });
});

// Minimal fake streaming client for callSpeakerTurn — one text delta plus a
// finalMessage() carrying usage, which is all callSpeakerTurn reads besides
// the deltas it forwards live.
function fakeStreamingClient({ text = 'a turn', usage = { input_tokens: 50, output_tokens: 10 } } = {}) {
  const asked = [];
  return {
    asked,
    messages: {
      stream: (req) => {
        asked.push(req);
        return {
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
          },
          finalMessage: async () => ({ usage }),
        };
      },
    },
  };
}

test('callSpeakerTurn — cache_control wiring', async t => {
  await t.test('caches the lodge-context prefix of the speaker system prompt', async () => {
    const client = fakeStreamingClient();
    await callSpeakerTurn({
      client, model: 'test-model',
      system: `${LODGE}\n\n---\n\nmember-specific prompt`,
      conversationHistory: [], userMessage: 'go', lodgeContext: LODGE,
    });
    assert.deepEqual(client.asked[0].system, [
      { type: 'text', text: LODGE, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '\n\n---\n\nmember-specific prompt' },
    ]);
  });

  await t.test('caches the tail of the shared round history', async () => {
    const client = fakeStreamingClient();
    const history = [{ role: 'user', content: 'prior round' }, { role: 'assistant', content: 'prior text' }];
    await callSpeakerTurn({
      client, model: 'test-model', system: LODGE, conversationHistory: history, userMessage: 'go', lodgeContext: LODGE,
    });
    assert.deepEqual(client.asked[0].messages[1], {
      role: 'assistant',
      content: [{ type: 'text', text: 'prior text', cache_control: { type: 'ephemeral' } }],
    });
  });
});

// #244 — runRound's new passage-end vocabulary (endedBy, lullNote, beats).

test('resolveLullNote', async t => {
  await t.test('trims and hard-caps a director-authored note', () => {
    const overlong = 'x'.repeat(LULL_NOTE_MAX_CHARS + 50);
    assert.equal(resolveLullNote(`  ${overlong}  `).length, LULL_NOTE_MAX_CHARS);
  });

  await t.test('falls back to a stock note when the director wrote nothing', () => {
    assert.ok(STOCK_LULL_NOTES.includes(resolveLullNote(null)));
    assert.ok(STOCK_LULL_NOTES.includes(resolveLullNote('   ')));
  });

  await t.test('#246: never repeats the previous lull note back to back, even when the rng would pick it', () => {
    const previous = STOCK_LULL_NOTES[0];
    const rngAlwaysFirst = () => 0; // would pick STOCK_LULL_NOTES[0] with no exclusion
    const note = resolveLullNote(null, rngAlwaysFirst, previous);
    assert.notEqual(note, previous);
    assert.ok(STOCK_LULL_NOTES.includes(note));
  });
});

test('pickStockLullNote', async t => {
  await t.test('is deterministic against a fixed rng and always a listed note', () => {
    for (let i = 0; i < STOCK_LULL_NOTES.length; i++) {
      const rng = () => i / STOCK_LULL_NOTES.length;
      assert.equal(pickStockLullNote(rng), STOCK_LULL_NOTES[i]);
    }
  });

  await t.test('#246: excludes the previous note from the pool it draws from', () => {
    const excluded = STOCK_LULL_NOTES[1];
    // Sweep the full rng range — every draw must land on one of the two
    // remaining notes, never the excluded one.
    for (let i = 0; i < 20; i++) {
      const rng = () => i / 20;
      assert.notEqual(pickStockLullNote(rng, excluded), excluded);
    }
  });
});

// Handles both director consult calls (tool: select_speakers) and
// disposition calls (tool: update_disposition) via messages.create, plus
// speaker turns via messages.stream — enough surface for runRound's full
// beat loop. `windingDownOnConsult` is the pattern of `true`/`false`
// returned across successive select_speakers calls (initial pool first,
// then each re-consult); it runs out, later calls repeat the last entry.
function fakePassageClient({ speakerText = 'A turn.', windingDownOnConsult = [false], lullNote = null } = {}) {
  let selectCalls = 0;
  const asked = [];
  return {
    asked,
    messages: {
      create: async (req) => {
        asked.push(req);
        const toolName = req.tools?.[0]?.name;
        if (toolName === 'select_speakers') {
          const i = Math.min(selectCalls, windingDownOnConsult.length - 1);
          const windingDown = windingDownOnConsult[i];
          selectCalls++;
          return {
            content: [{ type: 'tool_use', input: { speakers: ['crowley'], reasoning: 'r', windingDown, lullNote: windingDown ? lullNote : null } }],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        }
        // update_disposition
        return {
          content: [{ type: 'tool_use', input: { reflection: 'Considering.', waitingOnMemberId: 'none' } }],
          usage: { input_tokens: 8, output_tokens: 4 },
        };
      },
      stream: () => ({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: speakerText } };
        },
        finalMessage: async () => ({ usage: { input_tokens: 20, output_tokens: 10 } }),
      }),
    },
  };
}

const SINGLE_MEMBER_ROSTER = [{ id: 'crowley', name: 'Crowley', file: 'crowley.md' }];
const loadMemberFile = () => 'Crowley\'s character file.';

test('runRound — passage end-causes and beats (#244)', async t => {
  await t.test('ends with endedBy "lull" and the director\'s own note when it judges the room winding down', async () => {
    // Single-member pool exhausts deterministically after 2 beats
    // (MAX_TURNS_PER_POOL_MEMBER), forcing exactly one re-consult — which
    // this fake answers with windingDown: true.
    const client = fakePassageClient({ windingDownOnConsult: [false, true], lullNote: 'The fire settles; Yeats refills his glass.' });
    const result = await runRound({
      client, model: 'test-model', lodgeContext: LODGE, ROSTER: SINGLE_MEMBER_ROSTER, loadMemberFile,
      presentMemberIds: ['crowley'], artifact: null, notes: {},
      roundPrompt: 'Opening prompt', conversationHistory: [],
      speakerCount: 1, round: 0, disposition: {},
    });
    assert.equal(result.endedBy, 'lull');
    assert.equal(result.lullNote, 'The fire settles; Yeats refills his glass.');
    assert.equal(result.beats.length, 2);
    assert.deepEqual(result.beats.map(b => b.memberId), ['crowley', 'crowley']);
    assert.deepEqual(result.beats.map(b => b.text), ['A turn.', 'A turn.']);
  });

  await t.test('falls back to a stock lull note when the director judges winding down but writes nothing', async () => {
    const client = fakePassageClient({ windingDownOnConsult: [false, true], lullNote: null });
    const result = await runRound({
      client, model: 'test-model', lodgeContext: LODGE, ROSTER: SINGLE_MEMBER_ROSTER, loadMemberFile,
      presentMemberIds: ['crowley'], artifact: null, notes: {},
      roundPrompt: 'Opening prompt', conversationHistory: [],
      speakerCount: 1, round: 0, disposition: {},
    });
    assert.equal(result.endedBy, 'lull');
    assert.ok(STOCK_LULL_NOTES.includes(result.lullNote));
  });

  await t.test('defaults to endedBy "budget" (with a resolved stock lull note) when the director never judges a wind-down', async () => {
    const client = fakePassageClient({ windingDownOnConsult: [false] });
    const result = await runRound({
      client, model: 'test-model', lodgeContext: LODGE, ROSTER: SINGLE_MEMBER_ROSTER, loadMemberFile,
      presentMemberIds: ['crowley'], artifact: null, notes: {},
      roundPrompt: 'Opening prompt', conversationHistory: [],
      speakerCount: 1, round: 0, disposition: {},
    });
    // Short fixed speaker turns never spend BREATH_BUDGET_WORDS, so the
    // MAX_TOTAL_BEATS safety net is what actually ends this passage —
    // still 'budget', per runRound's single default for every non-lull exit.
    assert.equal(result.endedBy, 'budget');
    assert.ok(STOCK_LULL_NOTES.includes(result.lullNote));
    assert.ok(result.beats.length > 0);
  });

  await t.test('includes the player\'s preceding turn as a beat with memberId null', async () => {
    const client = fakePassageClient({ windingDownOnConsult: [true] });
    const result = await runRound({
      client, model: 'test-model', lodgeContext: LODGE, ROSTER: SINGLE_MEMBER_ROSTER, loadMemberFile,
      presentMemberIds: ['crowley'], artifact: null, notes: {},
      roundPrompt: 'Opening prompt', conversationHistory: [],
      speakerCount: 1, round: 0, disposition: {},
      precedingTurn: { speakerName: 'A Visitor', text: 'I have a question.' },
    });
    assert.deepEqual(result.beats[0], { memberId: null, text: 'I have a question.' });
  });

  await t.test('excludes a failed speaker turn from beats but still ends the passage cleanly', async () => {
    const client = fakePassageClient({ windingDownOnConsult: [false, true] });
    let streamCalls = 0;
    const originalStream = client.messages.stream;
    // withOneRetry makes 2 stream() calls for a beat that fails outright —
    // fail both of the first beat's attempts (calls 1-2), then let every
    // later call (the second beat's single attempt) succeed normally.
    client.messages.stream = (req) => {
      streamCalls++;
      if (streamCalls <= 2) {
        return {
          [Symbol.asyncIterator]: async function* () { throw new Error('network blip'); },
          finalMessage: async () => { throw new Error('network blip'); },
        };
      }
      return originalStream(req);
    };
    const result = await runRound({
      client, model: 'test-model', lodgeContext: LODGE, ROSTER: SINGLE_MEMBER_ROSTER, loadMemberFile,
      presentMemberIds: ['crowley'], artifact: null, notes: {},
      roundPrompt: 'Opening prompt', conversationHistory: [],
      speakerCount: 1, round: 0, disposition: {},
    });
    // Two beats were attempted (spokenCounts still credits the failed one,
    // triggering the re-consult that ends the passage via lull), but only
    // the surviving, successful one is in `beats`.
    assert.equal(result.beats.length, 1);
    assert.equal(result.beats[0].text, 'A turn.');
    assert.ok(result.fullRoundText.length > 0);
  });
});
