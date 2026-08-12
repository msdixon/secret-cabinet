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

// Auth guard — applied to all routes except login/logout
// Must run before express.static: static previously short-circuited the gate,
// serving index.html to anyone while only the API calls it made 401'd.
function createRequireAuth(passphrase) {
  return function requireAuth(req, res, next) {
    if (!passphrase) return next(); // no passphrase set = open
    if (req.path === '/api/config') return next(); // health check — always public
    // #38: the reading room is the one intentionally public surface — gated by
    // session.published inside the route handler itself, not by passphrase.
    // Authoring/publishing stays behind the passphrase; only the rendered
    // output is reachable here. Portraits must also bypass: the reading room
    // page embeds them directly, and on a deployed (passphrase-set) instance
    // an unauthenticated visitor's <img> requests would otherwise 401. Static
    // character art, not sensitive on its own — safe to open regardless of
    // whether any session happens to be published.
    if (req.path.startsWith('/reading-room/')) return next();
    if (req.path.startsWith('/portraits/')) return next();
    if (req.session.authed) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
    res.redirect('/login');
  };
}

module.exports = {
  loginPageHtml,
  registerAuthRoutes,
  createRequireAuth,
};
