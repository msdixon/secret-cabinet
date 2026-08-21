'use strict';

// #29 (ElevenLabs pass) — src/routes/voice.js. Same fakeApp/fakeReq
// conventions as member-routes.test.js; fakeRes is a real Writable so
// fs.createReadStream(...).pipe(res) in the route works exactly as it does
// against a live http.ServerResponse. global.fetch is stubbed per test
// (routes/voice.js is the only place in this codebase that calls out to
// ElevenLabs) and restored in t.after so no test leaks a stub into another.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');

const { registerVoiceRoutes } = require('../src/routes/voice.js');

function fakeApp() {
  const routes = {};
  return {
    routes,
    get(p, handler) {
      routes[`GET ${p}`] = handler;
    },
    post(p, handler) {
      routes[`POST ${p}`] = handler;
    },
  };
}

// #380: req.authed mirrors what createRequireAuth sets on every request in
// server.js before this route ever runs. Defaults to true here so the
// pre-#380 tests below (which predate the concept and exercise the
// authenticated/synthesize-freely path) don't need to change.
function fakeReq({ body = {}, authed = true } = {}) {
  return { body, authed };
}

function fakeRes() {
  const chunks = [];
  const res = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  res.statusCode = 200;
  res.headers = {};
  res.body = null;
  res.status = function (code) {
    this.statusCode = code;
    return this;
  };
  res.json = function (body) {
    this.body = body;
    return this;
  };
  res.setHeader = function (k, v) {
    this.headers[k] = v;
  };
  res.buffer = () => Buffer.concat(chunks);
  return res;
}

// The route's success path pipes a file into res without awaiting the pipe
// itself (correct against a real http.ServerResponse, which manages its own
// lifecycle) -- so a test awaiting the route call alone can race the stream.
// Wait for the Writable's own 'finish' event instead.
function waitForFinish(res) {
  return new Promise(resolve => res.on('finish', resolve));
}

function makeCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'voice-cache-test-'));
}

function stubFetch(impl) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return impl(url, opts);
  };
  return { calls, restore: () => (global.fetch = original) };
}

const ROSTER = [
  { id: 'crowley', name: 'Crowley', voiceId: 'voice-crowley' },
  { id: 'waite', name: 'Waite' }, // no voiceId assigned
];

test('registerVoiceRoutes', async t => {
  await t.test('registers GET /api/voice/config and POST /api/voice/speak', () => {
    const app = fakeApp();
    registerVoiceRoutes(app, { roster: ROSTER, voiceCacheDir: makeCacheDir(), apiKey: null, modelId: 'model' });
    assert.equal(typeof app.routes['GET /api/voice/config'], 'function');
    assert.equal(typeof app.routes['POST /api/voice/speak'], 'function');
  });
});

test('GET /api/voice/config', async t => {
  await t.test('reports unavailable with no API key', () => {
    const app = fakeApp();
    registerVoiceRoutes(app, { roster: ROSTER, voiceCacheDir: makeCacheDir(), apiKey: null, modelId: 'model' });
    const res = fakeRes();
    app.routes['GET /api/voice/config'](fakeReq(), res);
    assert.deepEqual(res.body, { available: false });
  });

  await t.test('reports available with an API key configured', () => {
    const app = fakeApp();
    registerVoiceRoutes(app, { roster: ROSTER, voiceCacheDir: makeCacheDir(), apiKey: 'sk-test', modelId: 'model' });
    const res = fakeRes();
    app.routes['GET /api/voice/config'](fakeReq(), res);
    assert.deepEqual(res.body, { available: true });
  });
});

test('POST /api/voice/speak', async t => {
  await t.test('503s when no API key is configured', async () => {
    const app = fakeApp();
    registerVoiceRoutes(app, { roster: ROSTER, voiceCacheDir: makeCacheDir(), apiKey: null, modelId: 'model' });
    const res = fakeRes();
    await app.routes['POST /api/voice/speak'](fakeReq({ body: { memberId: 'crowley', text: 'Hello.' } }), res);
    assert.equal(res.statusCode, 503);
  });

  await t.test('400s when text is missing', async () => {
    const app = fakeApp();
    registerVoiceRoutes(app, { roster: ROSTER, voiceCacheDir: makeCacheDir(), apiKey: 'sk-test', modelId: 'model' });
    const res = fakeRes();
    await app.routes['POST /api/voice/speak'](fakeReq({ body: { memberId: 'crowley' } }), res);
    assert.equal(res.statusCode, 400);
  });

  await t.test('404s when the member has no voiceId assigned', async () => {
    const app = fakeApp();
    registerVoiceRoutes(app, { roster: ROSTER, voiceCacheDir: makeCacheDir(), apiKey: 'sk-test', modelId: 'model' });
    const res = fakeRes();
    await app.routes['POST /api/voice/speak'](fakeReq({ body: { memberId: 'waite', text: 'Hello.' } }), res);
    assert.equal(res.statusCode, 404);
  });

  await t.test('404s for an unknown member id', async () => {
    const app = fakeApp();
    registerVoiceRoutes(app, { roster: ROSTER, voiceCacheDir: makeCacheDir(), apiKey: 'sk-test', modelId: 'model' });
    const res = fakeRes();
    await app.routes['POST /api/voice/speak'](fakeReq({ body: { memberId: 'nobody', text: 'Hello.' } }), res);
    assert.equal(res.statusCode, 404);
  });

  await t.test('calls ElevenLabs with the resolved voiceId, streams audio back, and caches it on disk', async t2 => {
    const stub = stubFetch(async () => ({
      ok: true,
      arrayBuffer: async () => Buffer.from('fake-mp3-bytes'),
    }));
    t2.after(stub.restore);

    const cacheDir = makeCacheDir();
    t2.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
    const app = fakeApp();
    registerVoiceRoutes(app, { roster: ROSTER, voiceCacheDir: cacheDir, apiKey: 'sk-test', modelId: 'turbo-model' });
    const res = fakeRes();
    await app.routes['POST /api/voice/speak'](fakeReq({ body: { memberId: 'crowley', text: 'Hello.' } }), res);
    await waitForFinish(res);

    assert.equal(stub.calls.length, 1);
    assert.match(stub.calls[0].url, /\/text-to-speech\/voice-crowley$/);
    assert.equal(stub.calls[0].opts.headers['xi-api-key'], 'sk-test');
    assert.equal(JSON.parse(stub.calls[0].opts.body).model_id, 'turbo-model');

    assert.equal(res.headers['Content-Type'], 'audio/mpeg');
    assert.equal(res.buffer().toString(), 'fake-mp3-bytes');
    assert.equal(fs.readdirSync(cacheDir).length, 1, 'expected the synthesized audio to be cached on disk');
  });

  await t.test(
    'a second request for the same voice+text is served from cache without calling ElevenLabs again',
    async t2 => {
      const stub = stubFetch(async () => ({
        ok: true,
        arrayBuffer: async () => Buffer.from('fake-mp3-bytes'),
      }));
      t2.after(stub.restore);

      const cacheDir = makeCacheDir();
      t2.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
      const app = fakeApp();
      registerVoiceRoutes(app, { roster: ROSTER, voiceCacheDir: cacheDir, apiKey: 'sk-test', modelId: 'model' });

      const res1 = fakeRes();
      await app.routes['POST /api/voice/speak'](fakeReq({ body: { memberId: 'crowley', text: 'Hello.' } }), res1);
      await waitForFinish(res1);
      const res2 = fakeRes();
      await app.routes['POST /api/voice/speak'](fakeReq({ body: { memberId: 'crowley', text: 'Hello.' } }), res2);
      await waitForFinish(res2);

      assert.equal(stub.calls.length, 1, 'the second identical request should hit the cache, not ElevenLabs again');
      assert.equal(res2.buffer().toString(), 'fake-mp3-bytes');
    }
  );

  await t.test('502s when ElevenLabs responds with a non-OK status', async t2 => {
    const stub = stubFetch(async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }));
    t2.after(stub.restore);
    const cacheDir = makeCacheDir();
    t2.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
    const app = fakeApp();
    registerVoiceRoutes(app, { roster: ROSTER, voiceCacheDir: cacheDir, apiKey: 'sk-test', modelId: 'model' });
    const res = fakeRes();
    await app.routes['POST /api/voice/speak'](fakeReq({ body: { memberId: 'crowley', text: 'Hello.' } }), res);
    assert.equal(res.statusCode, 502);
    assert.equal(fs.readdirSync(cacheDir).length, 0, 'a failed request should not be cached');
  });

  await t.test('502s when the fetch itself throws (network error)', async t2 => {
    const stub = stubFetch(async () => {
      throw new Error('network down');
    });
    t2.after(stub.restore);
    const cacheDir = makeCacheDir();
    t2.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
    const app = fakeApp();
    registerVoiceRoutes(app, { roster: ROSTER, voiceCacheDir: cacheDir, apiKey: 'sk-test', modelId: 'model' });
    const res = fakeRes();
    await app.routes['POST /api/voice/speak'](fakeReq({ body: { memberId: 'crowley', text: 'Hello.' } }), res);
    assert.equal(res.statusCode, 502);
  });

  // #380: an unauthenticated (public-replay) request may only ever be served
  // a clip that's already cached on disk -- never trigger a fresh, billable
  // ElevenLabs synthesis.
  await t.test('unauthenticated + cache miss: 503s without ever calling ElevenLabs', async t2 => {
    const stub = stubFetch(async () => {
      throw new Error('should never be called');
    });
    t2.after(stub.restore);
    const cacheDir = makeCacheDir();
    t2.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
    const app = fakeApp();
    registerVoiceRoutes(app, { roster: ROSTER, voiceCacheDir: cacheDir, apiKey: 'sk-test', modelId: 'model' });
    const res = fakeRes();
    await app.routes['POST /api/voice/speak'](
      fakeReq({ body: { memberId: 'crowley', text: 'Never synthesized.' }, authed: false }),
      res
    );
    assert.equal(res.statusCode, 503);
    assert.equal(stub.calls.length, 0, 'an unauthenticated cache miss must never reach the ElevenLabs fetch');
    assert.equal(fs.readdirSync(cacheDir).length, 0);
  });

  await t.test('unauthenticated + cache hit: serves the cached clip, no ElevenLabs call', async t2 => {
    const stub = stubFetch(async () => ({
      ok: true,
      arrayBuffer: async () => Buffer.from('fake-mp3-bytes'),
    }));
    t2.after(stub.restore);
    const cacheDir = makeCacheDir();
    t2.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
    const app = fakeApp();
    registerVoiceRoutes(app, { roster: ROSTER, voiceCacheDir: cacheDir, apiKey: 'sk-test', modelId: 'model' });

    // Prime the cache as an authenticated request (e.g. Rachel watching the
    // meeting once before publishing it).
    const res1 = fakeRes();
    await app.routes['POST /api/voice/speak'](
      fakeReq({ body: { memberId: 'crowley', text: 'Already cached.' }, authed: true }),
      res1
    );
    await waitForFinish(res1);
    assert.equal(stub.calls.length, 1);

    // A later unauthenticated visitor replaying the same line gets the
    // cached clip, and ElevenLabs is not called again.
    const res2 = fakeRes();
    await app.routes['POST /api/voice/speak'](
      fakeReq({ body: { memberId: 'crowley', text: 'Already cached.' }, authed: false }),
      res2
    );
    await waitForFinish(res2);

    assert.equal(res2.statusCode, 200);
    assert.equal(stub.calls.length, 1, 'the unauthenticated cache hit should not call ElevenLabs');
    assert.equal(res2.buffer().toString(), 'fake-mp3-bytes');
  });
});
