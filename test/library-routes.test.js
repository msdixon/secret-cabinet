'use strict';

// #193 route-extraction — library-routes.js. Same fakeApp()/fakeReq()/
// fakeRes() convention as auth.test.js: handlers are recorded by
// registerLibraryRoutes and invoked directly, no real server or supertest.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerLibraryRoutes } = require('../library-routes.js');

function fakeApp() {
  const routes = {};
  return { routes, get(path, handler) { routes[`GET ${path}`] = handler; } };
}

function fakeReq({ params = {}, query = {} } = {}) {
  return { params, query };
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

const FIXTURE_ENTRIES = [
  { id: 'crowley-liber-al', title: 'Liber AL', source: 'The Book of the Law', file: 'crowley-liber-al.md', members: ['crowley'], themes: ['thelema'] },
  { id: 'jung-red-book', title: 'The Red Book', source: 'Liber Novus', file: 'jung-red-book.md', members: ['jung'], themes: ['individuation'] },
];

function makeDeps({ entries = FIXTURE_ENTRIES, images = {}, fileText = null } = {}) {
  return {
    loadLibraryIndex: () => entries,
    loadArchiveImageIndex: () => images,
    parseLibraryFrontmatter: () => ({ citation: 'A Citation', source_url: 'https://example.com' }),
    libraryDir: '/nonexistent/library-dir',
    _fileText: fileText,
  };
}

test('registerLibraryRoutes', async t => {
  await t.test('registers GET /api/library and GET /api/library/:id', () => {
    const app = fakeApp();
    registerLibraryRoutes(app, makeDeps());
    assert.equal(typeof app.routes['GET /api/library'], 'function');
    assert.equal(typeof app.routes['GET /api/library/:id'], 'function');
  });
});

test('GET /api/library', async t => {
  await t.test('returns every entry with an image field defaulted to null', () => {
    const app = fakeApp();
    registerLibraryRoutes(app, makeDeps());
    const res = fakeRes();
    app.routes['GET /api/library'](fakeReq(), res);
    assert.equal(res.body.length, 2);
    assert.equal(res.body[0].image, null);
  });

  await t.test('attaches an image when the archive index has one for that entry', () => {
    const app = fakeApp();
    registerLibraryRoutes(app, makeDeps({ images: { 'crowley-liber-al': { image: '/archive/x.jpg' } } }));
    const res = fakeRes();
    app.routes['GET /api/library'](fakeReq(), res);
    assert.equal(res.body.find(e => e.id === 'crowley-liber-al').image, '/archive/x.jpg');
  });

  await t.test('?member= filters to entries listing that member', () => {
    const app = fakeApp();
    registerLibraryRoutes(app, makeDeps());
    const res = fakeRes();
    app.routes['GET /api/library'](fakeReq({ query: { member: 'jung' } }), res);
    assert.deepEqual(res.body.map(e => e.id), ['jung-red-book']);
  });

  await t.test('?q= matches title, source, themes, or members (case-insensitive)', () => {
    const app = fakeApp();
    registerLibraryRoutes(app, makeDeps());
    const res = fakeRes();
    app.routes['GET /api/library'](fakeReq({ query: { q: 'RED book' } }), res);
    assert.deepEqual(res.body.map(e => e.id), ['jung-red-book']);
  });

  await t.test('a broken library index is caught, returns 500 rather than throwing', () => {
    const app = fakeApp();
    registerLibraryRoutes(app, {
      loadLibraryIndex: () => { throw new Error('disk error'); },
      loadArchiveImageIndex: () => ({}),
      parseLibraryFrontmatter: () => ({}),
      libraryDir: '/x',
    });
    const res = fakeRes();
    app.routes['GET /api/library'](fakeReq(), res);
    assert.equal(res.statusCode, 500);
  });
});

test('GET /api/library/:id', async t => {
  await t.test('404s when no entry matches the id', () => {
    const app = fakeApp();
    registerLibraryRoutes(app, makeDeps());
    const res = fakeRes();
    app.routes['GET /api/library/:id'](fakeReq({ params: { id: 'nonexistent' } }), res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'Entry not found' });
  });

  await t.test('404s when the entry exists in the index but its file is missing on disk', () => {
    const app = fakeApp();
    registerLibraryRoutes(app, makeDeps());
    const res = fakeRes();
    app.routes['GET /api/library/:id'](fakeReq({ params: { id: 'crowley-liber-al' } }), res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'File not found' });
  });

  await t.test('strips frontmatter and returns text + citation for a real file on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-routes-test-'));
    fs.writeFileSync(path.join(dir, 'crowley-liber-al.md'), '---\ncitation: "A Citation"\n---\nThe excerpt text.');
    const deps = makeDeps();
    deps.libraryDir = dir;
    const app = fakeApp();
    registerLibraryRoutes(app, deps);
    const res = fakeRes();
    app.routes['GET /api/library/:id'](fakeReq({ params: { id: 'crowley-liber-al' } }), res);
    assert.equal(res.body.text, 'The excerpt text.');
    assert.equal(res.body.citation, 'A Citation');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
