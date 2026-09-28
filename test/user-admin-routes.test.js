'use strict';

// #594 chunk A — src/routes/users.js, the admin guest list. Handlers are
// driven directly against fake req/res with the real users.js store on a
// tmpdir; the admin gate itself is auth.js's and tested in auth.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createUserStore } = require('../src/users.js');
const { registerUserAdminRoutes, guestListHtml } = require('../src/routes/users.js');

function setup({ mailerEnabled = true, sendFails = false } = {}) {
  const routes = {};
  const app = {
    get: (p, h) => (routes[`GET ${p}`] = h),
    post: (p, h) => (routes[`POST ${p}`] = h),
  };
  const users = createUserStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-guests-')), 'users.json'));
  const admin = users.ensureAdmin({ email: 'rachel@example.com' });
  const sent = [];
  const mailer = {
    enabled: mailerEnabled,
    send: async msg => {
      if (sendFails) throw new Error('boom');
      sent.push(msg);
    },
  };
  registerUserAdminRoutes(app, { users, mailer, appUrl: 'https://archon-salon.org', log: { error: () => {} } });
  return { routes, users, admin, sent };
}

function fakeRes() {
  return {
    redirect(url) {
      this.redirectedTo = url;
    },
    send(html) {
      this.sentHtml = html;
    },
  };
}

test('guest list routes', async t => {
  await t.test(
    'adding a guest persists them, emails an invite, and reports it without the email in the URL',
    async () => {
      const { routes, users, sent } = setup();
      const res = fakeRes();
      await routes['POST /admin/users']({ body: { email: 'ada@example.com', name: 'Ada', sendInvite: '1' } }, res);
      assert.equal(res.redirectedTo, '/admin/users?done=invited');
      assert.ok(users.findByEmail('ada@example.com'));
      assert.equal(sent[0].to, 'ada@example.com');
      assert.match(sent[0].text, /archon-salon\.org\/login/);

      const page = fakeRes();
      routes['GET /admin/users']({ query: { done: 'invited' } }, page);
      assert.match(page.sentHtml, /invitation sent/);
      assert.match(page.sentHtml, /ada@example\.com/);
    }
  );

  await t.test('an unknown done= value renders no message', () => {
    const { routes } = setup();
    const page = fakeRes();
    routes['GET /admin/users']({ query: { done: '<b>x</b>' } }, page);
    assert.doesNotMatch(page.sentHtml, /<p class="(flash|error)"/);
  });

  await t.test('without the invite box ticked, nothing is sent', async () => {
    const { routes, sent } = setup();
    const res = fakeRes();
    await routes['POST /admin/users']({ body: { email: 'ada@example.com' } }, res);
    assert.equal(sent.length, 0);
    assert.equal(res.redirectedTo, '/admin/users?done=added');
  });

  await t.test('a duplicate or invalid email is reported, not thrown', async () => {
    const { routes } = setup();
    const dup = fakeRes();
    await routes['POST /admin/users']({ body: { email: 'Rachel@example.com' } }, dup);
    assert.equal(dup.redirectedTo, '/admin/users?done=duplicate-email');
    const bad = fakeRes();
    await routes['POST /admin/users']({ body: { email: 'nope' } }, bad);
    assert.equal(bad.redirectedTo, '/admin/users?done=invalid-email');
  });

  await t.test('a failed invite still keeps the guest and says the email failed', async () => {
    const { routes, users } = setup({ sendFails: true });
    const res = fakeRes();
    await routes['POST /admin/users']({ body: { email: 'ada@example.com', sendInvite: '1' } }, res);
    assert.ok(users.findByEmail('ada@example.com'));
    assert.equal(res.redirectedTo, '/admin/users?done=invite-failed');
  });

  await t.test('removing a guest works; removing the admin does not', async () => {
    const { routes, users, admin } = setup();
    const guest = users.addUser({ email: 'ada@example.com' });
    const ok = fakeRes();
    routes['POST /admin/users/:id/remove']({ params: { id: guest.id } }, ok);
    assert.equal(users.findById(guest.id), null);
    assert.equal(ok.redirectedTo, '/admin/users?done=removed');
    const refused = fakeRes();
    routes['POST /admin/users/:id/remove']({ params: { id: admin.id } }, refused);
    assert.ok(users.findById(admin.id));
    assert.equal(refused.redirectedTo, '/admin/users?done=remove-failed');
  });
});

test('guestListHtml escapes what guests typed', () => {
  const html = guestListHtml({
    users: [{ id: 'x', name: '<img src=x onerror=alert(1)>', email: 'a@example.com', isAdmin: false }],
    mailerEnabled: false,
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img/);
  assert.match(html, /no invitation will be sent/);
});
