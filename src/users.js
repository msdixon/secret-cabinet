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
// The admin is bootstrapped by ensureAdmin(), and is who the break-glass
// passphrase login signs in as. Everyone else is added by the admin from
// the /admin/users guest list (chunk A) via addUser/removeUser, and signs
// in with an emailed code.

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
        // ADMIN_EMAIL is the source of truth for the admin's address: a
        // mistyped first value would otherwise be stuck on the volume with
        // no UI to fix it. Skipped if a guest already holds that address.
        if (normalized && existing.email !== normalized && !users.some(u => u !== existing && u.email === normalized)) {
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

    // Throws on a missing/invalid or already-present email rather than
    // returning null, so the guest-list form can show why nothing happened;
    // err.code tells the two apart without parsing the message.
    addUser({ email, name } = {}) {
      const normalized = normalizeEmail(email);
      if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
        throw Object.assign(new Error('A valid email address is required.'), { code: 'invalid-email' });
      }
      if (users.some(u => u.email === normalized)) {
        throw Object.assign(new Error(`${normalized} is already on the guest list.`), { code: 'duplicate-email' });
      }
      const trimmedName = typeof name === 'string' ? name.trim() : '';
      const user = {
        id: crypto.randomUUID(),
        email: normalized,
        name: trimmedName || normalized.split('@')[0],
        isAdmin: false,
        createdAt: new Date().toISOString(),
        lastLoginAt: null,
      };
      users.push(user);
      save();
      return user;
    },

    // The admin can't be removed from here: it's the account the
    // passphrase recovers, and losing it would lock the guest list itself.
    // Returns whether anyone was removed. Their sessions stop resolving on
    // the next request (auth.js's resolveUser), so removal is immediate.
    removeUser(id) {
      const index = users.findIndex(u => u.id === id);
      if (index === -1 || users[index].isAdmin) return false;
      users.splice(index, 1);
      save();
      return true;
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
