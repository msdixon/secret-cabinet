'use strict';

// #623 — integrity checks on prompts/library/starters.json, the same way
// library.test.js checks library.json: hand-curated data with no schema, where
// a typo'd id doesn't throw, it just silently ships a dead card.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { resolveStarters, MAX_CAST, MIN_CAST } = require('../src/starters.js');

const LIBRARY_DIR = path.join(__dirname, '..', 'prompts', 'library');
const file = JSON.parse(fs.readFileSync(path.join(LIBRARY_DIR, 'starters.json'), 'utf8'));
const library = JSON.parse(fs.readFileSync(path.join(LIBRARY_DIR, 'library.json'), 'utf8'));
const roster = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'prompts', 'members', 'roster.json'), 'utf8'));
const libraryIds = new Set(library.map(e => e.id));
const rosterIds = new Set(roster.map(m => m.id));

test('starters.json (#623)', async t => {
  await t.test('has between 8 and 12 starters', () => {
    assert.ok(file.starters.length >= 8 && file.starters.length <= 12, `got ${file.starters.length}`);
  });

  await t.test('ids are unique and every starter has a hook', () => {
    const ids = file.starters.map(s => s.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const s of file.starters) assert.ok(s.hook && s.hook.trim(), `${s.id} has no hook`);
  });

  await t.test('every starter names a real library entry', () => {
    const bad = file.starters.filter(s => !libraryIds.has(s.libraryId)).map(s => s.id);
    assert.deepEqual(bad, []);
  });

  await t.test('every cast is 2-3 distinct, real roster members', () => {
    for (const s of file.starters) {
      assert.ok(s.cast.length >= MIN_CAST && s.cast.length <= MAX_CAST, `${s.id} cast size ${s.cast.length}`);
      assert.equal(new Set(s.cast).size, s.cast.length, `${s.id} repeats a member`);
      const unknown = s.cast.filter(id => !rosterIds.has(id));
      assert.deepEqual(unknown, [], `${s.id} casts unknown members`);
    }
  });

  await t.test('each starter uses its excerpt at most once', () => {
    const ids = file.starters.map(s => s.libraryId);
    assert.equal(new Set(ids).size, ids.length);
  });

  await t.test('sitting is null or a session id string', () => {
    assert.ok(file.sitting === null || (typeof file.sitting === 'string' && file.sitting));
  });
});

test('resolveStarters', async t => {
  await t.test('joins library display fields and keeps every curated starter', () => {
    const out = resolveStarters(file, library);
    assert.equal(out.starters.length, file.starters.length);
    assert.ok(out.starters.every(s => s.title && s.source));
  });

  await t.test('drops a starter whose library entry is missing', () => {
    const out = resolveStarters({ starters: [{ id: 'x', libraryId: 'nope', hook: 'h', cast: ['a', 'b'] }] }, library);
    assert.deepEqual(out.starters, []);
    assert.equal(out.sitting, null);
  });
});

test('scenarios in starters.json (#626)', async t => {
  const scenarios = file.scenarios || [];

  await t.test('are present, with unique ids, labels and text', () => {
    assert.ok(scenarios.length >= 1);
    assert.equal(new Set(scenarios.map(s => s.id)).size, scenarios.length);
    for (const s of scenarios) assert.ok(s.label && s.text, `${s.id} needs a label and text`);
  });

  await t.test('every cast is 2-3 distinct, real roster members', () => {
    for (const s of scenarios) {
      assert.ok(s.cast.length >= MIN_CAST && s.cast.length <= MAX_CAST, `${s.id} cast size ${s.cast.length}`);
      assert.equal(new Set(s.cast).size, s.cast.length, `${s.id} repeats a member`);
      assert.deepEqual(
        s.cast.filter(id => !rosterIds.has(id)),
        [],
        `${s.id} casts unknown members`
      );
    }
  });

  await t.test('an artifact scenario names text and a member who is in its cast', () => {
    for (const s of scenarios.filter(x => x.setup === 'artifact')) {
      assert.ok(s.artifact && s.artifact.text, `${s.id} has no artifact text`);
      assert.ok(s.cast.includes(s.artifact.memberId), `${s.id} shows its artifact to someone not seated`);
    }
  });

  await t.test('setup is absent, "you" or "artifact"', () => {
    for (const s of scenarios) assert.ok([undefined, 'you', 'artifact'].includes(s.setup), `${s.id}: ${s.setup}`);
  });

  await t.test('at least one scenario opens each way into the room (You, artifact)', () => {
    assert.ok(scenarios.some(s => s.setup === 'you'));
    assert.ok(scenarios.some(s => s.setup === 'artifact'));
  });
});

test('resolveScenarios via resolveStarters (#626)', async t => {
  await t.test('passes scenarios through, normalising setup and dropping malformed ones', () => {
    const out = resolveStarters(
      {
        scenarios: [
          { id: 'a', label: 'A', text: 't', cast: ['x', 'y'], setup: 'bogus' },
          {
            id: 'b',
            label: 'B',
            text: 't',
            cast: ['x', 'y'],
            setup: 'artifact',
            artifact: { memberId: 'x', text: 'n' },
          },
          { id: 'c', text: 'no label', cast: ['x', 'y'] },
        ],
      },
      library
    );
    assert.deepEqual(
      out.scenarios.map(s => [s.id, s.setup]),
      [
        ['a', null],
        ['b', 'artifact'],
      ]
    );
    assert.equal(out.scenarios[1].artifact.memberId, 'x');
  });

  await t.test('a file with no scenarios yields an empty list', () => {
    assert.deepEqual(resolveStarters({ starters: [] }, library).scenarios, []);
  });
});
