'use strict';

// #137 — test harness for public/'s script-tag modules.
//
// public/ has no bundler and no build step: index.html loads scene.js,
// witness.js, export.js, sessions.js and app.js as plain <script> tags, and
// each of the extracted modules (#142) is an IIFE that assigns one
// `window.X`. Rather than fight that with a module shim, this harness runs
// each file the same way the browser does -- read the shipped source
// verbatim, eval it inside a jsdom window -- so what the tests exercise is
// literally the file that gets served, not a transformed copy of it.
//
// jsdom is the only test-side dependency. Node's built-in `node:test` is the
// runner; see test/README.md for why.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
// #272 moved the script-tag modules into public/js/ (index.html itself stays
// in public/). Two constants rather than one so loadPublicModule's callers
// keep passing a bare 'casting.js' — the file names are what those tests are
// about, not where the directory split put them.
const PUBLIC_JS_DIR = path.join(PUBLIC_DIR, 'js');

/**
 * Boot a jsdom window containing `bodyHtml`, then load public/<fileName>
 * into it exactly as a <script> tag would.
 *
 * `beforeEval(window)` runs after the window exists but before the module is
 * loaded into it — the only place to seed browser state a module reads at
 * load time rather than at call time (casting.js reads localStorage for the
 * user's regulars there, the way a real page would; witness.js's stage view
 * switcher does the same for its persisted text/room preference).
 *
 * Returns { dom, window, document, module, globalsAdded, cleanup }:
 *   module        — the single window global the file defined (window.Witness, ...)
 *   globalsAdded  — every global name the file added, so a test can assert the
 *                   module leaked nothing beyond its own namespace (#142's rule)
 *   cleanup       — closes the window; call it from t.after() so pending
 *                   auto-advance timers don't outlive the test
 */
function loadPublicModule(fileName, bodyHtml = '', beforeEval = null) {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    runScripts: 'outside-only', // gives us window.eval; does NOT run inline <script> in bodyHtml
    url: 'http://localhost:3132/',
  });
  const { window } = dom;

  // jsdom implements no layout, so scrollIntoView() simply doesn't exist and
  // calling it throws. witness.js's start() calls it on the panel. Stub it
  // rather than let a layout gap masquerade as a module failure.
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};

  beforeEval?.(window);

  const before = new Set(Object.keys(window));
  const src = fs.readFileSync(path.join(PUBLIC_JS_DIR, fileName), 'utf8');
  window.eval(src);
  const globalsAdded = Object.keys(window).filter(k => !before.has(k));

  return {
    dom,
    window,
    document: window.document,
    module: globalsAdded.length === 1 ? window[globalsAdded[0]] : undefined,
    globalsAdded,
    cleanup: () => window.close(),
  };
}

/**
 * Fixture-drift guard. The DOM fixtures below are hand-written minimums, not
 * copies of index.html -- which means they can quietly go stale if an id is
 * renamed there. Assert every id a fixture stubs still exists in the real
 * page, so a rename fails the suite instead of leaving it green against a
 * DOM that no longer ships.
 */
function assertIdsExistInIndexHtml(ids) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const missing = ids.filter(id => !new RegExp(`id=["']${id}["']`).test(html));
  assert.deepEqual(missing, [], `ids missing from public/index.html: ${missing.join(', ')}`);
}

module.exports = { loadPublicModule, assertIdsExistInIndexHtml, PUBLIC_DIR, PUBLIC_JS_DIR };
