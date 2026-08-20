'use strict';

// #354 — record.js: the record's shared vocabulary. Pure functions and
// constants, no I/O — same testing shape as beats.js's own test/pipeline.test.js
// coverage (record.js is required the same dual Node/browser way; see its
// own top-of-file comment).

const test = require('node:test');
const assert = require('node:assert/strict');

const record = require('../public/js/record.js');

test('segmentKind / isInterjectionSegment', async t => {
  await t.test('a segment with no kind is a passage — every pre-#354 segment', () => {
    assert.equal(record.segmentKind({ label: 'x', text: 'y' }), record.SEGMENT_KIND_PASSAGE);
    assert.equal(record.isInterjectionSegment({ label: 'x', text: 'y' }), false);
  });

  await t.test('an explicit kind is respected', () => {
    assert.equal(
      record.segmentKind({ kind: record.SEGMENT_KIND_INTERJECTION }),
      record.SEGMENT_KIND_INTERJECTION
    );
    assert.equal(record.isInterjectionSegment({ kind: record.SEGMENT_KIND_INTERJECTION }), true);
  });
});

test('labelOpensSegment', async t => {
  await t.test('a pre-#244 segment (no endedBy) opens with its label', () => {
    assert.equal(record.labelOpensSegment({ label: 'First Movement', text: 'x' }), true);
  });

  await t.test('a #244 passage (endedBy set, no kind) closes with its label', () => {
    assert.equal(record.labelOpensSegment({ label: 'The room draws breath.', text: 'x', endedBy: 'lull' }), false);
  });

  await t.test('a #354 interjection opens with its label even though it carries an endedBy', () => {
    assert.equal(
      record.labelOpensSegment({
        kind: record.SEGMENT_KIND_INTERJECTION,
        label: 'A Presence Passes Through',
        text: 'x',
        endedBy: 'budget',
      }),
      true
    );
  });
});

test('isPresenceHeader', async t => {
  await t.test('recognizes the presence header line exactly, trimmed', () => {
    assert.equal(record.isPresenceHeader(record.PRESENCE_SPEAKER_NAME), true);
    assert.equal(record.isPresenceHeader(`  ${record.PRESENCE_SPEAKER_NAME}  `), true);
  });

  await t.test('rejects an ordinary speaker line', () => {
    assert.equal(record.isPresenceHeader('Crowley'), false);
    assert.equal(record.isPresenceHeader(''), false);
  });
});

// #354 item 4: pre-#244 sessions are deliberately left with no `beats` —
// this is the part of the proposal that keeps a session from silently
// claiming a completeness it can't have.
test('recordCompleteness / recordCompletenessNote', async t => {
  await t.test('an empty session is vacuously complete', () => {
    const c = record.recordCompleteness({ rounds: [] });
    assert.deepEqual(c, { segments: 0, segmentsWithBeats: 0, turns: 0, complete: true });
    assert.match(record.recordCompletenessNote({ rounds: [] }), /complete — 0 turns across 0 segments/);
  });

  await t.test('a fully post-#244 session with beats on every segment is complete', () => {
    const session = {
      rounds: [{ beats: [{ memberId: 'crowley', text: 'a' }] }, { beats: [{ memberId: 'jung', text: 'b' }] }],
    };
    const c = record.recordCompleteness(session);
    assert.equal(c.complete, true);
    assert.equal(c.turns, 2);
    assert.match(record.recordCompletenessNote(session), /complete — 2 turns across 2 segments/);
  });

  await t.test('a session with any pre-#244 segment (no beats array) is incomplete', () => {
    const session = {
      rounds: [{ label: 'First Movement', text: 'x' }, { beats: [{ memberId: 'crowley', text: 'a' }] }],
    };
    const c = record.recordCompleteness(session);
    assert.equal(c.complete, false);
    assert.equal(c.segments, 2);
    assert.equal(c.segmentsWithBeats, 1);
    const note = record.recordCompletenessNote(session);
    assert.match(note, /incomplete — 1 of 2 segments predates it/);
    assert.match(note, /cannot be cited individually/);
  });
});
