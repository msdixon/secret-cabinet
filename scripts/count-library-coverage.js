'use strict';

// Computes prompts/library/library.json's coverage numbers from the data
// itself, rather than the hand-written "N of 38" in README.md that every
// #35a PR had to remember to bump. Two concurrent PRs (Pauli #318, Yates
// #322) both bumped that same README line from the same stale base on
// 2026-08-19 — git's merge didn't even flag it as a conflict, it just left
// the wrong number in place, caught only by hand-recomputing from
// library.json. test/library.test.js asserts README's stated numbers match
// this script's output, so a stale count fails CI instead of drifting
// silently between doc-checkins.
//
//   node scripts/count-library-coverage.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function computeCoverage() {
  const library = JSON.parse(fs.readFileSync(path.join(ROOT, 'prompts', 'library', 'library.json'), 'utf8'));
  const roster = JSON.parse(fs.readFileSync(path.join(ROOT, 'prompts', 'members', 'roster.json'), 'utf8'));

  const byAuthor = new Set(library.map(e => e.author));
  const byMembers = new Set(library.flatMap(e => e.members || []));
  const translated = library.filter(e => e.translated).length;

  return {
    rosterSize: roster.length,
    entries: library.length,
    authorCoverage: byAuthor.size,
    memberCoverage: byMembers.size,
    translated,
  };
}

function main() {
  const c = computeCoverage();
  console.log(`${c.authorCoverage} of ${c.rosterSize} roster members covered by author (${c.memberCoverage} by members union).`);
  console.log(`${c.translated} of ${c.entries} entries are translated.`);
}

if (require.main === module) main();

module.exports = { computeCoverage };
