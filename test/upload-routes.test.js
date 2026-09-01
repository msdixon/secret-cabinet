'use strict';

// #193 route-extraction — src/routes/upload.js. The route is a two-handler
// chain (multer middleware, then the extraction logic) — fakeApp records
// both; tests exercise the extraction handler directly with a crafted
// req.file, the same way multer would have populated it, rather than
// driving real multipart parsing.
//
// #443: upload.js does `const multer = require('multer')` and
// `const PDFParser = require('pdf2json')` at module load time, so (same
// reasoning as export-routes.test.js's `withMockedExecFile`) patching
// either after the module is already required does nothing. The
// with*-helpers below install a fake implementation in the require cache,
// force a fresh require of upload.js so its module-scope bindings pick up
// the fake, then restore the real module afterwards.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const { registerUploadRoutes, extractPdfText } = require('../src/routes/upload.js');

function withMockedModule(depName, fakeExports, run) {
  const modPath = require.resolve('../src/routes/upload.js');
  const depPath = require.resolve(depName);
  const original = require.cache[depPath];
  const fakeModule = new Module(depPath);
  fakeModule.exports = fakeExports;
  require.cache[depPath] = fakeModule;
  delete require.cache[modPath];
  try {
    return run(require(modPath));
  } finally {
    if (original) require.cache[depPath] = original;
    else delete require.cache[depPath];
    delete require.cache[modPath];
    require(modPath);
  }
}

function withMockedMulter(middlewareErr, run) {
  function fakeMulter() {
    return { single: () => (req, res, cb) => cb(middlewareErr) };
  }
  fakeMulter.memoryStorage = () => ({});
  return withMockedModule('multer', fakeMulter, run);
}

// A fake PDFParser standing in for pdf2json: `succeedWith` resolves via the
// dataReady callback (mirroring parser.getRawTextContent()), `failWith`
// rejects via the dataError callback (mirroring err.parserError).
function withMockedPdfParser({ succeedWith, failWith }, run) {
  class FakePdfParser {
    on(event, cb) {
      (this._handlers ??= {})[event] = cb;
    }
    getRawTextContent() {
      return succeedWith;
    }
    parseBuffer() {
      setImmediate(() => {
        if (failWith) this._handlers.pdfParser_dataError({ parserError: failWith });
        else this._handlers.pdfParser_dataReady();
      });
    }
  }
  return withMockedModule('pdf2json', FakePdfParser, run);
}

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

test('POST /api/upload — multer middleware handler', async t => {
  await t.test('400s with a friendly message on LIMIT_FILE_SIZE', () => {
    withMockedMulter({ code: 'LIMIT_FILE_SIZE' }, ({ registerUploadRoutes: freshRegister }) => {
      const app = fakeApp();
      freshRegister(app);
      const middleware = app.routes['POST /api/upload'][0];
      const res = fakeRes();
      let nextCalled = false;
      middleware({}, res, () => {
        nextCalled = true;
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'File too large — maximum 25 MB');
      assert.equal(nextCalled, false);
    });
  });

  await t.test('400s with the multer error message for other multer errors', () => {
    withMockedMulter(new Error('Unexpected field'), ({ registerUploadRoutes: freshRegister }) => {
      const app = fakeApp();
      freshRegister(app);
      const middleware = app.routes['POST /api/upload'][0];
      const res = fakeRes();
      middleware({}, res, () => {});
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'Unexpected field');
    });
  });

  await t.test('calls next() when multer succeeds', () => {
    withMockedMulter(null, ({ registerUploadRoutes: freshRegister }) => {
      const app = fakeApp();
      freshRegister(app);
      const middleware = app.routes['POST /api/upload'][0];
      const res = fakeRes();
      let nextCalled = false;
      middleware({}, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);
      assert.equal(res.statusCode, null);
    });
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

  await t.test('routes a .pdf upload through extractPdfText and returns the extracted, normalised text', async () => {
    await withMockedPdfParser(
      { succeedWith: 'Line one\r\nLine two\r' },
      async ({ registerUploadRoutes: freshRegister }) => {
        const app = fakeApp();
        freshRegister(app);
        const pdfHandler = app.routes['POST /api/upload'][1];
        const res = fakeRes();
        const req = { file: { originalname: 'doc.pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.4') } };
        await pdfHandler(req, res);
        assert.equal(res.body.text, 'Line one\nLine two');
        assert.equal(res.body.filename, 'doc.pdf');
      }
    );
  });

  await t.test('routes by mimetype when the extension is not .pdf', async () => {
    await withMockedPdfParser({ succeedWith: 'extracted' }, async ({ registerUploadRoutes: freshRegister }) => {
      const app = fakeApp();
      freshRegister(app);
      const pdfHandler = app.routes['POST /api/upload'][1];
      const res = fakeRes();
      const req = {
        file: { originalname: 'upload', mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.4') },
      };
      await pdfHandler(req, res);
      assert.equal(res.body.text, 'extracted');
    });
  });

  await t.test('500s when PDF extraction fails (corrupt/unparseable PDF)', async () => {
    await withMockedPdfParser(
      { failWith: new Error('corrupt PDF') },
      async ({ registerUploadRoutes: freshRegister }) => {
        const app = fakeApp();
        freshRegister(app);
        const pdfHandler = app.routes['POST /api/upload'][1];
        const res = fakeRes();
        const req = { file: { originalname: 'bad.pdf', mimetype: 'application/pdf', buffer: Buffer.from('broken') } };
        await pdfHandler(req, res);
        assert.equal(res.statusCode, 500);
        assert.equal(res.body.error, 'Could not extract text from file');
      }
    );
  });
});

test('extractPdfText', async t => {
  await t.test('rejects for a buffer that is not a valid PDF', async () => {
    await assert.rejects(() => extractPdfText(Buffer.from('not a pdf')));
  });

  await t.test('resolves with normalised text (CRLF/CR collapsed, trimmed) on a successful parse', async () => {
    await withMockedPdfParser(
      { succeedWith: '  \r\nLine one\r\nLine two\r  ' },
      async ({ extractPdfText: freshExtract }) => {
        const text = await freshExtract(Buffer.from('irrelevant'));
        assert.equal(text, 'Line one\nLine two');
      }
    );
  });

  await t.test('rejects with the parser error on a dataError event', async () => {
    const parserError = new Error('bad xref table');
    await withMockedPdfParser({ failWith: parserError }, async ({ extractPdfText: freshExtract }) => {
      await assert.rejects(() => freshExtract(Buffer.from('irrelevant')), parserError);
    });
  });
});
