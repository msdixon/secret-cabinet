'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    // components/layout/*.jsx and *.d.ts landed 2026-08-12 from a design
    // tool and aren't wired into the runtime or build path yet — scoping
    // them out here rather than half-configuring JSX/TS handling for two
    // files. Revisit once they're actually consumed by something.
    ignores: [
      'node_modules/**',
      'public/vendor/**',
      'components/layout/**',
      'residue/**',
      'sessions/**',
      '.auth-sessions/**',
    ],
  },
  js.configs.recommended,
  {
    // Server, scripts, tests: plain Node/CommonJS. `err`/`_`-style unused
    // catch bindings are this codebase's established swallow-the-error
    // idiom (see e.g. session-routes.js, library-routes.js) — not flagging
    // them, same as no-empty allowing an intentionally-empty catch.
    files: ['*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      ecmaVersion: 2022,
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { caughtErrors: 'none', varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
    },
  },
  {
    // public/ has no bundler — each file is a classic <script> tag. Most
    // window.X names it exposes (Casting, Export, Metrics, Sessions,
    // Witness, Beats — see test/README.md) are only ever consumed as
    // window.X property access elsewhere, so they don't need declaring as
    // globals here. LodgeScene is the one exception: app.js's
    // initSceneLayer() calls it bare (`LodgeScene.init(...)`, not
    // `window.LodgeScene.init(...)`) after already null-checking
    // window.LodgeScene — works today because a window.X assignment is
    // reachable as a bare global too, but it's invisible to static
    // analysis without declaring it.
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        BABYLON: 'readonly',
        module: 'readonly', // beats.js's dual Node/browser export guard
        LodgeScene: 'readonly',
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      // sourceType: 'script' means top-level declarations live in global
      // scope; vars:'local' skips checking those specifically because
      // several top-level functions here are only reachable from inline
      // onclick="..."/onerror="..." HTML attribute strings (e.g.
      // toggleAnnotation, portraitFallback) — invisible to static analysis,
      // not actually dead. Local (function-scoped) unused vars still get
      // flagged normally.
      'no-unused-vars': [
        'error',
        { vars: 'local', caughtErrors: 'none', varsIgnorePattern: '^_', argsIgnorePattern: '^_' },
      ],
    },
  },
];
