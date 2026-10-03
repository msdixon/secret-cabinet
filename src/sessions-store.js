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
  const slug = entry
    .trim()
    .slice(0, 40)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  const hash = crypto.createHash('md5').update(entry).digest('hex').slice(0, 6);
  return `${date}-${slug}-${hash}`;
}

// Branch IDs can't reuse makeSessionId's hash-of-entry-text — the entry is
// identical to the parent's, so same-day branches would collide. Mix in the
// parent id, branch point, and wall-clock time for uniqueness.
function makeBranchId(parent, roundIndex) {
  const date = new Date().toISOString().slice(0, 10);
  const slug = parent.entry
    .trim()
    .slice(0, 40)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  const hash = crypto
    .createHash('md5')
    .update(`${parent.id}:${roundIndex}:${Date.now()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 6);
  return `${date}-${slug}-branch-${hash}`;
}

function saveSession(sessionsDir, session) {
  fs.writeFileSync(path.join(sessionsDir, `${session.id}.json`), JSON.stringify(session, null, 2));
}

function loadSession(sessionsDir, id) {
  const p = path.join(sessionsDir, `${id}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

// #595: sessions are private to their creator by default, with `published`
// (#378/#379) as the one opt-in way to share. These predicates are the whole
// policy; routes call them rather than re-deriving it.
//
// - Reading: the owner, or anyone when the session is published.
// - Writing (continue, interject, tag, delete, publish, grounding...): the
//   owner only. Published is read access, never edit access.
// - Admins get no exemption. The 2026-09-21 scope decision is metadata-only
//   admin visibility (see the admin sessions route), the same protection
//   Rachel wants for her own drafts. The one exception is the open-mode local
//   user (no passphrase, so everyone is Rachel on her own machine): it owns
//   everything, including sessions saved before ownership existed.
const LOCAL_USER_ID = 'local';

function isOwner(session, user) {
  if (!session || !user) return false;
  if (user.id === LOCAL_USER_ID) return true;
  return !!session.ownerId && session.ownerId === user.id;
}

function canRead(session, user) {
  return !!session && (!!session.published || isOwner(session, user));
}

function canWrite(session, user) {
  return isOwner(session, user);
}

// Gives every session written before #595 (no ownerId) to `ownerId`, the
// admin, as decided 2026-09-21. Idempotent: a session that already has an
// owner is never touched, so it is safe to run on every startup. Returns the
// number of sessions claimed.
function claimOwnerlessSessions(sessionsDir, ownerId) {
  if (!ownerId || !fs.existsSync(sessionsDir)) return 0;
  let claimed = 0;
  for (const file of fs.readdirSync(sessionsDir)) {
    if (!file.endsWith('.json')) continue;
    const p = path.join(sessionsDir, file);
    try {
      const session = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (session.ownerId) continue;
      session.ownerId = ownerId;
      // Same write-then-rename as users.js: a crash mid-migration must not
      // leave a truncated session file behind.
      fs.writeFileSync(`${p}.tmp`, JSON.stringify(session, null, 2));
      fs.renameSync(`${p}.tmp`, p);
      claimed++;
    } catch (err) {
      console.warn(`[sessions] could not assign an owner to ${file}: ${err.message}`);
    }
  }
  return claimed;
}

// For the aggregate readers (graph, bibliography, manifest) that scan the
// whole directory and would otherwise leak one user's sessions to another.
function filterReadable(sessions, user) {
  return sessions.filter(s => canRead(s, user));
}

module.exports = {
  LOCAL_USER_ID,
  isOwner,
  canRead,
  canWrite,
  claimOwnerlessSessions,
  filterReadable,
  makeSessionId,
  makeBranchId,
  saveSession,
  loadSession,
};
