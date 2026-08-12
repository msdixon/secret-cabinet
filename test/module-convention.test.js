'use strict';

// #137 — the #142 convention itself, under test.
//
// Every extracted public/ module is an IIFE that assigns exactly one
// `window.X` and never declares or reaches into app.js's core globals
// (MEMBERS, currentSessionId, activeMembers, ...). That rule is currently
// enforced only by review; a stray `var` or a forgotten `window.foo =` would
// pass silently in the browser and only surface as a collision later. This
// pins it: load each file the way index.html does and check what it left on
// the window.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadPublicModule, PUBLIC_DIR } = require('./helpers/dom.js');

// Load order matters in index.html (scene → witness → export → sessions →
// casting → app); each is loaded in isolation here, which is the stronger
// claim: no module needs another to be present just to define itself.
const MODULES = [
  // #219: beats.js is also require()-able from Node (pipeline.js does, so
  // it's tested identically to that file's other pure functions) -- see
  // its own top-of-file comment. In the browser it behaves exactly like
  // the other modules below: one window.Beats, added the same way.
  { file: 'beats.js', global: 'Beats', api: ['splitIntoBeats'] },
  { file: 'scene/scene.js', global: 'LodgeScene', api: ['init', 'updateSeats', 'setSpeaking'] },
  { file: 'witness.js', global: 'Witness', api: ['configure', 'liveReset', 'resetLiveStage', 'liveRoundHeader', 'liveSpeech', 'collapseStage', 'reopenStage', 'exitClicked', 'advance', 'start'] },
  { file: 'export.js', global: 'Export', api: ['configure', 'buildAnnotatedTranscript', 'exportMd'] },
  { file: 'sessions.js', global: 'Sessions', api: ['configure', 'restoreSession', 'collectSessionNotes'] },
  { file: 'casting.js', global: 'Casting', api: ['configure', 'getRegulars', 'isRegular', 'toggleRegular', 'seatRegulars', 'noteHandCast', 'requestProposal', 'acceptProposal', 'dismissProposal', 'consumeMetrics', 'render'] },
];

for (const { file, global: globalName, api } of MODULES) {
  test(`public/${file}`, async t => {
    await t.test('adds exactly one global to window, named as index.html expects', t2 => {
      const loaded = loadPublicModule(file);
      t2.after(loaded.cleanup);
      assert.deepEqual(loaded.globalsAdded, [globalName]);
    });

    await t.test('exposes its documented API as functions', t2 => {
      const loaded = loadPublicModule(file);
      t2.after(loaded.cleanup);
      for (const fn of api) {
        assert.equal(typeof loaded.module[fn], 'function', `${globalName}.${fn} should be a function`);
      }
    });

    await t.test('defines itself without touching app.js core state or the DOM', t2 => {
      // Loading happens against an empty <body>. If a module read a core
      // global or queried an element at load time rather than at call time,
      // this would throw rather than reach the assertion below.
      const loaded = loadPublicModule(file);
      t2.after(loaded.cleanup);
      assert.equal(typeof loaded.module, 'object');
    });

    await t.test('is loaded by index.html', () => {
      // #272: the modules live in public/js/ now, index.html still in public/,
      // so the tag carries a `js/` prefix the MODULES entries above don't.
      const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
      assert.ok(
        new RegExp(`<script src="js/${file}"`).test(html),
        `public/index.html has no <script src="js/${file}"> tag`,
      );
    });
  });
}

// The other half of the convention — "never reach into app.js's core state
// directly" — is checked behaviourally rather than by grepping for names: a
// destructured `const { currentEntry } = deps.getCore()` is indistinguishable
// from a bare global read by pattern-matching, but trivially distinguishable
// at runtime. See the poisoned-globals tests in export.test.js and
// sessions.test.js, which put a decoy value on the window and assert the
// module ignores it in favour of what deps handed over. Modules are also
// strict-mode, so any bare read of an app.js global inside an exercised code
// path throws ReferenceError under these fixtures rather than passing quietly.
