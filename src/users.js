'use strict';

// #594 — the per-user identity store, chunk B of the 2026-09-21 scope
// (app-side identity). One small JSON file on DATA_DIR, the same shape of
// persistence as visits.json: a handful of invited people, not a user base,
// so a database would be solving a scale this project doesn't have.
//
// A user's `id` is a random UUID, deliberately not the email: #595 keys
// session ownership off it, and an invitee changing address shouldn't
// orphan everything they own. `email` is the sign-in handle (chunk A adds
// emailed-code login against it) and is stored lowercased so lookups are
// case-insensitive.
//
// This PR only ever creates one user — the admin, bootstrapped by
// ensureAdmin() — which the passphrase login signs in as. Adding invitees
// is chunk A's job, once there's a way for them to sign in at all.

const fs = require('fs');
const crypto = require('crypto');

function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed || null;
}

function readUsersFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed.users) ? parsed.users : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    // A corrupt users file must not silently become "no users" — that would
    // look like a fresh install and mint a second admin on top of it.
    throw new Error(`Could not read users file ${filePath}: ${err.message}`, { cause: err });
  }
}

// Write-then-rename so a crash mid-write can't leave a truncated users.json
// behind (see readUsersFile for why a corrupt file is fatal, not ignorable).
function writeUsersFile(filePath, users) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ users }, null, 2));
  fs.renameSync(tmp, filePath);
}

function createUserStore(filePath) {
  const users = readUsersFile(filePath);

  const save = () => writeUsersFile(filePath, users);

  return {
    list: () => users.slice(),
    findById: id => (id && users.find(u => u.id === id)) || null,
    findByEmail: email => {
      const normalized = normalizeEmail(email);
      return (normalized && users.find(u => u.email === normalized)) || null;
    },
    findAdmin: () => users.find(u => u.isAdmin) || null,

    // Guarantees exactly the one admin the passphrase login resolves to.
    // Idempotent across restarts: an existing admin is kept (same id, so
    // anything keyed to it later, like #595's ownerId, stays attached), and
    // only gains an email if it didn't already have one.
    ensureAdmin({ email } = {}) {
      const normalized = normalizeEmail(email);
      const existing = users.find(u => u.isAdmin);
      if (existing) {
        if (normalized && !existing.email) {
          existing.email = normalized;
          save();
        }
        return existing;
      }
      const admin = {
        id: crypto.randomUUID(),
        email: normalized,
        name: 'Admin',
        isAdmin: true,
        createdAt: new Date().toISOString(),
        lastLoginAt: null,
      };
      users.push(admin);
      save();
      return admin;
    },

    recordLogin(id) {
      const user = users.find(u => u.id === id);
      if (!user) return;
      user.lastLoginAt = new Date().toISOString();
      save();
    },
  };
}

module.exports = { createUserStore, normalizeEmail };
