'use strict';

// #193 — library.js (the code that reads prompts/library/), extracted from
// server.js. Not to be confused with test/library.test.js, the pre-existing
// data-integrity suite for library.json's contents (#187/#35) — this file
// exercises the reading code itself, against disposable fixtures.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lib = require('../library.js');

function makeFixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-test-'));
  return dir;
}

function writeEntry(libraryDir, filename, { frontmatter = '', body = 'Excerpt body text.' } = {}) {
  fs.writeFileSync(path.join(libraryDir, filename), `---\n${frontmatter}---\n${body}\n`, 'utf8');
}

test('loadLibraryIndex', async t => {
  await t.test('parses library.json', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const libraryFile = path.join(dir, 'library.json');
    const data = [{ id: 'a', title: 'A', file: 'a.md' }];
    fs.writeFileSync(libraryFile, JSON.stringify(data), 'utf8');
    assert.deepEqual(lib.loadLibraryIndex(libraryFile), data);
  });

  await t.test('returns an empty array when library.json is missing', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    assert.deepEqual(lib.loadLibraryIndex(path.join(dir, 'nope.json')), []);
  });
});

test('loadArchiveImageIndex', async t => {
  await t.test('returns the entries map from metadata.json', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const imageFile = path.join(dir, 'metadata.json');
    fs.writeFileSync(imageFile, JSON.stringify({ entries: { a: { image: 'a.jpg' } } }), 'utf8');
    assert.deepEqual(lib.loadArchiveImageIndex(imageFile), { a: { image: 'a.jpg' } });
  });

  await t.test('returns {} when the file is missing', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    assert.deepEqual(lib.loadArchiveImageIndex(path.join(dir, 'nope.json')), {});
  });

  await t.test('returns {} when the file has no entries key', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const imageFile = path.join(dir, 'metadata.json');
    fs.writeFileSync(imageFile, JSON.stringify({}), 'utf8');
    assert.deepEqual(lib.loadArchiveImageIndex(imageFile), {});
  });
});

test('parseLibraryFrontmatter', async t => {
  await t.test('extracts citation and source_url from YAML frontmatter', () => {
    const raw = '---\ncitation: "Some Citation, 1911"\nsource_url: "https://example.com/x"\n---\nBody.';
    assert.deepEqual(lib.parseLibraryFrontmatter(raw), {
      citation: 'Some Citation, 1911',
      source_url: 'https://example.com/x',
    });
  });

  await t.test('returns nulls for fields missing from frontmatter', () => {
    const raw = '---\ntitle: "X"\n---\nBody.';
    assert.deepEqual(lib.parseLibraryFrontmatter(raw), { citation: null, source_url: null });
  });

  await t.test('returns nulls when there is no frontmatter block at all', () => {
    assert.deepEqual(lib.parseLibraryFrontmatter('Just body text.'), { citation: null, source_url: null });
  });
});

test('loadVoiceExemplar', async t => {
  await t.test('finds the entry authored by the given member and returns its stripped text', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const libraryFile = path.join(dir, 'library.json');
    fs.writeFileSync(libraryFile, JSON.stringify([
      { id: 'e1', title: 'T1', source: 'S1', date: '1911', translated: false, file: 'e1.md', author: 'crowley' },
    ]), 'utf8');
    writeEntry(dir, 'e1.md', { body: 'The actual prose.' });

    const exemplar = lib.loadVoiceExemplar(dir, libraryFile, 'crowley');
    assert.equal(exemplar.id, 'e1');
    assert.equal(exemplar.text, 'The actual prose.');
    assert.equal(exemplar.translated, false);
  });

  await t.test('returns null when no memberId is given', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const libraryFile = path.join(dir, 'library.json');
    fs.writeFileSync(libraryFile, JSON.stringify([]), 'utf8');
    assert.equal(lib.loadVoiceExemplar(dir, libraryFile, null), null);
  });

  await t.test('returns null when no entry is authored by that member', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const libraryFile = path.join(dir, 'library.json');
    fs.writeFileSync(libraryFile, JSON.stringify([
      { id: 'e1', file: 'e1.md', author: 'jung' },
    ]), 'utf8');
    writeEntry(dir, 'e1.md');
    assert.equal(lib.loadVoiceExemplar(dir, libraryFile, 'crowley'), null);
  });

  await t.test('takes the first author match when more than one exists (deterministic order)', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const libraryFile = path.join(dir, 'library.json');
    fs.writeFileSync(libraryFile, JSON.stringify([
      { id: 'first', file: 'first.md', author: 'crowley' },
      { id: 'second', file: 'second.md', author: 'crowley' },
    ]), 'utf8');
    writeEntry(dir, 'first.md', { body: 'First text.' });
    writeEntry(dir, 'second.md', { body: 'Second text.' });
    const exemplar = lib.loadVoiceExemplar(dir, libraryFile, 'crowley');
    assert.equal(exemplar.id, 'first');
  });
});

test('loadLibraryCitationLookup', async t => {
  await t.test('builds a lookup keyed by entry id with citation/source_url/text', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const libraryFile = path.join(dir, 'library.json');
    fs.writeFileSync(libraryFile, JSON.stringify([
      { id: 'e1', title: 'T1', source: 'S1', file: 'e1.md' },
    ]), 'utf8');
    writeEntry(dir, 'e1.md', { frontmatter: 'citation: "C1"\nsource_url: "https://x"\n', body: 'Excerpt.' });

    const lookup = lib.loadLibraryCitationLookup(dir, libraryFile);
    assert.deepEqual(lookup.e1, {
      title: 'T1', source: 'S1', citation: 'C1', source_url: 'https://x', text: 'Excerpt.',
    });
  });

  await t.test('skips an entry whose file is missing on disk', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const libraryFile = path.join(dir, 'library.json');
    fs.writeFileSync(libraryFile, JSON.stringify([{ id: 'ghost', file: 'missing.md' }]), 'utf8');
    assert.deepEqual(lib.loadLibraryCitationLookup(dir, libraryFile), {});
  });
});
