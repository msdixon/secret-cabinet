'use strict';

// #193 route-extraction — upload-routes.js. The route is a two-handler
// chain (multer middleware, then the extraction logic) — fakeApp records
// both; tests exercise the extraction handler directly with a crafted
// req.file, the same way multer would have populated it, rather than
// driving real multipart parsing.

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerUploadRoutes, extractPdfText } = require('../upload-routes.js');

function fakeApp() {
  const routes = {};
  return {
    routes,
    post(path, ...handlers) {
      routes[`POST ${path}`] = handlers;
    },
  };
}

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return res;
}

test('registerUploadRoutes', async t => {
  await t.test('registers POST /api/upload as a two-handler chain (multer, then extraction)', () => {
    const app = fakeApp();
    registerUploadRoutes(app);
    const handlers = app.routes['POST /api/upload'];
    assert.equal(handlers.length, 2);
    assert.equal(typeof handlers[1], 'function');
  });
});

test('POST /api/upload — extraction handler', async t => {
  let app, handler;
  t.beforeEach(() => {
    app = fakeApp();
    registerUploadRoutes(app);
    handler = app.routes['POST /api/upload'][1];
  });

  await t.test('400s when no file was attached', async () => {
    const res = fakeRes();
    await handler({ file: null }, res);
    assert.equal(res.statusCode, 400);
  });

  await t.test('reads a .txt file as UTF-8 and normalises line endings', async () => {
    const res = fakeRes();
    const req = {
      file: { originalname: 'notes.txt', mimetype: 'text/plain', buffer: Buffer.from('line one\r\nline two\r\n') },
    };
    await handler(req, res);
    assert.equal(res.body.text, 'line one\nline two');
    assert.equal(res.body.filename, 'notes.txt');
  });

  await t.test('422s when the extracted text is empty', async () => {
    const res = fakeRes();
    const req = { file: { originalname: 'empty.txt', mimetype: 'text/plain', buffer: Buffer.from('   \n  ') } };
    await handler(req, res);
    assert.equal(res.statusCode, 422);
  });
});

test('extractPdfText', async t => {
  await t.test('rejects for a buffer that is not a valid PDF', async () => {
    await assert.rejects(() => extractPdfText(Buffer.from('not a pdf')));
  });
});
