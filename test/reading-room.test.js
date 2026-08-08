'use strict';

// #193 — reading-room.js, extracted from server.js (public reading room, #38).
//
// Pure HTML templating; no filesystem, no I/O. Depends on transcript-format.js
// for speaker recognition, exercised through its real (not mocked) exports —
// the boundary worth testing is "roster in, HTML out", not the internals of
// a dependency that already has its own test file.

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderRoundHtml, renderReadingRoomPage } = require('../reading-room.js');

const ROSTER = [
  { id: 'crowley', name: 'Crowley' },
  { id: 'blavatsky', name: 'Blavatsky' },
];

test('renderRoundHtml', async t => {
  await t.test('groups speaker + speech into rr-turn blocks', () => {
    const html = renderRoundHtml('Crowley\nA line of speech.\nBlavatsky:\nAnother line.', ROSTER);
    assert.match(html, /<div class="rr-turn"><div class="rr-speaker">Crowley<\/div>/);
    assert.match(html, /A line of speech\./);
    assert.match(html, /<div class="rr-speaker">Blavatsky<\/div>/);
  });

  await t.test('renders a standalone asterisk line before any speaker as a stage action', () => {
    const html = renderRoundHtml('*The fire crackles.*\nCrowley\nSpeaks.', ROSTER);
    assert.match(html, /<p class="rr-stage-action">The fire crackles\.<\/p>/);
  });

  await t.test('renders an asterisk-wrapped line inside a speech as an inline action paragraph', () => {
    const html = renderRoundHtml('Crowley\n*gestures broadly*', ROSTER);
    assert.match(html, /<p class="rr-action">gestures broadly<\/p>/);
  });

  await t.test('escapes HTML in speaker names and speech', () => {
    const html = renderRoundHtml('Crowley\n<script>alert(1)</script>', ROSTER);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });

  await t.test('ignores divider lines', () => {
    const html = renderRoundHtml('Crowley\nFirst.\n---\nStill Crowley.', ROSTER);
    // Divider doesn't break the open speaker turn or introduce stray markup
    assert.doesNotMatch(html, /<div class="rr-turn"><div class="rr-speaker">---/);
  });

  await t.test('empty text produces no turns', () => {
    assert.equal(renderRoundHtml('', ROSTER), '');
    assert.equal(renderRoundHtml(undefined, ROSTER), '');
  });
});

test('renderReadingRoomPage', async t => {
  const SESSION = {
    id: 'sess-1',
    date: '2026-08-08',
    entry: 'The source document.',
    members: ['crowley', 'blavatsky'],
    rounds: [{ label: 'First Movement', text: 'Crowley\nHello there, friend.' }],
  };

  await t.test('renders a full HTML page with title, members, and rounds', () => {
    const html = renderReadingRoomPage(SESSION, ROSTER);
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<title>The source document\. — The Secret-Cabin-et<\/title>/);
    assert.match(html, /rr-member-name">Crowley</);
    assert.match(html, /rr-member-name">Blavatsky</);
    assert.match(html, /rr-round-label">First Movement</);
    assert.match(html, /Hello there, friend\./);
  });

  await t.test('drops member ids not found on the roster instead of throwing', () => {
    const html = renderReadingRoomPage({ ...SESSION, members: ['crowley', 'ghost'] }, ROSTER);
    assert.match(html, /rr-member-name">Crowley</);
    assert.doesNotMatch(html, /ghost/);
  });

  await t.test('escapes the source entry and session date', () => {
    const html = renderReadingRoomPage({ ...SESSION, entry: '<b>x</b>' }, ROSTER);
    assert.doesNotMatch(html, /<b>x<\/b>/);
    assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  });

  await t.test('handles a session with no rounds or members', () => {
    const html = renderReadingRoomPage({ id: 'empty', entry: '', rounds: [] }, ROSTER);
    assert.match(html, /^<!DOCTYPE html>/);
  });
});
