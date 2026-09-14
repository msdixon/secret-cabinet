'use strict';

// #422 — visits.js, the visitation-metrics module for the public read tier.
// No Express app spun up, same fakeReq convention as auth.test.js. File I/O
// is exercised against a tmpdir, the same pattern session-routes.test.js
// uses for real sessions-store.js persistence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const visits = require('../src/visits.js');

function fakeReq({ path: reqPath, method = 'GET' } = {}) {
  return { path: reqPath, method };
}

test('classifyVisit', async t => {
  await t.test('labels the app-shell pages', () => {
    assert.equal(visits.classifyVisit(fakeReq({ path: '/' })), 'GET /');
    assert.equal(visits.classifyVisit(fakeReq({ path: '/lodge' })), 'GET /lodge');
    assert.equal(visits.classifyVisit(fakeReq({ path: '/reading-room/abc123' })), 'GET /reading-room/:id');
  });

  await t.test('does not label static assets', () => {
    for (const p of ['/app.js', '/css/style.css', '/portraits/crowley.png', '/vendor/babylonjs/babylon.js']) {
      assert.equal(visits.classifyVisit(fakeReq({ path: p })), null, `expected ${p} not to be counted`);
    }
  });

  await t.test('labels the public read-only API routes distinctly, including templated ones', () => {
    assert.equal(visits.classifyVisit(fakeReq({ path: '/api/sessions' })), 'GET /api/sessions');
    assert.equal(visits.classifyVisit(fakeReq({ path: '/api/sessions/abc123' })), 'GET /api/sessions/:id');
    assert.equal(
      visits.classifyVisit(fakeReq({ path: '/api/sessions/abc123/transcript' })),
      'GET /api/sessions/:id/transcript'
    );
    assert.equal(
      visits.classifyVisit(fakeReq({ path: '/api/members/crowley/dossier' })),
      'GET /api/members/:id/dossier'
    );
    assert.equal(visits.classifyVisit(fakeReq({ path: '/api/voice/speak', method: 'POST' })), 'POST /api/voice/speak');
  });

  await t.test('does not label gated/mutating API calls', () => {
    for (const [method, p] of [
      ['DELETE', '/api/sessions/abc123'],
      ['POST', '/api/convene'],
      ['GET', '/api/admin/visits'],
    ]) {
      assert.equal(
        visits.classifyVisit(fakeReq({ path: p, method })),
        null,
        `expected ${method} ${p} not to be counted`
      );
    }
  });

  await t.test('does not label a non-GET/HEAD request to a shell path', () => {
    assert.equal(visits.classifyVisit(fakeReq({ path: '/lodge', method: 'POST' })), null);
  });
});

test('classifyGatedVisit', async t => {
  await t.test('labels convene/cast/round/interject', () => {
    assert.equal(visits.classifyGatedVisit(fakeReq({ path: '/api/convene', method: 'POST' })), 'POST /api/convene');
    assert.equal(visits.classifyGatedVisit(fakeReq({ path: '/api/cast', method: 'POST' })), 'POST /api/cast');
    assert.equal(visits.classifyGatedVisit(fakeReq({ path: '/api/round', method: 'POST' })), 'POST /api/round');
    assert.equal(visits.classifyGatedVisit(fakeReq({ path: '/api/interject', method: 'POST' })), 'POST /api/interject');
  });

  await t.test('does not label the local-only prototype route', () => {
    assert.equal(visits.classifyGatedVisit(fakeReq({ path: '/api/prototype/round', method: 'POST' })), null);
  });

  await t.test('does not label public-tier or unrelated requests', () => {
    for (const [method, p] of [
      ['GET', '/'],
      ['GET', '/api/sessions'],
      ['GET', 'api/convene'],
      ['DELETE', '/api/sessions/abc123'],
    ]) {
      assert.equal(
        visits.classifyGatedVisit(fakeReq({ path: p, method })),
        null,
        `expected ${method} ${p} not to be counted`
      );
    }
  });
});

test('recordVisit', async t => {
  let tmpDir;
  let filePath;

  t.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visits-test-'));
    filePath = path.join(tmpDir, 'visits.json');
  });

  t.afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await t.test('increments total, byDate, and byRoute, and persists to disk', () => {
    const store = visits.emptyStore();
    const now = new Date('2026-08-25T12:00:00Z');
    const label = visits.recordVisit(filePath, store, fakeReq({ path: '/' }), now);

    assert.equal(label, 'GET /');
    assert.equal(store.total, 1);
    assert.equal(store.byDate['2026-08-25'], 1);
    assert.equal(store.byRoute['GET /'], 1);

    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(onDisk.total, 1);
  });

  await t.test('returns null and leaves the store untouched for an uncountable request', () => {
    const store = visits.emptyStore();
    const label = visits.recordVisit(filePath, store, fakeReq({ path: '/app.js' }));
    assert.equal(label, null);
    assert.equal(store.total, 0);
    assert.equal(fs.existsSync(filePath), false);
  });

  await t.test('accumulates across multiple calls', () => {
    const store = visits.emptyStore();
    const day1 = new Date('2026-08-25T12:00:00Z');
    const day2 = new Date('2026-08-26T09:00:00Z');
    visits.recordVisit(filePath, store, fakeReq({ path: '/' }), day1);
    visits.recordVisit(filePath, store, fakeReq({ path: '/reading-room/xyz' }), day1);
    visits.recordVisit(filePath, store, fakeReq({ path: '/' }), day2);

    assert.equal(store.total, 3);
    assert.deepEqual(store.byDate, { '2026-08-25': 2, '2026-08-26': 1 });
    assert.equal(store.byRoute['GET /'], 2);
    assert.equal(store.byRoute['GET /reading-room/:id'], 1);
  });
});

test('recordGatedVisit', async t => {
  let tmpDir;
  let filePath;

  t.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visits-test-'));
    filePath = path.join(tmpDir, 'visits.json');
  });

  t.afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await t.test('increments gatedTotal, gatedByDate, and gatedByRoute, and persists to disk', () => {
    const store = visits.emptyStore();
    const now = new Date('2026-08-25T12:00:00Z');
    const label = visits.recordGatedVisit(filePath, store, fakeReq({ path: '/api/convene', method: 'POST' }), now);

    assert.equal(label, 'POST /api/convene');
    assert.equal(store.gatedTotal, 1);
    assert.equal(store.gatedByDate['2026-08-25'], 1);
    assert.equal(store.gatedByRoute['POST /api/convene'], 1);
    // The public-tier fields are untouched by a gated-side record.
    assert.equal(store.total, 0);

    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(onDisk.gatedTotal, 1);
  });

  await t.test('returns null and leaves the store untouched for an uncountable request', () => {
    const store = visits.emptyStore();
    const label = visits.recordGatedVisit(filePath, store, fakeReq({ path: '/api/prototype/round', method: 'POST' }));
    assert.equal(label, null);
    assert.equal(store.gatedTotal, 0);
    assert.equal(fs.existsSync(filePath), false);
  });

  await t.test('accumulates across multiple calls and routes', () => {
    const store = visits.emptyStore();
    const day1 = new Date('2026-08-25T12:00:00Z');
    const day2 = new Date('2026-08-26T09:00:00Z');
    visits.recordGatedVisit(filePath, store, fakeReq({ path: '/api/convene', method: 'POST' }), day1);
    visits.recordGatedVisit(filePath, store, fakeReq({ path: '/api/round', method: 'POST' }), day1);
    visits.recordGatedVisit(filePath, store, fakeReq({ path: '/api/convene', method: 'POST' }), day2);

    assert.equal(store.gatedTotal, 3);
    assert.deepEqual(store.gatedByDate, { '2026-08-25': 2, '2026-08-26': 1 });
    assert.equal(store.gatedByRoute['POST /api/convene'], 2);
    assert.equal(store.gatedByRoute['POST /api/round'], 1);
  });
});

test('loadStore', async t => {
  let tmpDir;

  t.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visits-test-'));
  });

  t.afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await t.test('returns an empty store when the file does not exist yet', () => {
    const store = visits.loadStore(path.join(tmpDir, 'missing.json'));
    assert.deepEqual(store, visits.emptyStore());
  });

  await t.test('round-trips a saved store', () => {
    const filePath = path.join(tmpDir, 'visits.json');
    const store = {
      total: 5,
      byDate: { '2026-08-25': 5 },
      byRoute: { 'GET /': 5 },
      gatedTotal: 2,
      gatedByDate: { '2026-08-25': 2 },
      gatedByRoute: { 'POST /api/convene': 2 },
    };
    visits.saveStore(filePath, store);
    assert.deepEqual(visits.loadStore(filePath), store);
  });
});

test('buildReport', async t => {
  await t.test('splits the headline traffic figure from page views only, not API calls', () => {
    const store = {
      total: 6,
      byDate: { '2026-08-24': 1, '2026-08-25': 5 },
      byRoute: { 'GET /': 2, 'GET /reading-room/:id': 1, 'GET /api/members': 2, 'GET /api/voice/config': 1 },
    };
    const report = visits.buildReport(store);
    // Headline is page views only (2 + 1 = 3), not the blended total (6).
    assert.match(report, /3 page view\(s\) recorded/);
    assert.doesNotMatch(report, /6 page view\(s\)/);
  });

  await t.test('renders traffic (page routes) and API calls as separate tables', () => {
    const store = {
      total: 6,
      byDate: { '2026-08-24': 1, '2026-08-25': 5 },
      byRoute: { 'GET /': 2, 'GET /reading-room/:id': 1, 'GET /api/members': 2, 'GET /api/voice/config': 1 },
    };
    const report = visits.buildReport(store);

    const trafficSection = report.split('## Traffic by page')[1].split('## Last 7 days')[0];
    assert.match(trafficSection, /\| GET \/ \| 2 \|/);
    assert.match(trafficSection, /\| GET \/reading-room\/:id \| 1 \|/);
    assert.doesNotMatch(trafficSection, /api/);

    const apiSection = report.split('## API calls')[1];
    assert.match(apiSection, /3 call\(s\) recorded/);
    assert.match(apiSection, /\| GET \/api\/members \| 2 \|/);
    assert.match(apiSection, /\| GET \/api\/voice\/config \| 1 \|/);
    assert.doesNotMatch(apiSection, /\| GET \/ \| /);
  });

  await t.test('keeps the last-7-days table as combined page+API event counts', () => {
    const store = {
      total: 6,
      byDate: { '2026-08-24': 1, '2026-08-25': 5 },
      byRoute: { 'GET /': 2, 'GET /reading-room/:id': 1, 'GET /api/members': 2, 'GET /api/voice/config': 1 },
    };
    const report = visits.buildReport(store);
    assert.match(report, /\| 2026-08-24 \| 1 \|/);
    assert.match(report, /\| 2026-08-25 \| 5 \|/);
  });

  await t.test('renders sensibly with no data yet', () => {
    const report = visits.buildReport(visits.emptyStore());
    assert.match(report, /0 page view\(s\) recorded/);
    assert.match(report, /0 call\(s\) recorded/);
    assert.match(report, /0 interaction\(s\) recorded/);
  });

  await t.test('renders the gated-interactions section from the gated* fields', () => {
    const store = {
      ...visits.emptyStore(),
      gatedTotal: 3,
      gatedByDate: { '2026-08-24': 1, '2026-08-25': 2 },
      gatedByRoute: { 'POST /api/convene': 2, 'POST /api/round': 1 },
    };
    const report = visits.buildReport(store);
    const gatedSection = report.split('## Gated interactions')[1];

    assert.match(gatedSection, /3 interaction\(s\) recorded/);
    assert.match(gatedSection, /\| POST \/api\/convene \| 2 \|/);
    assert.match(gatedSection, /\| POST \/api\/round \| 1 \|/);
    assert.match(gatedSection, /\| 2026-08-24 \| 1 \|/);
    assert.match(gatedSection, /\| 2026-08-25 \| 2 \|/);
  });

  await t.test('is unaffected by a store missing the gated* fields (pre-#583 data)', () => {
    const store = { total: 1, byDate: { '2026-08-25': 1 }, byRoute: { 'GET /': 1 } };
    assert.doesNotThrow(() => visits.buildReport(store));
    assert.match(visits.buildReport(store), /0 interaction\(s\) recorded/);
  });
});
