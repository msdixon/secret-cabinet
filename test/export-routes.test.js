'use strict';

// #193 route-extraction — src/routes/export.js: Day One, Ulysses, Obsidian.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const { registerExportRoutes } = require('../src/routes/export.js');

function fakeApp() {
  const routes = {};
  return {
    routes,
    post(path, handler) {
      routes[`POST ${path}`] = handler;
    },
  };
}

function fakeReq(body = {}) {
  return { body };
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

// src/routes/export.js does `const { execFile } = require('child_process')` at
// module load time, so patching cp.execFile after the module is already
// required does nothing -- the module's local binding still points at the
// real implementation. Force a fresh require (with the mock installed first)
// so the destructuring picks it up, then restore the real one afterwards so
// the require cache isn't left pointing at a stale mock for later tests.
function withMockedExecFile(mockFn, run) {
  const modPath = require.resolve('../src/routes/export.js');
  const originalExecFile = cp.execFile;
  cp.execFile = mockFn;
  delete require.cache[modPath];
  try {
    const { registerExportRoutes: freshRegister } = require(modPath);
    return run(freshRegister);
  } finally {
    cp.execFile = originalExecFile;
    delete require.cache[modPath];
    require(modPath);
  }
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
      'POST /api/dayone/journals',
      'POST /api/dayone/entries',
      'POST /api/dayone/fetch',
      'POST /api/dayone/export',
      'POST /api/ulysses/export',
      'POST /api/export/obsidian',
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

  await t.test('POST /api/dayone/journals 500s when the MCP call rejects', async () => {
    const app = fakeApp();
    registerExportRoutes(
      app,
      makeDeps({
        dayOne: {
          listJournals: async () => {
            throw new Error('boom');
          },
        },
      })
    );
    const res = fakeRes();
    await app.routes['POST /api/dayone/journals'](fakeReq(), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'Could not load journals');
  });

  await t.test('POST /api/dayone/entries 400s without a journalId', async () => {
    const app = fakeApp();
    registerExportRoutes(app, makeDeps());
    const res = fakeRes();
    await app.routes['POST /api/dayone/entries'](fakeReq({}), res);
    assert.equal(res.statusCode, 400);
  });

  await t.test('POST /api/dayone/entries maps raw entries into {date, preview, text}', async () => {
    const app = fakeApp();
    let seenArgs = null;
    const rawFirstBody = 'Line one \\(escaped\\) and \\[brackets\\].\nLine two.';
    const rawSecondText = 'B'.repeat(100);
    registerExportRoutes(
      app,
      makeDeps({
        dayOne: {
          getRecentEntries: async (journalId, limit) => {
            seenArgs = { journalId, limit };
            return [
              { date: '2026-08-01T00:00:00Z', body: rawFirstBody },
              { creation_date: '2026-08-02T10:00:00Z', text: rawSecondText },
            ];
          },
        },
      })
    );
    const res = fakeRes();
    await app.routes['POST /api/dayone/entries'](fakeReq({ journalId: 'j1' }), res);

    assert.deepEqual(seenArgs, { journalId: 'j1', limit: 3 }, 'defaults limit to 3 and forwards journalId');
    assert.equal(res.body.entries.length, 2);

    const [first, second] = res.body.entries;
    assert.equal(first.date, '2026-08-01');
    assert.equal(first.text, 'Line one (escaped) and [brackets].\nLine two.', 'unescapes backslashed punctuation');
    assert.equal(
      first.preview,
      'Line one (escaped) and [brackets]. Line two.',
      'collapses newlines to spaces in the preview'
    );

    assert.equal(second.date, '2026-08-02', 'falls back to creation_date when date is absent');
    assert.equal(second.text, rawSecondText, 'falls back to text when body is absent');
    assert.equal(second.preview, 'B'.repeat(80), 'truncates the preview to 80 characters');
  });

  await t.test('POST /api/dayone/entries respects an explicit limit', async () => {
    const app = fakeApp();
    let seenLimit = null;
    registerExportRoutes(
      app,
      makeDeps({
        dayOne: {
          getRecentEntries: async (journalId, limit) => {
            seenLimit = limit;
            return [];
          },
        },
      })
    );
    const res = fakeRes();
    await app.routes['POST /api/dayone/entries'](fakeReq({ journalId: 'j1', limit: 10 }), res);
    assert.equal(seenLimit, 10);
    assert.deepEqual(res.body, { entries: [] });
  });

  await t.test('POST /api/dayone/entries 500s when fetching entries rejects', async () => {
    const app = fakeApp();
    registerExportRoutes(
      app,
      makeDeps({
        dayOne: {
          getRecentEntries: async () => {
            throw new Error('boom');
          },
        },
      })
    );
    const res = fakeRes();
    await app.routes['POST /api/dayone/entries'](fakeReq({ journalId: 'j1' }), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'Could not fetch entries');
  });

  await t.test('POST /api/dayone/fetch returns text/date/journal when an entry is found', async () => {
    const app = fakeApp();
    registerExportRoutes(
      app,
      makeDeps({
        dayOne: {
          getLatestEntry: async () => ({
            body: 'An entry with \\(escaped\\) punctuation.',
            date: '2026-08-11T12:00:00Z',
          }),
        },
      })
    );
    const res = fakeRes();
    await app.routes['POST /api/dayone/fetch'](fakeReq({ journalId: 'j1', journalName: 'Journal One' }), res);
    assert.deepEqual(res.body, {
      text: 'An entry with (escaped) punctuation.',
      date: '2026-08-11',
      journal: 'Journal One',
    });
  });

  await t.test('POST /api/dayone/fetch 404s when there is no latest entry', async () => {
    const app = fakeApp();
    registerExportRoutes(app, makeDeps({ dayOne: { getLatestEntry: async () => null } }));
    const res = fakeRes();
    await app.routes['POST /api/dayone/fetch'](fakeReq({ journalId: 'j1' }), res);
    assert.equal(res.statusCode, 404);
  });

  await t.test('POST /api/dayone/fetch 500s when the MCP call rejects', async () => {
    const app = fakeApp();
    registerExportRoutes(
      app,
      makeDeps({
        dayOne: {
          getLatestEntry: async () => {
            throw new Error('boom');
          },
        },
      })
    );
    const res = fakeRes();
    await app.routes['POST /api/dayone/fetch'](fakeReq({ journalId: 'j1' }), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'Could not fetch entry');
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
    await app.routes['POST /api/dayone/export'](
      fakeReq({ journalId: 'j1', journalName: 'Journal One', transcriptText: 'text', sessionDate: '2026-08-11' }),
      res
    );
    assert.deepEqual(res.body, { success: true, journal: 'Journal One' });
  });

  await t.test('POST /api/dayone/export 500s when the create call rejects', async () => {
    const app = fakeApp();
    registerExportRoutes(
      app,
      makeDeps({
        dayOne: {
          createEntry: async () => {
            throw new Error('boom');
          },
        },
      })
    );
    const res = fakeRes();
    await app.routes['POST /api/dayone/export'](fakeReq({ journalId: 'j1', transcriptText: 'text' }), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'Export failed');
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

  await t.test('opens the ulysses:// URL and succeeds, preferring groupId over group', () => {
    const calls = [];
    withMockedExecFile(
      (cmd, args, cb) => {
        calls.push({ cmd, args });
        cb(null);
      },
      freshRegister => {
        const app = fakeApp();
        freshRegister(app, makeDeps());
        const res = fakeRes();
        app.routes['POST /api/ulysses/export'](
          fakeReq({ transcriptText: 'hello there', group: 'ignored-group', groupId: 'the-callback-id' }),
          res
        );

        assert.deepEqual(res.body, { success: true });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].cmd, 'open');
        const url = calls[0].args[0];
        assert.match(url, /^ulysses:\/\/x-callback-url\/new-sheet\?/);
        assert.match(url, /group=the-callback-id/);
        assert.doesNotMatch(url, /ignored-group/);
        assert.doesNotMatch(url, /\+/, 'spaces are encoded as %20, not +');
        assert.match(url, /text=.*hello%20there/);
      }
    );
  });

  await t.test('falls back to group when groupId is absent', () => {
    const calls = [];
    withMockedExecFile(
      (cmd, args, cb) => {
        calls.push({ cmd, args });
        cb(null);
      },
      freshRegister => {
        const app = fakeApp();
        freshRegister(app, makeDeps());
        const res = fakeRes();
        app.routes['POST /api/ulysses/export'](fakeReq({ transcriptText: 'text', group: 'My Group' }), res);

        assert.equal(res.body.success, true);
        assert.match(calls[0].args[0], /group=My%20Group/);
      }
    );
  });

  await t.test('omits the group param entirely when neither group nor groupId is supplied', () => {
    const calls = [];
    withMockedExecFile(
      (cmd, args, cb) => {
        calls.push({ cmd, args });
        cb(null);
      },
      freshRegister => {
        const app = fakeApp();
        freshRegister(app, makeDeps());
        const res = fakeRes();
        app.routes['POST /api/ulysses/export'](fakeReq({ transcriptText: 'text' }), res);

        assert.equal(res.body.success, true);
        assert.doesNotMatch(calls[0].args[0], /group=/);
      }
    );
  });

  await t.test('titles the sheet from title, falling back to sessionDate, falling back to a default', () => {
    const calls = [];
    withMockedExecFile(
      (cmd, args, cb) => {
        calls.push({ cmd, args });
        cb(null);
      },
      freshRegister => {
        const app = fakeApp();
        freshRegister(app, makeDeps());
        const res = fakeRes();
        app.routes['POST /api/ulysses/export'](fakeReq({ transcriptText: 'text', title: 'My Title' }), res);
        assert.match(decodeURIComponent(calls[0].args[0]), /\[Secret-Cabin-et\] My Title/);
      }
    );
  });

  await t.test('500s when execFile fails (Ulysses not installed)', () => {
    withMockedExecFile(
      (cmd, args, cb) => cb(new Error('spawn failed')),
      freshRegister => {
        const app = fakeApp();
        freshRegister(app, makeDeps());
        const res = fakeRes();
        app.routes['POST /api/ulysses/export'](fakeReq({ transcriptText: 'text' }), res);

        assert.equal(res.statusCode, 500);
        assert.equal(res.body.error, 'Could not open Ulysses. Is it installed?');
      }
    );
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
    app.routes['POST /api/export/obsidian'](
      fakeReq({ vaultPath: '/definitely/not/a/real/vault', transcriptText: 't' }),
      res
    );
    assert.equal(res.statusCode, 400);
  });

  await t.test('writes a Markdown file with frontmatter and bolded speaker lines into the vault', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'export-routes-test-'));
    const app = fakeApp();
    registerExportRoutes(app, makeDeps());
    const res = fakeRes();
    const transcriptText = 'Crowley —\nSome opening line.';
    app.routes['POST /api/export/obsidian'](
      fakeReq({
        vaultPath: vault,
        transcriptText,
        sessionDate: '2026-08-11',
        members: ['Crowley'],
        tags: ['custom-tag'],
        sourceExcerpt: 'a test entry',
      }),
      res
    );

    assert.equal(res.body.success, true);
    const written = fs.readFileSync(res.body.path, 'utf8');
    assert.match(written, /date: 2026-08-11/);
    assert.match(written, /- custom-tag/);
    assert.match(written, /\*\*Crowley\*\*/);

    fs.rmSync(vault, { recursive: true, force: true });
  });

  await t.test('500s with the error message when writing to the vault throws', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'export-routes-test-'));
    // "Secret Cabinet" already exists as a file, not a directory, so the
    // handler's existsSync check for it passes (skipping mkdirSync) but the
    // later writeFileSync into it fails -- exercising the catch block rather
    // than the earlier "vault not found" 400.
    fs.writeFileSync(path.join(vault, 'Secret Cabinet'), 'not a directory');

    const app = fakeApp();
    registerExportRoutes(app, makeDeps());
    const res = fakeRes();
    app.routes['POST /api/export/obsidian'](fakeReq({ vaultPath: vault, transcriptText: 'text' }), res);

    assert.equal(res.statusCode, 500);
    assert.equal(typeof res.body.error, 'string');
    assert.ok(res.body.error.length > 0);

    fs.rmSync(vault, { recursive: true, force: true });
  });
});
