'use strict';

// #623 — the starters on the empty stage: hand-curated provocations, each
// tied to one Archival Library entry and a pre-cast room of 2-3 members.
// Hand-curated, not generated (Principle 1: every starter carries a library
// excerpt, so it stays verifiable and costs nothing to show). Pure
// load-and-join, no I/O beyond the one JSON read, so it's testable the way
// library.js is.

const fs = require('fs');

const MAX_CAST = 3;
const MIN_CAST = 2;

function loadStartersFile(startersFile) {
  return JSON.parse(fs.readFileSync(startersFile, 'utf8'));
}

// Joins each starter to its library entry's display fields. A starter whose
// library entry has gone missing is dropped rather than shipped half-formed;
// test/starters.test.js is what makes that a CI failure instead of a silent
// shrink.
function resolveStarters(file, libraryIndex) {
  const byId = new Map(libraryIndex.map(e => [e.id, e]));
  const starters = (file.starters || [])
    .map(s => {
      const entry = byId.get(s.libraryId);
      if (!entry) return null;
      return {
        id: s.id,
        libraryId: s.libraryId,
        hook: s.hook,
        cast: s.cast,
        title: entry.title,
        source: entry.source,
        date: entry.date,
      };
    })
    .filter(Boolean);
  return { starters, sitting: file.sitting || null };
}

module.exports = { loadStartersFile, resolveStarters, MAX_CAST, MIN_CAST };
