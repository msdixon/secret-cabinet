'use strict';

// Converts pending docs/status/fragments/*.md files into dated entries at
// the top of STATUS.md (newest-first, same convention the file has always
// used), then deletes the fragment files it consumed. See
// docs/status/fragments/README.md for the fragment format and why this
// exists — direct concurrent edits to STATUS.md's insertion point were
// producing avoidable merge conflicts across parallel PR branches.
//
// Run manually any time:
//   node scripts/assemble-status.js
// Also runs weekly via .github/workflows/assemble-status.yml, which opens a
// PR only when there were pending fragments to assemble. Safe to run with
// zero fragments pending — it's a no-op.
//
// All fragments assembled in one run share that run's date (there's no
// per-PR merge date recorded anywhere to assemble from instead) and are
// ordered by issue/PR number, highest first, when more than one lands in
// the same run.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FRAGMENTS_DIR = path.join(ROOT, 'docs', 'status', 'fragments');
const STATUS_FILE = path.join(ROOT, 'STATUS.md');
const INSERTION_MARKER = '\n---\n\n';

function loadFragments() {
  return fs
    .readdirSync(FRAGMENTS_DIR)
    .filter(f => f.endsWith('.md') && f !== 'README.md')
    .map(file => {
      const match = file.match(/^(\d+)-/);
      if (!match) {
        throw new Error(`Fragment "${file}" doesn't start with "<number>-" — see docs/status/fragments/README.md`);
      }
      const text = fs.readFileSync(path.join(FRAGMENTS_DIR, file), 'utf8').trim();
      if (!text) {
        throw new Error(`Fragment "${file}" is empty`);
      }
      return { file, number: parseInt(match[1], 10), text };
    })
    .sort((a, b) => b.number - a.number);
}

function insertEntries(status, entries) {
  const at = status.indexOf(INSERTION_MARKER);
  if (at === -1) {
    throw new Error(`Couldn't find the "${INSERTION_MARKER.trim()}" insertion marker in STATUS.md`);
  }
  const insertAt = at + INSERTION_MARKER.length;
  return status.slice(0, insertAt) + entries.join('\n') + '\n' + status.slice(insertAt);
}

function main() {
  const fragments = loadFragments();
  if (fragments.length === 0) {
    console.log('No pending fragments — nothing to assemble.');
    return;
  }

  const date = new Date().toISOString().slice(0, 10);
  const entries = fragments.map(f => `- **${date}** — ${f.text}`);

  const status = fs.readFileSync(STATUS_FILE, 'utf8');
  fs.writeFileSync(STATUS_FILE, insertEntries(status, entries));
  fragments.forEach(f => fs.unlinkSync(path.join(FRAGMENTS_DIR, f.file)));

  console.log(`Assembled ${fragments.length} fragment(s) into STATUS.md, dated ${date}:`);
  fragments.forEach(f => console.log(`  - ${f.file}`));
}

main();
