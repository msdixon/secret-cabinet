'use strict';

// #409 — cross-session cost/metrics rollup, same read-and-aggregate shape as
// build-citation-manifest.js. Covers the aggregation logic (rollup) and the
// two staleness caveats (#225 phase coverage, #190 cache_read_input_tokens)
// it's specifically meant to surface, per docs/MODEL-REVIEW.md Step 1.

const test = require('node:test');
const assert = require('node:assert/strict');

const { rollup, buildReport } = require('../scripts/rollup-metrics.js');

function metric(phase, overrides = {}) {
  return {
    phase,
    round: null,
    memberId: null,
    attempts: 1,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 },
    latencyMs: 500,
    skipped: false,
    ...overrides,
  };
}

test('rollup', async t => {
  await t.test('sums tokens/calls across every session and phase', () => {
    const sessions = [
      { id: 's1', date: '2026-08-01', generationMetrics: [metric('director'), metric('speaker')] },
      { id: 's2', date: '2026-08-02', generationMetrics: [metric('speaker')] },
    ];
    const data = rollup(sessions);
    assert.equal(data.overall.calls, 3);
    assert.equal(data.overall.input, 300);
    assert.equal(data.sessionsScanned, 2);
    assert.equal(data.sessionsWithMetrics, 2);
  });

  await t.test('a session with no generationMetrics is scanned but does not contribute totals', () => {
    const sessions = [
      { id: 's1', date: '2026-08-01', generationMetrics: [] },
      { id: 's2', date: '2026-08-02' },
    ];
    const data = rollup(sessions);
    assert.equal(data.sessionsScanned, 2);
    assert.equal(data.sessionsWithMetrics, 0);
    assert.equal(data.overall.calls, 0);
  });

  await t.test('groups by phase, keeping totals separate per phase', () => {
    const sessions = [
      {
        id: 's1',
        date: '2026-08-01',
        generationMetrics: [metric('director', { usage: { input_tokens: 10, output_tokens: 1 } }), metric('speaker')],
      },
    ];
    const data = rollup(sessions);
    const director = data.byPhase.find(p => p.phase === 'director');
    const speaker = data.byPhase.find(p => p.phase === 'speaker');
    assert.equal(director.input, 10);
    assert.equal(speaker.input, 100);
  });

  await t.test('groups by date, summing same-day sessions together', () => {
    const sessions = [
      { id: 's1', date: '2026-08-01', generationMetrics: [metric('speaker')] },
      { id: 's2', date: '2026-08-01', generationMetrics: [metric('speaker')] },
      { id: 's3', date: '2026-08-02', generationMetrics: [metric('speaker')] },
    ];
    const data = rollup(sessions);
    const day1 = data.byDate.find(d => d.date === '2026-08-01');
    const day2 = data.byDate.find(d => d.date === '2026-08-02');
    assert.equal(day1.calls, 2);
    assert.equal(day2.calls, 1);
    assert.deepEqual(
      data.byDate.map(d => d.date),
      ['2026-08-01', '2026-08-02']
    );
  });

  await t.test('counts skipped calls and averages latency, ignoring entries with no latencyMs', () => {
    const sessions = [
      {
        id: 's1',
        date: '2026-08-01',
        generationMetrics: [
          metric('director', { skipped: true, latencyMs: null }),
          metric('director', { latencyMs: 300 }),
          metric('director', { latencyMs: 500 }),
        ],
      },
    ];
    const data = rollup(sessions);
    assert.equal(data.overall.skipped, 1);
    assert.equal(data.overall.latencySum, 800);
    assert.equal(data.overall.latencyCount, 2);
  });

  await t.test('flags a session missing casting/citation phases as possibly predating #225', () => {
    const sessions = [{ id: 's1', date: '2026-08-01', generationMetrics: [metric('director'), metric('speaker')] }];
    assert.equal(rollup(sessions).oldestPre225, true);
  });

  await t.test('a session with a casting or citation phase is not flagged as pre-#225', () => {
    const sessions = [{ id: 's1', date: '2026-08-01', generationMetrics: [metric('director'), metric('casting')] }];
    assert.equal(rollup(sessions).oldestPre225, false);
  });

  await t.test('flags a session with no cache_read_input_tokens anywhere as possibly predating #190', () => {
    const sessions = [
      {
        id: 's1',
        date: '2026-08-01',
        generationMetrics: [metric('speaker', { usage: { input_tokens: 1, output_tokens: 1 } })],
      },
    ];
    assert.equal(rollup(sessions).oldestPre190, true);
  });

  await t.test('a session with a real cache_read_input_tokens value is not flagged as pre-#190', () => {
    const sessions = [{ id: 's1', date: '2026-08-01', generationMetrics: [metric('speaker')] }];
    assert.equal(rollup(sessions).oldestPre190, false);
  });
});

test('buildReport', async t => {
  await t.test('renders total cost, a per-phase table, and a per-date table', () => {
    const sessions = [{ id: 's1', date: '2026-08-01', generationMetrics: [metric('speaker')] }];
    const report = buildReport(rollup(sessions));
    assert.match(report, /Total estimated cost/);
    assert.match(report, /## By phase/);
    assert.match(report, /## By date/);
    assert.match(report, /2026-08-01/);
  });

  await t.test('surfaces the #225/#190 staleness caveat only when a scanned session actually predates them', () => {
    const stale = buildReport(rollup([{ id: 's1', date: '2026-08-01', generationMetrics: [metric('director')] }]));
    assert.match(stale, /predate/);

    const fresh = buildReport(
      rollup([{ id: 's1', date: '2026-08-01', generationMetrics: [metric('director'), metric('casting')] }])
    );
    assert.doesNotMatch(fresh, /predate/);
  });

  await t.test('notes the per-model pricing limitation rather than silently pricing every session the same', () => {
    const report = buildReport(rollup([{ id: 's1', date: '2026-08-01', generationMetrics: [metric('speaker')] }]));
    assert.match(report, /can't break totals out by model/);
  });
});
