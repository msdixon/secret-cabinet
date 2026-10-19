'use strict';

// Disposition scratchpad: prompt builders, tool schema, callDispositionUpdate
// (src/pipeline-disposition.js). Split out of pipeline.test.js for #629.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DISPOSITION_MAX_CHARS,
  buildDispositionToolSchema,
  buildDispositionSystemPrompt,
  buildDispositionUserMessage,
  callDispositionUpdate,
  RESIDUE_NOTE_MAX_CHARS,
} = require('../src/pipeline.js');
const {
  MAX_CITATIONS_PER_BEAT,
  CITATION_QUOTE_MAX_CHARS,
  CITATION_WORK_MAX_CHARS,
  CITATION_NOTE_MAX_CHARS,
  MAX_INVOKED_PER_BEAT,
  INVOKED_WORK_MAX_CHARS,
  INVOKED_NOTE_MAX_CHARS,
} = require('../src/tuning.js');
const { fakeToolCallClient } = require('./helpers/fake-anthropic.js');

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
      member,
      priorDisposition: { text: "Unconvinced by Crowley's reading of Kabbalah.", waitingOnMemberId: null },
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
    const presentMembers = [
      { id: 'waite', name: 'A.E. Waite' },
      { id: 'yeats', name: 'W.B. Yeats' },
    ];
    const prompt = buildDispositionSystemPrompt({
      member,
      presentMembers,
      priorDisposition: { text: 'Still turning over the Kabbalah point.', waitingOnMemberId: 'waite' },
    });
    assert.match(prompt, /You were privately waiting to answer or press A\.E\. Waite\./);
  });

  await t.test('says nothing extra when there was no prior target', () => {
    const presentMembers = [{ id: 'waite', name: 'A.E. Waite' }];
    const prompt = buildDispositionSystemPrompt({
      member,
      presentMembers,
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
      member,
      priorDisposition: null,
      priorResidue: "Grew wary of Crowley's charm.",
    });
    assert.match(prompt, /Residue already carried from other evenings.*Grew wary of Crowley's charm\./s);
    assert.match(prompt, /most turns, it didn't/);
  });

  await t.test('asks for the residue fragment as rare, on top of the unspent-business ask', () => {
    const prompt = buildDispositionSystemPrompt({ member, priorDisposition: null });
    assert.match(prompt, /outlast this evening/);
    assert.match(prompt, /most turns, there is nothing here either/i);
  });

  // #355 — always-on citation capture, piggybacked on this same call.
  await t.test('always asks for citations from the turn just spoken, not this reflection', () => {
    const prompt = buildDispositionSystemPrompt({ member, priorDisposition: null });
    assert.match(prompt, /extract every citation/i);
    assert.match(prompt, /not this reflection/);
    assert.match(prompt, /most turns cite nothing/i);
  });

  // #356 — the weaker invoked-works tier, piggybacked on the same call.
  await t.test('always asks for texts invoked without a quote, separately from citations', () => {
    const prompt = buildDispositionSystemPrompt({ member, priorDisposition: null });
    assert.match(prompt, /invokedWorks tool field/);
    assert.match(prompt, /without quoting or citing it directly/);
    assert.match(prompt, /most turns invoke nothing/i);
  });

  await t.test('includes the library list when one is given, for libraryMatch', () => {
    const prompt = buildDispositionSystemPrompt({
      member,
      priorDisposition: null,
      libraryList: 'waite: The Pictorial Key to the Tarot — 1911 edition',
    });
    assert.match(prompt, /archival library entries/);
    assert.match(prompt, /waite: The Pictorial Key to the Tarot — 1911 edition/);
  });

  await t.test('says nothing about a library list when none is given', () => {
    const prompt = buildDispositionSystemPrompt({ member, priorDisposition: null });
    assert.doesNotMatch(prompt, /archival library entries/);
  });
});

test('buildDispositionUserMessage', async t => {
  await t.test("includes the round context, the member's own turn, and their name", () => {
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
  await t.test(
    'hard-truncates the reflection to DISPOSITION_MAX_CHARS regardless of what the model returns',
    async () => {
      const overlong = 'x'.repeat(DISPOSITION_MAX_CHARS + 200);
      const fakeClient = fakeToolCallClient({ reflection: overlong, waitingOnMemberId: 'none' });
      const { text } = await callDispositionUpdate({
        client: fakeClient,
        model: 'test-model',
        system: 'sys',
        userMessage: 'msg',
        presentIds: ['waite'],
      });
      assert.equal(text.length, DISPOSITION_MAX_CHARS);
    }
  );

  await t.test('trims whitespace and returns an empty string if the model returns nothing usable', async () => {
    const fakeClient = { messages: { create: async () => ({ content: [], usage: null }) } };
    const { text } = await callDispositionUpdate({
      client: fakeClient,
      model: 'test-model',
      system: 'sys',
      userMessage: 'msg',
    });
    assert.equal(text, '');
  });

  await t.test('resolves a valid, present waitingOnMemberId', async () => {
    const fakeClient = fakeToolCallClient({ reflection: 'Still turning this over.', waitingOnMemberId: 'waite' });
    const { waitingOnMemberId } = await callDispositionUpdate({
      client: fakeClient,
      model: 'test-model',
      system: 'sys',
      userMessage: 'msg',
      presentIds: ['waite', 'yeats'],
    });
    assert.equal(waitingOnMemberId, 'waite');
  });

  await t.test('treats the "none" sentinel as null', async () => {
    const fakeClient = fakeToolCallClient({ reflection: 'Nothing pending.', waitingOnMemberId: 'none' });
    const { waitingOnMemberId } = await callDispositionUpdate({
      client: fakeClient,
      model: 'test-model',
      system: 'sys',
      userMessage: 'msg',
      presentIds: ['waite'],
    });
    assert.equal(waitingOnMemberId, null);
  });

  // #449 SPIKE
  await t.test('passes through a valid reaction tag', async () => {
    const fakeClient = fakeToolCallClient({
      reflection: 'Something has shifted.',
      waitingOnMemberId: 'none',
      reaction: 'angry',
    });
    const { reaction, reactionRaw } = await callDispositionUpdate({
      client: fakeClient,
      model: 'test-model',
      system: 'sys',
      userMessage: 'msg',
      presentIds: ['waite'],
    });
    assert.equal(reaction, 'angry');
    assert.equal(reactionRaw, 'angry');
  });

  await t.test('fails closed to "none" on an unrecognized or missing reaction tag', async () => {
    const fakeClient = fakeToolCallClient({
      reflection: 'Something has shifted.',
      waitingOnMemberId: 'none',
      reaction: 'ecstatic',
    });
    const { reaction } = await callDispositionUpdate({
      client: fakeClient,
      model: 'test-model',
      system: 'sys',
      userMessage: 'msg',
      presentIds: ['waite'],
    });
    assert.equal(reaction, 'none');
  });

  await t.test(
    'ignores a target that is not in presentIds — a hallucinated or stale id must not silently pass through',
    async () => {
      const fakeClient = fakeToolCallClient({
        reflection: 'Still turning this over.',
        waitingOnMemberId: 'not-present-tonight',
      });
      const { waitingOnMemberId } = await callDispositionUpdate({
        client: fakeClient,
        model: 'test-model',
        system: 'sys',
        userMessage: 'msg',
        presentIds: ['waite'],
      });
      assert.equal(waitingOnMemberId, null);
    }
  );

  await t.test('defaults to no target when the tool call is missing or malformed', async () => {
    const fakeClient = { messages: { create: async () => ({ content: [], usage: null }) } };
    const { waitingOnMemberId } = await callDispositionUpdate({
      client: fakeClient,
      model: 'test-model',
      system: 'sys',
      userMessage: 'msg',
      presentIds: ['waite'],
    });
    assert.equal(waitingOnMemberId, null);
  });

  // #166 — the optional residueNote field, piggybacked on this same call.
  await t.test('returns an empty residueNote when the model leaves the field out — the common case', async () => {
    const fakeClient = fakeToolCallClient({ reflection: 'Still turning this over.', waitingOnMemberId: 'none' });
    const { residueNote } = await callDispositionUpdate({
      client: fakeClient,
      model: 'test-model',
      system: 'sys',
      userMessage: 'msg',
      presentIds: ['waite'],
    });
    assert.equal(residueNote, '');
  });

  await t.test('trims and returns a residueNote when the model writes one', async () => {
    const fakeClient = fakeToolCallClient({
      reflection: 'Still turning this over.',
      waitingOnMemberId: 'none',
      residueNote: '  Grew certain of it.  ',
    });
    const { residueNote } = await callDispositionUpdate({
      client: fakeClient,
      model: 'test-model',
      system: 'sys',
      userMessage: 'msg',
      presentIds: ['waite'],
    });
    assert.equal(residueNote, 'Grew certain of it.');
  });

  await t.test(
    'hard-truncates residueNote to RESIDUE_NOTE_MAX_CHARS regardless of what the model returns',
    async () => {
      const overlong = 'x'.repeat(RESIDUE_NOTE_MAX_CHARS + 200);
      const fakeClient = fakeToolCallClient({ reflection: 'ok', waitingOnMemberId: 'none', residueNote: overlong });
      const { residueNote } = await callDispositionUpdate({
        client: fakeClient,
        model: 'test-model',
        system: 'sys',
        userMessage: 'msg',
        presentIds: ['waite'],
      });
      assert.equal(residueNote.length, RESIDUE_NOTE_MAX_CHARS);
    }
  );

  // #355 — the optional citations array, sanitized the same way reflection
  // and residueNote already are: a tool call is a request, not a guarantee,
  // and this is written straight into the permanent record.
  await t.test('returns an empty citations array when the model leaves the field out — the common case', async () => {
    const fakeClient = fakeToolCallClient({ reflection: 'Nothing to add.', waitingOnMemberId: 'none' });
    const { citations } = await callDispositionUpdate({
      client: fakeClient,
      model: 'test-model',
      system: 'sys',
      userMessage: 'msg',
      presentIds: ['waite'],
    });
    assert.deepEqual(citations, []);
  });

  await t.test('passes through a well-formed citation', async () => {
    const fakeClient = fakeToolCallClient({
      reflection: 'ok',
      waitingOnMemberId: 'none',
      citations: [{ quote: 'a real quote', work: 'The Book of the Law', verdict: 'verified', note: 'It exists.' }],
    });
    const { citations } = await callDispositionUpdate({
      client: fakeClient,
      model: 'test-model',
      system: 'sys',
      userMessage: 'msg',
      presentIds: ['waite'],
    });
    assert.equal(citations.length, 1);
    assert.equal(citations[0].work, 'The Book of the Law');
    assert.equal(citations[0].verdict, 'verified');
    assert.equal(citations[0].libraryMatch, null);
  });

  await t.test('drops a citation with no usable quote or work rather than keeping it blank', async () => {
    const fakeClient = fakeToolCallClient({
      reflection: 'ok',
      waitingOnMemberId: 'none',
      citations: [
        { quote: '', work: 'Has No Quote', verdict: 'verified', note: 'n' },
        { quote: 'has no work', work: '', verdict: 'verified', note: 'n' },
      ],
    });
    const { citations } = await callDispositionUpdate({
      client: fakeClient,
      model: 'test-model',
      system: 'sys',
      userMessage: 'msg',
      presentIds: ['waite'],
    });
    assert.deepEqual(citations, []);
  });

  await t.test(
    'downgrades an unrecognized verdict to "uncertain" rather than passing it through unchecked',
    async () => {
      const fakeClient = fakeToolCallClient({
        reflection: 'ok',
        waitingOnMemberId: 'none',
        citations: [{ quote: 'q', work: 'W', verdict: 'definitely-true', note: 'n' }],
      });
      const { citations } = await callDispositionUpdate({
        client: fakeClient,
        model: 'test-model',
        system: 'sys',
        userMessage: 'msg',
        presentIds: ['waite'],
      });
      assert.equal(citations[0].verdict, 'uncertain');
    }
  );

  await t.test(
    'nulls out a libraryMatch not present in libraryIds — a hallucinated or stale id must not silently pass through',
    async () => {
      const fakeClient = fakeToolCallClient({
        reflection: 'ok',
        waitingOnMemberId: 'none',
        citations: [{ quote: 'q', work: 'W', verdict: 'verified', note: 'n', libraryMatch: 'not-a-real-entry' }],
      });
      const { citations } = await callDispositionUpdate({
        client: fakeClient,
        model: 'test-model',
        system: 'sys',
        userMessage: 'msg',
        presentIds: ['waite'],
        libraryIds: ['waite-tarot'],
      });
      assert.equal(citations[0].libraryMatch, null);
    }
  );

  await t.test('keeps a libraryMatch that is present in libraryIds', async () => {
    const fakeClient = fakeToolCallClient({
      reflection: 'ok',
      waitingOnMemberId: 'none',
      citations: [{ quote: 'q', work: 'W', verdict: 'verified', note: 'n', libraryMatch: 'waite-tarot' }],
    });
    const { citations } = await callDispositionUpdate({
      client: fakeClient,
      model: 'test-model',
      system: 'sys',
      userMessage: 'msg',
      presentIds: ['waite'],
      libraryIds: ['waite-tarot'],
    });
    assert.equal(citations[0].libraryMatch, 'waite-tarot');
  });

  await t.test('caps the citations array at MAX_CITATIONS_PER_BEAT', async () => {
    const overlong = Array.from({ length: MAX_CITATIONS_PER_BEAT + 5 }, (_, i) => ({
      quote: `q${i}`,
      work: `W${i}`,
      verdict: 'verified',
      note: 'n',
    }));
    const fakeClient = fakeToolCallClient({ reflection: 'ok', waitingOnMemberId: 'none', citations: overlong });
    const { citations } = await callDispositionUpdate({
      client: fakeClient,
      model: 'test-model',
      system: 'sys',
      userMessage: 'msg',
      presentIds: ['waite'],
    });
    assert.equal(citations.length, MAX_CITATIONS_PER_BEAT);
  });

  await t.test('hard-truncates quote/work/note regardless of what the model returns', async () => {
    const fakeClient = fakeToolCallClient({
      reflection: 'ok',
      waitingOnMemberId: 'none',
      citations: [
        {
          quote: 'q'.repeat(CITATION_QUOTE_MAX_CHARS + 50),
          work: 'w'.repeat(CITATION_WORK_MAX_CHARS + 50),
          verdict: 'verified',
          note: 'n'.repeat(CITATION_NOTE_MAX_CHARS + 50),
        },
      ],
    });
    const { citations } = await callDispositionUpdate({
      client: fakeClient,
      model: 'test-model',
      system: 'sys',
      userMessage: 'msg',
      presentIds: ['waite'],
    });
    assert.equal(citations[0].quote.length, CITATION_QUOTE_MAX_CHARS);
    assert.equal(citations[0].work.length, CITATION_WORK_MAX_CHARS);
    assert.equal(citations[0].note.length, CITATION_NOTE_MAX_CHARS);
  });

  await t.test('defaults to an empty citations array when the tool call is missing or malformed', async () => {
    const fakeClient = { messages: { create: async () => ({ content: [], usage: null }) } };
    const { citations } = await callDispositionUpdate({
      client: fakeClient,
      model: 'test-model',
      system: 'sys',
      userMessage: 'msg',
      presentIds: ['waite'],
    });
    assert.deepEqual(citations, []);
  });

  // #356 — the optional invokedWorks array, sanitized the same way citations
  // is: a weaker, unverified tier for texts/authors gestured at without a
  // supporting quote.
  await t.test(
    'returns an empty invokedWorks array when the model leaves the field out — the common case',
    async () => {
      const fakeClient = fakeToolCallClient({ reflection: 'Nothing to add.', waitingOnMemberId: 'none' });
      const { invokedWorks } = await callDispositionUpdate({
        client: fakeClient,
        model: 'test-model',
        system: 'sys',
        userMessage: 'msg',
        presentIds: ['waite'],
      });
      assert.deepEqual(invokedWorks, []);
    }
  );

  await t.test('passes through a well-formed invoked work', async () => {
    const fakeClient = fakeToolCallClient({
      reflection: 'ok',
      waitingOnMemberId: 'none',
      invokedWorks: [{ work: "Corbin's reading of Ibn Arabi", note: 'named in passing' }],
    });
    const { invokedWorks } = await callDispositionUpdate({
      client: fakeClient,
      model: 'test-model',
      system: 'sys',
      userMessage: 'msg',
      presentIds: ['waite'],
    });
    assert.equal(invokedWorks.length, 1);
    assert.equal(invokedWorks[0].work, "Corbin's reading of Ibn Arabi");
    assert.equal(invokedWorks[0].note, 'named in passing');
  });

  await t.test('drops an invoked work with no usable `work` field', async () => {
    const fakeClient = fakeToolCallClient({
      reflection: 'ok',
      waitingOnMemberId: 'none',
      invokedWorks: [{ note: 'orphaned note, no work named' }],
    });
    const { invokedWorks } = await callDispositionUpdate({
      client: fakeClient,
      model: 'test-model',
      system: 'sys',
      userMessage: 'msg',
      presentIds: ['waite'],
    });
    assert.deepEqual(invokedWorks, []);
  });

  await t.test('caps the invokedWorks array at MAX_INVOKED_PER_BEAT', async () => {
    const overlong = Array.from({ length: MAX_INVOKED_PER_BEAT + 5 }, (_, i) => ({ work: `Work ${i}` }));
    const fakeClient = fakeToolCallClient({ reflection: 'ok', waitingOnMemberId: 'none', invokedWorks: overlong });
    const { invokedWorks } = await callDispositionUpdate({
      client: fakeClient,
      model: 'test-model',
      system: 'sys',
      userMessage: 'msg',
      presentIds: ['waite'],
    });
    assert.equal(invokedWorks.length, MAX_INVOKED_PER_BEAT);
  });

  await t.test('hard-truncates invokedWorks fields to their max lengths', async () => {
    const fakeClient = fakeToolCallClient({
      reflection: 'ok',
      waitingOnMemberId: 'none',
      invokedWorks: [{ work: 'w'.repeat(INVOKED_WORK_MAX_CHARS + 50), note: 'n'.repeat(INVOKED_NOTE_MAX_CHARS + 50) }],
    });
    const { invokedWorks } = await callDispositionUpdate({
      client: fakeClient,
      model: 'test-model',
      system: 'sys',
      userMessage: 'msg',
      presentIds: ['waite'],
    });
    assert.equal(invokedWorks[0].work.length, INVOKED_WORK_MAX_CHARS);
    assert.equal(invokedWorks[0].note.length, INVOKED_NOTE_MAX_CHARS);
  });

  await t.test('defaults to an empty invokedWorks array when the tool call is missing or malformed', async () => {
    const fakeClient = { messages: { create: async () => ({ content: [], usage: null }) } };
    const { invokedWorks } = await callDispositionUpdate({
      client: fakeClient,
      model: 'test-model',
      system: 'sys',
      userMessage: 'msg',
      presentIds: ['waite'],
    });
    assert.deepEqual(invokedWorks, []);
  });
});

test('buildDispositionToolSchema', async t => {
  await t.test('constrains the target enum to present ids plus the "none" sentinel', () => {
    const schema = buildDispositionToolSchema(['waite', 'yeats']);
    assert.equal(schema.name, 'update_disposition');
    assert.deepEqual(schema.input_schema.properties.waitingOnMemberId.enum, ['waite', 'yeats', 'none']);
    assert.deepEqual(schema.input_schema.required, ['reflection', 'waitingOnMemberId', 'reaction']);
  });

  // #449 SPIKE — reaction is required (not omittable like residueNote/
  // citations) because the eval needs an explicit read every turn, even
  // "none", to score self-report reliability.
  await t.test('constrains reaction to the starter taxonomy plus "none", and requires it', () => {
    const schema = buildDispositionToolSchema(['waite']);
    assert.deepEqual(schema.input_schema.properties.reaction.enum, ['happy', 'thinking', 'angry', 'none']);
    assert.ok(schema.input_schema.required.includes('reaction'));
  });

  // #166 — residueNote must stay optional so an omitted field is how the
  // model expresses "nothing belongs here," the common case by design.
  await t.test('offers residueNote but does not require it', () => {
    const schema = buildDispositionToolSchema(['waite']);
    assert.equal(schema.input_schema.properties.residueNote.type, 'string');
    assert.ok(!schema.input_schema.required.includes('residueNote'));
  });

  // #355 — same optionality convention as residueNote: most turns cite
  // nothing, so citations must not be in `required`.
  await t.test('offers a bounded citations array but does not require it', () => {
    const schema = buildDispositionToolSchema(['waite']);
    assert.equal(schema.input_schema.properties.citations.type, 'array');
    assert.equal(schema.input_schema.properties.citations.maxItems, MAX_CITATIONS_PER_BEAT);
    assert.deepEqual(schema.input_schema.properties.citations.items.required, ['quote', 'work', 'verdict', 'note']);
    assert.ok(!schema.input_schema.required.includes('citations'));
  });

  await t.test('constrains each citation verdict to the three-way enum', () => {
    const schema = buildDispositionToolSchema(['waite']);
    assert.deepEqual(schema.input_schema.properties.citations.items.properties.verdict.enum, [
      'verified',
      'unverified',
      'uncertain',
    ]);
  });

  // #356 — same optionality convention as citations/residueNote: most turns
  // invoke nothing beyond what's already in citations.
  await t.test('offers a bounded invokedWorks array but does not require it, and only requires `work`', () => {
    const schema = buildDispositionToolSchema(['waite']);
    assert.equal(schema.input_schema.properties.invokedWorks.type, 'array');
    assert.equal(schema.input_schema.properties.invokedWorks.maxItems, MAX_INVOKED_PER_BEAT);
    assert.deepEqual(schema.input_schema.properties.invokedWorks.items.required, ['work']);
    assert.ok(!schema.input_schema.required.includes('invokedWorks'));
  });
});
