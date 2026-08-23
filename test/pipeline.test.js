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
  isPassTurn,
  lengthTendencyOf,
  PRIORITY_RANK_DECAY,
  MAX_UNDER_HEARD_DEFICIT,
  poolAverageTurns,
  underHeardDeficit,
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
  SECONDARY_VOICE_EXEMPLAR_WORD_BUDGET,
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
  buildDirectorPrompt,
  buildTurnLedgerBlock,
  callSpeakerTurn,
  runRound,
  BREATH_BUDGET_WORDS,
  POOL_SLACK,
  WORDS_PER_BEAT_ESTIMATE,
  RECONSULT_BUDGET_FRACTION,
  LULL_NOTE_MAX_CHARS,
  STOCK_LULL_NOTES,
  pickStockLullNote,
  resolveLullNote,
} = require('../src/pipeline.js');
const record = require('../public/js/record.js');
// #355 — citation-capture sizing constants live in tuning.js, not re-exported
// through pipeline.js's flat surface (see that file's own module.exports).
const {
  MAX_CITATIONS_PER_BEAT,
  CITATION_QUOTE_MAX_CHARS,
  CITATION_WORK_MAX_CHARS,
  CITATION_NOTE_MAX_CHARS,
  MAX_INVOKED_PER_BEAT,
  INVOKED_WORK_MAX_CHARS,
  INVOKED_NOTE_MAX_CHARS,
} = require('../src/tuning.js');

// #352's ledger lives in lodge-prompts.js (see its own comment for why) but
// is exercised here too — the distribution test below is the only place the
// reduction and the draw it feeds are measured together.
const { turnsSoFar } = require('../src/lodge-prompts.js');

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
    assert.equal(
      isPoolExhausted(
        pool,
        counts([
          ['scholem', 2],
          ['blavatsky', 2],
        ])
      ),
      true
    );
    assert.equal(
      isPoolExhausted(
        pool,
        counts([
          ['scholem', 2],
          ['blavatsky', 1],
        ])
      ),
      false
    );
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
      spokenCounts: counts([
        ['scholem', 2],
        ['blavatsky', 2],
      ]),
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

  // These pools all put the member under test at rank 0 (pool[0]) and the
  // other candidate at rank 1, so #330's priority weighting (PRIORITY_RANK_DECAY
  // applied to the rank-1 candidate, 1x to rank 0) is baked into every
  // expected share below, not just the tests that name it explicitly.

  await t.test('speaking back-to-back is rare but possible (~12% against one fresh voice)', () => {
    const share = shareOf('scholem', {
      pool: ['scholem', 'blavatsky'],
      spokenCounts: counts([['scholem', 1]]),
      lastSpeakerId: 'scholem',
      remainingBudget: 500,
    });
    // 0.12 / (0.12 + 1 * PRIORITY_RANK_DECAY)
    assert.ok(Math.abs(share - 0.13) < 0.01, `back-to-back share was ${share}`);
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
    // 0.45 / (0.45 + 1 * PRIORITY_RANK_DECAY) — discounted, but far likelier than the back-to-back case
    assert.ok(Math.abs(share - 0.36) < 0.01, `repeat-after-gap share was ${share}`);
  });

  await t.test('expansive voices are favoured while there is budget to spend', () => {
    const share = shareOf('crowley', {
      pool: ['crowley', 'scholem'],
      spokenCounts: counts([]),
      lastSpeakerId: null,
      remainingBudget: 500,
    });
    // 1.35 / (1.35 + 1 * PRIORITY_RANK_DECAY)
    assert.ok(Math.abs(share - 0.628) < 0.01, `expansive share was ${share}`);
  });

  await t.test('below the low-budget threshold that preference inverts, so the round can close', () => {
    const args = {
      pool: ['crowley', 'scholem'],
      spokenCounts: counts([]),
      lastSpeakerId: null,
      remainingBudget: 100, // < LOW_BUDGET_WORDS (120)
    };
    // 1.35 * 0.4 = 0.54, against a medium voice's 1 * PRIORITY_RANK_DECAY
    const share = shareOf('crowley', args);
    assert.ok(Math.abs(share - 0.403) < 0.01, `low-budget expansive share was ${share}`);
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
    // 3 / (3 + 1 * PRIORITY_RANK_DECAY)
    const share = shareOf('scholem', args);
    assert.ok(Math.abs(share - 0.789) < 0.02, `waiting-on share was ${share}`);
  });

  await t.test('the boost only applies when the target actually just spoke', () => {
    const withoutMatch = shareOf('scholem', {
      pool: ['scholem', 'blavatsky'],
      spokenCounts: counts([]),
      lastSpeakerId: 'yeats', // not who scholem is waiting on
      remainingBudget: 500,
      disposition: { scholem: { waitingOnMemberId: 'crowley' } },
    });
    // 1 / (1 + 1 * PRIORITY_RANK_DECAY) — no interrupt boost, just rank 0 vs rank 1
    assert.ok(Math.abs(withoutMatch - 0.556) < 0.02, `unmatched-target share was ${withoutMatch}`);
  });

  await t.test('is a no-op with no disposition map, and tolerant of a member missing from it', () => {
    const args = {
      pool: ['scholem', 'blavatsky'],
      spokenCounts: counts([]),
      lastSpeakerId: 'crowley',
      remainingBudget: 500,
    };
    // 1 / (1 + 1 * PRIORITY_RANK_DECAY)
    assert.ok(Math.abs(shareOf('scholem', args) - 0.556) < 0.02);
    assert.ok(Math.abs(shareOf('scholem', { ...args, disposition: {} }) - 0.556) < 0.02);
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
    // 1 / (1 + 1 * PRIORITY_RANK_DECAY)
    assert.ok(Math.abs(share - 0.556) < 0.02);
  });

  // #330: the director's own priority order (pool[0] = highest priority) is
  // now a real factor in the draw, not just a shortlist. Isolate it from
  // every other weighting factor — same tendency, no repeats, no interrupt —
  // so this test fails on its own if the rank multiplier regresses.
  await t.test('the director-ranked candidate is meaningfully likelier to be drawn, all else equal (#330)', () => {
    const base = {
      pool: ['blavatsky', 'scholem', 'yeats', 'crowley', 'waite'],
      spokenCounts: counts([]),
      lastSpeakerId: null,
      remainingBudget: 500,
    };
    const topShare = shareOf('blavatsky', base); // rank 0
    const bottomShare = shareOf('waite', base); // rank 4
    // yeats/crowley are seeded 'expansive' (LENGTH_WEIGHT), so rank alone
    // isn't a clean signal against them — waite stays default 'medium' like
    // blavatsky and scholem, isolating the rank effect from tendency.
    assert.ok(
      Math.abs(topShare / bottomShare - 1 / Math.pow(PRIORITY_RANK_DECAY, 4)) < 0.15,
      `top-vs-bottom ratio was ${topShare / bottomShare}, expected ~${1 / Math.pow(PRIORITY_RANK_DECAY, 4)}`
    );
    assert.ok(topShare > bottomShare, 'the top-ranked candidate should be drawn more often than the bottom-ranked one');
  });

  // #352: the meeting-level counterweight. Every test above passes no
  // `meetingTurns` at all, which is itself the first assertion here — the
  // boost has to be exactly inert without a ledger, since that is what a
  // session predating #244's `beats` (and the prototype route) will always
  // hand it.
  await t.test('is exactly inert with no ledger, an empty ledger, or an all-equal one', () => {
    const base = {
      pool: ['scholem', 'blavatsky'],
      spokenCounts: counts([]),
      lastSpeakerId: null,
      remainingBudget: 500,
    };
    // 1 / (1 + 1 * PRIORITY_RANK_DECAY), the same share every pre-#352 test asserts
    assert.ok(Math.abs(shareOf('scholem', base) - 0.556) < 0.02);
    assert.ok(Math.abs(shareOf('scholem', { ...base, meetingTurns: {} }) - 0.556) < 0.02);
    assert.ok(Math.abs(shareOf('scholem', { ...base, meetingTurns: { scholem: 3, blavatsky: 3 } }) - 0.556) < 0.02);
  });

  await t.test('a member who has not spoken tonight is boosted against one who has', () => {
    const base = {
      pool: ['scholem', 'blavatsky'],
      spokenCounts: counts([]),
      lastSpeakerId: null,
      remainingBudget: 500,
    };
    // Pool average 1; scholem's deficit 0, blavatsky's 1 -> 1.8x on the
    // rank-1 seat: 1 / (1 + 1.8 * PRIORITY_RANK_DECAY)
    const share = shareOf('scholem', { ...base, meetingTurns: { scholem: 2, blavatsky: 0 } });
    assert.ok(Math.abs(share - 0.41) < 0.02, `under-heard share was ${share}`);
    // ...and the direction is what matters: rank 0 has gone from favoured to
    // outdrawn by the silent member below it.
    assert.ok(share < 0.5, 'a silent rank-1 member should outdraw a talkative rank-0 one');
  });

  await t.test('the deficit is fractional, so pressure builds smoothly rather than stepping at whole turns', () => {
    const shares = [0, 1, 2, 3].map(
      turns =>
        1 -
        shareOf('scholem', {
          pool: ['scholem', 'blavatsky'],
          spokenCounts: counts([]),
          lastSpeakerId: null,
          remainingBudget: 500,
          meetingTurns: { scholem: turns, blavatsky: 0 },
        })
    );
    for (let i = 1; i < shares.length; i++) {
      assert.ok(shares[i] > shares[i - 1], `blavatsky's share should keep rising: ${shares.join(', ')}`);
    }
  });

  await t.test('the deficit is capped, so one runaway talker cannot make every other seat a certainty', () => {
    const capped = shareOf('blavatsky', {
      pool: ['scholem', 'blavatsky'],
      spokenCounts: counts([]),
      lastSpeakerId: null,
      // Pool average 20; blavatsky's raw deficit is 20, clamped to 3.
      remainingBudget: 500,
      meetingTurns: { scholem: 40, blavatsky: 0 },
    });
    // 1.8^3 * PRIORITY_RANK_DECAY / (1 + 1.8^3 * PRIORITY_RANK_DECAY)
    assert.ok(Math.abs(capped - 0.823) < 0.02, `capped share was ${capped}`);
    assert.ok(capped < 1, 'a boost, never a forced pick');
    assert.equal(underHeardDeficit('blavatsky', { scholem: 40 }, 20), MAX_UNDER_HEARD_DEFICIT);
  });

  await t.test('a member at the turn cap stays unpickable however long they have been silent overall', () => {
    // The cap is a hard zero, applied before any weighting — the boost must
    // not resurrect a member who has already taken their two turns this
    // passage just because the meeting owes them.
    const share = shareOf('scholem', {
      pool: ['scholem', 'blavatsky'],
      spokenCounts: counts([['scholem', 2]]),
      lastSpeakerId: null,
      remainingBudget: 500,
      meetingTurns: { scholem: 0, blavatsky: 30 },
    });
    assert.equal(share, 0);
  });

  await t.test('poolAverageTurns reads only the pool, ignoring members not shortlisted tonight', () => {
    // Deliberate: this function can only draw from the pool, so a silent
    // member the director never shortlisted must not drag the average down
    // and inflate everyone else's deficit. Getting *them* a turn is the
    // director half of #352 (buildTurnLedgerBlock), not this half.
    assert.equal(poolAverageTurns(['a', 'b'], { a: 3, b: 1, someone_else: 0 }), 2);
    assert.equal(poolAverageTurns(['a', 'b'], null), 0);
    assert.equal(poolAverageTurns([], { a: 3 }), 0);
  });

  await t.test('an unranked (unordered) pool still sums to a valid distribution', () => {
    // Pool order is the only signal for rank — a single-member pool has no
    // rank-1+ neighbor to be discounted against, so it should draw exactly
    // as often as an unweighted pick (this is really a sanity check that the
    // rank multiplier can't zero out or distort a trivial pool).
    const share = shareOf('scholem', {
      pool: ['scholem'],
      spokenCounts: counts([]),
      lastSpeakerId: null,
      remainingBudget: 500,
    });
    assert.equal(share, 1);
  });
});

// #352, director half. The prompt has always asked the director to weigh
// "who hasn't been heard from" and never gave it the means — these pin the
// line that does, and the two cases where saying nothing is the right call.
test('buildTurnLedgerBlock', async t => {
  const present = [
    { id: 'crowley', name: 'Aleister Crowley' },
    { id: 'yeats', name: 'W.B. Yeats' },
    { id: 'blavatsky', name: 'H.P. Blavatsky' },
  ];

  await t.test('names every present member with their count, and singularizes one turn', () => {
    const block = buildTurnLedgerBlock(present, { crowley: 3, yeats: 1 });
    assert.match(block, /TURNS TAKEN TONIGHT/);
    assert.match(block, /- Aleister Crowley: 3 turns/);
    assert.match(block, /- W\.B\. Yeats: 1 turn$/m);
    assert.match(block, /- H\.P\. Blavatsky: not once/);
  });

  await t.test('calls out the silent members by name, and licenses silence as a choice', () => {
    const block = buildTurnLedgerBlock(present, { crowley: 3 });
    assert.match(block, /W\.B\. Yeats and H\.P\. Blavatsky have not spoken at all tonight/);
    assert.match(block, /not automatically wrong/);
    assert.match(block, /not an accident of who kept getting the floor/);
  });

  await t.test('a single silent member reads as singular, not as a one-item list', () => {
    assert.match(buildTurnLedgerBlock(present, { crowley: 2, yeats: 2 }), /H\.P\. Blavatsky has not spoken/);
  });

  await t.test('says nothing at all when everyone present has spoken', () => {
    const block = buildTurnLedgerBlock(present, { crowley: 1, yeats: 1, blavatsky: 1 });
    assert.match(block, /TURNS TAKEN TONIGHT/);
    assert.doesNotMatch(block, /not spoken at all tonight/);
  });

  await t.test('is omitted entirely with no ledger, an empty one, or an all-zero one', () => {
    // The meeting's opening consult and any session predating #244's
    // `beats` both land here. A column of zeros would read as a claim that
    // the room has sat in silence rather than as an absence of data.
    assert.equal(buildTurnLedgerBlock(present, undefined), '');
    assert.equal(buildTurnLedgerBlock(present, {}), '');
    assert.equal(buildTurnLedgerBlock(present, { someone_absent: 4 }), '');
  });
});

test('buildDirectorPrompt', async t => {
  const present = [
    { id: 'crowley', name: 'Aleister Crowley' },
    { id: 'blavatsky', name: 'H.P. Blavatsky' },
  ];
  const args = {
    lodgeContext: 'THE LODGE',
    presentMembers: present,
    instruction: 'Discuss.',
    minCount: 1,
    maxCount: 2,
  };

  await t.test('carries the ledger next to the roster it annotates', () => {
    const { system } = buildDirectorPrompt({ ...args, meetingTurns: { crowley: 4 } });
    assert.ok(
      system.indexOf('PRESENT TONIGHT') < system.indexOf('TURNS TAKEN TONIGHT'),
      'the ledger should follow the roster it counts'
    );
    assert.ok(
      system.indexOf('TURNS TAKEN TONIGHT') < system.indexOf("THIS ROUND'S INSTRUCTION"),
      'and precede the instruction'
    );
    assert.match(system, /H\.P\. Blavatsky has not spoken at all tonight/);
  });

  await t.test('is byte-identical to the pre-#352 prompt when no ledger is passed', () => {
    // The opening consult of a meeting's first passage takes this path on
    // every single run, so it is the shape most sessions actually see.
    assert.equal(buildDirectorPrompt(args).system, buildDirectorPrompt({ ...args, meetingTurns: {} }).system);
    assert.doesNotMatch(buildDirectorPrompt(args).system, /TURNS TAKEN TONIGHT/);
  });
});

// #352 — the whole-meeting distribution, measured rather than reasoned
// about. The issue was filed off a simulation against these exact
// functions; this pins the result so a future tuning change to
// PRIORITY_RANK_DECAY, LENGTH_WEIGHT, or the boost itself can't quietly
// reopen it.
//
// The harness is runRound's beat loop with every API call and every piece
// of I/O removed: the real pickNextSpeaker and isPoolExhausted, the real
// turnsSoFar reduction over the record each passage leaves behind, and the
// real budget/re-consult arithmetic. Two deliberate simplifications, both
// worst-case rather than flattering: every member is default 'medium'
// tendency (so LENGTH_WEIGHT can't be what moves the numbers), and a
// re-consult returns the same pool in the same order (a real director
// re-orders, which would help on its own — this measures the floor).
//
// It therefore reproduces the *shape* of the issue's table, not its exact
// figures. The gradient is the claim: rank 0 is heard far more than rank 6,
// and nothing in the loop ever notices.
test('#352 whole-meeting turn distribution', async t => {
  const POOL = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6']; // DEFAULT_POOL_SIZE 5 + POOL_SLACK 2
  const MIN_WORDS_FOR_ANOTHER_BEAT = 40;
  const MAX_TOTAL_BEATS = 16;
  const WORDS_PER_TURN = 220; // ~4.3 beats per 1000-word breath budget

  // A tiny LCG rather than Math.random — this test asserts on percentages,
  // so it has to give the same ones on every run or it's a flake generator.
  function seededRng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function runPassage(rng, meetingTurns) {
    const beats = [];
    let spokenCounts = new Map();
    let lastSpeakerId = null;
    let beatsSinceConsult = 0;
    let remainingBudget = BREATH_BUDGET_WORDS;
    while (remainingBudget >= MIN_WORDS_FOR_ANOTHER_BEAT && beats.length < MAX_TOTAL_BEATS) {
      if (isPoolExhausted(POOL, spokenCounts) || beatsSinceConsult >= POOL.length + 3) {
        spokenCounts = new Map();
        beatsSinceConsult = 0;
      }
      const memberId = pickNextSpeaker({
        pool: POOL,
        spokenCounts,
        lastSpeakerId,
        remainingBudget,
        meetingTurns,
        rng,
      });
      if (!memberId) break;
      beats.push({ memberId, text: 'a turn' });
      if (meetingTurns) meetingTurns[memberId] = (meetingTurns[memberId] || 0) + 1;
      spokenCounts.set(memberId, (spokenCounts.get(memberId) || 0) + 1);
      lastSpeakerId = memberId;
      beatsSinceConsult++;
      remainingBudget -= WORDS_PER_TURN;
    }
    return { beats };
  }

  // `withLedger: false` is the pre-#352 pipeline exactly — runRound simply
  // never built a ledger to pass down.
  function simulate({ withLedger, passages = 5, meetings = 2000 }) {
    const rng = seededRng(20260820);
    const silentAllMeeting = POOL.map(() => 0);
    const totalTurns = POOL.map(() => 0);
    for (let i = 0; i < meetings; i++) {
      const rounds = [];
      for (let p = 0; p < passages; p++) {
        rounds.push(runPassage(rng, withLedger ? turnsSoFar(rounds) : undefined));
      }
      const ledger = turnsSoFar(rounds);
      POOL.forEach((id, rank) => {
        totalTurns[rank] += ledger[id] || 0;
        if (!ledger[id]) silentAllMeeting[rank]++;
      });
    }
    return {
      silentShare: silentAllMeeting.map(n => n / meetings),
      avgTurns: totalTurns.map(n => n / meetings),
    };
  }

  const before = simulate({ withLedger: false });
  const after = simulate({ withLedger: true });

  await t.test('reproduces the defect: without a ledger, the bottom of the pool goes whole meetings unheard', () => {
    assert.ok(
      before.silentShare[6] > 0.05,
      `bottom-ranked member sat out ${(before.silentShare[6] * 100).toFixed(1)}% of whole meetings, expected >5%`
    );
    assert.ok(
      before.avgTurns[0] / before.avgTurns[6] > 2,
      `top-vs-bottom turn ratio was ${(before.avgTurns[0] / before.avgTurns[6]).toFixed(2)}, expected >2x`
    );
  });

  await t.test('the ledger all but eliminates the never-spoke-all-evening case', () => {
    assert.ok(
      after.silentShare[6] < 0.01,
      `bottom-ranked member still sat out ${(after.silentShare[6] * 100).toFixed(1)}% of whole meetings`
    );
    assert.ok(
      after.silentShare[6] < before.silentShare[6] / 5,
      `expected at least a 5x drop, got ${before.silentShare[6]} -> ${after.silentShare[6]}`
    );
  });

  await t.test("it narrows the spread rather than flattening it — the director's ranking still counts", () => {
    const ratio = after.avgTurns[0] / after.avgTurns[6];
    assert.ok(ratio < before.avgTurns[0] / before.avgTurns[6], 'the top-to-bottom spread should narrow');
    assert.ok(ratio > 1.2, `ranking should still be visible in the outcome, ratio was ${ratio.toFixed(2)}`);
    // Monotonic in rank: priority order still orders the result.
    for (let rank = 1; rank < POOL.length; rank++) {
      assert.ok(after.avgTurns[rank] < after.avgTurns[rank - 1], `rank ${rank} outdrew rank ${rank - 1}`);
    }
  });

  await t.test('a single-passage meeting is barely affected, which is the correct scope for this fix', () => {
    // Silence within one passage is a legitimate outcome and REPEAT_DECAY's
    // business, not this boost's. With no prior passages there is no
    // meeting history to weigh, so the numbers should stay close to
    // pre-#352 — if this test ever starts failing loudly, the boost has
    // grown into a within-passage rota.
    const oneBefore = simulate({ withLedger: false, passages: 1 });
    const oneAfter = simulate({ withLedger: true, passages: 1 });
    assert.ok(
      Math.abs(oneAfter.silentShare[6] - oneBefore.silentShare[6]) < 0.05,
      `single-passage silence moved from ${oneBefore.silentShare[6]} to ${oneAfter.silentShare[6]}`
    );
  });
});

// #353 — the mid-passage re-consult, measured the same way #352 was: a
// simulation against the real pickNextSpeaker/isPoolExhausted, this time
// with beat length allowed to vary (a fixed 220 words/beat, as #352's
// harness above uses, can never produce the spread that decides whether a
// budget-spent-since-consult threshold is ever crossed — only variance
// does that). The pre-#353 shape (7-seat pool, a 150-word/beat sizing
// assumption, a `beats since consult >= pool.length + 3` trigger) is
// reproduced here rather than imported, since those exact values no longer
// exist in the source once this fix lands — pinning them inline is what
// keeps this test meaningful as a regression guard rather than a tautology
// that just re-reads whatever pipeline.js currently exports.
test('#353 mid-passage re-consult reachability', async t => {
  const MIN_WORDS_FOR_ANOTHER_BEAT = 40;
  const MAX_TOTAL_BEATS = 16;

  function seededRng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  // Real beat lengths vary around a mean, not always land on it — this is
  // the whole reason the old fixed-beat-count threshold's unreachability
  // wasn't obvious from a back-of-envelope "1000 / 220 ≈ 4.3" calculation
  // alone. Irwin-Hall-ish spread, roughly [0.3x, 1.7x] of the mean.
  function beatWords(rng, mean) {
    const u = (rng() + rng() + rng()) / 3;
    return Math.max(30, Math.round(mean * (0.3 + u * 1.4)));
  }

  // One pool-sizing/trigger regime, parameterized so the same harness can
  // run both the pre-#353 shape and the shipped one.
  function runPassage(rng, { poolSize, wordsPerBeatEstimate, poolSlack, trigger }) {
    const seatIds = Array.from({ length: poolSize }, (_, i) => `m${i}`);
    let pool = seatIds.slice();
    let spokenCounts = new Map();
    let lastSpeakerId = null;
    let remainingBudget = BREATH_BUDGET_WORDS;
    let beats = 0;
    let reconsults = 0;
    const triggerState = trigger.init(remainingBudget);

    while (remainingBudget >= MIN_WORDS_FOR_ANOTHER_BEAT && beats < MAX_TOTAL_BEATS) {
      if (isPoolExhausted(pool, spokenCounts) || trigger.shouldFire(triggerState, remainingBudget, beats)) {
        reconsults++;
        const nextCount = Math.max(1, Math.min(poolSize, Math.ceil(remainingBudget / wordsPerBeatEstimate)));
        pool = seatIds.slice(0, Math.min(poolSize, nextCount + poolSlack));
        spokenCounts = new Map();
        trigger.reset(triggerState, remainingBudget, beats);
        if (!pool.length) break;
      }
      const memberId = pickNextSpeaker({ pool, spokenCounts, lastSpeakerId, remainingBudget, rng });
      if (!memberId) break;
      spokenCounts.set(memberId, (spokenCounts.get(memberId) || 0) + 1);
      lastSpeakerId = memberId;
      beats++;
      remainingBudget -= beatWords(rng, 220); // 220: the same real-observed-length figure #352's harness uses
    }
    return { beats, reconsulted: reconsults > 0 };
  }

  function simulate(cfg, passages = 20000) {
    const rng = seededRng(20260820);
    let totalBeats = 0;
    let reconsulted = 0;
    for (let i = 0; i < passages; i++) {
      const result = runPassage(rng, cfg);
      totalBeats += result.beats;
      if (result.reconsulted) reconsulted++;
    }
    return { avgBeats: totalBeats / passages, reconsultRate: reconsulted / passages };
  }

  // The pre-#353 shape: a beat-count trigger that can never fire inside a
  // budget this small, at the old 7-seat/150-word-estimate sizing. The
  // harness calls shouldFire once per loop iteration, before that
  // iteration's beat happens, so beatsSinceConsult increments there —
  // mirroring runRound's own beatsSinceConsult++ at the bottom of its loop.
  const preFixTriggerCounting = {
    init: () => ({ beatsSinceConsult: 0 }),
    shouldFire(state) {
      const fire = state.beatsSinceConsult >= 7 + 3;
      state.beatsSinceConsult++;
      return fire;
    },
    reset: state => {
      state.beatsSinceConsult = 0;
    },
  };

  const preFix = simulate({
    poolSize: 7,
    wordsPerBeatEstimate: 150,
    poolSlack: 2,
    trigger: preFixTriggerCounting,
  });

  const postFixTrigger = {
    init: remainingBudget => ({ budgetAtLastConsult: remainingBudget }),
    shouldFire: (state, remainingBudget) =>
      state.budgetAtLastConsult - remainingBudget >= BREATH_BUDGET_WORDS * RECONSULT_BUDGET_FRACTION,
    reset: (state, remainingBudget) => {
      state.budgetAtLastConsult = remainingBudget;
    },
  };
  const postFixPoolSize = Math.max(1, Math.ceil(BREATH_BUDGET_WORDS / WORDS_PER_BEAT_ESTIMATE)) + POOL_SLACK;
  const postFix = simulate({
    poolSize: postFixPoolSize,
    wordsPerBeatEstimate: WORDS_PER_BEAT_ESTIMATE,
    poolSlack: POOL_SLACK,
    trigger: postFixTrigger,
  });

  await t.test('reproduces the defect: the pre-#353 trigger never fires against a realistic budget', () => {
    assert.equal(
      preFix.reconsultRate,
      0,
      `pre-#353 shape fired in ${(preFix.reconsultRate * 100).toFixed(1)}% of passages, expected 0%`
    );
  });

  await t.test('real passages average close to the ~4.3 beats the issue measured', () => {
    assert.ok(preFix.avgBeats > 3 && preFix.avgBeats < 6, `average beats was ${preFix.avgBeats}, expected roughly 4-5`);
  });

  await t.test('the fix makes the mechanism reachable without making it the norm', () => {
    assert.ok(
      postFix.reconsultRate > 0.05,
      `shipped constants only reconsulted in ${(postFix.reconsultRate * 100).toFixed(1)}% of passages, expected >5%`
    );
    assert.ok(
      postFix.reconsultRate < 0.95,
      `shipped constants reconsulted in ${(postFix.reconsultRate * 100).toFixed(1)}% of passages — that is no longer an occasional check-in`
    );
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
      roundPrompt: 'Discuss.',
      roundSoFarText: 'Crowley\nSome point.',
      member,
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

// #362 — the detector for a passed turn: nothing but the room's existing
// action-line idiom, and nothing else.
test('isPassTurn', async t => {
  await t.test('a bare action line, alone, is a pass', () => {
    assert.equal(isPassTurn('*lets the silence sit.*'), true);
  });

  await t.test('surrounding whitespace does not defeat it', () => {
    assert.equal(isPassTurn('  \n*lets the silence sit.*\n  '), true);
  });

  await t.test('an action followed by real speech is not a pass — the member spoke', () => {
    assert.equal(isPassTurn('*leans back.*\nActually, I have quite a lot to say.'), false);
  });

  await t.test('speech with no action at all is not a pass', () => {
    assert.equal(isPassTurn('I disagree entirely.'), false);
  });

  await t.test('two action lines are not a pass — the format is exactly one, and only one', () => {
    assert.equal(isPassTurn('*shrugs.*\n*looks away.*'), false);
  });

  await t.test('an empty or whitespace-only turn is not a pass — that is a different, undiagnosed case', () => {
    assert.equal(isPassTurn(''), false);
    assert.equal(isPassTurn('   '), false);
  });

  await t.test('a bare asterisk pair with nothing inside is not a pass', () => {
    assert.equal(isPassTurn('**'), false);
    assert.equal(isPassTurn('* *'), false);
  });
});

test('stripInternalBlankLines', async t => {
  await t.test('collapses a blank line so a multi-paragraph turn does not fragment into unattributed bubbles', () => {
    assert.equal(stripInternalBlankLines('First beat.\n\nSecond beat.'), 'First beat.\nSecond beat.');
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
    const line3 = `${words(5)}.`; // starts the next beat
    const beats = splitIntoBeats([line1, line2, line3].join('\n'));
    assert.deepEqual(beats, [`${line1}\n${line2}`, line3]);
  });

  await t.test(
    'a single line with no internal breaks that alone overruns the threshold falls back to sentence boundaries',
    () => {
      const s1 = `${words(20)}.`;
      const s2 = `${words(20)}.`;
      const s3 = `${words(10)}.`;
      const line = `${s1} ${s2} ${s3}`; // one line, 50 words, no \n at all
      const beats = splitIntoBeats(line);
      assert.deepEqual(beats, [`${s1} ${s2}`, s3]);
    }
  );

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
      text.trim().split(/\s+/)
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
  await t.test(
    'hard-truncates the reflection to DISPOSITION_MAX_CHARS regardless of what the model returns',
    async () => {
      const overlong = 'x'.repeat(DISPOSITION_MAX_CHARS + 200);
      const fakeClient = fakeDispositionClient({ reflection: overlong, waitingOnMemberId: 'none' });
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
    const fakeClient = fakeDispositionClient({ reflection: 'Still turning this over.', waitingOnMemberId: 'waite' });
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
    const fakeClient = fakeDispositionClient({ reflection: 'Nothing pending.', waitingOnMemberId: 'none' });
    const { waitingOnMemberId } = await callDispositionUpdate({
      client: fakeClient,
      model: 'test-model',
      system: 'sys',
      userMessage: 'msg',
      presentIds: ['waite'],
    });
    assert.equal(waitingOnMemberId, null);
  });

  await t.test(
    'ignores a target that is not in presentIds — a hallucinated or stale id must not silently pass through',
    async () => {
      const fakeClient = fakeDispositionClient({
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
    const fakeClient = fakeDispositionClient({ reflection: 'Still turning this over.', waitingOnMemberId: 'none' });
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
    const fakeClient = fakeDispositionClient({
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
      const fakeClient = fakeDispositionClient({ reflection: 'ok', waitingOnMemberId: 'none', residueNote: overlong });
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
    const fakeClient = fakeDispositionClient({ reflection: 'Nothing to add.', waitingOnMemberId: 'none' });
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
    const fakeClient = fakeDispositionClient({
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
    const fakeClient = fakeDispositionClient({
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
      const fakeClient = fakeDispositionClient({
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
      const fakeClient = fakeDispositionClient({
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
    const fakeClient = fakeDispositionClient({
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
    const fakeClient = fakeDispositionClient({ reflection: 'ok', waitingOnMemberId: 'none', citations: overlong });
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
    const fakeClient = fakeDispositionClient({
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
      const fakeClient = fakeDispositionClient({ reflection: 'Nothing to add.', waitingOnMemberId: 'none' });
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
    const fakeClient = fakeDispositionClient({
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
    const fakeClient = fakeDispositionClient({
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
    const fakeClient = fakeDispositionClient({ reflection: 'ok', waitingOnMemberId: 'none', invokedWorks: overlong });
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
    const fakeClient = fakeDispositionClient({
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
    assert.deepEqual(schema.input_schema.required, ['reflection', 'waitingOnMemberId']);
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
    assert.match(
      buildVoiceExemplarSection({ ...exemplar, translated: true }),
      /The English here is a translator's, not yours/
    );
  });

  await t.test('trims an over-budget excerpt to the shared budget', () => {
    const section = buildVoiceExemplarSection({ ...exemplar, text: words(VOICE_EXEMPLAR_WORD_BUDGET + 200) });
    assert.match(section, /\[…\]/);
    assert.ok(countWords(section) < VOICE_EXEMPLAR_WORD_BUDGET + 200);
  });

  // #370 wave 2 — a member can now have a secondary, "tone-tuning" entry
  // (a different-genre text) alongside the primary exemplar above.
  const secondaryExemplar = {
    id: 'blake-letter-to-butts-1803',
    title: 'Corporeal Friends Are Spiritual Enemies',
    source: 'The Letters of William Blake',
    date: '1803',
    translated: false,
    text: 'There is no medium or middle state.',
  };

  await t.test('omits the secondary block entirely when there are no secondary entries', () => {
    assert.equal(buildVoiceExemplarSection(exemplar), buildVoiceExemplarSection(exemplar, []));
    assert.doesNotMatch(buildVoiceExemplarSection(exemplar, []), /second page/);
    assert.doesNotMatch(buildVoiceExemplarSection(exemplar, undefined), /second page/);
  });

  await t.test('a member with no primary entry gets nothing, even with secondary entries present', () => {
    // Never fabricate a primary out of a secondary — see loadVoiceExemplar's
    // own contract, unchanged by this addition.
    assert.equal(buildVoiceExemplarSection(null, [secondaryExemplar]), '');
  });

  await t.test('appends the secondary excerpt and its provenance after the primary section', () => {
    const section = buildVoiceExemplarSection(exemplar, [secondaryExemplar]);
    assert.match(section, /Energy is the only life and is from the Body\./);
    assert.match(section, /There is no medium or middle state\./);
    assert.match(section, /Corporeal Friends Are Spiritual Enemies — The Letters of William Blake — 1803/);
    assert.ok(section.indexOf('Energy is the only life') < section.indexOf('There is no medium'));
  });

  await t.test('frames the secondary text as supplementary, not a competing exemplar', () => {
    const section = buildVoiceExemplarSection(exemplar, [secondaryExemplar]);
    assert.match(section, /doesn't replace the passage above/);
    assert.match(section, /Weight it lighter than the passage above/);
  });

  await t.test('trims each secondary excerpt to its own, smaller budget', () => {
    const section = buildVoiceExemplarSection(exemplar, [
      { ...secondaryExemplar, text: words(SECONDARY_VOICE_EXEMPLAR_WORD_BUDGET + 200) },
    ]);
    assert.match(section, /\[…\]/);
    assert.ok(SECONDARY_VOICE_EXEMPLAR_WORD_BUDGET < VOICE_EXEMPLAR_WORD_BUDGET);
  });

  await t.test('adds its own translator caveat, independent of the primary entry', () => {
    const untranslatedPrimary = buildVoiceExemplarSection(exemplar, [{ ...secondaryExemplar, translated: true }]);
    assert.doesNotMatch(untranslatedPrimary.split('second page')[0], /translator's/);
    assert.match(untranslatedPrimary, /The English here is a translator's, not yours/);
  });

  await t.test('renders more than one secondary entry, each with its own provenance', () => {
    const section = buildVoiceExemplarSection(exemplar, [
      secondaryExemplar,
      { ...secondaryExemplar, id: 'other', title: 'Another Page', text: 'A second secondary passage.' },
    ]);
    assert.match(section, /Corporeal Friends Are Spiritual Enemies/);
    assert.match(section, /Another Page/);
    assert.match(section, /A second secondary passage\./);
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
    const section = buildResidueSection("Grew wary of Crowley's charm.");
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

  // #370 wave 2 — secondaryVoiceExemplars wiring, threaded straight through
  // to buildVoiceExemplarSection (see that function's own tests for the
  // rendering behavior).
  await t.test('omitting secondaryVoiceExemplars gets the exact pre-#370-wave-2 prompt', () => {
    const withoutArg = buildSpeakerSystemPrompt({ ...base, voiceExemplar: exemplar });
    assert.equal(
      buildSpeakerSystemPrompt({ ...base, voiceExemplar: exemplar, secondaryVoiceExemplars: [] }),
      withoutArg
    );
    assert.equal(
      buildSpeakerSystemPrompt({ ...base, voiceExemplar: exemplar, secondaryVoiceExemplars: undefined }),
      withoutArg
    );
  });

  await t.test('a member with a secondary entry gets it appended inside the exemplar section', () => {
    const prompt = buildSpeakerSystemPrompt({
      ...base,
      voiceExemplar: exemplar,
      secondaryVoiceExemplars: [
        {
          id: 'blake-letter-to-butts-1803',
          title: 'Corporeal Friends Are Spiritual Enemies',
          source: 'The Letters of William Blake',
          date: '1803',
          translated: false,
          text: 'There is no medium or middle state.',
        },
      ],
    });
    assert.match(prompt, /Energy is Eternal Delight\./);
    assert.match(prompt, /There is no medium or middle state\./);
  });

  await t.test("the exemplar sits after the character file and before tonight's disposition", () => {
    const prompt = buildSpeakerSystemPrompt({
      ...base,
      voiceExemplar: exemplar,
      disposition: { text: 'Irritated by Crowley.', waitingOnMemberId: null },
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
    const prompt = buildSpeakerSystemPrompt({ ...base, residue: "Grew wary of Crowley's charm." });
    assert.match(prompt, /WHAT LINGERS, THOUGH YOU COULDN'T SAY WHY/);
    assert.match(prompt, /Grew wary of Crowley's charm\./);
  });

  await t.test(
    "residue sits after the exemplar and before tonight's disposition — slower-moving evidence in between",
    () => {
      const prompt = buildSpeakerSystemPrompt({
        ...base,
        voiceExemplar: exemplar,
        residue: 'Grew wary of Crowley.',
        disposition: { text: 'Irritated by Crowley.', waitingOnMemberId: null },
      });
      assert.ok(prompt.indexOf('HOW YOU ACTUALLY WRITE') < prompt.indexOf('WHAT LINGERS'));
      assert.ok(prompt.indexOf('WHAT LINGERS') < prompt.indexOf('YOUR PRIVATE STATE TONIGHT'));
    }
  );

  // #268 — relationship-as-data layer wiring.
  await t.test('omitting the present-roster/edges args gets the exact pre-#268 prompt', () => {
    const withoutArg = buildSpeakerSystemPrompt(base);
    assert.equal(
      buildSpeakerSystemPrompt({ ...base, otherPresentMembers: undefined, relationshipEdges: undefined }),
      withoutArg
    );
    assert.doesNotMatch(withoutArg, /OTHERS IN THE ROOM TONIGHT/);
  });

  await t.test("a present member already covered by the file's own prose gets no assembled line", () => {
    const prompt = buildSpeakerSystemPrompt({
      ...base,
      loadMemberFile: () =>
        '# BLAKE\n\n## YOUR RELATIONSHIPS IN THIS ROOM\n\n**Crowley**: You find him vulgar.\n\n## HOW YOU SPEAK\n\nAphoristic.',
      otherPresentMembers: [{ id: 'crowley', name: 'Crowley' }],
      relationshipEdges: [{ source: 'william-blake', target: 'crowley', type: 'parallel', label: 'n/a' }],
    });
    assert.doesNotMatch(prompt, /OTHERS IN THE ROOM TONIGHT/);
  });

  await t.test('a present member the prose is silent on gets the assembled fallback', () => {
    const prompt = buildSpeakerSystemPrompt({
      ...base,
      otherPresentMembers: [{ id: 'sun-ra', name: 'Sun Ra' }],
      relationshipEdges: [{ source: 'william-blake', target: 'sun-ra', type: 'influence', label: 'A cosmic lineage' }],
    });
    assert.match(prompt, /OTHERS IN THE ROOM TONIGHT/);
    assert.match(prompt, /Sun Ra/);
    assert.match(prompt, /A cosmic lineage/);
  });

  await t.test('the assembled section sits inside the member section, ahead of the voice exemplar', () => {
    const prompt = buildSpeakerSystemPrompt({
      ...base,
      voiceExemplar: exemplar,
      otherPresentMembers: [{ id: 'sun-ra', name: 'Sun Ra' }],
      relationshipEdges: [{ source: 'william-blake', target: 'sun-ra', type: 'influence', label: 'A cosmic lineage' }],
    });
    assert.ok(prompt.indexOf('OTHERS IN THE ROOM TONIGHT') < prompt.indexOf('HOW YOU ACTUALLY WRITE'));
  });
});

test('makeMetric — voiceExemplar attribution', async t => {
  await t.test('records the injected entry id on a speaker metric', () => {
    const metric = makeMetric('speaker', {
      round: 0,
      memberId: 'william-blake',
      voiceExemplar: 'blake-voice-of-the-devil-1790',
    });
    assert.equal(metric.voiceExemplar, 'blake-voice-of-the-devil-1790');
  });

  await t.test('is null when no exemplar was injected and on non-speaker phases', () => {
    assert.equal(makeMetric('speaker', { memberId: 'scholem' }).voiceExemplar, null);
    assert.equal(makeMetric('director', { round: 0 }).voiceExemplar, null);
  });

  // #370 wave 2 — same attribution need for secondary "tone-tuning" entries.
  await t.test('records secondary entry ids on a speaker metric', () => {
    const metric = makeMetric('speaker', {
      round: 0,
      memberId: 'william-blake',
      voiceExemplar: 'blake-voice-of-the-devil-1790',
      voiceExemplarSecondary: ['blake-letter-to-butts-1803'],
    });
    assert.deepEqual(metric.voiceExemplarSecondary, ['blake-letter-to-butts-1803']);
  });

  await t.test('is null when there were no secondary entries, not an empty array', () => {
    assert.equal(makeMetric('speaker', { memberId: 'scholem', voiceExemplarSecondary: [] }).voiceExemplarSecondary, null);
    assert.equal(makeMetric('speaker', { memberId: 'scholem' }).voiceExemplarSecondary, null);
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
    const metric = makeMetric('speaker', {
      usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 3200 },
    });
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
      create: async req => {
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
      lodgeContext: LODGE,
      candidates,
      regulars,
      documentText: 'a document about alchemy',
      minCount: 1,
      maxCount: 4,
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
      lodgeContext: LODGE,
      candidates: ROSTER,
      regulars: [],
      documentText: 'a document',
      minCount: 4,
      maxCount: 6,
    });
    assert.match(system, /No one is fixed for tonight/);
    assert.equal(/ALREADY COMING TONIGHT/.test(system), false);
  });

  await t.test('carries the member briefs — names alone are not enough to cast on', () => {
    const { system } = buildCastingPrompt({
      lodgeContext: LODGE,
      candidates: ROSTER,
      regulars: [],
      documentText: 'a document',
      minCount: 4,
      maxCount: 6,
    });
    assert.match(system, /Historian of Jewish mysticism/);
  });

  await t.test('truncates the document rather than paying for a whole book', () => {
    const { system } = buildCastingPrompt({
      lodgeContext: LODGE,
      candidates: ROSTER,
      regulars: [],
      documentText: 'z'.repeat(CASTING_DOCUMENT_LIMIT + 500),
      minCount: 4,
      maxCount: 6,
    });
    assert.equal(new RegExp(`z{${CASTING_DOCUMENT_LIMIT}}[^z]`).test(system + '|'), true);
  });

  await t.test('asks for friction, not coverage', () => {
    const { system } = buildCastingPrompt({
      lodgeContext: LODGE,
      candidates: ROSTER,
      regulars: [],
      documentText: 'a document',
      minCount: 4,
      maxCount: 6,
    });
    assert.match(system, /Cast for friction as much as for affinity/);
    assert.match(system, /Do not choose for coverage, seniority, or roster order/);
  });
});

test('proposeCast', async t => {
  await t.test("returns regulars first, then the model's additions in its own order", async () => {
    const client = fakeCastingClient({ speakers: ['scholem', 'jung'], reasoning: 'Both would dispute it.' });
    const result = await proposeCast({
      client,
      model: 'test-model',
      lodgeContext: LODGE,
      roster: ROSTER,
      regularIds: ['yeats', 'crowley'],
      documentText: 'a document about the Kabbalah',
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
      client,
      model: 'test-model',
      lodgeContext: LODGE,
      roster: ROSTER,
      regularIds: ['crowley', 'yeats', 'blavatsky'],
      documentText: 'a document',
      targetMin: 4,
      targetMax: 5,
    });
    const speakers = client.asked[0].tools[0].input_schema.properties.speakers;
    assert.equal(speakers.maxItems, 2, '5 wanted, 3 already coming');
    assert.equal(speakers.minItems, 1, '4 wanted, 3 already coming');
    assert.deepEqual(speakers.items.enum, ['jung', 'scholem']);
  });

  await t.test('spends no call at all when the regulars already fill the room', async () => {
    const client = fakeCastingClient({ speakers: ['jung'], reasoning: 'r' });
    const result = await proposeCast({
      client,
      model: 'test-model',
      lodgeContext: LODGE,
      roster: ROSTER,
      regularIds: ['crowley', 'yeats', 'blavatsky', 'jung'],
      documentText: 'a document',
      targetMin: 3,
      targetMax: 4,
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
      client,
      model: 'test-model',
      lodgeContext: LODGE,
      roster: ROSTER,
      regularIds: ['crowley', 'yeats', 'blavatsky'],
      documentText: 'a document',
      targetMin: 4,
      targetMax: 4,
    });
    assert.equal(result.cast.length, 4);
  });

  await t.test('retries once on an out-of-range answer, then keeps the valid one', async () => {
    const client = fakeCastingClient(n =>
      n === 1
        ? { speakers: ['jung', 'scholem', 'crowley'], reasoning: 'too many, and one is a regular' }
        : { speakers: ['jung'], reasoning: 'better' }
    );
    const result = await proposeCast({
      client,
      model: 'test-model',
      lodgeContext: LODGE,
      roster: ROSTER,
      regularIds: ['crowley', 'yeats', 'blavatsky'],
      documentText: 'a document',
      targetMin: 4,
      targetMax: 4,
    });
    assert.equal(client.asked.length, 2);
    assert.equal(result.source, 'director-retry');
    assert.deepEqual(result.cast, ['crowley', 'yeats', 'blavatsky', 'jung']);
  });

  await t.test('falls back to a real room rather than nothing when the call fails twice', async () => {
    const client = fakeCastingClient(new Error('the fire is low'));
    const metrics = [];
    const result = await proposeCast({
      client,
      model: 'test-model',
      lodgeContext: LODGE,
      roster: ROSTER,
      regularIds: ['crowley'],
      documentText: 'a document',
      targetMin: 3,
      targetMax: 5,
      onMetric: m => metrics.push(m),
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
      client,
      model: 'test-model',
      lodgeContext: LODGE,
      roster: ROSTER,
      regularIds: ['crowley', 'someone-deleted'],
      documentText: 'a document',
      targetMin: 3,
      targetMax: 3,
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

  await t.test("does not mutate the caller's array or its messages", () => {
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
      create: async req => {
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
      client,
      model: 'test-model',
      system: `${LODGE}\n\n---\n\nround instructions`,
      conversationHistory: [],
      userMessage: 'go',
      presentIds: ['crowley'],
      minCount: 1,
      maxCount: 1,
      lodgeContext: LODGE,
    });
    assert.deepEqual(client.asked[0].system, [
      { type: 'text', text: LODGE, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '\n\n---\n\nround instructions' },
    ]);
  });

  await t.test('caches the tail of a shared conversation history', async () => {
    const client = fakeToolCallClient({ speakers: ['crowley'], reasoning: 'r' });
    const history = [
      { role: 'user', content: 'prior round' },
      { role: 'assistant', content: 'prior text' },
    ];
    await callDirector({
      client,
      model: 'test-model',
      system: LODGE,
      conversationHistory: history,
      userMessage: 'go',
      presentIds: ['crowley'],
      minCount: 1,
      maxCount: 1,
      lodgeContext: LODGE,
    });
    assert.deepEqual(client.asked[0].messages[1], {
      role: 'assistant',
      content: [{ type: 'text', text: 'prior text', cache_control: { type: 'ephemeral' } }],
    });
    assert.deepEqual(history[1], { role: 'assistant', content: 'prior text' }, "the caller's history is untouched");
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
      stream: req => {
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
      client,
      model: 'test-model',
      system: `${LODGE}\n\n---\n\nmember-specific prompt`,
      conversationHistory: [],
      userMessage: 'go',
      lodgeContext: LODGE,
    });
    assert.deepEqual(client.asked[0].system, [
      { type: 'text', text: LODGE, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '\n\n---\n\nmember-specific prompt' },
    ]);
  });

  await t.test('caches the tail of the shared round history', async () => {
    const client = fakeStreamingClient();
    const history = [
      { role: 'user', content: 'prior round' },
      { role: 'assistant', content: 'prior text' },
    ];
    await callSpeakerTurn({
      client,
      model: 'test-model',
      system: LODGE,
      conversationHistory: history,
      userMessage: 'go',
      lodgeContext: LODGE,
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
      create: async req => {
        asked.push(req);
        const toolName = req.tools?.[0]?.name;
        if (toolName === 'select_speakers') {
          const i = Math.min(selectCalls, windingDownOnConsult.length - 1);
          const windingDown = windingDownOnConsult[i];
          selectCalls++;
          return {
            content: [
              {
                type: 'tool_use',
                input: { speakers: ['crowley'], reasoning: 'r', windingDown, lullNote: windingDown ? lullNote : null },
              },
            ],
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
const loadMemberFile = () => "Crowley's character file.";

test('runRound — passage end-causes and beats (#244)', async t => {
  await t.test(
    'ends with endedBy "lull" and the director\'s own note when it judges the room winding down',
    async () => {
      // Single-member pool exhausts deterministically after 2 beats
      // (MAX_TURNS_PER_POOL_MEMBER), forcing exactly one re-consult — which
      // this fake answers with windingDown: true.
      const client = fakePassageClient({
        windingDownOnConsult: [false, true],
        lullNote: 'The fire settles; Yeats refills his glass.',
      });
      const result = await runRound({
        client,
        model: 'test-model',
        lodgeContext: LODGE,
        ROSTER: SINGLE_MEMBER_ROSTER,
        loadMemberFile,
        presentMemberIds: ['crowley'],
        artifact: null,
        notes: {},
        roundPrompt: 'Opening prompt',
        conversationHistory: [],
        speakerCount: 1,
        round: 0,
        disposition: {},
      });
      assert.equal(result.endedBy, 'lull');
      assert.equal(result.lullNote, 'The fire settles; Yeats refills his glass.');
      assert.equal(result.beats.length, 2);
      assert.deepEqual(
        result.beats.map(b => b.memberId),
        ['crowley', 'crowley']
      );
      assert.deepEqual(
        result.beats.map(b => b.text),
        ['A turn.', 'A turn.']
      );
    }
  );

  await t.test('falls back to a stock lull note when the director judges winding down but writes nothing', async () => {
    const client = fakePassageClient({ windingDownOnConsult: [false, true], lullNote: null });
    const result = await runRound({
      client,
      model: 'test-model',
      lodgeContext: LODGE,
      ROSTER: SINGLE_MEMBER_ROSTER,
      loadMemberFile,
      presentMemberIds: ['crowley'],
      artifact: null,
      notes: {},
      roundPrompt: 'Opening prompt',
      conversationHistory: [],
      speakerCount: 1,
      round: 0,
      disposition: {},
    });
    assert.equal(result.endedBy, 'lull');
    assert.ok(STOCK_LULL_NOTES.includes(result.lullNote));
  });

  await t.test(
    'defaults to endedBy "budget" (with a resolved stock lull note) when the director never judges a wind-down',
    async () => {
      const client = fakePassageClient({ windingDownOnConsult: [false] });
      const result = await runRound({
        client,
        model: 'test-model',
        lodgeContext: LODGE,
        ROSTER: SINGLE_MEMBER_ROSTER,
        loadMemberFile,
        presentMemberIds: ['crowley'],
        artifact: null,
        notes: {},
        roundPrompt: 'Opening prompt',
        conversationHistory: [],
        speakerCount: 1,
        round: 0,
        disposition: {},
      });
      // Short fixed speaker turns never spend BREATH_BUDGET_WORDS, so the
      // MAX_TOTAL_BEATS safety net is what actually ends this passage —
      // still 'budget', per runRound's single default for every non-lull exit.
      assert.equal(result.endedBy, 'budget');
      assert.ok(STOCK_LULL_NOTES.includes(result.lullNote));
      assert.ok(result.beats.length > 0);
    }
  );

  await t.test("includes the player's preceding turn as a beat under a stable identity (#354)", async () => {
    const client = fakePassageClient({ windingDownOnConsult: [true] });
    const result = await runRound({
      client,
      model: 'test-model',
      lodgeContext: LODGE,
      ROSTER: SINGLE_MEMBER_ROSTER,
      loadMemberFile,
      presentMemberIds: ['crowley'],
      artifact: null,
      notes: {},
      roundPrompt: 'Opening prompt',
      conversationHistory: [],
      speakerCount: 1,
      round: 0,
      disposition: {},
      // The caller (server.js/lodge-prompts.resolvePlayerSpeakerId) resolves
      // the real memberId before runRound ever sees precedingTurn — here a
      // custom-name player, so the non-roster sentinel.
      precedingTurn: { speakerName: 'A Visitor', memberId: record.PLAYER_SPEAKER_ID, text: 'I have a question.' },
    });
    assert.deepEqual(result.beats[0], {
      memberId: record.PLAYER_SPEAKER_ID,
      speakerName: 'A Visitor',
      text: 'I have a question.',
    });
  });

  await t.test('a precedingTurn with no memberId falls back to the non-roster sentinel, not null (#354)', async () => {
    const client = fakePassageClient({ windingDownOnConsult: [true] });
    const result = await runRound({
      client,
      model: 'test-model',
      lodgeContext: LODGE,
      ROSTER: SINGLE_MEMBER_ROSTER,
      loadMemberFile,
      presentMemberIds: ['crowley'],
      artifact: null,
      notes: {},
      roundPrompt: 'Opening prompt',
      conversationHistory: [],
      speakerCount: 1,
      round: 0,
      disposition: {},
      precedingTurn: { speakerName: 'A Visitor', text: 'I have a question.' },
    });
    assert.equal(result.beats[0].memberId, record.PLAYER_SPEAKER_ID);
  });

  await t.test('records a failed speaker turn as a beat with no text rather than dropping it (#354)', async () => {
    const client = fakePassageClient({ windingDownOnConsult: [false, true] });
    let streamCalls = 0;
    const originalStream = client.messages.stream;
    // withOneRetry makes 2 stream() calls for a beat that fails outright —
    // fail both of the first beat's attempts (calls 1-2), then let every
    // later call (the second beat's single attempt) succeed normally.
    client.messages.stream = req => {
      streamCalls++;
      if (streamCalls <= 2) {
        return {
          [Symbol.asyncIterator]: async function* () {
            throw new Error('network blip');
          },
          finalMessage: async () => {
            throw new Error('network blip');
          },
        };
      }
      return originalStream(req);
    };
    const result = await runRound({
      client,
      model: 'test-model',
      lodgeContext: LODGE,
      ROSTER: SINGLE_MEMBER_ROSTER,
      loadMemberFile,
      presentMemberIds: ['crowley'],
      artifact: null,
      notes: {},
      roundPrompt: 'Opening prompt',
      conversationHistory: [],
      speakerCount: 1,
      round: 0,
      disposition: {},
    });
    // Two beats were attempted (spokenCounts still credits the failed one,
    // triggering the re-consult that ends the passage via lull): the failed
    // attempt first, recorded with no text and a failure marker rather than
    // silently omitted, then the surviving, successful one.
    assert.equal(result.beats.length, 2);
    assert.equal(result.beats[0].memberId, 'crowley');
    assert.equal(result.beats[0].text, '');
    assert.equal(result.beats[0].failed, true);
    assert.ok(result.beats[0].error);
    assert.equal(result.beats[1].text, 'A turn.');
    assert.equal(result.beats[1].failed, undefined);
    // The failed attempt contributed no text to the rolled-up passage either.
    assert.ok(result.fullRoundText.length > 0);
    assert.ok(!result.fullRoundText.includes('undefined'));
  });

  // #362: a member who declines the turn via the room's own action-only
  // idiom is recorded distinctly from both a spoken turn and a failed one.
  await t.test('records a passed turn as a distinct beat, not a failure, and keeps it in the transcript', async () => {
    const client = fakePassageClient({ speakerText: '*lets the silence sit.*', windingDownOnConsult: [false] });
    const result = await runRound({
      client,
      model: 'test-model',
      lodgeContext: LODGE,
      ROSTER: SINGLE_MEMBER_ROSTER,
      loadMemberFile,
      presentMemberIds: ['crowley'],
      artifact: null,
      notes: {},
      roundPrompt: 'Opening prompt',
      conversationHistory: [],
      speakerCount: 1,
      round: 0,
      disposition: {},
    });
    assert.equal(result.beats[0].memberId, 'crowley');
    assert.equal(result.beats[0].text, '*lets the silence sit.*');
    assert.equal(result.beats[0].passed, true);
    assert.equal(result.beats[0].failed, undefined);
    // Still a real beat in the rolled-up passage — a pass is not a gap.
    assert.match(result.fullRoundText, /lets the silence sit/);
  });

  await t.test('a turn with an action and real speech is not treated as a pass (#362)', async () => {
    const client = fakePassageClient({
      speakerText: '*leans forward.*\nI have a great deal to say about this.',
      windingDownOnConsult: [false],
    });
    const result = await runRound({
      client,
      model: 'test-model',
      lodgeContext: LODGE,
      ROSTER: SINGLE_MEMBER_ROSTER,
      loadMemberFile,
      presentMemberIds: ['crowley'],
      artifact: null,
      notes: {},
      roundPrompt: 'Opening prompt',
      conversationHistory: [],
      speakerCount: 1,
      round: 0,
      disposition: {},
    });
    assert.equal(result.beats[0].passed, undefined);
  });
});

// #355 — always-on citation capture, piggybacked on the same disposition
// call runRound already makes after every successful beat. A dedicated fake
// client (rather than fakePassageClient) so the disposition tool_use input
// is configurable per test.
function fakeCitationPassageClient({ dispositionInput }) {
  return {
    messages: {
      create: async req => {
        const toolName = req.tools?.[0]?.name;
        if (toolName === 'select_speakers') {
          return {
            content: [
              { type: 'tool_use', input: { speakers: ['crowley'], reasoning: 'r', windingDown: true, lullNote: null } },
            ],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        }
        return {
          content: [{ type: 'tool_use', input: dispositionInput }],
          usage: { input_tokens: 8, output_tokens: 4 },
        };
      },
      stream: () => ({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'A turn.' } };
        },
        finalMessage: async () => ({ usage: { input_tokens: 20, output_tokens: 10 } }),
      }),
    },
  };
}

test('runRound — citation capture piggybacked on the disposition call (#355)', async t => {
  const baseArgs = {
    model: 'test-model',
    lodgeContext: LODGE,
    ROSTER: SINGLE_MEMBER_ROSTER,
    loadMemberFile,
    presentMemberIds: ['crowley'],
    artifact: null,
    notes: {},
    roundPrompt: 'Opening prompt',
    conversationHistory: [],
    speakerCount: 1,
    round: 0,
    disposition: {},
  };

  await t.test('attaches citations from the disposition call onto the beat that earned them', async () => {
    const client = fakeCitationPassageClient({
      dispositionInput: {
        reflection: 'Considering.',
        waitingOnMemberId: 'none',
        citations: [{ quote: 'a real quote', work: 'The Book of the Law', verdict: 'verified', note: 'It exists.' }],
      },
    });
    const result = await runRound({ ...baseArgs, client });
    assert.equal(result.beats[0].citations.length, 1);
    assert.equal(result.beats[0].citations[0].work, 'The Book of the Law');
  });

  await t.test('omits `citations` entirely from a beat that cited nothing — the common case', async () => {
    const client = fakeCitationPassageClient({
      dispositionInput: { reflection: 'Considering.', waitingOnMemberId: 'none' },
    });
    const result = await runRound({ ...baseArgs, client });
    assert.equal('citations' in result.beats[0], false);
  });

  await t.test(
    'validates a returned libraryMatch against loadLibraryCitationLookup, keeping a real match',
    async () => {
      const client = fakeCitationPassageClient({
        dispositionInput: {
          reflection: 'Considering.',
          waitingOnMemberId: 'none',
          citations: [{ quote: 'q', work: 'W', verdict: 'verified', note: 'n', libraryMatch: 'crowley-book' }],
        },
      });
      const result = await runRound({
        ...baseArgs,
        client,
        loadLibraryCitationLookup: () => ({ 'crowley-book': { title: 'The Book of the Law', source: '1904' } }),
      });
      assert.equal(result.beats[0].citations[0].libraryMatch, 'crowley-book');
    }
  );

  await t.test('nulls out a libraryMatch the injected library does not actually have', async () => {
    const client = fakeCitationPassageClient({
      dispositionInput: {
        reflection: 'Considering.',
        waitingOnMemberId: 'none',
        citations: [{ quote: 'q', work: 'W', verdict: 'verified', note: 'n', libraryMatch: 'not-a-real-entry' }],
      },
    });
    const result = await runRound({
      ...baseArgs,
      client,
      loadLibraryCitationLookup: () => ({ 'crowley-book': { title: 'The Book of the Law', source: '1904' } }),
    });
    assert.equal(result.beats[0].citations[0].libraryMatch, null);
  });

  await t.test(
    'degrades to no library context (never throws) when loadLibraryCitationLookup is not given',
    async () => {
      const client = fakeCitationPassageClient({
        dispositionInput: {
          reflection: 'Considering.',
          waitingOnMemberId: 'none',
          citations: [{ quote: 'q', work: 'W', verdict: 'verified', note: 'n' }],
        },
      });
      const result = await runRound({ ...baseArgs, client });
      assert.equal(result.beats[0].citations.length, 1);
    }
  );

  await t.test('degrades to no library context when loadLibraryCitationLookup itself throws', async () => {
    const client = fakeCitationPassageClient({
      dispositionInput: {
        reflection: 'Considering.',
        waitingOnMemberId: 'none',
        citations: [{ quote: 'q', work: 'W', verdict: 'verified', note: 'n', libraryMatch: 'crowley-book' }],
      },
    });
    const result = await runRound({
      ...baseArgs,
      client,
      loadLibraryCitationLookup: () => {
        throw new Error('library.json missing');
      },
    });
    assert.equal(result.beats[0].citations[0].libraryMatch, null);
  });

  // #356 — the weaker invoked-works tier, piggybacked on the same call.
  await t.test('attaches invokedWorks from the disposition call onto the beat that earned them', async () => {
    const client = fakeCitationPassageClient({
      dispositionInput: {
        reflection: 'Considering.',
        waitingOnMemberId: 'none',
        invokedWorks: [{ work: "Corbin's reading of Ibn Arabi", note: 'named in passing' }],
      },
    });
    const result = await runRound({ ...baseArgs, client });
    assert.equal(result.beats[0].invokedWorks.length, 1);
    assert.equal(result.beats[0].invokedWorks[0].work, "Corbin's reading of Ibn Arabi");
  });

  await t.test('omits `invokedWorks` entirely from a beat that invoked nothing — the common case', async () => {
    const client = fakeCitationPassageClient({
      dispositionInput: { reflection: 'Considering.', waitingOnMemberId: 'none' },
    });
    const result = await runRound({ ...baseArgs, client });
    assert.equal('invokedWorks' in result.beats[0], false);
  });
});
