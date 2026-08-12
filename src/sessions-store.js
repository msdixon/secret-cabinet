'use strict';

// #193 seam-map, module 8 of 8 — session persistence (read/write/list/branch,
// as named in the original issue proposal).
//
// sessionsDir is passed in explicitly rather than read from a module-level
// constant, following the convention set by roster.js/library.js/graph.js.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function makeSessionId(entry) {
  const date = new Date().toISOString().slice(0, 10);
  const slug = entry.trim().slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const hash = crypto.createHash('md5').update(entry).digest('hex').slice(0, 6);
  return `${date}-${slug}-${hash}`;
}

// Branch IDs can't reuse makeSessionId's hash-of-entry-text — the entry is
// identical to the parent's, so same-day branches would collide. Mix in the
// parent id, branch point, and wall-clock time for uniqueness.
function makeBranchId(parent, roundIndex) {
  const date = new Date().toISOString().slice(0, 10);
  const slug = parent.entry.trim().slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const hash = crypto.createHash('md5').update(`${parent.id}:${roundIndex}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 6);
  return `${date}-${slug}-branch-${hash}`;
}

function saveSession(sessionsDir, session) {
  fs.writeFileSync(path.join(sessionsDir, `${session.id}.json`), JSON.stringify(session, null, 2));
}

function loadSession(sessionsDir, id) {
  const p = path.join(sessionsDir, `${id}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

module.exports = {
  makeSessionId,
  makeBranchId,
  saveSession,
  loadSession,
};
