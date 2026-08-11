'use strict';

// #193 route-extraction — export-routes.js: Day One, Ulysses, Obsidian.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerExportRoutes } = require('../export-routes.js');

function fakeApp() {
  const routes = {};
  return { routes, post(path, handler) { routes[`POST ${path}`] = handler; } };
}

function fakeReq(body = {}) {
  return { body };
}

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

function makeDeps(overrides = {}) {
  return {
    dayOne: {
      listJournals: async () => [{ id: 'j1', name: 'Journal One' }],
      getRecentEntries: async () => [{ date: '2026-08-01T00:00:00Z', body: 'entry body', text: '' }],
      getLatestEntry: async () => ({ body: 'latest entry', date: '2026-08-11T00:00:00Z' }),
      createEntry: async () => ({}),
    },
    isLocal: true,
    buildSpeakerHeaderSet: roster => new Set(roster.map(m => m.name)),
    normalizeSpeaker: name => name,
    roster: [{ id: 'crowley', name: 'Crowley' }],
    ...overrides,
  };
}

test('registerExportRoutes', async t => {
  await t.test('registers all seven export routes', () => {
    const app = fakeApp();
    registerExportRoutes(app, makeDeps());
    [
      'POST /api/dayone/journals', 'POST /api/dayone/entries', 'POST /api/dayone/fetch', 'POST /api/dayone/export',
      'POST /api/ulysses/export', 'POST /api/export/obsidian',
    ].forEach(key => assert.equal(typeof app.routes[key], 'function', key));
  });
});

test('Day One routes', async t => {
  await t.test('POST /api/dayone/journals normalises the journal list', async () => {
    const app = fakeApp();
    registerExportRoutes(app, makeDeps());
    const res = fakeRes();
    await app.routes['POST /api/dayone/journals'](fakeReq(), res);
    assert.deepEqual(res.body, { journals: [{ id: 'j1', name: 'Journal One' }] });
  });

  await t.test('POST /api/dayone/entries 400s without a journalId', async () => {
    const app = fakeApp();
    registerExportRoutes(app, makeDeps());
    const res = fakeRes();
    await app.routes['POST /api/dayone/entries'](fakeReq({}), res);
    assert.equal(res.statusCode, 400);
  });

  await t.test('POST /api/dayone/fetch 404s when there is no latest entry', async () => {
    const app = fakeApp();
    registerExportRoutes(app, makeDeps({ dayOne: { getLatestEntry: async () => null } }));
    const res = fakeRes();
    await app.routes['POST /api/dayone/fetch'](fakeReq({ journalId: 'j1' }), res);
    assert.equal(res.statusCode, 404);
  });

  await t.test('POST /api/dayone/export 400s without transcriptText', async () => {
    const app = fakeApp();
    registerExportRoutes(app, makeDeps());
    const res = fakeRes();
    await app.routes['POST /api/dayone/export'](fakeReq({ journalId: 'j1' }), res);
    assert.equal(res.statusCode, 400);
  });

  await t.test('POST /api/dayone/export succeeds when the create call resolves', async () => {
    const app = fakeApp();
    registerExportRoutes(app, makeDeps());
    const res = fakeRes();
    await app.routes['POST /api/dayone/export'](fakeReq({ journalId: 'j1', journalName: 'Journal One', transcriptText: 'text', sessionDate: '2026-08-11' }), res);
    assert.deepEqual(res.body, { success: true, journal: 'Journal One' });
  });
});

test('POST /api/ulysses/export', async t => {
  await t.test('404s when not local', async () => {
    const app = fakeApp();
    registerExportRoutes(app, makeDeps({ isLocal: false }));
    const res = fakeRes();
    await app.routes['POST /api/ulysses/export'](fakeReq({ transcriptText: 'text' }), res);
    assert.equal(res.statusCode, 404);
  });

  await t.test('400s without transcriptText', async () => {
    const app = fakeApp();
    registerExportRoutes(app, makeDeps());
    const res = fakeRes();
    await app.routes['POST /api/ulysses/export'](fakeReq({}), res);
    assert.equal(res.statusCode, 400);
  });
});

test('POST /api/export/obsidian', async t => {
  await t.test('404s when not local', async () => {
    const app = fakeApp();
    registerExportRoutes(app, makeDeps({ isLocal: false }));
    const res = fakeRes();
    app.routes['POST /api/export/obsidian'](fakeReq({ vaultPath: '/x', transcriptText: 't' }), res);
    assert.equal(res.statusCode, 404);
  });

  await t.test('400s without vaultPath or transcriptText', async () => {
    const app = fakeApp();
    registerExportRoutes(app, makeDeps());
    const res = fakeRes();
    app.routes['POST /api/export/obsidian'](fakeReq({}), res);
    assert.equal(res.statusCode, 400);
  });

  await t.test('400s when the vault path does not exist on disk', async () => {
    const app = fakeApp();
    registerExportRoutes(app, makeDeps());
    const res = fakeRes();
    app.routes['POST /api/export/obsidian'](fakeReq({ vaultPath: '/definitely/not/a/real/vault', transcriptText: 't' }), res);
    assert.equal(res.statusCode, 400);
  });

  await t.test('writes a Markdown file with frontmatter and bolded speaker lines into the vault', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'export-routes-test-'));
    const app = fakeApp();
    registerExportRoutes(app, makeDeps());
    const res = fakeRes();
    const transcriptText = 'Crowley —\nSome opening line.';
    app.routes['POST /api/export/obsidian'](fakeReq({
      vaultPath: vault, transcriptText, sessionDate: '2026-08-11', members: ['Crowley'], tags: ['custom-tag'], sourceExcerpt: 'a test entry',
    }), res);

    assert.equal(res.body.success, true);
    const written = fs.readFileSync(res.body.path, 'utf8');
    assert.match(written, /date: 2026-08-11/);
    assert.match(written, /- custom-tag/);
    assert.match(written, /\*\*Crowley\*\*/);

    fs.rmSync(vault, { recursive: true, force: true });
  });
});
