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

const auth = require('../src/auth.js');

function fakeReq({ path, method = 'GET', session = {}, query = {}, body = {} } = {}) {
  return { path, method, session, query, body };
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

test('isAuthedRequest', async t => {
  await t.test('true with no passphrase configured, even with no session.authed', () => {
    assert.equal(auth.isAuthedRequest(fakeReq({ session: {} }), null), true);
  });

  await t.test('true with a passphrase configured and an authed session', () => {
    assert.equal(auth.isAuthedRequest(fakeReq({ session: { authed: true } }), 'secret'), true);
  });

  await t.test('false with a passphrase configured and no authed session', () => {
    assert.equal(auth.isAuthedRequest(fakeReq({ session: {} }), 'secret'), false);
  });
});

test('createRequireAuth', async t => {
  await t.test('with no passphrase set, every path passes through (open mode)', () => {
    const requireAuth = auth.createRequireAuth(null);
    let nextCalled = false;
    requireAuth(fakeReq({ path: '/api/sessions', session: {} }), fakeRes(), () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });

  // #378: req.authed is the one thing downstream route handlers (e.g. the
  // four session read routes) read to decide published-filtering — it must
  // land as true here even though session.authed itself is never set when
  // no passphrase is configured.
  await t.test('with no passphrase set, req.authed is true', () => {
    const requireAuth = auth.createRequireAuth(null);
    const req = fakeReq({ path: '/api/sessions', session: {} });
    requireAuth(req, fakeRes(), () => {});
    assert.equal(req.authed, true);
  });

  await t.test('with a passphrase set and an authed session, req.authed is true', () => {
    const requireAuth = auth.createRequireAuth('secret');
    const req = fakeReq({ path: '/api/sessions', session: { authed: true } });
    requireAuth(req, fakeRes(), () => {});
    assert.equal(req.authed, true);
  });

  await t.test('with a passphrase set and no authed session, req.authed is false even on a bypassed path', () => {
    const requireAuth = auth.createRequireAuth('secret');
    const req = fakeReq({ path: '/reading-room/abc123', session: {} });
    requireAuth(req, fakeRes(), () => {});
    assert.equal(req.authed, false);
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

  await t.test('an unauthenticated request to a gated API route is rejected with 401 JSON, not a redirect', () => {
    // #379: GET /api/sessions itself is now part of the public read tier
    // (see the PUBLIC_API_ROUTES tests below) — POST /api/convene stays
    // gated regardless, since convening spends Anthropic money.
    const requireAuth = auth.createRequireAuth('secret');
    const res = fakeRes();
    let nextCalled = false;
    requireAuth(fakeReq({ path: '/api/convene', method: 'POST', session: {} }), res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'Unauthorized' });
  });

  await t.test('an unauthenticated non-GET/HEAD request to a non-API path is redirected to /login', () => {
    // #379: every real non-API route in this app is GET (the app shell,
    // /lodge, /reading-room/:id, /portraits/*), so this fallback is dead
    // code for anything actually registered today — kept covered here in
    // case a future non-API route ever needs a method other than GET.
    const requireAuth = auth.createRequireAuth('secret');
    const res = fakeRes();
    let nextCalled = false;
    requireAuth(fakeReq({ path: '/lodge', method: 'POST', session: {} }), res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res.redirectedTo, '/login');
  });

  await t.test(
    '#379: the app shell (e.g. /, /lodge, static assets like /app.js) is public for an unauthenticated GET — deliberately, not the #38 bug this bypass used to guard against',
    () => {
      // Before #379, this exact request was rejected — see the STATUS.md/
      // PRINCIPLES.md history: opening the app shell to strangers, with the
      // room as the landing surface, is the point of this issue. The
      // ordering invariant (requireAuth before express.static) still
      // matters for keeping every /api/ path gated by default; it just no
      // longer needs to gate the shell itself.
      const requireAuth = auth.createRequireAuth('secret');
      for (const path of ['/', '/lodge', '/app.js', '/css/style.css']) {
        const res = fakeRes();
        let nextCalled = false;
        requireAuth(fakeReq({ path, session: {} }), res, () => {
          nextCalled = true;
        });
        assert.equal(nextCalled, true, `expected ${path} to be public`);
      }
    }
  );

  await t.test('#379: the four #378-scoped session read routes are public for an unauthenticated GET', () => {
    const requireAuth = auth.createRequireAuth('secret');
    for (const path of ['/api/sessions', '/api/sessions/abc123', '/api/sessions/abc123/transcript', '/api/threads']) {
      const res = fakeRes();
      let nextCalled = false;
      requireAuth(fakeReq({ path, session: {} }), res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true, `expected GET ${path} to be public`);
    }
  });

  await t.test('#379: "the room and the shelf" read routes are public for an unauthenticated GET', () => {
    const requireAuth = auth.createRequireAuth('secret');
    for (const path of [
      '/api/members',
      '/api/members/crowley/dossier',
      '/api/library',
      '/api/library/some-work',
      '/api/graph',
      '/api/voice/config',
    ]) {
      const res = fakeRes();
      let nextCalled = false;
      requireAuth(fakeReq({ path, session: {} }), res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true, `expected GET ${path} to be public`);
    }
  });

  await t.test(
    '#380: POST /api/voice/speak is public at the auth layer — routes/voice.js itself refuses to synthesize for an unauthenticated request, so opening it here only opens cache-hit replay',
    () => {
      const requireAuth = auth.createRequireAuth('secret');
      const res = fakeRes();
      let nextCalled = false;
      requireAuth(fakeReq({ path: '/api/voice/speak', method: 'POST', session: {} }), res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true, 'expected POST /api/voice/speak to reach the route handler unauthenticated');
    }
  );

  await t.test(
    '#379: a mutating verb on an otherwise-public session path stays gated — the method check, not just the path, decides',
    () => {
      const requireAuth = auth.createRequireAuth('secret');
      const cases = [
        ['DELETE', '/api/sessions/abc123'],
        ['PATCH', '/api/sessions/abc123/publish'],
        ['PATCH', '/api/sessions/abc123/annotations'],
        ['PATCH', '/api/sessions/abc123/tags'],
        ['PATCH', '/api/sessions/abc123/thread'],
        ['POST', '/api/sessions/abc123/branch'],
        ['POST', '/api/sessions/abc123/close'],
        ['POST', '/api/sessions/abc123/verify-citations'],
      ];
      for (const [method, path] of cases) {
        const res = fakeRes();
        let nextCalled = false;
        requireAuth(fakeReq({ path, method, session: {} }), res, () => {
          nextCalled = true;
        });
        assert.equal(nextCalled, false, `expected ${method} ${path} to stay gated`);
        assert.equal(res.statusCode, 401, `expected ${method} ${path} to 401, not redirect`);
      }
    }
  );

  await t.test('#379: anything that costs money, touches Rachel\'s machine, or is admin-only stays gated', () => {
    const requireAuth = auth.createRequireAuth('secret');
    const cases = [
      ['POST', '/api/members'], // the generator, not the GET roster list
      ['POST', '/api/cast'],
      ['POST', '/api/round'],
      ['POST', '/api/interject'],
      ['POST', '/api/dayone/export'],
      ['POST', '/api/ulysses/export'],
      ['POST', '/api/export/obsidian'],
      ['GET', '/api/admin/citation-manifest'],
      ['GET', '/api/admin/bibliography'],
    ];
    for (const [method, path] of cases) {
      const res = fakeRes();
      let nextCalled = false;
      requireAuth(fakeReq({ path, method, session: {} }), res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false, `expected ${method} ${path} to stay gated`);
      assert.equal(res.statusCode, 401, `expected ${method} ${path} to 401`);
    }
  });
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
