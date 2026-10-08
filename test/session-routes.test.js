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
// #595: defaults to the open-mode local user, who owns everything, so tests
// that aren't about ownership stay valid; pass `user` to act as someone else.
function fakeReq({ params = {}, body = {}, query = {}, authed = true, user } = {}) {
  return {
    params,
    body,
    query,
    authed,
    user: user === undefined ? (authed ? { id: 'local', isAdmin: true } : null) : user,
  };
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
    type() {
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
    loadManifestSessions: () => [],
    buildCitationManifest: () => '# Citation Manifest',
    buildBibliography: () => '# Bibliography',
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

  await t.test(
    '#378: the published filter applies before ?q=, so an unauthenticated ?q= cannot match an unpublished session',
    () => {
      const dir = makeFixtureDir();
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      store.saveSession(dir, baseSession('s1', { entry: 'about silence', published: false }));
      const app = fakeApp();
      registerSessionRoutes(app, makeDeps(dir));
      const res = fakeRes();
      app.routes['GET /api/sessions'](fakeReq({ query: { q: 'silence' }, authed: false }), res);
      assert.deepEqual(res.body, []);
    }
  );

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

  await t.test('a sessions dir that cannot be read is caught, returns 500 rather than throwing', () => {
    const missingDir = path.join(os.tmpdir(), `session-routes-missing-${Date.now()}`);
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(missingDir));
    const res = fakeRes();
    app.routes['GET /api/sessions'](fakeReq(), res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Failed to list sessions' });
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

  await t.test('a sessions dir that cannot be read is caught, returns 500 rather than throwing', () => {
    const missingDir = path.join(os.tmpdir(), `session-routes-missing-${Date.now()}`);
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(missingDir));
    const res = fakeRes();
    app.routes['GET /api/threads'](fakeReq(), res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Failed to list threads' });
  });
});

test('GET /api/admin/citation-manifest', async t => {
  await t.test('returns the built manifest as markdown', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    let seenSessions;
    const app = fakeApp();
    registerSessionRoutes(
      app,
      makeDeps(dir, {
        loadManifestSessions: d => {
          seenSessions = d;
          return [{ id: 's1' }];
        },
        buildCitationManifest: sessions => `# Manifest (${sessions.length})`,
      })
    );
    const res = fakeRes();
    app.routes['GET /api/admin/citation-manifest'](fakeReq(), res);
    assert.equal(seenSessions, dir);
    assert.equal(res.sentText, '# Manifest (1)');
  });

  await t.test('a build failure is caught, returns 500 rather than throwing', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const app = fakeApp();
    registerSessionRoutes(
      app,
      makeDeps(dir, {
        loadManifestSessions: () => {
          throw new Error('disk error');
        },
      })
    );
    const res = fakeRes();
    app.routes['GET /api/admin/citation-manifest'](fakeReq(), res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Failed to build citation manifest' });
  });
});

test('GET /api/admin/bibliography', async t => {
  await t.test('returns the built bibliography as markdown', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const app = fakeApp();
    registerSessionRoutes(
      app,
      makeDeps(dir, {
        loadManifestSessions: () => [{ id: 's1' }],
        buildBibliography: sessions => `# Bibliography (${sessions.length})`,
      })
    );
    const res = fakeRes();
    app.routes['GET /api/admin/bibliography'](fakeReq(), res);
    assert.equal(res.sentText, '# Bibliography (1)');
  });

  await t.test('a build failure is caught, returns 500 rather than throwing', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const app = fakeApp();
    registerSessionRoutes(
      app,
      makeDeps(dir, {
        loadManifestSessions: () => {
          throw new Error('disk error');
        },
      })
    );
    const res = fakeRes();
    app.routes['GET /api/admin/bibliography'](fakeReq(), res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Failed to build bibliography' });
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

  await t.test('an unlink failure is caught, returns 500 rather than throwing', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    // Make unlinkSync itself throw — a deterministic way to reach the catch
    // without relying on filesystem permissions.
    store.saveSession(dir, baseSession('s1'));
    t.mock.method(fs, 'unlinkSync', () => {
      throw new Error('EPERM');
    });
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['DELETE /api/sessions/:id'](fakeReq({ params: { id: 's1' } }), res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Failed to delete session' });
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

  // #178: per-round curation. threeRoundSession has indices 0/1/2 to select from.
  function threeRoundSession(id, extra = {}) {
    return baseSession(id, {
      rounds: [
        { label: 'First', text: 'Crowley —\nOne.' },
        { label: 'Second', text: 'Crowley —\nTwo.' },
        { label: 'Third', text: 'Crowley —\nThree.' },
      ],
      ...extra,
    });
  }

  await t.test('publishedRounds is normalized to deduped, sorted, in-bounds indices', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, threeRoundSession('s1'));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['PATCH /api/sessions/:id/publish'](
      fakeReq({ params: { id: 's1' }, body: { published: true, publishedRounds: [2, 0, 2, 99, -1, 1.5, 'x'] } }),
      res
    );
    assert.deepEqual(res.body.publishedRounds, [0, 2]);
    assert.deepEqual(store.loadSession(dir, 's1').publishedRounds, [0, 2]);
  });

  await t.test('omitting publishedRounds from the request leaves the stored selection untouched', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, threeRoundSession('s1', { published: true, publishedRounds: [1] }));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['PATCH /api/sessions/:id/publish'](fakeReq({ params: { id: 's1' }, body: { published: true } }), res);
    assert.deepEqual(res.body.publishedRounds, [1]);
    assert.deepEqual(store.loadSession(dir, 's1').publishedRounds, [1]);
  });

  await t.test('an explicit null publishedRounds clears curation back to every passage', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, threeRoundSession('s1', { published: true, publishedRounds: [1] }));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['PATCH /api/sessions/:id/publish'](
      fakeReq({ params: { id: 's1' }, body: { published: true, publishedRounds: null } }),
      res
    );
    assert.equal(res.body.publishedRounds, null);
    assert.equal(store.loadSession(dir, 's1').publishedRounds, null);
  });

  await t.test('re-publishing to edit curation does not bump publishedAt', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, threeRoundSession('s1', { published: true, publishedAt: '2026-01-01T00:00:00.000Z' }));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['PATCH /api/sessions/:id/publish'](
      fakeReq({ params: { id: 's1' }, body: { published: true, publishedRounds: [0] } }),
      res
    );
    assert.equal(res.body.publishedAt, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(res.body.publishedRounds, [0]);
  });

  await t.test('unpublishing clears publishedAt but leaves publishedRounds for the next publish', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, threeRoundSession('s1', { published: true, publishedRounds: [0, 1] }));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    const res = fakeRes();
    app.routes['PATCH /api/sessions/:id/publish'](fakeReq({ params: { id: 's1' }, body: { published: false } }), res);
    assert.equal(res.body.published, false);
    assert.equal(res.body.publishedAt, null);
    assert.deepEqual(store.loadSession(dir, 's1').publishedRounds, [0, 1]);
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

  // #153 part 1's grounding pass reports its own usage back through a metrics
  // callback (`m => session.generationMetrics.push(m)`); the default stub
  // never invokes it, so it's otherwise never exercised.
  await t.test('grounding-pass metrics reported through the onMetric callback land on the session', async () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1'));
    const app = fakeApp();
    registerSessionRoutes(
      app,
      makeDeps(dir, {
        groundAgainstLibraryText: async (rawCitations, lookup, onMetric) => {
          onMetric({ phase: 'grounding', usage: {} });
          return new Map();
        },
      })
    );
    const res = fakeRes();
    await app.routes['POST /api/sessions/:id/verify-citations'](fakeReq({ params: { id: 's1' } }), res);
    assert.deepEqual(store.loadSession(dir, 's1').generationMetrics, [{ phase: 'grounding', usage: {} }]);
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

// #595 — sessions are private to their creator; `published` is the share.
test('per-user session isolation (#595)', async t => {
  const alice = { id: 'alice', name: 'Alice', email: 'a@x.org', isAdmin: false };
  const bob = { id: 'bob', name: 'Bob', email: 'b@x.org', isAdmin: false };
  const admin = { id: 'admin', name: 'Admin', email: 'r@x.org', isAdmin: true };
  const setup = () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('mine', { ownerId: 'alice' }));
    store.saveSession(dir, baseSession('theirs', { ownerId: 'bob' }));
    store.saveSession(dir, baseSession('shared', { ownerId: 'bob', published: true }));
    const app = fakeApp();
    registerSessionRoutes(
      app,
      makeDeps(dir, { users: { findById: id => [alice, bob, admin].find(u => u.id === id) } })
    );
    return { dir, app };
  };

  await t.test('the shelf lists only the caller’s own sessions', () => {
    const { app } = setup();
    const res = fakeRes();
    app.routes['GET /api/sessions'](fakeReq({ user: alice }), res);
    assert.deepEqual(
      res.body.map(s => s.id),
      ['mine']
    );
  });

  await t.test('another user’s private session is 404 to read, edit, or delete', () => {
    const { app, dir } = setup();
    for (const route of ['GET /api/sessions/:id', 'GET /api/sessions/:id/transcript']) {
      const res = fakeRes();
      app.routes[route](fakeReq({ params: { id: 'theirs' }, user: alice }), res);
      assert.equal(res.statusCode, 404, route);
    }
    const res = fakeRes();
    app.routes['DELETE /api/sessions/:id'](fakeReq({ params: { id: 'theirs' }, user: alice }), res);
    assert.equal(res.statusCode, 404);
    assert.ok(store.loadSession(dir, 'theirs'));
  });

  await t.test('a published session is readable but not writable by others', () => {
    const { app, dir } = setup();
    const read = fakeRes();
    app.routes['GET /api/sessions/:id'](fakeReq({ params: { id: 'shared' }, user: alice }), read);
    assert.equal(read.body.id, 'shared');
    const del = fakeRes();
    app.routes['DELETE /api/sessions/:id'](fakeReq({ params: { id: 'shared' }, user: alice }), del);
    assert.equal(del.statusCode, 404);
    assert.ok(store.loadSession(dir, 'shared'));
  });

  await t.test('admin metadata view lists owners and never entry text for unpublished sessions', () => {
    const { app } = setup();
    const res = fakeRes();
    app.routes['GET /api/admin/sessions'](fakeReq({ user: admin }), res);
    const rows = Object.fromEntries(res.body.sessions.map(r => [r.id, r]));
    assert.equal(rows.mine.ownerEmail, 'a@x.org');
    assert.equal(rows.theirs.ownerName, 'Bob');
    assert.equal(rows.theirs.entry, undefined);
    assert.equal(rows.shared.entry, 'The source entry');
    assert.equal(JSON.stringify(res.body).includes('Hello.'), false);
  });
});

// #625: the narrow, opt-in share — only the keeper (admin) gains read access.
test('PATCH /api/sessions/:id/share-with-keeper (#625)', async t => {
  const owner = { id: 'guest1', isAdmin: false };
  const other = { id: 'guest2', isAdmin: false };
  const admin = { id: 'admin', isAdmin: true };
  function setup() {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store.saveSession(dir, baseSession('s1', { ownerId: owner.id }));
    const app = fakeApp();
    registerSessionRoutes(app, makeDeps(dir));
    return app;
  }
  const share = (app, user, shared) => {
    const res = fakeRes();
    app.routes['PATCH /api/sessions/:id/share-with-keeper'](
      fakeReq({ params: { id: 's1' }, body: { shared }, user }),
      res
    );
    return res;
  };
  const get = (app, user) => {
    const res = fakeRes();
    app.routes['GET /api/sessions/:id'](fakeReq({ params: { id: 's1' }, user }), res);
    return res;
  };

  await t.test('not shared: the admin gets 404 like any other non-owner', () => {
    const app = setup();
    assert.equal(get(app, admin).statusCode, 404);
  });

  await t.test('owner shares: admin can read, another guest still 404s; unsharing closes it again', () => {
    const app = setup();
    assert.equal(share(app, owner, true).body.sharedWithKeeper, true);
    assert.notEqual(get(app, admin).statusCode, 404);
    assert.equal(get(app, other).statusCode, 404);
    assert.equal(share(app, owner, false).body.sharedWithKeeper, false);
    assert.equal(get(app, admin).statusCode, 404);
  });

  await t.test('only the owner can toggle it, and the body must be boolean', () => {
    const app = setup();
    assert.equal(share(app, other, true).statusCode, 404);
    assert.equal(share(app, admin, true).statusCode, 404);
    assert.equal(share(app, owner, 'yes').statusCode, 400);
  });
});
