'use strict';

// #141 first cut — turn distribution, beats/endedBy, and the replayable
// pickNextSpeaker simulation. Same read-and-aggregate test shape as
// rollup-metrics.test.js/build-citation-manifest.test.js: exercise the pure
// functions with fixture data, not the CLI/fs bits.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  turnDistributionForSession,
  aggregateTurnDistribution,
  passageStatsForSession,
  aggregatePassageStats,
  seededRng,
  simulatePassage,
  simulateMeetings,
  buildReport,
} = require('../scripts/eval-harness.js');

function beat(memberId, overrides = {}) {
  return { memberId, text: 'something', ...overrides };
}

test('turnDistributionForSession', async t => {
  await t.test('reduces beats into a ledger and flags seated members with zero turns', () => {
    const session = {
      members: ['crowley', 'yeats', 'blavatsky'],
      rounds: [{ beats: [beat('crowley'), beat('crowley'), beat('yeats')] }],
    };
    const { ledger, zeroTurnIds } = turnDistributionForSession(session);
    assert.equal(ledger.crowley, 2);
    assert.equal(ledger.yeats, 1);
    assert.deepEqual(zeroTurnIds, ['blavatsky']);
  });

  await t.test('a member never in the pool at all is still flagged zero, not silently absent', () => {
    const session = { members: ['crowley', 'waite'], rounds: [] };
    const { zeroTurnIds } = turnDistributionForSession(session);
    assert.deepEqual(zeroTurnIds, ['crowley', 'waite']);
  });

  await t.test('missing session.members degrades to no present ids rather than throwing', () => {
    const { presentIds, zeroTurnIds } = turnDistributionForSession({ rounds: [] });
    assert.deepEqual(presentIds, []);
    assert.deepEqual(zeroTurnIds, []);
  });
});

test('aggregateTurnDistribution', async t => {
  await t.test('sums seated-meetings and zero-turn-meetings per member across sessions', () => {
    const sessions = [
      { members: ['crowley', 'yeats'], rounds: [{ beats: [beat('crowley')] }] },
      { members: ['crowley', 'yeats'], rounds: [{ beats: [beat('crowley'), beat('yeats')] }] },
    ];
    const data = aggregateTurnDistribution(sessions);
    assert.equal(data.meetingsScanned, 2);
    const crowley = data.perMember.find(r => r.memberId === 'crowley');
    const yeats = data.perMember.find(r => r.memberId === 'yeats');
    assert.equal(crowley.turns, 2);
    assert.equal(crowley.zeroTurnMeetings, 0);
    assert.equal(yeats.turns, 1);
    assert.equal(yeats.zeroTurnMeetings, 1);
  });

  await t.test('a session with no seated roster or no rounds is scanned but contributes nothing', () => {
    const sessions = [
      { members: [], rounds: [{ beats: [beat('crowley')] }] },
      { members: ['crowley'], rounds: [] },
    ];
    const data = aggregateTurnDistribution(sessions);
    assert.equal(data.meetingsScanned, 0);
    assert.equal(data.perMember.length, 0);
  });

  await t.test('ranks the highest zero-turn-share member first', () => {
    const sessions = [
      { members: ['crowley', 'waite'], rounds: [{ beats: [beat('crowley')] }] },
      { members: ['crowley', 'waite'], rounds: [{ beats: [beat('crowley')] }] },
    ];
    const data = aggregateTurnDistribution(sessions);
    assert.equal(data.perMember[0].memberId, 'waite');
    assert.equal(data.perMember[0].zeroTurnShare, 1);
  });
});

test('passageStatsForSession', async t => {
  await t.test('reads beats length and endedBy off each passage', () => {
    const session = {
      rounds: [
        { beats: [beat('crowley'), beat('yeats')], endedBy: 'budget' },
        { beats: [beat('crowley')], endedBy: 'lull' },
      ],
    };
    const stats = passageStatsForSession(session);
    assert.deepEqual(
      stats.map(s => [s.kind, s.beats, s.endedBy]),
      [
        ['passage', 2, 'budget'],
        ['passage', 1, 'lull'],
      ]
    );
  });

  await t.test('a pre-#244 segment with no beats field reports beats: null, not zero', () => {
    const session = { rounds: [{ endedBy: 'lull' }] };
    assert.equal(passageStatsForSession(session)[0].beats, null);
  });

  await t.test('an interjection segment is tagged separately from a passage', () => {
    const session = {
      rounds: [{ kind: 'interjection', beats: [beat('presence:interjection')], endedBy: 'budget' }],
    };
    assert.equal(passageStatsForSession(session)[0].kind, 'interjection');
  });
});

test('aggregatePassageStats', async t => {
  await t.test('averages beats and breaks down endedBy across scanned passages', () => {
    const sessions = [
      { rounds: [{ beats: [beat('a'), beat('b')], endedBy: 'budget' }] },
      { rounds: [{ beats: [beat('a'), beat('b'), beat('c'), beat('d')], endedBy: 'lull' }] },
    ];
    const data = aggregatePassageStats(sessions);
    assert.equal(data.passagesScanned, 2);
    assert.equal(data.avgBeatsPerPassage, 3);
    assert.deepEqual(data.endedByCounts, { budget: 1, lull: 1 });
    assert.equal(data.endedByShare.budget, 0.5);
  });

  await t.test('excludes interjection segments and beats-less segments from the average', () => {
    const sessions = [
      {
        rounds: [
          { beats: [beat('a'), beat('b')], endedBy: 'budget' },
          { kind: 'interjection', beats: [beat('presence:interjection')], endedBy: 'budget' },
          { endedBy: 'lull' }, // pre-#244, no beats
        ],
      },
    ];
    const data = aggregatePassageStats(sessions);
    assert.equal(data.passagesScanned, 1);
    assert.equal(data.avgBeatsPerPassage, 2);
  });
});

test('seededRng', async t => {
  await t.test('is deterministic given the same seed', () => {
    const a = seededRng(42);
    const b = seededRng(42);
    const sequenceA = Array.from({ length: 5 }, () => a());
    const sequenceB = Array.from({ length: 5 }, () => b());
    assert.deepEqual(sequenceA, sequenceB);
  });

  await t.test('produces values in [0, 1)', () => {
    const rng = seededRng(7);
    for (let i = 0; i < 100; i++) {
      const v = rng();
      assert.ok(v >= 0 && v < 1, `value ${v} out of range`);
    }
  });
});

// The real pickNextSpeaker/isPoolExhausted, imported directly from
// src/pipeline-speaker.js by scripts/eval-harness.js — this is the
// #352/#353-style guarantee that the simulation can't drift from the
// pipeline's actual behavior, only from tuning.js's current constants.
test('simulatePassage', async t => {
  await t.test('is deterministic for a given seed', () => {
    const seatIds = ['m0', 'm1', 'm2', 'm3', 'm4'];
    const a = simulatePassage({ seatIds, meetingTurns: {}, rng: seededRng(20260825) });
    const b = simulatePassage({ seatIds, meetingTurns: {}, rng: seededRng(20260825) });
    assert.deepEqual(
      a.beats.map(b2 => b2.memberId),
      b.beats.map(b2 => b2.memberId)
    );
  });

  await t.test('stays within the passage safety net and only ever picks from the given seats', () => {
    const seatIds = ['m0', 'm1', 'm2'];
    const result = simulatePassage({ seatIds, meetingTurns: {}, rng: seededRng(1) });
    assert.ok(result.beats.length > 0);
    assert.ok(result.beats.length <= 16); // MAX_TOTAL_BEATS
    result.beats.forEach(b2 => assert.ok(seatIds.includes(b2.memberId)));
  });
});

// Pins the current shape of the distribution, the same spirit as #352's
// "whole-meeting turn distribution" pipeline.test.js suite, but at the
// harness level rather than as a one-off inline test — a future tuning.js
// edit that meaningfully widens the gradient again should move this.
test('simulateMeetings', async t => {
  await t.test('is deterministic for a given seed', () => {
    const a = simulateMeetings({ meetings: 50, seed: 999 });
    const b = simulateMeetings({ meetings: 50, seed: 999 });
    assert.deepEqual(a, b);
  });

  await t.test('produces a monotonic-ish gradient by priority rank, with the current ledger keeping it narrow', () => {
    const data = simulateMeetings({ meetings: 3000, seed: 20260825 });
    assert.ok(
      data.perSeat[0].avgTurns > data.perSeat[data.perSeat.length - 1].avgTurns,
      'top rank should outdraw bottom rank'
    );
    // #352 shipped specifically to keep this small — a regression here would
    // mean the under-heard boost stopped doing its job.
    assert.ok(data.zeroTurnShare < 0.05, `zero-turn share was ${data.zeroTurnShare}, expected <5%`);
  });

  await t.test('the mid-passage re-consult is reachable but not the norm, per #353', () => {
    const data = simulateMeetings({ meetings: 3000, seed: 20260825 });
    assert.ok(data.reconsultRate > 0.05 && data.reconsultRate < 0.95, `reconsult rate was ${data.reconsultRate}`);
  });

  await t.test('a custom rankPool hook is honored', () => {
    // A director that always reverses priority order should flip which seat
    // ends up on top — proof the hook actually reaches pickNextSpeaker's
    // priority-rank weighting, not just relabeling the same result.
    const forward = simulateMeetings({ meetings: 1500, seed: 5, seatCount: 5, passagesPerMeeting: 3 });
    const reversed = simulateMeetings({
      meetings: 1500,
      seed: 5,
      seatCount: 5,
      passagesPerMeeting: 3,
      rankPool: (ids, count) => ids.slice().reverse().slice(0, count),
    });
    assert.ok(forward.perSeat[0].avgTurns > forward.perSeat[4].avgTurns);
    assert.ok(reversed.perSeat[4].avgTurns > reversed.perSeat[0].avgTurns);
  });
});

test('buildReport', async t => {
  await t.test('renders all three sections', () => {
    const turnData = aggregateTurnDistribution([{ members: ['crowley'], rounds: [{ beats: [beat('crowley')] }] }]);
    const passageData = aggregatePassageStats([{ rounds: [{ beats: [beat('crowley')], endedBy: 'budget' }] }]);
    const simData = simulateMeetings({ meetings: 20 });
    const report = buildReport({ sessions: [{}], turnData, passageData, simData, rosterNames: new Map() });
    assert.match(report, /## 1\. Turn distribution per meeting/);
    assert.match(report, /## 2\. Beats per passage/);
    assert.match(report, /## 3\. Replayable pickNextSpeaker simulation/);
  });

  await t.test('falls back to raw ids when no roster name is known', () => {
    const turnData = aggregateTurnDistribution([{ members: ['some-unknown-id'], rounds: [{ beats: [] }] }]);
    const passageData = aggregatePassageStats([]);
    const simData = simulateMeetings({ meetings: 5 });
    const report = buildReport({ sessions: [{}], turnData, passageData, simData, rosterNames: new Map() });
    assert.match(report, /some-unknown-id/);
  });

  await t.test('says so plainly when no real sessions have usable data', () => {
    const turnData = aggregateTurnDistribution([]);
    const passageData = aggregatePassageStats([]);
    const simData = simulateMeetings({ meetings: 5 });
    const report = buildReport({ sessions: [], turnData, passageData, simData, rosterNames: new Map() });
    assert.match(report, /No sessions with both a seated roster/);
    assert.match(report, /No passages with a recorded/);
  });
});
