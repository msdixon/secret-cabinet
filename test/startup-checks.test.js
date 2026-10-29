'use strict';

// Startup safety: a deployed instance must not run without PASSPHRASE, and a
// local one listens on loopback only.

const test = require('node:test');
const assert = require('node:assert/strict');

const { isDeployed, authConfigError, listenHost } = require('../src/startup-checks.js');

test('isDeployed', async t => {
  await t.test('false for local dev', () => {
    assert.equal(isDeployed({}, true), false);
  });

  await t.test('true when NODE_ENV made IS_LOCAL false', () => {
    assert.equal(isDeployed({}, false), true);
  });

  await t.test('true on Railway even if IS_LOCAL is true', () => {
    assert.equal(isDeployed({ RAILWAY_ENVIRONMENT_NAME: 'production' }, true), true);
    assert.equal(isDeployed({ RAILWAY_SERVICE_ID: 'abc' }, true), true);
  });
});

test('authConfigError', async t => {
  await t.test('local dev may run without a passphrase', () => {
    assert.equal(authConfigError({}, true), null);
  });

  await t.test('a deployed instance without PASSPHRASE refuses to start', () => {
    assert.match(authConfigError({}, false), /PASSPHRASE must be set/);
    assert.match(authConfigError({ RAILWAY_ENVIRONMENT: 'production' }, true), /PASSPHRASE must be set/);
  });

  await t.test('a deployed instance with PASSPHRASE starts', () => {
    assert.equal(authConfigError({ PASSPHRASE: 'x' }, false), null);
  });

  await t.test('ALLOW_OPEN_DEPLOY=true opts in to an open deploy; other values do not', () => {
    assert.equal(authConfigError({ ALLOW_OPEN_DEPLOY: 'true' }, false), null);
    assert.match(authConfigError({ ALLOW_OPEN_DEPLOY: '1' }, false), /PASSPHRASE must be set/);
  });
});

test('listenHost', async t => {
  await t.test('local dev listens on loopback only', () => {
    assert.equal(listenHost({}, true), '127.0.0.1');
  });

  await t.test('deployed instances listen on every interface', () => {
    assert.equal(listenHost({}, false), '0.0.0.0');
    assert.equal(listenHost({ RAILWAY_ENVIRONMENT: 'production' }, true), '0.0.0.0');
  });

  await t.test('HOST overrides both', () => {
    assert.equal(listenHost({ HOST: '0.0.0.0' }, true), '0.0.0.0');
    assert.equal(listenHost({ HOST: '127.0.0.1' }, false), '127.0.0.1');
  });
});
