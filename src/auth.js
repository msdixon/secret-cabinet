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
//
// #594 (chunk B, app-side identity): "authenticated" now means "this request
// resolves to a user in users.js", not "this cookie once knew the shared
// passphrase". The passphrase itself survives as the break-glass way to sign
// in as the admin user (and, until chunk A's emailed codes land, the only
// way), and every downstream check reads req.user / req.isAdmin, set once in
// createRequireAuth below. A second tier, ADMIN_API_ROUTES, gates the routes
// that touch Rachel's own machine or the shared roster — see that table.

const crypto = require('crypto');
const { createFailureLimiter } = require('./rate-limit');

// With no passphrase configured (local dev), every request is this user:
// exactly the pre-#594 "open mode", now with an identity attached so code
// downstream can read req.user unconditionally. Never persisted to users.js.
const LOCAL_ADMIN = Object.freeze({ id: 'local', email: null, name: 'Local', isAdmin: true });

// 10 wrong passphrases per IP per 15 minutes. Generous for a person who
// mistypes, useless for guessing a long passphrase.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

// Hash-then-timingSafeEqual so neither the comparison's timing nor a length
// mismatch leaks anything about the configured passphrase.
function passphraseMatches(candidate, passphrase) {
  if (typeof candidate !== 'string' || !passphrase) return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(passphrase).digest();
  return crypto.timingSafeEqual(a, b);
}

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
      ${error === 'rate' ? '<p class="error">Too many attempts. Try again later.</p>' : error ? '<p class="error">Incorrect passphrase.</p>' : ''}
    </form>
  </div>
</body>
</html>`;
}

// Registers /login (GET+POST) and /logout on the given Express app. Callers
// must still apply the requireAuth middleware themselves afterward — see the
// module comment above for why that ordering is left explicit at the call
// site rather than folded into this function.
//
// #594: a correct passphrase signs in as the admin user from users.js (the
// break-glass path), rather than setting an identity-less `authed` flag.
// Sessions from before #594 carry only that flag and no userId, so they
// resolve to nobody and have to sign in once more — deliberately, rather
// than mapping them to the admin, since the old shared passphrase was handed
// to friends and their cookies shouldn't quietly become admin sessions.
function registerAuthRoutes(
  app,
  passphrase,
  { users, limiter = createFailureLimiter({ windowMs: LOGIN_WINDOW_MS, max: LOGIN_MAX_FAILURES }) } = {}
) {
  // Login page — only served when a passphrase is set and session is not authenticated
  app.get('/login', (req, res) => {
    if (!passphrase || resolveUser(req, passphrase, users)) return res.redirect('/');
    res.send(loginPageHtml(req.query.error));
  });

  app.post('/login', (req, res) => {
    const key = req.ip || 'unknown';
    if (limiter.isBlocked(key)) return res.redirect('/login?error=rate');

    const admin = users?.findAdmin();
    if (!admin || !passphraseMatches(req.body.passphrase, passphrase)) {
      limiter.recordFailure(key);
      return res.redirect('/login?error=1');
    }

    limiter.reset(key);
    // A fresh session id on sign-in, so a cookie planted before login
    // (session fixation) never becomes an authenticated one.
    req.session.regenerate(err => {
      if (err) return res.redirect('/login?error=1');
      req.session.userId = admin.id;
      users.recordLogin(admin.id);
      res.redirect('/');
    });
  });

  app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
  });
}

// #594: the one place that decides who a request is. With no passphrase
// configured every request is LOCAL_ADMIN (open mode, unchanged from before);
// otherwise the session's userId has to name a user that still exists, so
// removing someone from users.json cuts them off on their next request
// rather than whenever their 30-day cookie happens to expire.
function resolveUser(req, passphrase, users) {
  if (!passphrase) return LOCAL_ADMIN;
  const id = req.session && req.session.userId;
  if (!id || !users) return null;
  return users.findById(id);
}

// #378: whether this request should be treated as authenticated for gating
// output by session.published — deliberately not just req.session.authed.
// With no passphrase configured, every request already gets full access via
// createRequireAuth's early return below, but that path never sets
// session.authed to true. A route that checked req.session.authed directly
// would read every no-passphrase deploy (including all of local dev) as
// unauthenticated and start filtering by published — exactly backwards. This
// is the one place that reconciles the two. (#594: now a thin wrapper over
// resolveUser, which does the reconciling.)
function isAuthedRequest(req, passphrase, users) {
  return !!resolveUser(req, passphrase, users);
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
// filtering reachable in production for the first time. POST
// /api/voice/speak (#380) is the one exception to "opening a route means
// it's free": routes/voice.js itself refuses to synthesize anything for a
// request where req.authed is false, serving only a cache hit or the same
// 503 an unconfigured server would return — so listing it here opens replay
// of already-cached voice, not new billable synthesis. Everything else
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
  ['POST', /^\/api\/voice\/speak$/],
];

function isPublicRoute(req) {
  if ((req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/api/')) return true;
  return PUBLIC_API_ROUTES.some(([method, pattern]) => req.method === method && pattern.test(req.path));
}

// #594: the second authorization tier. Before per-user sign-in, "anyone
// authenticated" meant Rachel, so these were gated only by requireAuth.
// Once invitees can sign in they become admin-only:
//
// - Day One: reads and writes Rachel's own journals via the Day One MCP on
//   whatever machine the server runs on. The one route family here with no
//   local-only guard of its own, so this is its only protection.
// - Ulysses/Obsidian export: act on the server's machine (`open` a URL
//   scheme; write a file to a caller-supplied path), not the caller's.
//   Already 404 on a deployed instance; gated here as well so a
//   local instance reached by someone else can't use them either. Everyone
//   keeps the browser-side downloads (.txt/.md/scholarly note).
// - /api/admin/*: visits, the citation manifest, the raw bibliography
//   aggregate — reports across every session, not the caller's own.
// - POST /api/members: spends an Anthropic call and rewrites the roster
//   every user shares.
//
// Prefix patterns are fine here (unlike PUBLIC_API_ROUTES): over-matching
// an admin table only ever gates more, never less.
const ADMIN_API_ROUTES = [
  ['POST', /^\/api\/dayone\//],
  ['POST', /^\/api\/ulysses\/export$/],
  ['POST', /^\/api\/export\/obsidian$/],
  ['*', /^\/api\/admin\//],
  ['POST', /^\/api\/members$/],
];

function isAdminRoute(req) {
  return ADMIN_API_ROUTES.some(
    ([method, pattern]) => (method === '*' || req.method === method) && pattern.test(req.path)
  );
}

// Auth guard — applied to all routes except login/logout
// Must run before express.static: static previously short-circuited the gate,
// serving index.html to anyone while only the API calls it made 401'd — moot
// for the app shell now that #379 opens it deliberately, but the ordering
// still matters for keeping every /api/ path gated by default.
function createRequireAuth(passphrase, users) {
  return function requireAuth(req, res, next) {
    // #378: set once, here, so route handlers downstream (e.g. the four
    // session read routes gated by published) can read req.authed directly
    // instead of each re-deriving it from passphrase/session state. #594
    // adds req.user and req.isAdmin alongside it, same reasoning.
    req.user = resolveUser(req, passphrase, users);
    req.authed = !!req.user;
    req.isAdmin = !!(req.user && req.user.isAdmin);
    if (!passphrase) return next(); // no passphrase set = open, as LOCAL_ADMIN
    if (isPublicRoute(req)) return next();
    if (!req.user) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
      return res.redirect('/login');
    }
    // 403, not 404: unlike an unpublished session, the existence of an
    // admin route isn't a secret worth hiding from a signed-in invitee.
    if (isAdminRoute(req) && !req.isAdmin) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

module.exports = {
  LOCAL_ADMIN,
  loginPageHtml,
  registerAuthRoutes,
  createRequireAuth,
  resolveUser,
  isAuthedRequest,
  isPublicRoute,
  isAdminRoute,
  passphraseMatches,
};
