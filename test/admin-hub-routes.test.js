'use strict';

// #637 — the /admin hub page. Handler driven against fake req/res; the admin
// gate itself is auth.js's (ADMIN_ROUTES), asserted here via isAdminRoute.

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerAdminHubRoutes, adminHubHtml, ADMIN_LINKS } = require('../src/routes/admin.js');
const { isAdminRoute } = require('../src/auth.js');

test('GET /admin renders a link to every admin view', () => {
  const routes = {};
  registerAdminHubRoutes({ get: (p, h) => (routes[`GET ${p}`] = h) });
  let html;
  routes['GET /admin']({}, { send: h => (html = h) });
  for (const l of ADMIN_LINKS) assert.ok(html.includes(`href="${l.href}"`), l.href);
  assert.match(html, /href="\/admin\/users"/);
  assert.match(html, /href="\/api\/admin\/visits"/);
});

test('every hub link is itself an admin-gated route', () => {
  for (const l of ADMIN_LINKS) assert.ok(isAdminRoute({ method: 'GET', path: l.href }), l.href);
});

test('/admin is admin-gated, so guests get 403 rather than the hub', () => {
  assert.ok(isAdminRoute({ method: 'GET', path: '/admin' }));
  assert.ok(isAdminRoute({ method: 'GET', path: '/admin/' }));
  assert.ok(adminHubHtml([]).includes('Back to the lodge'));
});
