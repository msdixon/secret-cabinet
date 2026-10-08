'use strict';

// #625 — guest notes to the keeper, the first-convene funnel, and the routes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFeedbackStore, computeFunnel, MAX_NOTE_CHARS } = require('../src/feedback.js');
const { registerFeedbackRoutes, feedbackPageHtml } = require('../src/routes/feedback.js');
const { canView } = require('../src/sessions-store.js');

function tmpDir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-feedback-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('feedback store', async t => {
  await t.test('adds, lists newest first, trims and truncates, rejects empty', t2 => {
    const file = path.join(tmpDir(t2), 'feedback.jsonl');
    let n = 0;
    const store = createFeedbackStore(file, { clock: () => new Date(Date.UTC(2026, 9, 1, 0, 0, n++)) });
    assert.equal(store.add({ userId: 'u1', text: '   ' }), null);
    assert.equal(store.add({ text: 'no user' }), null);
    store.add({ userId: 'u1', text: '  first  ', page: 'footer' });
    store.add({ userId: 'u2', text: 'x'.repeat(MAX_NOTE_CHARS + 50) });
    const list = store.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].userId, 'u2');
    assert.equal(list[0].text.length, MAX_NOTE_CHARS);
    assert.equal(list[1].text, 'first');
  });

  await t.test('tolerates a torn trailing line and a missing file', t2 => {
    const file = path.join(tmpDir(t2), 'feedback.jsonl');
    const store = createFeedbackStore(file);
    assert.deepEqual(store.list(), []);
    store.add({ userId: 'u1', text: 'ok' });
    fs.appendFileSync(file, '{"ts":"2026');
    assert.equal(store.list().length, 1);
  });
});

test('computeFunnel', () => {
  const day = d => `2026-10-0${d}`;
  const users = [
    { id: 'a', name: 'Admin', email: 'a@x', isAdmin: true },
    { id: 'g1', name: 'G1', email: 'g1@x' },
    { id: 'g2', name: 'G2', email: 'g2@x', lastLoginAt: '2026-10-01T00:00:00Z', loginDays: [day(1)] },
    { id: 'g3', name: 'G3', email: 'g3@x', loginDays: [day(1), day(2)] },
  ];
  const sessions = [
    { ownerId: 'g3', rounds: 2 },
    { ownerId: 'g3', rounds: 0 },
    { ownerId: 'g2', rounds: 0 },
  ];
  const f = computeFunnel(users, sessions);
  assert.equal(f.total, 3);
  const counts = Object.fromEntries(f.stages.map(s => [s.key, s.count]));
  assert.deepEqual(counts, { invited: 3, signedIn: 2, convened: 2, completed: 1, returned: 1 });
  assert.equal(f.rows.find(r => r.id === 'g3').sessions, 2);
});

test('canView: shared sitting readable by admin only', () => {
  const s = { ownerId: 'g1', sharedWithKeeper: true };
  assert.equal(canView(s, { id: 'a', isAdmin: true }), true);
  assert.equal(canView(s, { id: 'g2', isAdmin: false }), false);
  assert.equal(canView({ ownerId: 'g1' }, { id: 'a', isAdmin: true }), false);
});

test('feedback routes', async t => {
  function setup(t2, limiter) {
    const dir = tmpDir(t2);
    const routes = {};
    const app = { get: (p, h) => (routes[`GET ${p}`] = h), post: (p, h) => (routes[`POST ${p}`] = h) };
    const feedback = createFeedbackStore(path.join(dir, 'f.jsonl'));
    const users = { list: () => [{ id: 'g1', name: '<b>Guest</b>', email: 'g@x' }] };
    registerFeedbackRoutes(app, { feedback, users, sessionsDir: dir, limiter });
    return { routes, feedback, dir };
  }
  const res = () => ({
    code: 200,
    body: null,
    status(c) {
      this.code = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
  });

  await t.test('stores a note, rejects empty, rate-limits', t2 => {
    const { routes, feedback } = setup(t2);
    const post = body => {
      const r = res();
      routes['POST /api/feedback']({ user: { id: 'g1' }, body }, r);
      return r;
    };
    assert.equal(post({ text: 'hello', page: 'footer' }).code, 200);
    assert.equal(post({ text: '  ' }).code, 400);
    for (let i = 0; i < 9; i++) post({ text: `n${i}` });
    assert.equal(post({ text: 'one too many' }).code, 429);
    assert.equal(feedback.list().length, 10);
  });

  await t.test('anonymous POST is 401', t2 => {
    const { routes } = setup(t2);
    const r = res();
    routes['POST /api/feedback']({ body: { text: 'x' } }, r);
    assert.equal(r.code, 401);
  });

  await t.test('admin page escapes note and names, lists shared sittings only', t2 => {
    const { routes, feedback, dir } = setup(t2);
    feedback.add({ userId: 'g1', text: '<script>alert(1)</script>' });
    fs.writeFileSync(
      path.join(dir, 's1.json'),
      JSON.stringify({
        id: 's1',
        ownerId: 'g1',
        rounds: [{}],
        entry: 'Shared one',
        sharedWithKeeper: true,
        sharedWithKeeperAt: '2026-10-02T10:00:00Z',
      })
    );
    fs.writeFileSync(
      path.join(dir, 's2.json'),
      JSON.stringify({ id: 's2', ownerId: 'g1', rounds: [{}], entry: 'Private one' })
    );
    const r = res();
    routes['GET /admin/feedback']({}, r);
    assert.ok(!r.body.includes('<script>alert'));
    assert.ok(r.body.includes('&lt;script&gt;'));
    assert.ok(!r.body.includes('<b>Guest</b>'));
    assert.ok(r.body.includes('Shared one'));
    assert.ok(!r.body.includes('Private one'));
  });

  assert.equal(typeof feedbackPageHtml, 'function');
});
