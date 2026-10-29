'use strict';

// Startup checks that keep a deployed instance from running unprotected,
// and keep a local one off the network. Pure functions of the environment,
// so they can be tested without booting the server.

// Railway sets these on every deploy. Counting them as "deployed" means a
// Railway instance is treated as one even if NODE_ENV were ever missing
// there, which would otherwise make IS_LOCAL true.
const RAILWAY_VARS = [
  'RAILWAY_ENVIRONMENT',
  'RAILWAY_ENVIRONMENT_NAME',
  'RAILWAY_ENVIRONMENT_ID',
  'RAILWAY_SERVICE_ID',
];

function isDeployed(env, isLocal) {
  return !isLocal || RAILWAY_VARS.some(name => !!env[name]);
}

// Returns an error message when the server must not start, or null.
//
// With no PASSPHRASE every request is the local admin (see auth.js), which is
// right on Rachel's machine and wrong anywhere public: a deploy that lost the
// variable would silently open every session, every admin page and the API
// budget to anyone. ALLOW_OPEN_DEPLOY=true is the deliberate escape hatch.
function authConfigError(env, isLocal) {
  if (!isDeployed(env, isLocal)) return null;
  if (!env.PASSPHRASE && env.ALLOW_OPEN_DEPLOY !== 'true') {
    return (
      'PASSPHRASE must be set on a deployed instance; without it every visitor is treated as the admin. ' +
      'Set PASSPHRASE (and SESSION_SECRET), or set ALLOW_OPEN_DEPLOY=true to run it open on purpose.'
    );
  }
  return null;
}

// Local dev listens on loopback only, so nobody else on the same network
// reaches an open-mode server. Deployed instances must bind every interface
// for Railway's router to reach them. HOST overrides both (e.g. HOST=0.0.0.0
// to try the app from a phone on the same Wi-Fi).
function listenHost(env, isLocal) {
  if (env.HOST) return env.HOST;
  return isDeployed(env, isLocal) ? '0.0.0.0' : '127.0.0.1';
}

module.exports = { isDeployed, authConfigError, listenHost };
