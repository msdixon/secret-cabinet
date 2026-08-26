'use strict';

// #34 — "the document as object." scene.js's 3D geometry and Babylon-driven
// camera moves can't be exercised outside a real WebGL context (no BABYLON
// global in this test's jsdom window, same constraint every other scene.js
// test respects — see module-convention.test.js's own comment on the file).
// What *is* testable here without BABYLON: the guard clauses that make
// setDocumentText()/closeDocumentInspect() safe no-ops before init() has run
// (sceneRef/cameraRef are both still null at that point), and that init()
// itself fails closed rather than throwing when BABYLON isn't defined at all
// -- exactly the situation a browser hits if the CDN script fails to load,
// which is why init()'s own try/catch exists.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPublicModule } = require('./helpers/dom.js');

test('scene.js document-as-object (#34) guards', async t => {
  await t.test('setDocumentText is a no-op before init() — no BABYLON needed', () => {
    const loaded = loadPublicModule('scene/scene.js');
    t.after(loaded.cleanup);
    assert.doesNotThrow(() => loaded.module.setDocumentText('a provocation'));
    assert.doesNotThrow(() => loaded.module.setDocumentText(''));
  });

  await t.test('closeDocumentInspect is a no-op before init() — no BABYLON needed', () => {
    const loaded = loadPublicModule('scene/scene.js');
    t.after(loaded.cleanup);
    assert.doesNotThrow(() => loaded.module.closeDocumentInspect());
  });

  await t.test('init() fails closed (returns false) rather than throwing when BABYLON is absent', () => {
    const loaded = loadPublicModule('scene/scene.js');
    t.after(loaded.cleanup);
    const canvas = loaded.document.createElement('canvas');
    let result;
    assert.doesNotThrow(() => {
      result = loaded.module.init(canvas);
    });
    assert.equal(result, false);
  });

  await t.test('openDocumentInspect is intentionally internal — only click-triggered, never exposed', () => {
    // Documents the design choice in scene.js's own #34 comment: opening the
    // inspect view is reachable only via the canvas click handler inside
    // init(); closing it is the only half of the pair callers (app.js's
    // close button, an Escape-key listener) need directly.
    const loaded = loadPublicModule('scene/scene.js');
    t.after(loaded.cleanup);
    assert.equal(loaded.module.openDocumentInspect, undefined);
    assert.equal(typeof loaded.module.closeDocumentInspect, 'function');
  });
});
