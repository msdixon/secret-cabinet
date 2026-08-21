'use strict';

// #193 route-extraction — src/routes/session.js: session CRUD, threads, branch,
// transcript, publish/reading-room, and verify-citations. loadSession/
// saveSession are the real sessions-store.js functions against a real
// tmpdir (same fixture pattern as sessions-store.test.js) — everything else
// is faked, following auth.test.js's fakeApp()/fakeReq()/fakeRes()
// convention.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerSessionRoutes } = require('../src/routes/session.js');
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
    patch(path, handler) {
      routes[`PATCH ${path}`] = handler;
    },
    delete(path, handler) {
      routes[`DELETE ${path}`] = handler;
    },
  };
}

// #378: authed defaults true — every existing call site in this file
// exercises the authenticated/admin path (the only one reachable today,
// since requireAuth already gates /api/ before these handlers run whenever a
// passphrase is set). Tests for the unauthenticated published-filter pass
// `authed: false` explicitly.
function fakeReq({ params = {}, body = {}, query = {}, authed = true } = {}) {
  return { params, body, query, authed };
}

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    sentText: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(text) {
      this.sentText = text;
      return this;
    },
  };
  return res;
}

function makeFixtureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'session-routes-test-'));
}

function makeDeps(dir, overrides = {}) {
  return {
    sessionsDir: dir,
    loadSession: id => store.loadSession(dir, id),
    saveSession: session => store.saveSession(dir, session),
    roster: [
      { id: 'crowley', name: 'Crowley' },
      { id: 'jung', name: 'Carl Jung' },
    ],
    makeBranchId: store.makeBranchId,
    buildTranscriptHeader: (entry, members, date) => `HEADER(${date})\n${entry}\n`,
    composeSegmentText: segment =>
      segment.endedBy ? `\n${segment.text}\n\n— ${segment.label} —\n` : `\n— ${segment.label} —\n\n${segment.text}\n`,
    renderReadingRoomPage: session => `<html>${session.id}</html>`,
    loadLibraryCitationLookup: () => ({}),
    loadArchiveImageIndex: () => ({}),
    groundAgainstLibraryText: async () => new Map(),
    escalateCitationsToWeb: async () => new Map(),
    ...overrides,
  };
}

function baseSession(id, extra = {}) {
  return {
    id,
    date: '2026-08-11',
    entry: 'The source entry',
    members: ['crowley', 'jung'],
    conversationHistory: [],
    rounds: [{ label: 'First Movement', text: 'Crowley —\nHello.', historyLength: 2 }],
    transcriptText: 'HEADER\n— First Movement —\n\nCrowley —\nHello.\n',
    generationMetrics: [],
    playerTurns: [],
    disposition: {},
    ...extra,
  };
}

test('GET /api/sessions', async t => {
  await t.test('lists sessions newest-first with member names resolved', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1'));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['GET /api/sessions'](fakeReq(), res);
    assert.equal(res.body.length, 1);
    assert.deepEqual(res.body[0].members, ['Crowley', 'Carl Jung']);
  });

  await t.test('?q= filters by entry/transcript/tag/date text', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1', { entry: 'about silence' }));
    store.saveSession(dir, baseSession('s2', { entry: 'about music' }));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['GET /api/sessions'](fakeReq({ query: { q: 'silence' } }), res);
    assert.deepEqual(
      res.body.map(s => s.id),
      ['s1']
    );
  });

  await t.test('#378: an unauthenticated request only sees published sessions', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1', { published: true }));
    store.saveSession(dir, baseSession('s2'));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['GET /api/sessions'](fakeReq({ authed: false }), res);
    assert.deepEqual(
      res.body.map(s => s.id),
      ['s1']
    );
  });

  await t.test('#378: the published filter applies before ?q=, so an unauthenticated ?q= cannot match an unpublished session', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1', { entry: 'about silence', published: false }));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['GET /api/sessions'](fakeReq({ query: { q: 'silence' }, authed: false }), res);
    assert.deepEqual(res.body, []);
  });

  await t.test('?thread= filters and sorts chronologically oldest-first', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1', { date: '2026-08-10', threadId: 't1', threadName: 'A Thread' }));
    store.saveSession(dir, baseSession('s2', { date: '2026-08-05', threadId: 't1', threadName: 'A Thread' }));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['GET /api/sessions'](fakeReq({ query: { thread: 't1' } }), res);
    assert.deepEqual(
      res.body.map(s => s.id),
      ['s2', 's1']
    );
  });
});

test('GET /api/threads', async t => {
  await t.test('groups sessions into named threads with counts', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1', { threadId: 't1', threadName: 'Thread One' }));
    store.saveSession(dir, baseSession('s2', { threadId: 't1', threadName: 'Thread One' }));
    store.saveSession(dir, baseSession('s3'));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['GET /api/threads'](fakeReq(), res);
    assert.deepEqual(res.body, [{ id: 't1', name: 'Thread One', count: 2 }]);
  });

  await t.test('#378: an unauthenticated request excludes threads made up only of unpublished sessions', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1', { threadId: 't1', threadName: 'Thread One', published: true }));
    store.saveSession(dir, baseSession('s2', { threadId: 't2', threadName: 'Thread Two', published: false }));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['GET /api/threads'](fakeReq({ authed: false }), res);
    assert.deepEqual(res.body, [{ id: 't1', name: 'Thread One', count: 1 }]);
  });
});

test('PATCH /api/sessions/:id/thread', async t => {
  await t.test('sets threadId/threadName, slugifying the id', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1'));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['PATCH /api/sessions/:id/thread'](
      fakeReq({ params: { id: 's1' }, body: { threadId: 'My Thread!', threadName: 'My Thread' } }),
      res
    );
    assert.equal(res.body.threadId, 'my-thread');
    assert.equal(store.loadSession(dir, 's1').threadId, 'my-thread');
  });

  await t.test('clears thread fields when threadId/threadName are omitted', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1', { threadId: 't1', threadName: 'T1' }));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['PATCH /api/sessions/:id/thread'](fakeReq({ params: { id: 's1' }, body: {} }), res);
    assert.deepEqual(res.body, { threadId: null, threadName: null });
  });

  await t.test('404s for an unknown session', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['PATCH /api/sessions/:id/thread'](fakeReq({ params: { id: 'nope' }, body: {} }), res);
    assert.equal(res.statusCode, 404);
  });
});

test('PATCH /api/sessions/:id/annotations', async t => {
  await t.test('400s when annotations is not an array', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['PATCH /api/sessions/:id/annotations'](
      fakeReq({ params: { id: 's1' }, body: { annotations: 'x' } }),
      res
    );
    assert.equal(res.statusCode, 400);
  });

  await t.test('saves the annotations array', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1'));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['PATCH /api/sessions/:id/annotations'](
      fakeReq({ params: { id: 's1' }, body: { annotations: [{ note: 'x' }] } }),
      res
    );
    assert.deepEqual(res.body, { count: 1 });
  });
});

test('PATCH /api/sessions/:id/tags', async t => {
  await t.test('trims and drops empty tags', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1'));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['PATCH /api/sessions/:id/tags'](
      fakeReq({ params: { id: 's1' }, body: { tags: [' one ', '', 'two'] } }),
      res
    );
    assert.deepEqual(res.body.tags, ['one', 'two']);
  });
});

test('DELETE /api/sessions/:id', async t => {
  await t.test('removes the session file', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1'));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['DELETE /api/sessions/:id'](fakeReq({ params: { id: 's1' } }), res);
    assert.deepEqual(res.body, { success: true });
    assert.equal(fs.existsSync(path.join(dir, 's1.json')), false);
  });

  await t.test('404s for an unknown session', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['DELETE /api/sessions/:id'](fakeReq({ params: { id: 'nope' } }), res);
    assert.equal(res.statusCode, 404);
  });
});

test('GET /api/sessions/:id', async t => {
  await t.test('returns the full stored session', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1'));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['GET /api/sessions/:id'](fakeReq({ params: { id: 's1' } }), res);
    assert.equal(res.body.id, 's1');
  });

  await t.test('#378: an unauthenticated request 404s (not 403) for an unpublished session', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1'));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['GET /api/sessions/:id'](fakeReq({ params: { id: 's1' }, authed: false }), res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error, 'Session not found');
  });

  await t.test('#378: an unauthenticated request can still load a published session', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1', { published: true }));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['GET /api/sessions/:id'](fakeReq({ params: { id: 's1' }, authed: false }), res);
    assert.equal(res.body.id, 's1');
  });
});

// #245: `closed` is the user's end-cause, not the room's — #244 defined it but
// left it unreachable because nothing server-side decides it. This route is
// what reaches it, and the distinction it records ("the room wound down and
// the user agreed" vs. "the user cut it off") is what #164's pacing review
// needs; the two are indistinguishable without it.
test('POST /api/sessions/:id/close', async t => {
  await t.test('marks the final segment as closed by the user', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(
      dir,
      baseSession('s1', {
        rounds: [
          { label: 'The room draws breath.', text: 'a', endedBy: 'lull' },
          { label: 'The fire settles.', text: 'b', endedBy: 'budget' },
        ],
      })
    );
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['POST /api/sessions/:id/close'](fakeReq({ params: { id: 's1' } }), res);
    assert.equal(res.body.closedAt, 1);
    const saved = store.loadSession(dir, 's1');
    assert.equal(saved.rounds[1].endedBy, 'closed');
    assert.equal(saved.rounds[0].endedBy, 'lull', 'earlier passages keep their own end-cause');
  });

  // #354: interjections are real segments now, and the last segment isn't
  // necessarily a passage any more. "Let it end" answers a lull; only a
  // passage ends in one, so an interjection tacked on after it must be
  // skipped rather than wrongly marked as the thing the user closed.
  await t.test('skips a trailing interjection segment and closes the passage before it', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(
      dir,
      baseSession('s1', {
        rounds: [
          { label: 'The room draws breath.', text: 'a', endedBy: 'budget' },
          { kind: 'interjection', label: 'A Presence Passes Through', text: 'b', endedBy: 'budget' },
        ],
      })
    );
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['POST /api/sessions/:id/close'](fakeReq({ params: { id: 's1' } }), res);
    assert.equal(res.body.closedAt, 0);
    const saved = store.loadSession(dir, 's1');
    assert.equal(saved.rounds[0].endedBy, 'closed');
    assert.equal(saved.rounds[1].endedBy, 'budget', "the interjection's own end-cause is untouched");
  });

  await t.test('404s for a session that does not exist', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['POST /api/sessions/:id/close'](fakeReq({ params: { id: 'nope' } }), res);
    assert.equal(res.statusCode, 404);
  });

  await t.test('400s rather than closing a session with no passages', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1', { rounds: [] }));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['POST /api/sessions/:id/close'](fakeReq({ params: { id: 's1' } }), res);
    assert.equal(res.statusCode, 400);
  });
});

test('POST /api/sessions/:id/branch', async t => {
  await t.test('400s when roundIndex is out of range', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1'));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['POST /api/sessions/:id/branch'](fakeReq({ params: { id: 's1' }, body: { roundIndex: 5 } }), res);
    assert.equal(res.statusCode, 400);
  });

  await t.test('creates a truncated copy sharing history up to roundIndex', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(
      dir,
      baseSession('s1', {
        conversationHistory: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
        ],
      })
    );
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['POST /api/sessions/:id/branch'](fakeReq({ params: { id: 's1' }, body: { roundIndex: 0 } }), res);
    assert.ok(res.body.sessionId);
    const branch = store.loadSession(dir, res.body.sessionId);
    assert.equal(branch.parentId, 's1');
    assert.equal(branch.branchRound, 0);
    assert.equal(branch.rounds.length, 1);
  });
});

test('GET /api/sessions/:id/transcript', async t => {
  await t.test('weaves in a player-turn marker at the right round', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(
      dir,
      baseSession('s1', {
        transcriptText: 'HEADER\n— First Movement —\n\nCrowley —\nHello there.\n',
        playerTurns: [{ round: 0, speakerName: 'You', text: 'A player line' }],
      })
    );
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['GET /api/sessions/:id/transcript'](fakeReq({ params: { id: 's1' } }), res);
    assert.match(res.body.transcript, /played by a human participant, live/);
  });

  await t.test('#378: an unauthenticated request 404s (not 403) for an unpublished session', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1'));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['GET /api/sessions/:id/transcript'](fakeReq({ params: { id: 's1' }, authed: false }), res);
    assert.equal(res.statusCode, 404);
  });
});

test('PATCH /api/sessions/:id/publish + GET /reading-room/:id', async t => {
  await t.test('publishing sets published/publishedAt and the reading room then renders', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1'));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const publishRes = fakeRes();
    app.routes['PATCH /api/sessions/:id/publish'](
      fakeReq({ params: { id: 's1' }, body: { published: true } }),
      publishRes
    );
    assert.equal(publishRes.body.published, true);
    assert.equal(publishRes.body.url, '/reading-room/s1');

    const roomRes = fakeRes();
    app.routes['GET /reading-room/:id'](fakeReq({ params: { id: 's1' } }), roomRes);
    assert.match(roomRes.sentText, /s1/);
  });

  await t.test('an unpublished session 404s at the reading room rather than revealing it exists', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1'));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['GET /reading-room/:id'](fakeReq({ params: { id: 's1' } }), res);
    assert.equal(res.statusCode, 404);
  });

  await t.test('an unknown session id also 404s (same response either way)', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['GET /reading-room/:id'](fakeReq({ params: { id: 'nope' } }), res);
    assert.equal(res.statusCode, 404);
  });
});

test('POST /api/sessions/:id/verify-citations', async t => {
  await t.test('404s for an unknown session', async () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    await app.routes['POST /api/sessions/:id/verify-citations'](fakeReq({ params: { id: 'nope' } }), res);
    assert.equal(res.statusCode, 404);
  });

  // #355: extraction no longer happens in this route — it reads the
  // always-on citations already captured on session.rounds[].beats
  // (pipeline-disposition.js's piggyback) and runs only the grounding pass.
  await t.test('grounds and web-escalates citations already captured on beats, then stores citationFlags', async () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(
      dir,
      baseSession('s1', {
        rounds: [
          {
            label: 'First Movement',
            text: 'Crowley\nHello.',
            historyLength: 2,
            beats: [
              {
                memberId: 'crowley',
                text: 'Hello.',
                citations: [{ quote: 'a quote', work: 'A Work', verdict: 'uncertain', note: 'n', libraryMatch: null }],
              },
            ],
          },
        ],
      })
    );
    const app = fakeApp();
    registerSessionRoutes(
      app,
      makeDeps(dir, {
        groundAgainstLibraryText: async () => new Map([[0, { verdict: 'verified', note: 'grounded' }]]),
      })
    );
    const res = fakeRes();
    await app.routes['POST /api/sessions/:id/verify-citations'](fakeReq({ params: { id: 's1' } }), res);
    assert.equal(res.body.citations.length, 1);
    assert.equal(res.body.citations[0].speaker, 'Crowley');
    assert.equal(res.body.citations[0].verdict, 'verified');
    assert.equal(res.body.citations[0].source, 'library');
    assert.equal(store.loadSession(dir, 's1').citationFlags.length, 1);
  });

  await t.test('a session with no captured citations grounds an empty list rather than erroring', async () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    // baseSession's default rounds shape carries no `beats` at all — the
    // pre-#354/#355 case this route must degrade gracefully on, per
    // record.js's "readers degrade to the empty case" convention.
    store.saveSession(dir, baseSession('s1'));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    await app.routes['POST /api/sessions/:id/verify-citations'](fakeReq({ params: { id: 's1' } }), res);
    assert.equal(res.statusCode, null);
    assert.deepEqual(res.body.citations, []);
    assert.deepEqual(store.loadSession(dir, 's1').citationFlags, []);
  });

  await t.test('a thrown error mid-verification (the grounding pass) is caught and returns 500', async () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1'));
    const app = fakeApp();
    registerSessionRoutes(
      app,
      makeDeps(dir, {
        groundAgainstLibraryText: async () => {
          throw new Error('API error');
        },
      })
    );
    const res = fakeRes();
    await app.routes['POST /api/sessions/:id/verify-citations'](fakeReq({ params: { id: 's1' } }), res);
    assert.equal(res.statusCode, 500);
  });
});
