'use strict';

// #193 — auth.js, extracted from server.js. Last of the seam-mapped
// extractions, and the one where getting the wiring order wrong is a real
// security regression (see the module comment on createRequireAuth) —
// tested more heavily than the others as a result. No Express app is
// spun up; the middleware is exercised directly against fake req/res/next,
// the same way test/pipeline.test.js exercises functions against fake
// clients rather than reaching for supertest.

const test = require('node:test');
const assert = require('node:assert/strict');

const auth = require('../auth.js');

function fakeReq({ path, session = {}, query = {}, body = {} } = {}) {
  return { path, session, query, body };
}

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    redirectedTo: null,
    sentHtml: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    redirect(url) {
      this.redirectedTo = url;
      return this;
    },
    send(html) {
      this.sentHtml = html;
      return this;
    },
  };
  return res;
}

test('createRequireAuth', async t => {
  await t.test('with no passphrase set, every path passes through (open mode)', () => {
    const requireAuth = auth.createRequireAuth(null);
    let nextCalled = false;
    requireAuth(fakeReq({ path: '/api/sessions', session: {} }), fakeRes(), () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });

  await t.test('/api/config is always public, even unauthenticated', () => {
    const requireAuth = auth.createRequireAuth('secret');
    let nextCalled = false;
    requireAuth(fakeReq({ path: '/api/config', session: {} }), fakeRes(), () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });

  await t.test('/reading-room/:id is always public', () => {
    const requireAuth = auth.createRequireAuth('secret');
    let nextCalled = false;
    requireAuth(fakeReq({ path: '/reading-room/abc123', session: {} }), fakeRes(), () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });

  await t.test('/portraits/:file.png is always public', () => {
    const requireAuth = auth.createRequireAuth('secret');
    let nextCalled = false;
    requireAuth(fakeReq({ path: '/portraits/crowley.png', session: {} }), fakeRes(), () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });

  await t.test('an authenticated session passes through to any other path', () => {
    const requireAuth = auth.createRequireAuth('secret');
    let nextCalled = false;
    requireAuth(fakeReq({ path: '/api/sessions', session: { authed: true } }), fakeRes(), () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });

  await t.test('an unauthenticated API request is rejected with 401 JSON, not a redirect', () => {
    const requireAuth = auth.createRequireAuth('secret');
    const res = fakeRes();
    let nextCalled = false;
    requireAuth(fakeReq({ path: '/api/sessions', session: {} }), res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'Unauthorized' });
  });

  await t.test('an unauthenticated non-API request is redirected to /login', () => {
    const requireAuth = auth.createRequireAuth('secret');
    const res = fakeRes();
    let nextCalled = false;
    requireAuth(fakeReq({ path: '/lodge', session: {} }), res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res.redirectedTo, '/login');
  });

  await t.test(
    'static assets (e.g. /app.js) are gated too, not just /api/ — the #38 static-bypass bug this guards against',
    () => {
      // This is the specific regression the guard's mounting order exists to
      // prevent: requireAuth must run before express.static, or an
      // unauthenticated visitor gets index.html/app.js served regardless.
      const requireAuth = auth.createRequireAuth('secret');
      const res = fakeRes();
      let nextCalled = false;
      requireAuth(fakeReq({ path: '/app.js', session: {} }), res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false);
      assert.equal(res.redirectedTo, '/login');
    }
  );
});

test('loginPageHtml', async t => {
  await t.test('renders the login form', () => {
    const html = auth.loginPageHtml(false);
    assert.match(html, /<form method="POST" action="\/login">/);
    assert.match(html, /input type="password" name="passphrase"/);
  });

  await t.test('shows an error message only when error is truthy', () => {
    assert.match(auth.loginPageHtml(true), /Incorrect passphrase\./);
    assert.doesNotMatch(auth.loginPageHtml(false), /Incorrect passphrase\./);
  });
});

test('registerAuthRoutes', async t => {
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

  await t.test('registers GET/POST /login and GET /logout', () => {
    const app = fakeApp();
    auth.registerAuthRoutes(app, 'secret');
    assert.equal(typeof app.routes['GET /login'], 'function');
    assert.equal(typeof app.routes['POST /login'], 'function');
    assert.equal(typeof app.routes['GET /logout'], 'function');
  });

  await t.test('GET /login redirects to / when no passphrase is configured', () => {
    const app = fakeApp();
    auth.registerAuthRoutes(app, null);
    const res = fakeRes();
    app.routes['GET /login'](fakeReq({ session: {}, query: {} }), res);
    assert.equal(res.redirectedTo, '/');
  });

  await t.test('GET /login redirects to / when the session is already authenticated', () => {
    const app = fakeApp();
    auth.registerAuthRoutes(app, 'secret');
    const res = fakeRes();
    app.routes['GET /login'](fakeReq({ session: { authed: true }, query: {} }), res);
    assert.equal(res.redirectedTo, '/');
  });

  await t.test('GET /login serves the form when a passphrase is set and the session is not authed', () => {
    const app = fakeApp();
    auth.registerAuthRoutes(app, 'secret');
    const res = fakeRes();
    app.routes['GET /login'](fakeReq({ session: {}, query: {} }), res);
    assert.match(res.sentHtml, /<form method="POST" action="\/login">/);
  });

  await t.test('POST /login with the correct passphrase marks the session authed and redirects home', () => {
    const app = fakeApp();
    auth.registerAuthRoutes(app, 'secret');
    const res = fakeRes();
    const req = fakeReq({ session: {}, body: { passphrase: 'secret' } });
    app.routes['POST /login'](req, res);
    assert.equal(req.session.authed, true);
    assert.equal(res.redirectedTo, '/');
  });

  await t.test('POST /login with the wrong passphrase does not authenticate and redirects to the error state', () => {
    const app = fakeApp();
    auth.registerAuthRoutes(app, 'secret');
    const res = fakeRes();
    const req = fakeReq({ session: {}, body: { passphrase: 'wrong' } });
    app.routes['POST /login'](req, res);
    assert.equal(req.session.authed, undefined);
    assert.equal(res.redirectedTo, '/login?error=1');
  });

  await t.test('GET /logout destroys the session and redirects to /login', () => {
    const app = fakeApp();
    auth.registerAuthRoutes(app, 'secret');
    const res = fakeRes();
    let destroyed = false;
    const req = fakeReq({
      session: {
        authed: true,
        destroy: cb => {
          destroyed = true;
          cb();
        },
      },
    });
    app.routes['GET /logout'](req, res);
    assert.equal(destroyed, true);
    assert.equal(res.redirectedTo, '/login');
  });
});
