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
  return { starters, scenarios: resolveScenarios(file), sitting: file.sitting || null };
}

// #626 — scenarios are situations, not texts: no library entry, no join. They
// only need to be well-formed enough to render; test/starters.test.js checks
// the casts and artifact targets against the real roster.
function resolveScenarios(file) {
  return (file.scenarios || [])
    .filter(s => s && s.id && s.label && s.text && Array.isArray(s.cast))
    .map(s => ({
      id: s.id,
      label: s.label,
      text: s.text,
      cast: s.cast,
      setup: s.setup === 'you' || s.setup === 'artifact' ? s.setup : null,
      artifact: s.setup === 'artifact' && s.artifact ? s.artifact : null,
    }));
}

module.exports = { loadStartersFile, resolveStarters, MAX_CAST, MIN_CAST };
