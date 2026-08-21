'use strict';

// #355 — scripts/build-citation-manifest.js used to filter to
// `sessions.filter(s => Array.isArray(s.citationFlags))`, so the cumulative
// manifest only ever covered sessions someone remembered to run through
// Verify Citations (1 of 11 local sessions, at the review that filed the
// issue). Citations are now captured always-on, per beat, at write time —
// buildManifest reads a session's grounded `citationFlags` when present, and
// falls back to flattening the raw always-on capture off its beats
// otherwise, so every session with beats contributes something. No test
// coverage existed for this script before this change.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildManifest } = require('../scripts/build-citation-manifest.js');

const roster = [{ id: 'crowley', name: 'Crowley' }];

function sessionWithBeatCitations(id, citations) {
  return {
    id,
    date: '2026-08-20',
    rounds: [{ beats: [{ memberId: 'crowley', text: 'a turn', citations }] }],
  };
}

test('buildManifest', async t => {
  await t.test('a session with no citationFlags falls back to its always-on beat citations', () => {
    const session = sessionWithBeatCitations('s1', [
      { quote: 'a quote', work: 'The Book of the Law', verdict: 'verified', note: 'n' },
    ]);
    const manifest = buildManifest([session], roster);
    assert.match(manifest, /The Book of the Law/);
    assert.match(manifest, /Crowley/);
  });

  await t.test('a fallback citation with no explicit source is labeled "ungrounded", not "model-knowledge"', () => {
    const session = sessionWithBeatCitations('s1', [
      { quote: 'q', work: 'A Work', verdict: 'uncertain', note: 'n' },
    ]);
    const manifest = buildManifest([session], roster);
    assert.match(manifest, /captured at write time — not yet run through Verify Citations/);
  });

  await t.test('a grounded citationFlags entry keeps its own explicit source label', () => {
    const session = {
      id: 's1',
      date: '2026-08-20',
      citationFlags: [{ speaker: 'Crowley', quote: 'q', work: 'A Work', verdict: 'verified', note: 'n', source: 'library' }],
    };
    const manifest = buildManifest([session], roster);
    assert.match(manifest, /checked against curated text/);
    assert.doesNotMatch(manifest, /captured at write time/);
  });

  await t.test('citationFlags takes priority over beat citations when both are present', () => {
    const session = {
      ...sessionWithBeatCitations('s1', [{ quote: 'raw', work: 'Raw-Only Work', verdict: 'uncertain', note: 'n' }]),
      citationFlags: [
        { speaker: 'Crowley', quote: 'grounded', work: 'Grounded Work', verdict: 'verified', note: 'n', source: 'web' },
      ],
    };
    const manifest = buildManifest([session], roster);
    assert.match(manifest, /Grounded Work/);
    assert.doesNotMatch(manifest, /Raw-Only Work/);
  });

  await t.test('a session with no captured citations at all is counted but not rendered as a work', () => {
    const session = { id: 's1', date: '2026-08-20', rounds: [{ beats: [{ memberId: 'crowley', text: 'nothing cited' }] }] };
    const manifest = buildManifest([session], roster);
    assert.match(manifest, /1 session\(s\) on disk cite nothing/);
  });

  await t.test('the summary line counts captured-vs-grounded sessions separately', () => {
    const captured = sessionWithBeatCitations('s1', [{ quote: 'q', work: 'W1', verdict: 'verified', note: 'n' }]);
    const grounded = {
      id: 's2',
      date: '2026-08-20',
      citationFlags: [{ speaker: 'Crowley', quote: 'q2', work: 'W2', verdict: 'verified', note: 'n', source: 'library' }],
    };
    const manifest = buildManifest([captured, grounded], roster);
    assert.match(manifest, /Generated from 2 session\(s\) on disk, 2 with captured citations\. 1 have been run through Verify Citations' grounding pass\./);
  });

  await t.test('still groups by normalized work and sorts unverified/uncertain into "Needs review"', () => {
    const session = sessionWithBeatCitations('s1', [
      { quote: 'q1', work: 'A Suspicious Work', verdict: 'unverified', note: 'Looks invented.' },
      { quote: 'q2', work: 'A Solid Work', verdict: 'verified', note: 'Checks out.' },
    ]);
    const manifest = buildManifest([session], roster);
    const reviewIdx = manifest.indexOf('⚠ Needs review');
    const verifiedIdx = manifest.indexOf('✓ Verified');
    assert.ok(reviewIdx >= 0 && verifiedIdx >= 0);
    assert.ok(manifest.indexOf('A Suspicious Work') > reviewIdx && manifest.indexOf('A Suspicious Work') < verifiedIdx);
    assert.ok(manifest.indexOf('A Solid Work') > verifiedIdx);
  });

  await t.test('produces the no-citations message when nothing has been captured anywhere', () => {
    const manifest = buildManifest([{ id: 's1', date: '2026-08-20', rounds: [] }], roster);
    assert.match(manifest, /No citations found yet/);
  });

  await t.test('defaults roster to an empty array so a beat citation still renders under its raw memberId', () => {
    const session = sessionWithBeatCitations('s1', [{ quote: 'q', work: 'W', verdict: 'verified', note: 'n' }]);
    const manifest = buildManifest([session]);
    assert.match(manifest, /crowley/);
  });
});
