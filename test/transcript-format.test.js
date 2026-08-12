'use strict';

// #193 — transcript-format.js, extracted from server.js.
//
// Pure string transforms; no filesystem, no ROSTER singleton. Every test
// here passes its own small roster fixture.

const test = require('node:test');
const assert = require('node:assert/strict');

const tf = require('../transcript-format.js');

const ROSTER = [
  { id: 'crowley', name: 'Aleister Crowley', aliases: ['Beast'] },
  { id: 'blavatsky', name: 'Blavatsky' },
  { id: 'teresa', name: 'Teresa of Ávila' },
];

test('normalizeSpeaker', async t => {
  await t.test('lowercases, strips diacritics and apostrophes, collapses whitespace/hyphens', () => {
    assert.equal(tf.normalizeSpeaker('Teresa of Ávila'), 'teresa of avila');
    assert.equal(tf.normalizeSpeaker("O'Brien-Smith"), 'obrien smith');
    assert.equal(tf.normalizeSpeaker('  Multiple   Spaces  '), 'multiple spaces');
  });
});

test('buildSpeakerHeaderSet', async t => {
  await t.test('registers full names, aliases, and significant name tokens', () => {
    const headers = tf.buildSpeakerHeaderSet(ROSTER);
    assert.ok(headers.has('aleister crowley'));
    assert.ok(headers.has('crowley')); // surname token
    assert.ok(headers.has('beast')); // alias
    assert.ok(headers.has('blavatsky'));
    assert.ok(headers.has('teresa of avila'));
  });

  await t.test('excludes stopword tokens like "of" from being registered alone', () => {
    const headers = tf.buildSpeakerHeaderSet(ROSTER);
    assert.equal(headers.has('of'), false);
  });

  await t.test('a key claimed by two different members becomes ambiguous and is excluded', () => {
    const clashing = [
      { id: 'a', name: 'Aleister Crowley' },
      { id: 'b', name: 'Crowley Smith' },
    ];
    const headers = tf.buildSpeakerHeaderSet(clashing);
    // "crowley" token registered by both ids -> ambiguous -> excluded
    assert.equal(headers.has('crowley'), false);
    // full names remain unambiguous
    assert.ok(headers.has('aleister crowley'));
    assert.ok(headers.has('crowley smith'));
  });
});

test('escapeHtml', async t => {
  await t.test('escapes the five HTML-significant characters', () => {
    assert.equal(tf.escapeHtml(`<a href="x">O'Brien & Sons</a>`),
      '&lt;a href=&quot;x&quot;&gt;O&#39;Brien &amp; Sons&lt;/a&gt;');
  });
});

test('formatTranscriptText', async t => {
  await t.test('appends " —" to lines matching a known speaker header', () => {
    const text = 'Crowley\nSomething was said.\nBlavatsky:\nSomething else.';
    const result = tf.formatTranscriptText(text, ROSTER);
    assert.equal(result, 'Crowley —\nSomething was said.\nBlavatsky —\nSomething else.');
  });

  await t.test('leaves non-speaker lines untouched', () => {
    const text = 'An ordinary line of prose.';
    assert.equal(tf.formatTranscriptText(text, ROSTER), text);
  });
});

// #245: the `endedBy` discriminator is the whole point here — without it there
// is no way to tell an opening round header from the lull that closed a
// passage, since both live in the same `label` field.
test('composeSegmentText', async t => {
  await t.test('puts a post-#244 lull note after the passage it ended', () => {
    const out = tf.composeSegmentText(
      { label: 'The room draws breath.', text: 'Crowley\nOne.', endedBy: 'lull' },
      ROSTER,
    );
    assert.equal(out, '\nCrowley —\nOne.\n\n— The room draws breath. —\n');
  });

  await t.test('leaves a pre-#244 round label above its passage, as it always was', () => {
    const out = tf.composeSegmentText({ label: 'First Movement', text: 'Crowley\nOne.' }, ROSTER);
    assert.equal(out, '\n— First Movement —\n\nCrowley —\nOne.\n');
  });

  await t.test('treats a user-closed segment as ending in a lull like any other', () => {
    const out = tf.composeSegmentText(
      { label: 'The fire settles.', text: 'Crowley\nOne.', endedBy: 'closed' },
      ROSTER,
    );
    assert.match(out, /One\.\n\n— The fire settles\. —\n$/);
  });
});

test('buildTranscriptHeader', async t => {
  await t.test('joins resolved member names and embeds the source entry', () => {
    const header = tf.buildTranscriptHeader('The source text.', ['crowley', 'blavatsky'], '2026-08-08', ROSTER);
    assert.match(header, /THE SECRET-CABIN-ET/);
    assert.match(header, /Meeting Notes — 2026-08-08/);
    assert.match(header, /Assembled: Aleister Crowley, Blavatsky/);
    assert.match(header, /The source text\.\n$/);
  });

  await t.test('drops unresolved member ids rather than throwing', () => {
    const header = tf.buildTranscriptHeader('x', ['crowley', 'ghost'], '2026-08-08', ROSTER);
    assert.match(header, /Assembled: Aleister Crowley\n/);
  });
});
