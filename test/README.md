# Tests

Frontend + pure-logic test suite for Secret-Cabin-et ([#137](https://github.com/msdixon/secret-cabinet/issues/137)).

```bash
npm test
```

Runs in CI on every PR and every push to `main` (`.github/workflows/ci.yml`).

## The scoping pass — what was chosen, and why

`#137` was labelled `complexity: unscoped`: choosing the framework *was* part of the
work. This is the decision.

**Runner: Node's built-in `node:test` + `node:assert/strict`. No test-runner dependency.**

The constraint that decided it is the one the issue named — `public/` has no bundler
and no build step. `index.html` loads `scene/scene.js`, `witness.js`, `export.js`,
`sessions.js` and `app.js` as plain `<script>` tags, and each extracted module
([#142](https://github.com/msdixon/secret-cabinet/issues/142)) is an IIFE assigning one
`window.X`. Nothing in `public/` is an ES module or a CommonJS module, so *no* runner
can `import` it directly.

That levels the field: Vitest and Jest would both need the same workaround this suite
uses — read the file, evaluate it in a DOM realm — while adding a large dependency tree
and a config file to a repo that currently has neither. They earn their keep on
codebases with a build pipeline to hook into. There isn't one here, and adding one just
to run tests would invert the precedent `public/` has held since the start.

Meanwhile `pipeline.js` is already CommonJS with a `module.exports`, so `require()`
covers the backend half with no ceremony at all.

`node --test` ships with Node 20 (CI's version), gives `describe`/`it`-style nesting,
subtests, `t.after()` cleanup, a watch mode (`node --test --watch`), and a spec
reporter. Cost: zero packages.

**DOM: `jsdom`, the single devDependency.**

`test/helpers/dom.js` boots a jsdom window, reads the shipped `public/*.js` source
verbatim, and `window.eval`s it — which is what a `<script>` tag does. What the tests
exercise is literally the file that gets served, not a transformed copy of it.

The alternative, a hand-rolled `document` stub, was rejected: these modules do real DOM
work (moving nodes between panels, `classList` toggles, `querySelectorAll` sweeps), and
a stub faithful enough to test that honestly would itself be the thing under test.

**Out of scope for this tranche.** WebGL/visual correctness of `scene/scene.js` — jsdom
has no WebGL, and the issue body already separates "DOM/state logic" from
"visual/WebGL correctness" as different problems needing different tools. `scene.js` is
covered here only at the convention level (it defines `window.LodgeScene`, exposes its
API, loads standalone). Rendering fidelity would want a headless-browser tool, which is
a separate decision to make when there's something worth asserting about the picture.

`app.js` itself is also not directly covered. It is the tangled core the seam mapping
deliberately left in place; it reaches it through the deps bags the module tests fake,
which is the seam that exists to be tested. Splitting it further is
[#193](https://github.com/msdixon/secret-cabinet/issues/193)'s territory, not this one's.

## Layout

| File | Covers |
| --- | --- |
| `pipeline.test.js` | `pipeline.js`'s pure scheduling functions — `pickNextSpeaker`, `isPoolExhausted`, `isValidSelection`, `stripInternalBlankLines`, `countWords`, `lengthTendencyOf` |
| `module-convention.test.js` | The #142 convention itself: one `window.X` per file, documented API present, loads standalone, is actually in `index.html` |
| `witness.test.js` | `witness.js` — replay block parsing, playback, live/reading panel swap, exit → `restoreSession` handback |
| `export.test.js` | `export.js` — `buildAnnotatedTranscript` and the `deps.getCore()` seam |
| `sessions.test.js` | `sessions.js` — `restoreSession`'s full hydration contract, comparative mode, session notes, dossier |
| `helpers/dom.js` | The jsdom loader and the fixture-drift guard |
| `auth.test.js` | `auth.js` — `createRequireAuth`'s gate logic, `registerAuthRoutes`, `loginPageHtml` |
| `library-routes.test.js`, `graph-routes.test.js`, `upload-routes.test.js`, `member-routes.test.js`, `export-routes.test.js`, `session-routes.test.js`, `convene-routes.test.js` | #193's second pass — the `register<X>Routes(app, deps)` server-side route modules, same `fakeApp()`/`fakeReq()`/`fakeRes()` convention `auth.test.js` established: handlers are recorded, then invoked directly against fakes rather than a real server or `supertest`. `session-routes.test.js`/`convene-routes.test.js` use real `sessions-store.js` I/O against a tmpdir fixture where file persistence is the thing under test. |

## Conventions

- **Test through the public API and the deps bag.** Module-private functions
  (`parseWitnessBlocks`, `getAnnotatedPassages`) are exercised through the entry point
  `app.js` actually calls. Nothing here reaches into module internals, for the same
  reason `app.js` doesn't.
- **Fakes are dumb on purpose.** `escapeHTML`, `resolveMember`, `parseAndRenderTranscript`
  and friends are one-liners. The point is to observe what the module does with them,
  not to re-test `app.js`.
- **DOM fixtures are minimal, and guarded.** Fixtures stub only the elements a module
  reaches for. `assertIdsExistInIndexHtml()` fails the suite if one of those ids stops
  existing in the real page, so a rename can't leave the suite green against a DOM that
  no longer ships.
- **No wall-clock waits.** Witness playback auto-advances on a reading-speed timer; tests
  drive `advance()` directly, which is the same entry point the space bar uses. Every
  jsdom window is closed in `t.after()` so no timer outlives its test.
- **Randomness is swept, not seeded.** `pickNextSpeaker` takes an injectable `rng`; the
  tests sweep it deterministically across `[0,1)` and assert on the resulting
  distribution, so the assertions read in the same units the weight constants are
  written in.
