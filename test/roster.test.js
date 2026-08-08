'use strict';

// #193 — roster.js, the first module extracted from server.js's monolith.
//
// Express-agnostic, like pipeline.js: every function takes its file paths
// and cache explicitly rather than reaching for a module-level ROSTER
// singleton, so these tests exercise real filesystem I/O against a disposable
// fixture directory instead of stubbing fs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const roster = require('../roster.js');

function makeFixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-test-'));
  const membersDir = path.join(dir, 'members');
  fs.mkdirSync(membersDir);
  return { dir, membersDir };
}

function writeMemberFile(membersDir, filename, { who = 'A member of the room.', speak = 'Plainly.' } = {}) {
  fs.writeFileSync(
    path.join(membersDir, filename),
    `# NAME\n\n## WHO YOU ARE\n\n${who}\n\nMore detail follows.\n\n## HOW YOU SPEAK\n\n${speak}\n`,
    'utf8',
  );
}

test('assignGlyph', async t => {
  await t.test('picks a pool glyph not already used', () => {
    const used = [{ glyph: '☉' }, { glyph: '♀' }];
    const glyph = roster.assignGlyph(used);
    assert.ok(roster.FALLBACK_GLYPHS.includes(glyph));
    assert.notEqual(glyph, '☉');
    assert.notEqual(glyph, '♀');
  });

  await t.test('cycles by roster size once the pool is exhausted', () => {
    const all = roster.FALLBACK_GLYPHS.map(glyph => ({ glyph }));
    const glyph = roster.assignGlyph(all);
    assert.equal(glyph, roster.FALLBACK_GLYPHS[all.length % roster.FALLBACK_GLYPHS.length]);
  });
});

test('reloadRoster', async t => {
  await t.test('loads roster.json as-is when every file exists and glyphs are set', () => {
    const { dir, membersDir } = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    writeMemberFile(membersDir, 'crowley.md');
    const rosterFile = path.join(membersDir, 'roster.json');
    const input = [{ id: 'crowley', name: 'Crowley', file: 'crowley.md', glyph: '☉' }];
    fs.writeFileSync(rosterFile, JSON.stringify(input), 'utf8');

    const result = roster.reloadRoster(rosterFile, membersDir);
    assert.deepEqual(result, input);
  });

  await t.test('drops entries whose character file no longer exists on disk', () => {
    const { dir, membersDir } = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    writeMemberFile(membersDir, 'crowley.md');
    const rosterFile = path.join(membersDir, 'roster.json');
    fs.writeFileSync(rosterFile, JSON.stringify([
      { id: 'crowley', name: 'Crowley', file: 'crowley.md', glyph: '☉' },
      { id: 'ghost', name: 'Ghost', file: 'missing.md', glyph: '♀' },
    ]), 'utf8');

    const result = roster.reloadRoster(rosterFile, membersDir);
    assert.deepEqual(result.map(m => m.id), ['crowley']);
    // Rewritten to disk without the dropped entry
    const onDisk = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    assert.deepEqual(onDisk.map(m => m.id), ['crowley']);
  });

  await t.test('keeps an entry with no file field (no existence check applies)', () => {
    const { dir, membersDir } = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const rosterFile = path.join(membersDir, 'roster.json');
    fs.writeFileSync(rosterFile, JSON.stringify([{ id: 'nofile', name: 'No File', glyph: '☉' }]), 'utf8');

    const result = roster.reloadRoster(rosterFile, membersDir);
    assert.deepEqual(result.map(m => m.id), ['nofile']);
  });

  await t.test('backfills a missing glyph and persists it', () => {
    const { dir, membersDir } = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    writeMemberFile(membersDir, 'crowley.md');
    const rosterFile = path.join(membersDir, 'roster.json');
    fs.writeFileSync(rosterFile, JSON.stringify([{ id: 'crowley', name: 'Crowley', file: 'crowley.md' }]), 'utf8');

    const result = roster.reloadRoster(rosterFile, membersDir);
    assert.ok(result[0].glyph, 'expected a glyph to be backfilled');
    const onDisk = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    assert.equal(onDisk[0].glyph, result[0].glyph);
  });
});

test('loadMemberFile', async t => {
  await t.test('reads an existing member file', () => {
    const { dir, membersDir } = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    writeMemberFile(membersDir, 'crowley.md', { who: 'The beast himself.' });
    const text = roster.loadMemberFile(membersDir, 'crowley.md');
    assert.match(text, /The beast himself\./);
  });

  await t.test('returns empty string for a missing filename', () => {
    const { dir, membersDir } = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    assert.equal(roster.loadMemberFile(membersDir, null), '');
    assert.equal(roster.loadMemberFile(membersDir, 'nope.md'), '');
  });
});

test('extractSection', async t => {
  const TEXT = `# NAME\n\n## WHO YOU ARE\n\nA line with *emphasis* stripped.\nSecond line of the same paragraph.\n\nA second paragraph not included.\n\n## HOW YOU SPEAK\n\nCrisply.\n`;

  await t.test('extracts and cleans the first paragraph of a section', () => {
    const result = roster.extractSection(TEXT, 'WHO YOU ARE');
    assert.equal(result, 'A line with emphasis stripped. Second line of the same paragraph.');
  });

  await t.test('truncates to the given limit', () => {
    const result = roster.extractSection(TEXT, 'WHO YOU ARE', 10);
    assert.equal(result.length, 10);
  });

  await t.test('returns null for a section that does not exist', () => {
    assert.equal(roster.extractSection(TEXT, 'NOT A SECTION'), null);
  });
});

test('memberBrief', async t => {
  await t.test('caches the extracted brief across calls', () => {
    const { dir, membersDir } = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    writeMemberFile(membersDir, 'crowley.md', { who: 'The beast himself, and more.' });
    const cache = new Map();
    const member = { id: 'crowley', file: 'crowley.md' };

    const first = roster.memberBrief(membersDir, cache, member);
    assert.match(first, /The beast himself/);
    assert.ok(cache.has('crowley'));

    // Delete the file — a cache hit must not need to re-read it
    fs.rmSync(path.join(membersDir, 'crowley.md'));
    const second = roster.memberBrief(membersDir, cache, member);
    assert.equal(second, first);
  });

  await t.test('caches null for a member with no file', () => {
    const { dir, membersDir } = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const cache = new Map();
    const brief = roster.memberBrief(membersDir, cache, { id: 'nofile', file: null });
    assert.equal(brief, null);
    assert.equal(cache.get('nofile'), null);
  });
});

test('castingRoster', async t => {
  await t.test('maps roster entries to id/name/brief', () => {
    const { dir, membersDir } = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    writeMemberFile(membersDir, 'crowley.md', { who: 'The beast.' });
    const cache = new Map();
    const result = roster.castingRoster(membersDir, cache, [{ id: 'crowley', name: 'Crowley', file: 'crowley.md' }]);
    assert.deepEqual(result, [{ id: 'crowley', name: 'Crowley', brief: 'The beast.' }]);
  });
});
