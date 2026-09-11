'use strict';

// #542 phase 2 — advisory observed-vs-static length-tendency report. Covers
// the beat-filtering rules (passed/failed/playerAuthored excluded), the
// MIN_SAMPLE_TURNS gate, and the quartile comparison against
// LENGTH_TENDENCY_OVERRIDES. Uses synthetic fixture sessions throughout —
// sessions/ is gitignored and real session data never lives in the repo.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collectObservedTurns,
  buildReport,
  MIN_SAMPLE_TURNS,
} = require('../scripts/report-observed-length-tendency.js');

function beat(memberId, wordCount, overrides = {}) {
  return { memberId, text: Array(wordCount).fill('word').join(' '), ...overrides };
}

function session(rounds) {
  return { id: 's', date: '2026-09-10', rounds };
}

test('collectObservedTurns', async t => {
  await t.test('sums words and counts turns per member across rounds and sessions', () => {
    const sessions = [
      session([{ beats: [beat('crowley', 10), beat('crowley', 20)] }]),
      session([{ beats: [beat('crowley', 30)] }]),
    ];
    const { perMember } = collectObservedTurns(sessions);
    assert.deepEqual(perMember.get('crowley'), { turns: 3, words: 60 });
  });

  await t.test('excludes passed beats from the length signal', () => {
    const sessions = [session([{ beats: [beat('crowley', 10), beat('crowley', 999, { passed: true })] }])];
    const { perMember } = collectObservedTurns(sessions);
    assert.deepEqual(perMember.get('crowley'), { turns: 1, words: 10 });
  });

  await t.test('excludes failed beats', () => {
    const sessions = [
      session([{ beats: [beat('crowley', 10), { memberId: 'crowley', text: '', failed: true, error: 'x' }] }]),
    ];
    const { perMember } = collectObservedTurns(sessions);
    assert.deepEqual(perMember.get('crowley'), { turns: 1, words: 10 });
  });

  await t.test('excludes player-authored beats', () => {
    const sessions = [session([{ beats: [beat('crowley', 10), beat('crowley', 999, { playerAuthored: true })] }])];
    const { perMember } = collectObservedTurns(sessions);
    assert.deepEqual(perMember.get('crowley'), { turns: 1, words: 10 });
  });

  await t.test('a session with no beats at all is scanned but contributes nothing', () => {
    const sessions = [session([{ label: 'l', text: 't' }])];
    const { perMember, sessionsScanned, sessionsWithBeats } = collectObservedTurns(sessions);
    assert.equal(perMember.size, 0);
    assert.equal(sessionsScanned, 1);
    assert.equal(sessionsWithBeats, 0);
  });
});

test('buildReport', async t => {
  await t.test('omits a member below MIN_SAMPLE_TURNS as insufficient data', () => {
    const beats = [];
    for (let i = 0; i < MIN_SAMPLE_TURNS - 1; i++) beats.push(beat('crowley', 5));
    const data = collectObservedTurns([session([{ beats }])]);
    const report = buildReport(data);
    assert.equal(report.rows.length, 0);
    assert.equal(report.insufficientCount, 1);
  });

  await t.test('includes a member at or above MIN_SAMPLE_TURNS', () => {
    const beats = [];
    for (let i = 0; i < MIN_SAMPLE_TURNS; i++) beats.push(beat('crowley', 5));
    const data = collectObservedTurns([session([{ beats }])]);
    const report = buildReport(data);
    assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0].memberId, 'crowley');
    assert.equal(report.rows[0].turns, MIN_SAMPLE_TURNS);
  });

  await t.test('flags a mismatch between observed bucket and the static tuning.js override', () => {
    // crowley is 'terse' in LENGTH_TENDENCY_OVERRIDES (src/tuning.js). Give
    // it the longest average among three qualifying members so it lands in
    // the top quartile ('expansive') — a deliberate mismatch.
    const makeBeats = words => {
      const beats = [];
      for (let i = 0; i < MIN_SAMPLE_TURNS; i++) beats.push(beat('x', words));
      return beats;
    };
    const sessions = [
      session([{ beats: makeBeats(5).map(b => ({ ...b, memberId: 'al-hallaj' })) }]), // also 'terse'
      session([{ beats: makeBeats(10).map(b => ({ ...b, memberId: 'sun-ra' })) }]), // 'expansive'
      session([{ beats: makeBeats(50).map(b => ({ ...b, memberId: 'crowley' })) }]), // 'terse', now observed-expansive
    ];
    const data = collectObservedTurns(sessions);
    const report = buildReport(data);
    const crowleyRow = report.rows.find(r => r.memberId === 'crowley');
    assert.equal(crowleyRow.current, 'terse');
    assert.equal(crowleyRow.observed, 'expansive');
    assert.equal(crowleyRow.match, false);
  });

  await t.test('a member with no static override defaults to medium via lengthTendencyOf fallback', () => {
    const beats = [];
    for (let i = 0; i < MIN_SAMPLE_TURNS; i++) beats.push(beat('nobody-in-particular', 10));
    const data = collectObservedTurns([session([{ beats }])]);
    const report = buildReport(data);
    assert.equal(report.rows[0].current, 'medium');
  });
});
