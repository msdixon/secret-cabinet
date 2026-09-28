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

function fakeReq({ path, method = 'GET', session = {}, query = {}, body = {}, ip = '127.0.0.1' } = {}) {
  return { path, method, session, query, body, ip };
}

// #594: a stand-in for src/users.js's store — one admin and one invitee,
// enough to tell "signed in" apart from "signed in as the admin".
const ADMIN = { id: 'admin-id', email: 'rachel@example.com', name: 'Admin', isAdmin: true };
const MEMBER = { id: 'member-id', email: 'friend@example.com', name: 'Friend', isAdmin: false };

function fakeUsers(list = [ADMIN, MEMBER]) {
  const logins = [];
  return {
    logins,
    findById: id => list.find(u => u.id === id) || null,
    findAdmin: () => list.find(u => u.isAdmin) || null,
    recordLogin: id => logins.push(id),
  };
}

const users = fakeUsers();

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
  await t.test('true with no passphrase configured, even with no session user', () => {
    assert.equal(auth.isAuthedRequest(fakeReq({ session: {} }), null), true);
  });

  await t.test('true with a passphrase configured and an authed session', () => {
    assert.equal(auth.isAuthedRequest(fakeReq({ session: { userId: ADMIN.id } }), 'secret', users), true);
  });

  await t.test('false with a passphrase configured and no authed session', () => {
    assert.equal(auth.isAuthedRequest(fakeReq({ session: {} }), 'secret', users), false);
  });

  // #594: a cookie from before per-user identity carries only authed:true.
  // The old passphrase was shared, so such a session can't be assumed to be
  // Rachel's — it resolves to nobody and has to sign in again.
  await t.test('false for a legacy authed:true session with no userId', () => {
    assert.equal(auth.isAuthedRequest(fakeReq({ session: { authed: true } }), 'secret', users), false);
  });

  await t.test("false once the session's user no longer exists", () => {
    assert.equal(auth.isAuthedRequest(fakeReq({ session: { userId: 'removed' } }), 'secret', users), false);
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
    const requireAuth = auth.createRequireAuth('secret', users);
    const req = fakeReq({ path: '/api/sessions', session: { userId: ADMIN.id } });
    requireAuth(req, fakeRes(), () => {});
    assert.equal(req.authed, true);
  });

  await t.test('with a passphrase set and no authed session, req.authed is false even on a bypassed path', () => {
    const requireAuth = auth.createRequireAuth('secret', users);
    const req = fakeReq({ path: '/reading-room/abc123', session: {} });
    requireAuth(req, fakeRes(), () => {});
    assert.equal(req.authed, false);
  });

  await t.test('/api/config is always public, even unauthenticated', () => {
    const requireAuth = auth.createRequireAuth('secret', users);
    let nextCalled = false;
    requireAuth(fakeReq({ path: '/api/config', session: {} }), fakeRes(), () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });

  await t.test('/reading-room/:id is always public', () => {
    const requireAuth = auth.createRequireAuth('secret', users);
    let nextCalled = false;
    requireAuth(fakeReq({ path: '/reading-room/abc123', session: {} }), fakeRes(), () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });

  await t.test('/portraits/:file.png is always public', () => {
    const requireAuth = auth.createRequireAuth('secret', users);
    let nextCalled = false;
    requireAuth(fakeReq({ path: '/portraits/crowley.png', session: {} }), fakeRes(), () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });

  await t.test('an authenticated session passes through to any other path', () => {
    const requireAuth = auth.createRequireAuth('secret', users);
    let nextCalled = false;
    requireAuth(fakeReq({ path: '/api/sessions', session: { userId: ADMIN.id } }), fakeRes(), () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });

  await t.test('an unauthenticated request to a gated API route is rejected with 401 JSON, not a redirect', () => {
    // #379: GET /api/sessions itself is now part of the public read tier
    // (see the PUBLIC_API_ROUTES tests below) — POST /api/convene stays
    // gated regardless, since convening spends Anthropic money.
    const requireAuth = auth.createRequireAuth('secret', users);
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
    const requireAuth = auth.createRequireAuth('secret', users);
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
      const requireAuth = auth.createRequireAuth('secret', users);
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
    const requireAuth = auth.createRequireAuth('secret', users);
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
    const requireAuth = auth.createRequireAuth('secret', users);
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
      const requireAuth = auth.createRequireAuth('secret', users);
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
      const requireAuth = auth.createRequireAuth('secret', users);
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

  await t.test("#379: anything that costs money, touches Rachel's machine, or is admin-only stays gated", () => {
    const requireAuth = auth.createRequireAuth('secret', users);
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

test('#594: admin-only routes', async t => {
  const adminOnly = [
    ['POST', '/api/members'],
    ['POST', '/api/dayone/journals'],
    ['POST', '/api/dayone/export'],
    ['POST', '/api/ulysses/export'],
    ['POST', '/api/export/obsidian'],
    ['GET', '/api/admin/visits'],
    ['GET', '/api/admin/bibliography'],
  ];

  await t.test('a signed-in non-admin gets 403 on each admin route', () => {
    const requireAuth = auth.createRequireAuth('secret', users);
    for (const [method, path] of adminOnly) {
      const res = fakeRes();
      let nextCalled = false;
      requireAuth(fakeReq({ path, method, session: { userId: MEMBER.id } }), res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false, `expected ${method} ${path} to be refused`);
      assert.equal(res.statusCode, 403, `expected ${method} ${path} to 403`);
    }
  });

  await t.test('the admin passes through on each admin route', () => {
    const requireAuth = auth.createRequireAuth('secret', users);
    for (const [method, path] of adminOnly) {
      let nextCalled = false;
      requireAuth(fakeReq({ path, method, session: { userId: ADMIN.id } }), fakeRes(), () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true, `expected ${method} ${path} to pass for the admin`);
    }
  });

  await t.test('a non-admin still reaches ordinary gated routes like convening and casting', () => {
    const requireAuth = auth.createRequireAuth('secret', users);
    for (const [method, path] of [
      ['POST', '/api/convene'],
      ['POST', '/api/round'],
      ['GET', '/api/members'],
      ['POST', '/api/cast'],
    ]) {
      const req = fakeReq({ path, method, session: { userId: MEMBER.id } });
      let nextCalled = false;
      requireAuth(req, fakeRes(), () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true, `expected ${method} ${path} to pass for a non-admin`);
      assert.equal(req.isAdmin, false);
      assert.equal(req.user, MEMBER);
    }
  });

  await t.test('open mode (no passphrase) is LOCAL_ADMIN, so local dev keeps every route', () => {
    const requireAuth = auth.createRequireAuth(null);
    const req = fakeReq({ path: '/api/dayone/export', method: 'POST', session: {} });
    let nextCalled = false;
    requireAuth(req, fakeRes(), () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(req.user, auth.LOCAL_ADMIN);
    assert.equal(req.isAdmin, true);
  });

  await t.test('an unauthenticated request to an admin route is still a 401, not a 403', () => {
    const requireAuth = auth.createRequireAuth('secret', users);
    const res = fakeRes();
    requireAuth(fakeReq({ path: '/api/admin/visits', session: {} }), res, () => {});
    assert.equal(res.statusCode, 401);
  });
});

test('passphraseMatches', async t => {
  await t.test('matches only the exact passphrase', () => {
    assert.equal(auth.passphraseMatches('secret', 'secret'), true);
    assert.equal(auth.passphraseMatches('Secret', 'secret'), false);
    assert.equal(auth.passphraseMatches('', 'secret'), false);
  });

  await t.test('rejects a missing or non-string candidate without throwing', () => {
    assert.equal(auth.passphraseMatches(undefined, 'secret'), false);
    assert.equal(auth.passphraseMatches(['secret'], 'secret'), false);
  });
});

test('loginPageHtml', async t => {
  await t.test('renders the login form', () => {
    const html = auth.loginPageHtml(false);
    assert.match(html, /<form method="POST" action="\/login">/);
    assert.match(html, /input type="password" name="passphrase"/);
  });

  await t.test('#594: shows a rate-limit message for error=rate', () => {
    assert.match(auth.loginPageHtml('rate'), /Too many attempts/);
    assert.doesNotMatch(auth.loginPageHtml('rate'), /Incorrect passphrase\./);
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
    auth.registerAuthRoutes(app, 'secret', { users });
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
    auth.registerAuthRoutes(app, 'secret', { users });
    const res = fakeRes();
    app.routes['GET /login'](fakeReq({ session: { userId: ADMIN.id }, query: {} }), res);
    assert.equal(res.redirectedTo, '/');
  });

  await t.test('GET /login serves the form when a passphrase is set and the session is not authed', () => {
    const app = fakeApp();
    auth.registerAuthRoutes(app, 'secret', { users });
    const res = fakeRes();
    app.routes['GET /login'](fakeReq({ session: {}, query: {} }), res);
    assert.match(res.sentHtml, /<form method="POST" action="\/login">/);
  });

  // express-session's regenerate() swaps req.session for a fresh object
  // before calling back; the fake does the same, so a test can tell the
  // user id landed on the *new* session, not the pre-login one.
  function loginReq(passphrase, ip) {
    const req = fakeReq({ session: { planted: true }, body: { passphrase }, ip });
    req.session.regenerate = cb => {
      req.session = {};
      cb();
    };
    return req;
  }

  await t.test('POST /login with the correct passphrase signs in as the admin on a regenerated session', () => {
    const app = fakeApp();
    const store = fakeUsers();
    auth.registerAuthRoutes(app, 'secret', { users: store });
    const res = fakeRes();
    const req = loginReq('secret');
    app.routes['POST /login'](req, res);
    assert.equal(req.session.userId, ADMIN.id);
    assert.equal(req.session.planted, undefined, 'expected the pre-login session to be replaced');
    assert.deepEqual(store.logins, [ADMIN.id]);
    assert.equal(res.redirectedTo, '/');
  });

  await t.test('POST /login with the wrong passphrase does not authenticate and redirects to the error state', () => {
    const app = fakeApp();
    auth.registerAuthRoutes(app, 'secret', { users });
    const res = fakeRes();
    const req = loginReq('wrong');
    app.routes['POST /login'](req, res);
    assert.equal(req.session.userId, undefined);
    assert.equal(res.redirectedTo, '/login?error=1');
  });

  await t.test('POST /login fails closed when there is no admin user to sign in as', () => {
    const app = fakeApp();
    auth.registerAuthRoutes(app, 'secret', { users: fakeUsers([]) });
    const res = fakeRes();
    const req = loginReq('secret');
    app.routes['POST /login'](req, res);
    assert.equal(req.session.userId, undefined);
    assert.equal(res.redirectedTo, '/login?error=1');
  });

  await t.test(
    '#594: POST /login blocks an IP after repeated failures, even for the right passphrase, and only that IP',
    () => {
      const app = fakeApp();
      const { createFailureLimiter } = require('../src/rate-limit.js');
      const limiter = createFailureLimiter({ windowMs: 60_000, max: 2 });
      auth.registerAuthRoutes(app, 'secret', { users: fakeUsers(), limiter });
      for (let i = 0; i < 2; i++) app.routes['POST /login'](loginReq('wrong', '1.1.1.1'), fakeRes());

      const blocked = fakeRes();
      const blockedReq = loginReq('secret', '1.1.1.1');
      app.routes['POST /login'](blockedReq, blocked);
      assert.equal(blocked.redirectedTo, '/login?error=rate');
      assert.equal(blockedReq.session.userId, undefined);

      const other = fakeRes();
      app.routes['POST /login'](loginReq('secret', '2.2.2.2'), other);
      assert.equal(other.redirectedTo, '/');
    }
  );

  await t.test('GET /logout destroys the session and redirects to /login', () => {
    const app = fakeApp();
    auth.registerAuthRoutes(app, 'secret', { users });
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
