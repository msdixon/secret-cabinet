'use strict';

// Splinter exchanges (src/pipeline-splinter.js). Split out of pipeline.test.js for #629.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runRound,
  shouldSplinter,
  canOpenDirectorSplinter,
  sanitizeSplinterPair,
  buildSplinterUserMessage,
  formatSplinterBlock,
} = require('../src/pipeline.js');
const { SPLINTER_CHANCE, SPLINTER_MIN_BUDGET_WORDS, MAX_SPLINTERS_PER_PASSAGE } = require('../src/tuning.js');
const { clampedAt, fakeConsultClient } = require('./helpers/fake-anthropic.js');
const {
  LODGE,
  SPLINTER_ROSTER,
  loadSplinterMemberFile,
  withScriptedRandom,
} = require('./helpers/pipeline-fixtures.js');

// #196 — splinter exchanges: two members trading a private aside while the
// main thread continues. shouldSplinter, buildSplinterUserMessage, and
// formatSplinterBlock are pure and tested directly first; the runRound
// integration test below (which needs a two-member pool, unlike every other
// runRound fixture in this file) exercises the full loop wiring.
test('shouldSplinter (#196)', async t => {
  const interruptedMember = { id: 'crowley', name: 'Crowley' };

  await t.test('never fires without a live interrupt-intent signal', () => {
    assert.equal(
      shouldSplinter({
        interruptedMember: null,
        remainingBudget: SPLINTER_MIN_BUDGET_WORDS + 100,
        splinterCount: 0,
        rng: () => 0,
      }),
      false
    );
  });

  await t.test('respects the once-per-passage cap', () => {
    assert.equal(
      shouldSplinter({
        interruptedMember,
        remainingBudget: SPLINTER_MIN_BUDGET_WORDS + 100,
        splinterCount: MAX_SPLINTERS_PER_PASSAGE,
        rng: () => 0,
      }),
      false
    );
  });

  await t.test('needs enough budget headroom for both beats plus something left over', () => {
    assert.equal(
      shouldSplinter({
        interruptedMember,
        remainingBudget: SPLINTER_MIN_BUDGET_WORDS - 1,
        splinterCount: 0,
        rng: () => 0,
      }),
      false
    );
    assert.equal(
      shouldSplinter({
        interruptedMember,
        remainingBudget: SPLINTER_MIN_BUDGET_WORDS,
        splinterCount: 0,
        rng: () => 0,
      }),
      true
    );
  });

  await t.test('is the exception, not the default — gated by SPLINTER_CHANCE', () => {
    const args = { interruptedMember, remainingBudget: SPLINTER_MIN_BUDGET_WORDS + 100, splinterCount: 0 };
    assert.equal(shouldSplinter({ ...args, rng: () => SPLINTER_CHANCE - 0.001 }), true);
    assert.equal(shouldSplinter({ ...args, rng: () => SPLINTER_CHANCE }), false);
    assert.equal(shouldSplinter({ ...args, rng: () => 0.999 }), false);
  });
});

test('canOpenDirectorSplinter (#458)', async t => {
  await t.test('never fires without a proposed pair', () => {
    assert.equal(
      canOpenDirectorSplinter({ pair: null, splinterCount: 0, remainingBudget: SPLINTER_MIN_BUDGET_WORDS + 100 }),
      false
    );
  });

  await t.test('respects the same once-per-passage cap as the reactive trigger', () => {
    assert.equal(
      canOpenDirectorSplinter({
        pair: ['crowley', 'scholem'],
        splinterCount: MAX_SPLINTERS_PER_PASSAGE,
        remainingBudget: SPLINTER_MIN_BUDGET_WORDS + 100,
      }),
      false
    );
  });

  await t.test('needs the same budget headroom as the reactive trigger', () => {
    assert.equal(
      canOpenDirectorSplinter({
        pair: ['crowley', 'scholem'],
        splinterCount: 0,
        remainingBudget: SPLINTER_MIN_BUDGET_WORDS - 1,
      }),
      false
    );
    assert.equal(
      canOpenDirectorSplinter({
        pair: ['crowley', 'scholem'],
        splinterCount: 0,
        remainingBudget: SPLINTER_MIN_BUDGET_WORDS,
      }),
      true
    );
  });

  await t.test(
    'unlike shouldSplinter, there is no rng gating — a proposed pair with room and budget always opens',
    () => {
      // shouldSplinter's own SPLINTER_CHANCE test above shows a roll can still
      // say no even with room and budget; canOpenDirectorSplinter takes no rng
      // at all, so there is nothing to script here — the director's own
      // prompt-level restraint is the only thing keeping a proposal rare.
      assert.equal(
        canOpenDirectorSplinter({
          pair: ['crowley', 'scholem'],
          splinterCount: 0,
          remainingBudget: SPLINTER_MIN_BUDGET_WORDS + 1000,
        }),
        true
      );
    }
  );
});

test('sanitizeSplinterPair (#458)', async t => {
  const presentIds = ['crowley', 'scholem', 'yeats'];

  await t.test('a valid pair of distinct, present members passes through unchanged', () => {
    assert.deepEqual(sanitizeSplinterPair(['crowley', 'scholem'], presentIds), ['crowley', 'scholem']);
  });

  await t.test('rejects a pair naming the same member twice', () => {
    assert.equal(sanitizeSplinterPair(['crowley', 'crowley'], presentIds), null);
  });

  await t.test('rejects a member outside the present roster', () => {
    assert.equal(sanitizeSplinterPair(['crowley', 'absent-member'], presentIds), null);
  });

  await t.test('rejects the wrong array length', () => {
    assert.equal(sanitizeSplinterPair(['crowley'], presentIds), null);
    assert.equal(sanitizeSplinterPair(['crowley', 'scholem', 'yeats'], presentIds), null);
    assert.equal(sanitizeSplinterPair([], presentIds), null);
  });

  await t.test("rejects a non-array or missing pair — the director simply didn't propose one", () => {
    assert.equal(sanitizeSplinterPair(null, presentIds), null);
    assert.equal(sanitizeSplinterPair(undefined, presentIds), null);
    assert.equal(sanitizeSplinterPair('crowley,scholem', presentIds), null);
  });
});

test('buildSplinterUserMessage (#196)', async t => {
  const crowley = { name: 'Crowley' };
  const scholem = { name: 'Scholem' };

  await t.test('the opening line frames the aside and quotes what triggered it', () => {
    const msg = buildSplinterUserMessage({
      speaker: scholem,
      other: crowley,
      priorText: '',
      triggeringText: 'A wild claim about the Golden Dawn.',
    });
    assert.match(msg, /stepped a half-step apart/);
    assert.match(msg, /does not hear this exchange/);
    assert.match(msg, /"A wild claim about the Golden Dawn\."/);
    assert.match(msg, /Generate Scholem's side of this aside now/);
    assert.equal(/SO FAR/.test(msg), false);
  });

  await t.test('a reply shows the exchange so far instead of the triggering line', () => {
    const msg = buildSplinterUserMessage({
      speaker: crowley,
      other: scholem,
      priorText: 'Scholem\nWhat did you mean by that?',
      triggeringText: 'ignored on a reply',
    });
    assert.match(msg, /BETWEEN YOU AND SCHOLEM, SO FAR/);
    assert.match(msg, /What did you mean by that\?/);
    assert.equal(/ignored on a reply/.test(msg), false);
  });

  await t.test('never mentions the room or an audience — the whole point is that no one else hears it', () => {
    const msg = buildSplinterUserMessage({ speaker: scholem, other: crowley, priorText: '', triggeringText: null });
    assert.match(msg, /nothing addressed to the room/);
  });
});

test('formatSplinterBlock (#196)', async t => {
  await t.test('wraps the exchange in a diegetic bracket naming both participants', () => {
    const block = formatSplinterBlock({ name: 'Scholem' }, { name: 'Crowley' }, [
      { speakerName: 'Scholem', text: 'You cannot have meant that.' },
      { speakerName: 'Crowley', text: 'I meant every word.' },
    ]);
    assert.match(block, /^\[Aside — Scholem and Crowley, apart from the room\]/);
    assert.match(block, /Scholem\nYou cannot have meant that\./);
    assert.match(block, /Crowley\nI meant every word\./);
    assert.match(block, /\[\/Aside\]$/);
  });

  await t.test('a one-sided exchange (the reply failed) still renders the opening line alone', () => {
    const block = formatSplinterBlock({ name: 'Scholem' }, { name: 'Crowley' }, [
      { speakerName: 'Scholem', text: 'You cannot have meant that.' },
    ]);
    assert.match(block, /\[Aside — Scholem and Crowley, apart from the room\]\nScholem\n/);
    assert.equal(/Crowley\n/.test(block), false);
  });
});

test('runRound — a splinter exchange interleaves into the passage record (#196)', async t => {
  await t.test('two members granted a private exchange, folded into the record and the rolled-up text', async () => {
    // rng script: pick crowley (beat 1, roll 0 → first candidate), #513's
    // tangent-nudge roll for that same beat (well above TANGENT_NUDGE_CHANCE
    // — irrelevant to this test, just consuming its slot), pick scholem
    // (beat 2 — heavily interrupt-boosted already, 0.5 lands there
    // regardless of exact weights), shouldSplinter's own roll (well under
    // SPLINTER_CHANCE — the splinter path `continue`s before ever reaching
    // the tangent-nudge roll, so beat 2 gets no slot for it), then pick
    // scholem again (beat 4 — crowley is at cap by then, so this is
    // deterministic regardless of the roll's value) and its own
    // tangent-nudge roll.
    const client = fakeConsultClient({
      speakers: ['crowley', 'scholem'],
      windingDownOnConsult: [false, true],
      lullNote: 'A note.',
    });
    const result = await withScriptedRandom([0, 0.9, 0.5, 0.01, 0.5, 0.9], () =>
      runRound({
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
        // Seeds the #203 interrupt-intent signal directly, exactly as if
        // scholem's own disposition had already named crowley as unspent
        // business before the passage even began — the trigger this
        // mechanism is built to reuse, not a new one.
        disposition: { scholem: { text: 'Unfinished business.', waitingOnMemberId: 'crowley' } },
      })
    );

    assert.equal(result.beats.length, 4);
    assert.deepEqual(
      result.beats.map(b => b.memberId),
      ['crowley', 'scholem', 'crowley', 'scholem']
    );
    // Only the middle two beats — the splinter — carry a thread tag.
    assert.equal(result.beats[0].thread, undefined);
    assert.equal(result.beats[3].thread, undefined);
    assert.ok(result.beats[1].thread);
    assert.ok(result.beats[2].thread);
    assert.equal(result.beats[1].thread.id, result.beats[2].thread.id);
    assert.deepEqual(result.beats[1].thread.participants, ['scholem', 'crowley']);

    // The splinter is folded into the rolled-up text as one bracketed
    // block, distinct from the ordinary "Name\ntext" beats around it — this
    // is what makes every existing surface that renders segment.text
    // (reading room, export, live SSE) show the aside correctly with no
    // client change.
    assert.match(result.fullRoundText, /\[Aside — Scholem and Crowley, apart from the room\]/);
    assert.match(result.fullRoundText, /\[\/Aside\]/);

    // Both participants read as having spoken, for the meeting-level
    // ledger and pacing bookkeeping's sake — a splinter isn't "off the
    // books."
    assert.deepEqual(new Set(result.speakerOrder), new Set(['crowley', 'scholem']));
    assert.equal(result.endedBy, 'lull');
  });

  await t.test(
    'a splinter never triggers off the very first pick — there is no lastSpeakerId yet to interrupt',
    async () => {
      // Same seeded disposition, but scholem is never picked first (rng: 0
      // always favors the rank-0 candidate, crowley) — confirms the null
      // lastSpeakerId guard rather than assuming it from the happy path above.
      const client = fakeConsultClient({
        speakers: ['crowley', 'scholem'],
        windingDownOnConsult: [false, true],
        lullNote: 'A note.',
      });
      const result = await withScriptedRandom([0], () =>
        runRound({
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
          disposition: { crowley: { text: 'Unfinished business.', waitingOnMemberId: 'scholem' } },
        })
      );
      assert.ok(result.beats.every(b => b.thread === undefined));
    }
  );
});

// #458 — director-proposed splinters: `splinterPairOnConsult` puts a pair on
// the opening consult, a mid-passage re-consult, or neither (indexed per
// select_speakers call, clamping to the last entry like windingDownOnConsult).
const fakeDirectorSplinterClient = ({ splinterPairOnConsult = [], windingDownOnConsult = [false, true] } = {}) =>
  fakeConsultClient({
    speakers: ['crowley', 'scholem'],
    windingDownOnConsult,
    lullNote: 'A note.',
    consultExtras: i => ({ splinterPair: clampedAt(splinterPairOnConsult, i) ?? null }),
  });

test('runRound — a director-proposed splinter opens the passage before anyone in the room has spoken (#458)', async t => {
  await t.test("the opening consult's pair resolves as the passage's first move, then the room continues", async () => {
    // rng script: two zeros for the two main-thread picks after the
    // director's splinter resolves. rng 0 always lands on the pool's first
    // still-eligible candidate (see pickNextSpeaker: roll starts at 0, so it
    // clears the first positive weight it meets) — crowley for the first
    // main pick, then crowley again next since a lone repeat isn't
    // disallowed, only discounted, until crowley hits MAX_TURNS_PER_POOL_MEMBER
    // and scholem becomes the only nonzero-weight candidate.
    const client = fakeDirectorSplinterClient({ splinterPairOnConsult: [['crowley', 'scholem']] });
    const result = await withScriptedRandom([0, 0], () =>
      runRound({
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
        // No #203 signal seeded at all — this splinter has nothing to do
        // with interrupt-intent, which is the whole point of #458 adding a
        // second, independent trigger.
        disposition: {},
      })
    );

    assert.equal(result.beats.length, 4);
    // The director's pair is the opening move: beats 0 and 1 carry the
    // thread tag before either main-thread beat happens.
    assert.ok(result.beats[0].thread);
    assert.ok(result.beats[1].thread);
    assert.equal(result.beats[0].thread.id, result.beats[1].thread.id);
    assert.deepEqual(result.beats[0].thread.participants, ['crowley', 'scholem']);
    assert.equal(result.beats[0].memberId, 'crowley');
    assert.equal(result.beats[1].memberId, 'scholem');
    // The two beats after it are ordinary main-thread turns.
    assert.equal(result.beats[2].thread, undefined);
    assert.equal(result.beats[3].thread, undefined);

    assert.match(result.fullRoundText, /\[Aside — Crowley and Scholem, apart from the room\]/);
    assert.deepEqual(new Set(result.speakerOrder), new Set(['crowley', 'scholem']));
    assert.equal(result.endedBy, 'lull');
  });
});

test('runRound — a director-proposed splinter opens at a mid-passage re-consult too (#458)', async t => {
  await t.test(
    'a pair proposed on a later consult opens exactly where it was proposed, not just at the start',
    async () => {
      // No pair on the opening consult; the mid-passage re-consult (the 2nd
      // select_speakers call) proposes one, and the 3rd ends the passage.
      const client = fakeDirectorSplinterClient({
        windingDownOnConsult: [false, false, true],
        splinterPairOnConsult: [null, ['crowley', 'scholem']],
      });
      // Six main-thread picks, all rng 0: four to exhaust the pool the first
      // time (crowley, crowley, scholem, scholem — each hits
      // MAX_TURNS_PER_POOL_MEMBER, forcing the re-consult), two more after the
      // mid-consult splinter resets spokenCounts and exhausts it again.
      const result = await withScriptedRandom([0, 0, 0, 0, 0, 0], () =>
        runRound({
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
        })
      );

      assert.equal(result.beats.length, 8);
      // The four main-thread beats before the mid-consult splinter.
      assert.deepEqual(
        result.beats.slice(0, 4).map(b => b.memberId),
        ['crowley', 'crowley', 'scholem', 'scholem']
      );
      assert.ok(result.beats.slice(0, 4).every(b => b.thread === undefined));
      // The splinter itself, opened at the re-consult rather than at passage start.
      assert.ok(result.beats[4].thread);
      assert.ok(result.beats[5].thread);
      assert.equal(result.beats[4].thread.id, result.beats[5].thread.id);
      assert.deepEqual(result.beats[4].thread.participants, ['crowley', 'scholem']);
      assert.equal(result.beats[4].memberId, 'crowley');
      assert.equal(result.beats[5].memberId, 'scholem');
      // Two more ordinary main-thread beats after the splinter, before the
      // final consult ends the passage.
      assert.ok(result.beats.slice(6).every(b => b.thread === undefined));

      assert.match(result.fullRoundText, /\[Aside — Crowley and Scholem, apart from the room\]/);
      assert.equal(result.endedBy, 'lull');
    }
  );

  await t.test(
    'the once-per-passage cap still applies across consults — a second proposal is dropped, not queued',
    async () => {
      // Both the opening and the mid-passage re-consult propose a pair;
      // MAX_SPLINTERS_PER_PASSAGE (1) means only the first one can ever open.
      const client = fakeDirectorSplinterClient({
        windingDownOnConsult: [false, false, true],
        splinterPairOnConsult: [
          ['crowley', 'scholem'],
          ['scholem', 'crowley'],
        ],
      });
      const result = await withScriptedRandom([0, 0], () =>
        runRound({
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
        })
      );

      const threaded = result.beats.filter(b => b.thread);
      assert.equal(threaded.length, 2);
      assert.equal(new Set(threaded.map(b => b.thread.id)).size, 1);
    }
  );
});
