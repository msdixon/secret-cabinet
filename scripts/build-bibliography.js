'use strict';

// #356 — the project-wide bibliography, a works-cited record of the project
// itself in appendix form. See src/bibliography.js for the document's shape
// and how it differs from scripts/build-citation-manifest.js's review-shaped
// CITATION-MANIFEST.md. Run with:
//   node scripts/build-bibliography.js

const fs = require('fs');
const path = require('path');
const { loadSessions } = require('./build-citation-manifest');
const { buildBibliography } = require('../src/bibliography');

const ROOT = path.join(__dirname, '..');
const OUTPUT_FILE = path.join(ROOT, 'BIBLIOGRAPHY.md');

module.exports = { buildBibliography };

// CLI entry point only — the admin route (src/routes/session.js) calls
// buildBibliography directly instead of shelling out to this file, same
// convention as build-citation-manifest.js.
if (require.main === module) {
  const sessionsDir = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || ROOT, 'sessions');
  const sessions = loadSessions(sessionsDir);

  const rosterModule = require('../src/roster');
  const membersDir = path.join(ROOT, 'prompts', 'members');
  const rosterFile = path.join(membersDir, 'roster.json');
  const roster = fs.existsSync(rosterFile) ? rosterModule.reloadRoster(rosterFile, membersDir) : [];

  const library = require('../src/library');
  const libraryDir = path.join(ROOT, 'prompts', 'library');
  const libraryFile = path.join(libraryDir, 'library.json');
  const libraryIndex = library.loadLibraryIndex(libraryFile);
  const libraryLookup = library.loadLibraryCitationLookup(libraryDir, libraryFile);
  const libraryEntries = libraryIndex.map(entry => ({ ...entry, ...libraryLookup[entry.id] }));

  const bibliography = buildBibliography(sessions, roster, libraryEntries);
  fs.writeFileSync(OUTPUT_FILE, bibliography, 'utf8');
  console.log(`Wrote ${OUTPUT_FILE} (${sessions.length} sessions scanned, from ${sessionsDir}).`);
}
