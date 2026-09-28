'use strict';

// #608 — every `const { a, b } = require('./local-module')` in scripts/ and
// src/ must name something the module actually exports.
//
// Destructuring a name a CommonJS module never exported doesn't throw — it's
// just `undefined`, and ESLint can't see across `require()`. That's how
// scripts/fix-558-thinking-fixup.js and scripts/fix-569-thinking-fixup.js
// built Gemini prompts reading "undefined Expression and pose: ... undefined"
// for weeks: they destructured REACTION_EXPRESSION_OVERRIDE_META and
// REACTION_STYLE_SUFFIX from src/portrait-generation.js, which defined both
// but never exported either. This loads each required module for real and
// checks every destructured name against it, so the next such miss fails CI
// instead of silently degrading whatever the script produces.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['scripts', 'src'];

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// `const { a, b: renamed, c = 1, ...rest } = require('./x')` -> ['a', 'b', 'c'].
// Only relative requires: packages are outside this repo's control, and a
// missing name there is a different problem than the one this guards.
const DESTRUCTURED_REQUIRE = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*(['"])(\.{1,2}\/[^'"]+)\2\s*\)/g;

function destructuredRequires(source) {
  const found = [];
  for (const match of source.matchAll(DESTRUCTURED_REQUIRE)) {
    const names = match[1]
      .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map(part => part.trim())
      .filter(part => part && !part.startsWith('...'))
      .map(part => part.split(/[:=]/)[0].trim());
    found.push({ specifier: match[3], names });
  }
  return found;
}

const sites = [];
for (const dir of SCAN_DIRS) {
  for (const file of listJsFiles(path.join(ROOT, dir))) {
    for (const { specifier, names } of destructuredRequires(fs.readFileSync(file, 'utf8'))) {
      sites.push({ file: path.relative(ROOT, file), specifier, names });
    }
  }
}

test('the scan finds destructured local requires to check', () => {
  // Guards the guard: if the regex ever stopped matching, every check below
  // would vanish and this file would pass vacuously.
  assert.ok(sites.length > 10, `expected many destructured requires, found ${sites.length}`);
  assert.ok(
    sites.some(s => s.file === path.join('scripts', 'fix-558-thinking-fixup.js')),
    'expected scripts/fix-558-thinking-fixup.js (the #608 case) among the scanned sites'
  );
});

for (const { file, specifier, names } of sites) {
  test(`${file}: require('${specifier}') exports ${names.join(', ')}`, () => {
    const resolved = require.resolve(path.resolve(ROOT, path.dirname(file), specifier));
    const mod = require(resolved);
    const missing = names.filter(name => !(name in Object(mod)));
    assert.deepEqual(missing, [], `${file} destructures ${missing.join(', ')} but ${specifier} doesn't export it`);
  });
}
