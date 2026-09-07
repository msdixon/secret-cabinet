'use strict';

// #514 route-extraction — src/routes/grounding.js: upload/list/clear a
// session's ephemeral sources, and verify-grounding. Same fixture pattern as
// session-routes.test.js: real sessions-store.js against a real tmpdir,
// fakeApp()/fakeReq()/fakeRes() for everything else. src/grounding.js's own
// in-memory store is real (not mocked) since it's the thing under test —
// each test uses its own session id so state never leaks across tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerGroundingRoutes } = require('../src/routes/grounding.js');
const { clearGrounding } = require('../src/grounding.js');
const store = require('../src/sessions-store.js');

function fakeApp() {
  const routes = {};
  return {
    routes,
    get(path, handler) {
      routes[`GET ${path}`] = handler;
    },
    post(path, handler) {
      routes[`POST ${path}`] = handler;
    },
    delete(path, handler) {
      routes[`DELETE ${path}`] = handler;
    },
  };
}

function fakeReq({ params = {}, body = {} } = {}) {
  return { params, body };
}

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return res;
}

function makeFixtureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-routes-test-'));
}

function baseSession(id, extra = {}) {
  return {
    id,
    date: '2026-09-06',
    entry: 'The source entry',
    members: ['crowley'],
    conversationHistory: [],
    rounds: [{ label: 'First Movement', text: 'Crowley —\nHello.', historyLength: 2 }],
    transcriptText: 'HEADER\n— First Movement —\n\nCrowley —\nHello.\n',
    generationMetrics: [],
    playerTurns: [],
    disposition: {},
    ...extra,
  };
}

function makeDeps(dir, overrides = {}) {
  return {
    client: { messages: { create: async () => ({ content: [] }) } },
    model: 'test-model',
    loadSession: id => store.loadSession(dir, id),
    saveSession: session => store.saveSession(dir, session),
    roster: [{ id: 'crowley', name: 'Crowley' }],
    ...overrides,
  };
}

test('POST /api/sessions/:id/grounding', async t => {
  t.after(() => clearGrounding('s1'));

  await t.test('404s for an unknown session', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const app = fakeApp();
    registerGroundingRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['POST /api/sessions/:id/grounding'](fakeReq({ params: { id: 'nope' }, body: { text: 'hi' } }), res);
    assert.equal(res.statusCode, 404);
  });

  await t.test('400s when no text is provided', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1'));
    const app = fakeApp();
    registerGroundingRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['POST /api/sessions/:id/grounding'](fakeReq({ params: { id: 's1' }, body: {} }), res);
    assert.equal(res.statusCode, 400);
  });

  await t.test('adds a source and returns its summary', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1'));
    const app = fakeApp();
    registerGroundingRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['POST /api/sessions/:id/grounding'](
      fakeReq({ params: { id: 's1' }, body: { filename: 'notes.txt', text: 'Some real content.' } }),
      res
    );
    assert.equal(res.statusCode, null);
    assert.equal(res.body.summary.sources.length, 1);
    assert.equal(res.body.summary.sources[0].filename, 'notes.txt');
  });
});

test('GET /api/sessions/:id/grounding', async t => {
  await t.test('404s for an unknown session', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const app = fakeApp();
    registerGroundingRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['GET /api/sessions/:id/grounding'](fakeReq({ params: { id: 'nope' } }), res);
    assert.equal(res.statusCode, 404);
  });

  await t.test('returns an empty summary for a session with no uploaded sources', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s2'));
    const app = fakeApp();
    registerGroundingRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['GET /api/sessions/:id/grounding'](fakeReq({ params: { id: 's2' } }), res);
    assert.deepEqual(res.body.sources, []);
  });
});

test('DELETE /api/sessions/:id/grounding', async t => {
  await t.test('clears an existing session\'s uploaded sources', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s3'));
    const app = fakeApp();
    registerGroundingRoutes(app, makeDeps(dir));
    app.routes['POST /api/sessions/:id/grounding'](
      fakeReq({ params: { id: 's3' }, body: { filename: 'a.txt', text: 'content' } }),
      fakeRes()
    );
    const res = fakeRes();
    app.routes['DELETE /api/sessions/:id/grounding'](fakeReq({ params: { id: 's3' } }), res);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.summary.sources, []);
  });
});

test('POST /api/sessions/:id/verify-grounding', async t => {
  await t.test('404s for an unknown session', async () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const app = fakeApp();
    registerGroundingRoutes(app, makeDeps(dir));
    const res = fakeRes();
    await app.routes['POST /api/sessions/:id/verify-grounding'](fakeReq({ params: { id: 'nope' } }), res);
    assert.equal(res.statusCode, 404);
  });

  await t.test('400s when the session has no uploaded sources yet', async () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s4'));
    const app = fakeApp();
    registerGroundingRoutes(app, makeDeps(dir));
    const res = fakeRes();
    await app.routes['POST /api/sessions/:id/verify-grounding'](fakeReq({ params: { id: 's4' } }), res);
    assert.equal(res.statusCode, 400);
  });

  await t.test('verifies captured citations against uploaded sources and stores citationFlags', async () => {
    const dir = makeFixtureDir();
    t.after(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      clearGrounding('s5');
    });
    store.saveSession(
      dir,
      baseSession('s5', {
        rounds: [
          {
            label: 'First Movement',
            text: 'Crowley\nHello.',
            historyLength: 2,
            beats: [
              {
                memberId: 'crowley',
                text: 'Hello.',
                citations: [{ quote: 'the ritual dagger gleamed under candlelight', work: 'A Work', libraryMatch: null }],
              },
            ],
          },
        ],
      })
    );
    const app = fakeApp();
    const fakeClient = {
      messages: {
        create: async () => ({
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [
            { type: 'tool_use', input: { verdicts: [{ index: 0, verdict: 'confirmed', note: 'Matches.' }] } },
          ],
        }),
      },
    };
    registerGroundingRoutes(app, makeDeps(dir, { client: fakeClient }));
    app.routes['POST /api/sessions/:id/grounding'](
      fakeReq({
        params: { id: 's5' },
        body: { filename: 'notes.txt', text: 'The ritual dagger gleamed under candlelight in the old chapel.' },
      }),
      fakeRes()
    );

    const res = fakeRes();
    await app.routes['POST /api/sessions/:id/verify-grounding'](fakeReq({ params: { id: 's5' } }), res);
    assert.equal(res.body.citations.length, 1);
    assert.equal(res.body.citations[0].speaker, 'Crowley');
    assert.equal(res.body.citations[0].verdict, 'verified');
    assert.equal(res.body.citations[0].source, 'user-grounding');
    assert.equal(store.loadSession(dir, 's5').citationFlags.length, 1);
  });

  await t.test('preserves a prior library/web verdict when grounding has nothing new to say', async () => {
    const dir = makeFixtureDir();
    t.after(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      clearGrounding('s6');
    });
    store.saveSession(
      dir,
      baseSession('s6', {
        rounds: [
          {
            label: 'First Movement',
            text: 'Crowley\nHello.',
            historyLength: 2,
            beats: [{ memberId: 'crowley', text: 'Hello.', citations: [{ quote: 'unrelated quote here', work: 'A Work' }] }],
          },
        ],
        citationFlags: [{ quote: 'unrelated quote here', work: 'A Work', verdict: 'verified', source: 'web' }],
      })
    );
    const app = fakeApp();
    registerGroundingRoutes(app, makeDeps(dir));
    app.routes['POST /api/sessions/:id/grounding'](
      fakeReq({ params: { id: 's6' }, body: { filename: 'notes.txt', text: 'Completely unrelated gardening content.' } }),
      fakeRes()
    );

    const res = fakeRes();
    await app.routes['POST /api/sessions/:id/verify-grounding'](fakeReq({ params: { id: 's6' } }), res);
    assert.equal(res.body.citations[0].verdict, 'verified');
    assert.equal(res.body.citations[0].source, 'web');
  });

  await t.test('a thrown error mid-verification is caught and returns 500', async () => {
    const dir = makeFixtureDir();
    t.after(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      clearGrounding('s7');
    });
    store.saveSession(
      dir,
      baseSession('s7', {
        rounds: [
          {
            label: 'First Movement',
            text: 'Crowley\nHello.',
            historyLength: 2,
            beats: [
              { memberId: 'crowley', text: 'Hello.', citations: [{ quote: 'the ritual dagger gleamed under candlelight', work: 'A Work' }] },
            ],
          },
        ],
      })
    );
    const app = fakeApp();
    const fakeClient = {
      messages: {
        create: async () => {
          throw new Error('API error');
        },
      },
    };
    registerGroundingRoutes(app, makeDeps(dir, { client: fakeClient }));
    app.routes['POST /api/sessions/:id/grounding'](
      fakeReq({
        params: { id: 's7' },
        body: { filename: 'notes.txt', text: 'The ritual dagger gleamed under candlelight in the old chapel.' },
      }),
      fakeRes()
    );

    const res = fakeRes();
    await app.routes['POST /api/sessions/:id/verify-grounding'](fakeReq({ params: { id: 's7' } }), res);
    assert.equal(res.statusCode, 500);
  });
});
