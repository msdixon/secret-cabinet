'use strict';

// #193 seam-map, module 9 of 9 (done last) — passphrase auth for deployed
// instances.
//
// Small, but touches req.session and the route-mounting order: requireAuth
// must still run before express.static (a prior bug let static short-circuit
// the gate, serving index.html to anyone while only the API calls it
// 401'd — see the comment on createRequireAuth below). server.js keeps
// explicit control of that ordering — this module never calls app.use()
// itself for the guard, only for the /login and /logout routes, so the seam
// with server.js stays visible at the call site rather than hidden inside
// this module's own registration order.
//
// passphrase is passed in explicitly rather than read from process.env here
// — server.js stays the one place that reads env vars, same as MODEL/IS_LOCAL.

function loginPageHtml(error) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>The Secret-Cabin-et</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #1a1510; color: #c8b89a; font-family: 'Georgia', serif;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .gate { text-align: center; width: 320px; }
    h1 { font-size: 1.1rem; letter-spacing: .2em; text-transform: uppercase;
         color: #8b7355; margin-bottom: 2rem; }
    input[type=password] { width: 100%; padding: .75rem 1rem; background: #0d0b08;
      border: 1px solid #3a3228; color: #c8b89a; font-family: inherit; font-size: 1rem;
      border-radius: 2px; outline: none; text-align: center; letter-spacing: .15em; }
    input[type=password]:focus { border-color: #8b7355; }
    button { margin-top: 1rem; width: 100%; padding: .75rem; background: transparent;
      border: 1px solid #5a4a3a; color: #a89070; font-family: inherit; font-size: .85rem;
      letter-spacing: .15em; text-transform: uppercase; cursor: pointer; border-radius: 2px; }
    button:hover { border-color: #8b7355; color: #c8b89a; }
    .error { margin-top: 1rem; color: #a05050; font-size: .85rem; }
  </style>
</head>
<body>
  <div class="gate">
    <h1>The Secret-Cabin-et</h1>
    <form method="POST" action="/login">
      <input type="password" name="passphrase" placeholder="Enter passphrase" autofocus>
      <button type="submit">Enter</button>
      ${error ? '<p class="error">Incorrect passphrase.</p>' : ''}
    </form>
  </div>
</body>
</html>`;
}

// Registers /login (GET+POST) and /logout on the given Express app. Callers
// must still apply the requireAuth middleware themselves afterward — see the
// module comment above for why that ordering is left explicit at the call
// site rather than folded into this function.
function registerAuthRoutes(app, passphrase) {
  // Login page — only served when a passphrase is set and session is not authenticated
  app.get('/login', (req, res) => {
    if (!passphrase || req.session.authed) return res.redirect('/');
    res.send(loginPageHtml(!!req.query.error));
  });

  app.post('/login', (req, res) => {
    if (req.body.passphrase === passphrase) {
      req.session.authed = true;
      return res.redirect('/');
    }
    res.redirect('/login?error=1');
  });

  app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
  });
}

// #378: whether this request should be treated as authenticated for gating
// output by session.published — deliberately not just req.session.authed.
// With no passphrase configured, every request already gets full access via
// createRequireAuth's early return below, but that path never sets
// session.authed to true. A route that checked req.session.authed directly
// would read every no-passphrase deploy (including all of local dev) as
// unauthenticated and start filtering by published — exactly backwards. This
// is the one place that reconciles the two.
function isAuthedRequest(req, passphrase) {
  return !passphrase || !!(req.session && req.session.authed);
}

// #379: the public read tier. What's reachable without authentication now
// has two shapes, checked in isPublicRoute below, rather than growing a
// fourth ad-hoc prefix onto the three this replaces (/api/config,
// /reading-room/, /portraits/) — see docs/PRINCIPLES.md Principle 7 for why
// that pattern doesn't scale and what the real axis is (published, not cost).
//
// (a) The app shell — every GET/HEAD request outside /api/. There is no
// authenticated-only page served outside /api/ (the reading room, the
// lodge page, portraits, and every static asset are all meant to render for
// a stranger), so one rule replaces the old /reading-room/ and /portraits/
// prefix checks and additionally opens `/` and `/lodge` the same way. A
// stranger's browser needs the whole shell — HTML, CSS, JS, the Babylon
// vendor bundle — to render the room at all. Restricted to GET/HEAD (not
// "any non-/api/ path") so a hypothetical future mutating route mounted
// outside /api/ doesn't slip through by accident.
//
// (b) A fixed allowlist of read-only API routes — "the room and the shelf".
// Checked by method AND exact/templated path, never a prefix, so a mutating
// verb on the same path (e.g. DELETE /api/sessions/:id) is never swept in
// alongside its GET sibling. GET /api/sessions, /api/sessions/:id,
// /api/sessions/:id/transcript, and /api/threads are safe to list here
// specifically because #378 already scopes each of them to `published`
// sessions when req.authed is false — this table is what makes that
// filtering reachable in production for the first time. Everything else
// under /api/ — anything that spends Anthropic/ElevenLabs money, touches
// Rachel's own machine (Day One, exports, the citation manifest), or can
// mutate or delete a session — stays behind the gate by omission; nothing
// needs to be added to keep a new route gated by default.
const PUBLIC_API_ROUTES = [
  ['GET', /^\/api\/config$/],
  ['GET', /^\/api\/sessions$/],
  ['GET', /^\/api\/sessions\/[^/]+$/],
  ['GET', /^\/api\/sessions\/[^/]+\/transcript$/],
  ['GET', /^\/api\/threads$/],
  ['GET', /^\/api\/members$/],
  ['GET', /^\/api\/members\/[^/]+\/dossier$/],
  ['GET', /^\/api\/library$/],
  ['GET', /^\/api\/library\/[^/]+$/],
  ['GET', /^\/api\/graph$/],
  ['GET', /^\/api\/voice\/config$/],
];

function isPublicRoute(req) {
  if ((req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/api/')) return true;
  return PUBLIC_API_ROUTES.some(([method, pattern]) => req.method === method && pattern.test(req.path));
}

// Auth guard — applied to all routes except login/logout
// Must run before express.static: static previously short-circuited the gate,
// serving index.html to anyone while only the API calls it made 401'd — moot
// for the app shell now that #379 opens it deliberately, but the ordering
// still matters for keeping every /api/ path gated by default.
function createRequireAuth(passphrase) {
  return function requireAuth(req, res, next) {
    // #378: set once, here, so route handlers downstream (e.g. the four
    // session read routes gated by published) can read req.authed directly
    // instead of each re-deriving it from passphrase/session state.
    req.authed = isAuthedRequest(req, passphrase);
    if (!passphrase) return next(); // no passphrase set = open
    if (isPublicRoute(req)) return next();
    if (req.session.authed) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
    res.redirect('/login');
  };
}

module.exports = {
  loginPageHtml,
  registerAuthRoutes,
  createRequireAuth,
  isAuthedRequest,
  isPublicRoute,
};
