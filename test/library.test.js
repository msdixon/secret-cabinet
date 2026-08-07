'use strict';

// #187 — integrity checks on prompts/library/library.json's index itself,
// not on any code that reads it.
//
// These exist because the library is hand-curated prose data with no schema
// and no build step, and #187 gave one of its fields a new job: `author`
// decides whose speaker prompt gets an entry injected as "how you actually
// write". A wrong or missing `author` doesn't throw — it silently either
// deprives a member of their own prose or, worse, attributes someone else's
// to them. That's the same class of failure #157 found in `source_url`
// (fabricated identifiers, undetected for months because nothing checked),
// so it gets a check that runs in CI on every push.
//
// Offline by construction — reads the repo, makes no network calls, unlike
// scripts/verify-library-sources.js which has to reach archive.org.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const LIBRARY_DIR = path.join(__dirname, '..', 'prompts', 'library');
const MEMBERS_DIR = path.join(__dirname, '..', 'prompts', 'members');

const library = JSON.parse(fs.readFileSync(path.join(LIBRARY_DIR, 'library.json'), 'utf8'));
const roster = JSON.parse(fs.readFileSync(path.join(MEMBERS_DIR, 'roster.json'), 'utf8'));
const rosterIds = new Set(roster.map(m => m.id));

test('library.json — author field (#187)', async t => {
  await t.test('every entry names an author', () => {
    const missing = library.filter(e => !e.author).map(e => e.id);
    assert.deepEqual(missing, [], `entries with no author: ${missing.join(', ')}`);
  });

  await t.test('every author is a real roster member id', () => {
    const unknown = library.filter(e => !rosterIds.has(e.author)).map(e => `${e.id} → ${e.author}`);
    assert.deepEqual(unknown, [], `authors not on the roster: ${unknown.join(', ')}`);
  });

  await t.test('every author also appears in that entry\'s members list', () => {
    // members is the association list; author must be a member of it, or the
    // graph (#22/#84) and the exemplar path would disagree about who this
    // entry belongs to.
    const orphans = library.filter(e => !e.members?.includes(e.author)).map(e => e.id);
    assert.deepEqual(orphans, [], `author missing from members: ${orphans.join(', ')}`);
  });

  await t.test('no member is credited as author of two entries', () => {
    // Not forbidden in principle, but loadVoiceExemplar takes the first
    // match in file order — if this ever fires, the pick is silently
    // order-dependent and wants a deliberate decision, not a default.
    const seen = new Map();
    for (const entry of library) seen.set(entry.author, (seen.get(entry.author) || 0) + 1);
    const doubled = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
    assert.deepEqual(doubled, [], `authors with more than one entry: ${doubled.join(', ')}`);
  });
});

test('library.json — translated field (#187)', async t => {
  await t.test('every entry states whether it is a translation', () => {
    const missing = library.filter(e => typeof e.translated !== 'boolean').map(e => e.id);
    assert.deepEqual(missing, [], `entries with no translated flag: ${missing.join(', ')}`);
  });
});

test('library.json — entry files (#187)', async t => {
  await t.test('every entry\'s file exists and has a non-empty excerpt body', () => {
    // The exemplar path reads the body after stripping frontmatter; an entry
    // whose file is frontmatter-only would silently inject nothing.
    const broken = [];
    for (const entry of library) {
      const filePath = path.join(LIBRARY_DIR, entry.file);
      if (!fs.existsSync(filePath)) { broken.push(`${entry.id} (no file)`); continue; }
      const body = fs.readFileSync(filePath, 'utf8').replace(/^---[\s\S]*?---\n/, '').trim();
      if (!body) broken.push(`${entry.id} (empty body)`);
    }
    assert.deepEqual(broken, [], broken.join(', '));
  });
});
