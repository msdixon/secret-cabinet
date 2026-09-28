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
    findByEmail: email => list.find(u => u.email === email) || null,
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
    ['GET', '/admin/users'],
    ['POST', '/admin/users'],
    ['POST', '/admin/users/member-id/remove'],
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

  // Chunk A: the guest list is the first admin page outside /api/, where
  // every GET is otherwise public app shell — the admin check has to win.
  await t.test('an unauthenticated GET /admin/users is redirected to /login, not served as app shell', () => {
    const requireAuth = auth.createRequireAuth('secret', users);
    const res = fakeRes();
    let nextCalled = false;
    requireAuth(fakeReq({ path: '/admin/users', session: {} }), res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res.redirectedTo, '/login');
  });

  await t.test('paths that merely start with "admin" are not swept into the admin tier', () => {
    assert.equal(auth.isAdminRoute(fakeReq({ path: '/administer.html' })), false);
    assert.equal(auth.isAdminRoute(fakeReq({ path: '/admin' })), true);
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
  await t.test('the passphrase step posts to /login/passphrase', () => {
    const html = auth.loginPageHtml({ step: 'passphrase' });
    assert.match(html, /<form method="POST" action="\/login\/passphrase">/);
    assert.match(html, /input type="password" name="passphrase"/);
    assert.doesNotMatch(html, /Sign in with email instead/);
  });

  await t.test('the passphrase step links back to email sign-in only when email is enabled', () => {
    assert.match(auth.loginPageHtml({ step: 'passphrase', emailEnabled: true }), /Sign in with email instead/);
  });

  await t.test('the email step posts to /login/code and links to the passphrase', () => {
    const html = auth.loginPageHtml({ step: 'email', emailEnabled: true });
    assert.match(html, /<form method="POST" action="\/login\/code">/);
    assert.match(html, /input type="email" name="email"/);
    assert.match(html, /href="\/login\/passphrase"/);
  });

  await t.test('the code step posts to /login/verify', () => {
    const html = auth.loginPageHtml({ step: 'code', emailEnabled: true });
    assert.match(html, /<form method="POST" action="\/login\/verify">/);
    assert.match(html, /autocomplete="one-time-code"/);
  });

  await t.test('#594: shows a rate-limit message for error=rate', () => {
    const html = auth.loginPageHtml({ step: 'passphrase', error: 'rate' });
    assert.match(html, /Too many attempts/);
    assert.doesNotMatch(html, /Incorrect passphrase\./);
  });

  await t.test('shows an error message only when there is an error', () => {
    assert.match(auth.loginPageHtml({ step: 'passphrase', error: 'passphrase' }), /Incorrect passphrase\./);
    assert.match(auth.loginPageHtml({ step: 'passphrase', error: '1' }), /Incorrect passphrase\./);
    assert.doesNotMatch(auth.loginPageHtml({ step: 'passphrase' }), /class="error"/);
    assert.match(auth.loginPageHtml({ step: 'code', error: 'code' }), /wrong or has expired/);
  });

  await t.test('never echoes an unknown error value into the page', () => {
    const html = auth.loginPageHtml({ step: 'email', error: '<script>x</script>' });
    assert.doesNotMatch(html, /<script>x/);
    assert.match(html, /Something went wrong/);
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

  await t.test('registers the login steps and GET /logout', () => {
    const app = fakeApp();
    auth.registerAuthRoutes(app, 'secret', { users });
    for (const route of [
      'GET /login',
      'GET /login/passphrase',
      'GET /login/code',
      'POST /login/passphrase',
      'POST /login/code',
      'POST /login/verify',
      'GET /logout',
    ]) {
      assert.equal(typeof app.routes[route], 'function', route);
    }
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

  await t.test('GET /login serves the passphrase form when email sign-in is not configured', () => {
    const app = fakeApp();
    auth.registerAuthRoutes(app, 'secret', { users });
    const res = fakeRes();
    app.routes['GET /login'](fakeReq({ session: {}, query: {} }), res);
    assert.match(res.sentHtml, /<form method="POST" action="\/login\/passphrase">/);
  });

  await t.test('GET /login serves the email form when email sign-in is configured', () => {
    const app = fakeApp();
    auth.registerAuthRoutes(app, 'secret', { users, mailer: { enabled: true } });
    const res = fakeRes();
    app.routes['GET /login'](fakeReq({ session: {}, query: {} }), res);
    assert.match(res.sentHtml, /<form method="POST" action="\/login\/code">/);
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

  await t.test(
    'POST /login/passphrase with the correct passphrase signs in as the admin on a regenerated session',
    () => {
      const app = fakeApp();
      const store = fakeUsers();
      auth.registerAuthRoutes(app, 'secret', { users: store });
      const res = fakeRes();
      const req = loginReq('secret');
      app.routes['POST /login/passphrase'](req, res);
      assert.equal(req.session.userId, ADMIN.id);
      assert.equal(req.session.planted, undefined, 'expected the pre-login session to be replaced');
      assert.deepEqual(store.logins, [ADMIN.id]);
      assert.equal(res.redirectedTo, '/');
    }
  );

  await t.test(
    'POST /login/passphrase with the wrong passphrase does not authenticate and redirects to the error state',
    () => {
      const app = fakeApp();
      auth.registerAuthRoutes(app, 'secret', { users });
      const res = fakeRes();
      const req = loginReq('wrong');
      app.routes['POST /login/passphrase'](req, res);
      assert.equal(req.session.userId, undefined);
      assert.equal(res.redirectedTo, '/login/passphrase?error=passphrase');
    }
  );

  await t.test('POST /login/passphrase fails closed when there is no admin user to sign in as', () => {
    const app = fakeApp();
    auth.registerAuthRoutes(app, 'secret', { users: fakeUsers([]) });
    const res = fakeRes();
    const req = loginReq('secret');
    app.routes['POST /login/passphrase'](req, res);
    assert.equal(req.session.userId, undefined);
    assert.equal(res.redirectedTo, '/login/passphrase?error=passphrase');
  });

  await t.test(
    '#594: POST /login/passphrase blocks an IP after repeated failures, even for the right passphrase, and only that IP',
    () => {
      const app = fakeApp();
      const { createFailureLimiter } = require('../src/rate-limit.js');
      const limiter = createFailureLimiter({ windowMs: 60_000, max: 2 });
      auth.registerAuthRoutes(app, 'secret', { users: fakeUsers(), limiter });
      for (let i = 0; i < 2; i++) app.routes['POST /login/passphrase'](loginReq('wrong', '1.1.1.1'), fakeRes());

      const blocked = fakeRes();
      const blockedReq = loginReq('secret', '1.1.1.1');
      app.routes['POST /login/passphrase'](blockedReq, blocked);
      assert.equal(blocked.redirectedTo, '/login/passphrase?error=rate');
      assert.equal(blockedReq.session.userId, undefined);

      const other = fakeRes();
      app.routes['POST /login/passphrase'](loginReq('secret', '2.2.2.2'), other);
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

// #594 chunk A: the emailed-code flow, end to end through the route
// handlers, with a recording mailer and the real code store.
test('emailed-code sign-in', async t => {
  const { createLoginCodeStore } = require('../src/login-codes.js');
  const { createFailureLimiter } = require('../src/rate-limit.js');

  function setup(overrides = {}) {
    const routes = {};
    const app = {
      get: (path, h) => (routes[`GET ${path}`] = h),
      post: (path, h) => (routes[`POST ${path}`] = h),
    };
    const sent = [];
    const mailer = {
      enabled: true,
      send: async msg => {
        if (overrides.sendFails) throw new Error('boom');
        sent.push(msg);
        return true;
      },
    };
    const store = fakeUsers();
    const errors = [];
    auth.registerAuthRoutes(app, 'secret', {
      users: store,
      mailer,
      codes: createLoginCodeStore(),
      log: { error: m => errors.push(m) },
      ...overrides.deps,
    });
    return { routes, sent, store, errors };
  }

  const codeFrom = msg => msg.text.match(/\b(\d{6})\b/)[1];

  function sessionReq(session, body, ip = '127.0.0.1') {
    const req = fakeReq({ session, body, ip });
    req.session.regenerate = cb => {
      req.session = {};
      cb();
    };
    return req;
  }

  await t.test('an invited address gets a code, and the right code signs them in', async () => {
    const { routes, sent, store } = setup();
    const session = {};
    const res = fakeRes();
    await routes['POST /login/code'](sessionReq(session, { email: '  Friend@Example.com ' }), res);
    assert.equal(res.redirectedTo, '/login/code');
    assert.deepEqual(session.pendingLogin, { email: MEMBER.email });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, MEMBER.email);

    const verifyReq = sessionReq(session, { code: codeFrom(sent[0]) });
    const verifyRes = fakeRes();
    routes['POST /login/verify'](verifyReq, verifyRes);
    assert.equal(verifyRes.redirectedTo, '/');
    assert.equal(verifyReq.session.userId, MEMBER.id);
    assert.equal(verifyReq.session.pendingLogin, undefined, 'expected a fresh session');
    assert.deepEqual(store.logins, [MEMBER.id]);
  });

  await t.test('an uninvited address sees the same code step but nothing is sent', async () => {
    const { routes, sent } = setup();
    const session = {};
    const res = fakeRes();
    await routes['POST /login/code'](sessionReq(session, { email: 'stranger@example.com' }), res);
    assert.equal(res.redirectedTo, '/login/code');
    assert.equal(sent.length, 0);

    const verifyRes = fakeRes();
    routes['POST /login/verify'](sessionReq(session, { code: '123456' }), verifyRes);
    assert.equal(verifyRes.redirectedTo, '/login/code?error=code');
  });

  await t.test('a wrong code does not sign in, and a code is single-use', async () => {
    const { routes, sent } = setup();
    const session = {};
    await routes['POST /login/code'](sessionReq(session, { email: MEMBER.email }), fakeRes());
    const code = codeFrom(sent[0]);
    const wrong = code === '000000' ? '000001' : '000000';

    const wrongReq = sessionReq(session, { code: wrong });
    const wrongRes = fakeRes();
    routes['POST /login/verify'](wrongReq, wrongRes);
    assert.equal(wrongRes.redirectedTo, '/login/code?error=code');
    assert.equal(wrongReq.session.userId, undefined);

    routes['POST /login/verify'](sessionReq(session, { code }), fakeRes());
    const replay = fakeRes();
    routes['POST /login/verify'](sessionReq({ pendingLogin: { email: MEMBER.email } }, { code }), replay);
    assert.equal(replay.redirectedTo, '/login/code?error=code');
  });

  await t.test('a removed user cannot finish signing in with a code issued before removal', async () => {
    const list = [ADMIN, { ...MEMBER }];
    const store = fakeUsers(list);
    const { routes, sent } = setup({ deps: { users: store } });
    const session = {};
    await routes['POST /login/code'](sessionReq(session, { email: MEMBER.email }), fakeRes());
    list.splice(1, 1);
    const res = fakeRes();
    const req = sessionReq(session, { code: codeFrom(sent[0]) });
    routes['POST /login/verify'](req, res);
    assert.equal(res.redirectedTo, '/login/code?error=code');
    assert.equal(req.session.userId, undefined);
  });

  await t.test('sends are capped per address, and the visitor still sees the code step', async () => {
    const emailLimiter = createFailureLimiter({ windowMs: 60_000, max: 2 });
    const sendLimiter = createFailureLimiter({ windowMs: 60_000, max: 100 });
    const { routes, sent } = setup({ deps: { emailLimiter, sendLimiter } });
    for (let i = 0; i < 4; i++) {
      const res = fakeRes();
      await routes['POST /login/code'](sessionReq({}, { email: MEMBER.email }), res);
      assert.equal(res.redirectedTo, '/login/code');
    }
    assert.equal(sent.length, 2);
  });

  await t.test('sends are capped per IP with a visible rate-limit error', async () => {
    const sendLimiter = createFailureLimiter({ windowMs: 60_000, max: 2 });
    const { routes } = setup({ deps: { sendLimiter } });
    for (let i = 0; i < 2; i++)
      await routes['POST /login/code'](sessionReq({}, { email: `x${i}@example.com` }), fakeRes());
    const res = fakeRes();
    await routes['POST /login/code'](sessionReq({}, { email: 'y@example.com' }), res);
    assert.equal(res.redirectedTo, '/login?error=rate');
  });

  await t.test('a failed send is logged, not revealed', async () => {
    const { routes, errors } = setup({ sendFails: true });
    const res = fakeRes();
    routes['POST /login/code'](sessionReq({}, { email: MEMBER.email }), res);
    assert.equal(res.redirectedTo, '/login/code', 'redirects without waiting on the send');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(errors.length, 1);
  });

  await t.test('a malformed email goes back to the form with an error', async () => {
    const { routes, sent } = setup();
    const res = fakeRes();
    await routes['POST /login/code'](sessionReq({}, { email: 'not-an-email' }), res);
    assert.equal(res.redirectedTo, '/login?error=email');
    assert.equal(sent.length, 0);
  });

  await t.test('with email disabled, the code routes send nobody anywhere but /login', async () => {
    const { routes } = setup({ deps: { mailer: { enabled: false } } });
    const res = fakeRes();
    await routes['POST /login/code'](sessionReq({}, { email: MEMBER.email }), res);
    assert.equal(res.redirectedTo, '/login');
    const getRes = fakeRes();
    routes['GET /login/code'](fakeReq({ session: { pendingLogin: { email: MEMBER.email } } }), getRes);
    assert.equal(getRes.redirectedTo, '/login');
  });

  await t.test('GET /login/code without a pending login redirects to /login', () => {
    const { routes } = setup();
    const res = fakeRes();
    routes['GET /login/code'](fakeReq({ session: {} }), res);
    assert.equal(res.redirectedTo, '/login');
  });
});
