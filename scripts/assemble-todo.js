'use strict';

// Regenerates PROJECT.md's flat Todo-status backlog list (the plain bullet
// items under "What needs to happen to get there," not the thread-status
// table above it) from docs/roadmap/todo/*.md fragment files. See
// docs/roadmap/todo/README.md for the fragment format and why this exists —
// same problem STATUS.md's fragments solve (parallel PRs editing near the
// same lines in one shared list), but this list also shrinks as items ship,
// so "marking done" is deleting a fragment file rather than appending one.
//
// Unlike assemble-status.js, this script doesn't consume fragments — it
// regenerates the list in place from whatever fragments currently exist, so
// it's safe (and idempotent) to run any time, including with zero changes
// since the last run.
//
// Run manually any time:
//   node scripts/assemble-todo.js
// Also runs weekly as a step in the "secret-cabinet-project-doc-checkin"
// scheduled task, alongside assemble-status.js.
//
// Fragments are sorted by issue number, ascending, for a stable, predictable
// order — there's no publish date to sort by like STATUS.md's entries have,
// since these are standing open items, not a dated log.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TODO_DIR = path.join(ROOT, 'docs', 'roadmap', 'todo');
const PROJECT_FILE = path.join(ROOT, 'PROJECT.md');
const START_MARKER = '<!-- TODO-FRAGMENTS:START -->';
const END_MARKER = '<!-- TODO-FRAGMENTS:END -->';
const EMPTY_PLACEHOLDER =
  '_Todo backlog is empty — see the [GitHub Project board](https://github.com/msdixon/secret-cabinet/projects/2) for anything pending triage._';

function loadFragments() {
  return fs
    .readdirSync(TODO_DIR)
    .filter(f => f.endsWith('.md') && f !== 'README.md')
    .map(file => {
      const match = file.match(/^(\d+)-/);
      if (!match) {
        throw new Error(`Fragment "${file}" doesn't start with "<number>-" — see docs/roadmap/todo/README.md`);
      }
      const text = fs.readFileSync(path.join(TODO_DIR, file), 'utf8').trim();
      if (!text) {
        throw new Error(`Fragment "${file}" is empty`);
      }
      return { file, number: parseInt(match[1], 10), text };
    })
    .sort((a, b) => a.number - b.number);
}

function replaceList(project, listBody) {
  const startAt = project.indexOf(START_MARKER);
  const endAt = project.indexOf(END_MARKER);
  if (startAt === -1 || endAt === -1) {
    throw new Error(`Couldn't find both "${START_MARKER}" and "${END_MARKER}" markers in PROJECT.md`);
  }
  const bodyStart = startAt + START_MARKER.length;
  return project.slice(0, bodyStart) + '\n' + listBody + '\n' + project.slice(endAt);
}

function main() {
  const fragments = loadFragments();
  const listBody = fragments.length === 0 ? `- ${EMPTY_PLACEHOLDER}` : fragments.map(f => `- ${f.text}`).join('\n');

  const project = fs.readFileSync(PROJECT_FILE, 'utf8');
  const updated = replaceList(project, listBody);

  if (updated === project) {
    console.log('Todo list already matches current fragments — nothing to update.');
    return;
  }

  fs.writeFileSync(PROJECT_FILE, updated);
  console.log(`Regenerated PROJECT.md's Todo list from ${fragments.length} fragment(s):`);
  fragments.forEach(f => console.log(`  - ${f.file}`));
}

main();
