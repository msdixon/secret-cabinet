'use strict';

// #193 route-extraction — src/routes/member.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerMemberRoutes } = require('../src/routes/member.js');

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

function makeDeps(overrides = {}) {
  const roster = overrides.roster || [{ id: 'crowley', name: 'Crowley', file: 'crowley.md' }];
  return {
    roster,
    rosterModule: {
      extractSection: (text, section) => `${section}-extracted`,
      assignGlyph: () => '★',
    },
    loadMemberFile: filename => (filename === 'missing.md' ? '' : `# content of ${filename}`),
    membersDir: '/nonexistent',
    rosterFile: '/nonexistent/roster.json',
    client: { messages: { create: async () => ({ content: [{ type: 'text', text: 'GENERATED FILE' }] }) } },
    model: 'test-model',
    lodgeContext: '## REGISTER PERMISSIONS\nsome text\n## FORMAT — ACTIONS AND SPEECH\n',
    axesDoc: 'axes doc text',
    portraitStyleGuide: 'style guide text',
    portraitPromptExemplar: 'exemplar text',
    pendingPortraitPromptsFile: '/nonexistent/PENDING-PROMPTS.md',
    geminiApiKey: null,
    portraitCandidatesDir: '/nonexistent/candidates',
    generatePortraitImage: async () => {
      throw new Error('generatePortraitImage should not be called when geminiApiKey is unset');
    },
    ...overrides,
  };
}

test('registerMemberRoutes', async t => {
  await t.test('registers GET /api/members, GET /api/members/:id/dossier, POST /api/members', () => {
    const app = fakeApp();
    registerMemberRoutes(app, makeDeps());
    assert.equal(typeof app.routes['GET /api/members'], 'function');
    assert.equal(typeof app.routes['GET /api/members/:id/dossier'], 'function');
    assert.equal(typeof app.routes['POST /api/members'], 'function');
  });
});

test('GET /api/members', async t => {
  await t.test('returns the live roster array', () => {
    const app = fakeApp();
    const deps = makeDeps();
    registerMemberRoutes(app, deps);
    const res = fakeRes();
    app.routes['GET /api/members'](fakeReq(), res);
    assert.equal(res.body, deps.roster);
  });
});

test('GET /api/members/:id/dossier', async t => {
  await t.test('404s for an unknown member id', () => {
    const app = fakeApp();
    registerMemberRoutes(app, makeDeps());
    const res = fakeRes();
    app.routes['GET /api/members/:id/dossier'](fakeReq({ params: { id: 'nobody' } }), res);
    assert.equal(res.statusCode, 404);
  });

  await t.test('returns bio/voice extracted from the character file', () => {
    const app = fakeApp();
    registerMemberRoutes(app, makeDeps());
    const res = fakeRes();
    app.routes['GET /api/members/:id/dossier'](fakeReq({ params: { id: 'crowley' } }), res);
    assert.equal(res.body.name, 'Crowley');
    assert.equal(res.body.bio, 'WHO YOU ARE-extracted');
    assert.equal(res.body.voice, 'HOW YOU SPEAK-extracted');
  });

  await t.test('returns nulls for bio/voice when the character file is missing/empty', () => {
    const app = fakeApp();
    registerMemberRoutes(app, makeDeps({ roster: [{ id: 'ghost', name: 'Ghost', file: 'missing.md' }] }));
    const res = fakeRes();
    app.routes['GET /api/members/:id/dossier'](fakeReq({ params: { id: 'ghost' } }), res);
    assert.deepEqual(res.body, { id: 'ghost', name: 'Ghost', bio: null, voice: null });
  });
});

test('POST /api/members', async t => {
  await t.test('400s when name or bio is missing', async () => {
    const app = fakeApp();
    registerMemberRoutes(app, makeDeps());
    const res = fakeRes();
    await app.routes['POST /api/members'](fakeReq({ body: { name: 'Someone' } }), res);
    assert.equal(res.statusCode, 400);
  });

  await t.test('409s when a member file already exists for the slugified name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'member-routes-test-'));
    fs.writeFileSync(path.join(dir, 'a-taken-name.md'), 'existing');
    const app = fakeApp();
    registerMemberRoutes(app, makeDeps({ membersDir: dir }));
    const res = fakeRes();
    await app.routes['POST /api/members'](fakeReq({ body: { name: 'A Taken Name', bio: 'bio text' } }), res);
    assert.equal(res.statusCode, 409);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('drafts a character file, writes it, and pushes the new member into the live roster', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'member-routes-test-'));
    const rosterFile = path.join(dir, 'roster.json');
    const pendingPortraitPromptsFile = path.join(dir, 'PENDING-PROMPTS.md');
    const app = fakeApp();
    const deps = makeDeps({ membersDir: dir, rosterFile, pendingPortraitPromptsFile });
    registerMemberRoutes(app, deps);
    const res = fakeRes();
    await app.routes['POST /api/members'](fakeReq({ body: { name: 'New Member', bio: 'A biography.' } }), res);

    assert.equal(res.body.member.id, 'new-member');
    assert.equal(res.body.member.glyph, '★');
    assert.equal(res.body.characterFile, 'GENERATED FILE');
    assert.ok(fs.existsSync(path.join(dir, 'new-member.md')));
    assert.equal(fs.readFileSync(path.join(dir, 'new-member.md'), 'utf8'), 'GENERATED FILE');
    assert.ok(deps.roster.some(m => m.id === 'new-member'));
    assert.ok(fs.existsSync(rosterFile));

    // #259: portrait-prompt drafting reuses the same mocked client, appends
    // to the pending-prompts file, and comes back in the response.
    assert.equal(res.body.portraitPrompt, 'GENERATED FILE');
    assert.ok(fs.existsSync(pendingPortraitPromptsFile));
    const pendingContents = fs.readFileSync(pendingPortraitPromptsFile, 'utf8');
    assert.ok(pendingContents.includes('# Pending Portrait Prompts'));
    assert.ok(pendingContents.includes('GENERATED FILE'));

    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('member creation still succeeds when portrait-prompt drafting fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'member-routes-test-'));
    const rosterFile = path.join(dir, 'roster.json');
    const pendingPortraitPromptsFile = path.join(dir, 'PENDING-PROMPTS.md');
    let calls = 0;
    const app = fakeApp();
    const deps = makeDeps({
      membersDir: dir,
      rosterFile,
      pendingPortraitPromptsFile,
      client: {
        messages: {
          create: async () => {
            calls += 1;
            if (calls === 1) return { content: [{ type: 'text', text: 'GENERATED FILE' }] };
            throw new Error('portrait API down');
          },
        },
      },
    });
    registerMemberRoutes(app, deps);
    const res = fakeRes();
    await app.routes['POST /api/members'](fakeReq({ body: { name: 'Resilient Member', bio: 'A biography.' } }), res);

    assert.equal(res.body.member.id, 'resilient-member');
    assert.equal(res.body.characterFile, 'GENERATED FILE');
    assert.equal(res.body.portraitPrompt, null);
    assert.equal(fs.existsSync(pendingPortraitPromptsFile), false);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('with no geminiApiKey, no portrait image is generated (default: prompt-drafting only)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'member-routes-test-'));
    const rosterFile = path.join(dir, 'roster.json');
    const pendingPortraitPromptsFile = path.join(dir, 'PENDING-PROMPTS.md');
    const portraitCandidatesDir = path.join(dir, 'candidates');
    const app = fakeApp();
    const deps = makeDeps({ membersDir: dir, rosterFile, pendingPortraitPromptsFile, portraitCandidatesDir });
    registerMemberRoutes(app, deps);
    const res = fakeRes();
    await app.routes['POST /api/members'](fakeReq({ body: { name: 'No Key Member', bio: 'A biography.' } }), res);

    assert.equal(res.body.portraitCandidatePath, null);
    assert.equal(fs.existsSync(portraitCandidatesDir), false);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('#435: with a geminiApiKey set, generates and writes a portrait candidate', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'member-routes-test-'));
    const rosterFile = path.join(dir, 'roster.json');
    const pendingPortraitPromptsFile = path.join(dir, 'PENDING-PROMPTS.md');
    const portraitCandidatesDir = path.join(dir, 'candidates');
    const app = fakeApp();
    let capturedPrompt = null;
    const deps = makeDeps({
      membersDir: dir,
      rosterFile,
      pendingPortraitPromptsFile,
      portraitCandidatesDir,
      geminiApiKey: 'test-gemini-key',
      generatePortraitImage: async ({ apiKey, prompt }) => {
        capturedPrompt = prompt;
        assert.equal(apiKey, 'test-gemini-key');
        return Buffer.from('fake-png-bytes');
      },
    });
    registerMemberRoutes(app, deps);
    const res = fakeRes();
    await app.routes['POST /api/members'](
      fakeReq({ body: { name: 'Pictured Member', bio: 'A biography.' } }),
      res
    );

    assert.equal(res.body.portraitCandidatePath, 'public/portraits/candidates/pictured-member.png');
    const candidateFile = path.join(portraitCandidatesDir, 'pictured-member.png');
    assert.ok(fs.existsSync(candidateFile));
    assert.equal(fs.readFileSync(candidateFile, 'utf8'), 'fake-png-bytes');
    assert.equal(capturedPrompt, 'GENERATED FILE');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('#435: a failed image-generation call is caught -- member creation and prompt drafting still succeed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'member-routes-test-'));
    const rosterFile = path.join(dir, 'roster.json');
    const pendingPortraitPromptsFile = path.join(dir, 'PENDING-PROMPTS.md');
    const portraitCandidatesDir = path.join(dir, 'candidates');
    const app = fakeApp();
    const deps = makeDeps({
      membersDir: dir,
      rosterFile,
      pendingPortraitPromptsFile,
      portraitCandidatesDir,
      geminiApiKey: 'test-gemini-key',
      generatePortraitImage: async () => {
        throw new Error('Gemini API down');
      },
    });
    registerMemberRoutes(app, deps);
    const res = fakeRes();
    await app.routes['POST /api/members'](
      fakeReq({ body: { name: 'Unlucky Member', bio: 'A biography.' } }),
      res
    );

    assert.equal(res.body.member.id, 'unlucky-member');
    assert.ok(res.body.portraitPrompt);
    assert.equal(res.body.portraitCandidatePath, null);
    assert.equal(fs.existsSync(portraitCandidatesDir), false);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('a failed generation call is caught and returns 500 without writing anything', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'member-routes-test-'));
    const app = fakeApp();
    registerMemberRoutes(
      app,
      makeDeps({
        membersDir: dir,
        client: {
          messages: {
            create: async () => {
              throw new Error('API down');
            },
          },
        },
      })
    );
    const res = fakeRes();
    await app.routes['POST /api/members'](fakeReq({ body: { name: 'Doomed Member', bio: 'bio' } }), res);
    assert.equal(res.statusCode, 500);
    assert.equal(fs.existsSync(path.join(dir, 'doomed-member.md')), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
