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
  VOICE_EXEMPLAR_WORD_BUDGET,
  trimToWordBudget,
  buildVoiceExemplarSection,
  buildSpeakerSystemPrompt,
  makeMetric,
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
      ...base, voiceExemplar: exemplar, disposition: 'Irritated by Crowley.',
    });
    assert.ok(prompt.indexOf('HOW YOU SPEAK') < prompt.indexOf('HOW YOU ACTUALLY WRITE'));
    assert.ok(prompt.indexOf('HOW YOU ACTUALLY WRITE') < prompt.indexOf('YOUR PRIVATE STATE TONIGHT'));
    assert.ok(prompt.indexOf('YOUR PRIVATE STATE TONIGHT') < prompt.indexOf('YOUR TURN RIGHT NOW'));
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
