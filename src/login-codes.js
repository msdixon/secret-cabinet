'use strict';

// #594 (chunk A) — one-time sign-in codes for emailed login. A 6-digit code
// rather than a magic link (decided 2026-09-28): it can't be pre-fetched and
// burned by a mail client's link scanner, and it works when the email is
// read on a phone but the lodge is open on a laptop.
//
// In-memory, same reasoning as rate-limit.js: one Railway process, and a
// restart only means someone asks for a fresh code. Codes are stored hashed
// so nothing in memory is directly usable, expire after ttlMs, allow
// maxAttempts wrong guesses before being discarded (so a million-code space
// can't be walked), and are single-use. Issuing a new code for an email
// replaces the old one.

const crypto = require('crypto');

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;

function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest();
}

function createLoginCodeStore({ ttlMs = CODE_TTL_MS, maxAttempts = CODE_MAX_ATTEMPTS, now = () => Date.now() } = {}) {
  const pending = new Map();

  return {
    issue(email) {
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      pending.set(email, { hash: hashCode(code), expiresAt: now() + ttlMs, attempts: 0 });
      return code;
    },

    verify(email, candidate) {
      const entry = pending.get(email);
      if (!entry) return false;
      if (now() >= entry.expiresAt) {
        pending.delete(email);
        return false;
      }
      const cleaned = typeof candidate === 'string' ? candidate.replace(/\s+/g, '') : '';
      const ok = /^\d{6}$/.test(cleaned) && crypto.timingSafeEqual(hashCode(cleaned), entry.hash);
      if (ok) {
        pending.delete(email);
        return true;
      }
      entry.attempts++;
      if (entry.attempts >= maxAttempts) pending.delete(email);
      return false;
    },
  };
}

module.exports = { createLoginCodeStore, CODE_TTL_MS, CODE_MAX_ATTEMPTS };
