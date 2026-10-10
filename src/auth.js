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
// passphrase". Invitees sign in with a 6-digit code emailed to them (chunk
// A); the passphrase survives only as the break-glass way to sign in as the
// admin user. Every downstream check reads req.user / req.isAdmin, set once
// in createRequireAuth below. A second tier, ADMIN_ROUTES, gates the routes
// that touch Rachel's own machine, the shared roster, or the guest list.

const crypto = require('crypto');
const { createFailureLimiter } = require('./rate-limit');
const { createLoginCodeStore } = require('./login-codes');
const { loginCodeEmail } = require('./mailer');
const { normalizeEmail } = require('./users');

// With no passphrase configured (local dev), every request is this user:
// exactly the pre-#594 "open mode", now with an identity attached so code
// downstream can read req.user unconditionally. Never persisted to users.js.
const LOCAL_ADMIN = Object.freeze({ id: 'local', email: null, name: 'Local', isAdmin: true });

// 10 wrong passphrases per IP per 15 minutes. Generous for a person who
// mistypes, useless for guessing a long passphrase.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

// Code emails: 5 per IP and 3 per address per 15 minutes. Enough to
// recover from a typo or a slow inbox; not enough to spam anyone with.
const CODE_SENDS_PER_IP = 5;
const CODE_SENDS_PER_EMAIL = 3;

// Hash-then-timingSafeEqual so neither the comparison's timing nor a length
// mismatch leaks anything about the configured passphrase.
function passphraseMatches(candidate, passphrase) {
  if (typeof candidate !== 'string' || !passphrase) return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(passphrase).digest();
  return crypto.timingSafeEqual(a, b);
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// Shared chrome for every server-rendered gate page (login steps, and the
// admin guest list in routes/users.js). Plain HTML forms, no client JS: the
// gate has to work before any of the app shell's scripts are trusted.
function gatePageHtml(inner, { width = 320 } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>The Secret-Cabin-et</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #1a1510; color: #c8b89a; font-family: 'Georgia', serif;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 16px; }
    .gate { text-align: center; width: 100%; max-width: ${width}px; }
    h1 { font-size: 1.1rem; letter-spacing: .2em; text-transform: uppercase;
         color: #8b7355; margin-bottom: 2rem; }
    p.note { font-size: .85rem; color: #8b7355; margin-bottom: 1rem; line-height: 1.5; }
    input { width: 100%; padding: .75rem 1rem; background: #0d0b08;
      border: 1px solid #3a3228; color: #c8b89a; font-family: inherit; font-size: 1rem;
      border-radius: 2px; outline: none; text-align: center; letter-spacing: .15em; }
    input + input { margin-top: .5rem; }
    input:focus { border-color: #8b7355; }
    button { margin-top: 1rem; width: 100%; padding: .75rem; background: transparent;
      border: 1px solid #5a4a3a; color: #a89070; font-family: inherit; font-size: .85rem;
      letter-spacing: .15em; text-transform: uppercase; cursor: pointer; border-radius: 2px; }
    button:hover { border-color: #8b7355; color: #c8b89a; }
    .error { margin-top: 1rem; color: #a05050; font-size: .85rem; }
    .flash { margin-bottom: 1rem; color: #a89070; font-size: .85rem; }
    .alt { margin-top: 1.5rem; font-size: .8rem; }
    a { color: #8b7355; }
    a:hover { color: #c8b89a; }
  </style>
</head>
<body>
  <div class="gate">
    <h1>The Secret-Cabin-et</h1>
${inner}
  </div>
</body>
</html>`;
}

const LOGIN_ERRORS = {
  rate: 'Too many attempts. Try again later.',
  passphrase: 'Incorrect passphrase. Check it and try again.',
  code: 'That code is wrong or has expired. Use the link below to ask for a new one.',
  email: 'Enter a valid email address.',
};

function errorHtml(error) {
  if (!error) return '';
  // Unknown values (including the pre-#594 `?error=1`) fall back to the
  // step's own generic message rather than echoing the query string.
  return `<p class="error">${escapeHtml(LOGIN_ERRORS[error] || 'Something went wrong. Try again.')}</p>`;
}

// #594 chunk A: three steps. `email` (the default when a mailer is
// configured) asks for an address; `code` asks for the emailed code;
// `passphrase` is the break-glass admin login, always reachable from a
// small link and the only step when email sign-in isn't configured.
function loginPageHtml({ step = 'passphrase', error = null, emailEnabled = false } = {}) {
  const passphraseLink = '<p class="alt"><a href="/login/passphrase">Sign in with the passphrase</a></p>';
  if (step === 'email') {
    return gatePageHtml(`    <form method="POST" action="/login/code">
      <p class="note">Enter the email you were invited with and we'll send you a sign-in code.</p>
      <input type="email" name="email" placeholder="you@example.com" autocomplete="email" required autofocus>
      <button type="submit">Send code</button>
      ${errorHtml(error)}
    </form>
    ${passphraseLink}`);
  }
  if (step === 'code') {
    return gatePageHtml(`    <form method="POST" action="/login/verify">
      <p class="note">If that address is on the guest list, a 6-digit code is on its way. It expires in 10 minutes.</p>
      <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" placeholder="000000" required autofocus>
      <button type="submit">Enter</button>
      ${errorHtml(error)}
    </form>
    <p class="alt"><a href="/login">Use a different email, or send a new code</a></p>`);
  }
  return gatePageHtml(`    <form method="POST" action="/login/passphrase">
      <input type="password" name="passphrase" placeholder="Enter passphrase" autofocus>
      <button type="submit">Enter</button>
      ${errorHtml(error === '1' || error === true ? 'passphrase' : error)}
    </form>
    ${emailEnabled ? '<p class="alt"><a href="/login">Sign in with email instead</a></p>' : ''}`);
}

// Registers the /login steps and /logout on the given Express app. Callers
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
//
// Chunk A adds emailed codes: POST /login/code always moves on to the code
// step whether or not the address is invited, so the form can't be used to
// learn who is on the guest list; a code is only generated and sent for an
// address that is. The pending email lives in the session, never the URL.
// Three limiters: wrong passphrases/codes per IP (`limiter`), and code sends
// per IP and per email (`sendLimiter`, `emailLimiter`) so the form can't be
// used to flood someone's inbox or burn Resend quota.
function registerAuthRoutes(
  app,
  passphrase,
  {
    users,
    mailer = { enabled: false },
    codes = createLoginCodeStore(),
    limiter = createFailureLimiter({ windowMs: LOGIN_WINDOW_MS, max: LOGIN_MAX_FAILURES }),
    sendLimiter = createFailureLimiter({ windowMs: LOGIN_WINDOW_MS, max: CODE_SENDS_PER_IP }),
    emailLimiter = createFailureLimiter({ windowMs: LOGIN_WINDOW_MS, max: CODE_SENDS_PER_EMAIL }),
    log = console,
  } = {}
) {
  const emailEnabled = !!mailer.enabled;
  const alreadyIn = req => !passphrase || resolveUser(req, passphrase, users);

  // A fresh session id on sign-in, so a cookie planted before login
  // (session fixation) never becomes an authenticated one.
  function signIn(req, res, user, errorUrl) {
    req.session.regenerate(err => {
      if (err) return res.redirect(errorUrl);
      req.session.userId = user.id;
      users.recordLogin(user.id);
      res.redirect('/');
    });
  }

  app.get('/login', (req, res) => {
    if (alreadyIn(req)) return res.redirect('/');
    res.send(loginPageHtml({ step: emailEnabled ? 'email' : 'passphrase', error: req.query.error, emailEnabled }));
  });

  app.get('/login/passphrase', (req, res) => {
    if (alreadyIn(req)) return res.redirect('/');
    res.send(loginPageHtml({ step: 'passphrase', error: req.query.error, emailEnabled }));
  });

  app.get('/login/code', (req, res) => {
    if (alreadyIn(req)) return res.redirect('/');
    if (!emailEnabled || !req.session.pendingLogin) return res.redirect('/login');
    res.send(loginPageHtml({ step: 'code', error: req.query.error, emailEnabled }));
  });

  app.post('/login/passphrase', (req, res) => {
    const key = req.ip || 'unknown';
    if (limiter.isBlocked(key)) return res.redirect('/login/passphrase?error=rate');

    const admin = users?.findAdmin();
    if (!admin || !passphraseMatches(req.body.passphrase, passphrase)) {
      limiter.recordFailure(key);
      return res.redirect('/login/passphrase?error=passphrase');
    }

    limiter.reset(key);
    signIn(req, res, admin, '/login/passphrase?error=passphrase');
  });

  app.post('/login/code', (req, res) => {
    if (!passphrase || !emailEnabled) return res.redirect('/login');
    const email = normalizeEmail(req.body.email);
    if (!email || !email.includes('@')) return res.redirect('/login?error=email');

    const ipKey = req.ip || 'unknown';
    if (sendLimiter.isBlocked(ipKey)) return res.redirect('/login?error=rate');
    sendLimiter.recordFailure(ipKey);

    req.session.pendingLogin = { email };
    const user = users?.findByEmail(email);
    if (user && !emailLimiter.isBlocked(email)) {
      emailLimiter.recordFailure(email);
      const code = codes.issue(email);
      // Not awaited: waiting on Resend only for listed addresses would make
      // their redirect a network round-trip slower, which reveals who is
      // invited. Failures are logged, not shown, for the same reason.
      Promise.resolve()
        .then(() => mailer.send({ to: email, ...loginCodeEmail(code) }))
        .catch(err => log.error(`[auth] sign-in code email failed: ${err.message}`));
    }
    res.redirect('/login/code');
  });

  app.post('/login/verify', (req, res) => {
    const pending = req.session.pendingLogin;
    if (!passphrase || !emailEnabled || !pending) return res.redirect('/login');

    const key = req.ip || 'unknown';
    if (limiter.isBlocked(key)) return res.redirect('/login/code?error=rate');

    const user = users?.findByEmail(pending.email);
    if (!codes.verify(pending.email, req.body.code) || !user) {
      limiter.recordFailure(key);
      return res.redirect('/login/code?error=code');
    }

    limiter.reset(key);
    emailLimiter.reset(pending.email);
    signIn(req, res, user, '/login/code?error=code');
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
// - /admin/*: the guest list (routes/users.js) — the only admin surface
//   outside /api/, and the reason requireAuth checks this table *before*
//   the public tier: a GET outside /api/ is otherwise public app shell.
//
// Prefix patterns are fine here (unlike PUBLIC_API_ROUTES): over-matching
// an admin table only ever gates more, never less.
const ADMIN_ROUTES = [
  ['POST', /^\/api\/dayone\//],
  ['POST', /^\/api\/ulysses\/export$/],
  ['POST', /^\/api\/export\/obsidian$/],
  ['*', /^\/api\/admin\//],
  ['POST', /^\/api\/members$/],
  ['*', /^\/admin(\/|$)/],
];

function isAdminRoute(req) {
  return ADMIN_ROUTES.some(([method, pattern]) => (method === '*' || req.method === method) && pattern.test(req.path));
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
    // Admin tier first — see ADMIN_ROUTES for why it has to precede the
    // public check.
    const admin = isAdminRoute(req);
    if (!admin && isPublicRoute(req)) return next();
    if (!req.user) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
      return res.redirect('/login');
    }
    // 403, not 404: unlike an unpublished session, the existence of an
    // admin route isn't a secret worth hiding from a signed-in invitee.
    if (admin && !req.isAdmin) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

module.exports = {
  LOCAL_ADMIN,
  loginPageHtml,
  gatePageHtml,
  escapeHtml,
  registerAuthRoutes,
  createRequireAuth,
  resolveUser,
  isAuthedRequest,
  isPublicRoute,
  isAdminRoute,
  passphraseMatches,
};
