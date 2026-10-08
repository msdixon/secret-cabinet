'use strict';

// #625 — the guest feedback loop's data side: notes from guests to the
// keeper of the lodge, and the first-convene funnel.
//
// Notes are an append-only JSONL file on DATA_DIR (same survive-a-redeploy
// reasoning as spend.jsonl), one line per note, keyed by the author's user id
// so they stay attached across an email change. Plain text only, no ratings
// machinery — see the issue. A torn trailing line (crash mid-append) is
// skipped on read rather than failing the whole page.
//
// The funnel deliberately derives from data the app already keeps (users.json
// sign-in history, the stored sessions) instead of adding an event log: it
// answers "how far did each guest get", which is a property of state, and a
// second source of truth would only drift from it. Admin-only; the stages
// are counts per guest, never content.

const fs = require('fs');

const MAX_NOTE_CHARS = 2000;
const MAX_PAGE_CHARS = 60;

function createFeedbackStore(filePath, { clock = () => new Date() } = {}) {
  return {
    // Returns the stored note, or null when the text is empty. Over-long text
    // is truncated, not rejected — a guest mid-thought shouldn't lose it.
    add({ userId, text, page } = {}) {
      const body = typeof text === 'string' ? text.trim().slice(0, MAX_NOTE_CHARS) : '';
      if (!body || !userId) return null;
      const note = {
        ts: clock().toISOString(),
        userId,
        text: body,
        page: typeof page === 'string' ? page.trim().slice(0, MAX_PAGE_CHARS) || null : null,
      };
      fs.appendFileSync(filePath, `${JSON.stringify(note)}\n`);
      return note;
    },

    // Newest first.
    list() {
      let raw;
      try {
        raw = fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
      const notes = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          notes.push(JSON.parse(line));
        } catch {
          // torn line — skip
        }
      }
      return notes.reverse();
    },
  };
}

// The stages, in order. Each guest is counted at every stage they reached.
const FUNNEL_STAGES = [
  { key: 'invited', label: 'Invited' },
  { key: 'signedIn', label: 'Signed in' },
  { key: 'convened', label: 'Convened a sitting' },
  { key: 'completed', label: 'Heard a full passage' },
  { key: 'returned', label: 'Came back on another day' },
];

// users: users.js records; sessions: [{ ownerId, rounds }] (rounds = number of
// completed passages stored). The admin is excluded — the funnel is about
// guests. "Returned" means sign-ins on two or more distinct days
// (`loginDays`, recorded by users.js); a guest who signed in before that
// field existed shows as one visit until they next sign in.
function computeFunnel(users, sessions) {
  const guests = users.filter(u => !u.isAdmin);
  const byOwner = new Map();
  for (const s of sessions) {
    if (!s || !s.ownerId) continue;
    const t = byOwner.get(s.ownerId) || { sessions: 0, completed: 0 };
    t.sessions += 1;
    if ((s.rounds || 0) >= 1) t.completed += 1;
    byOwner.set(s.ownerId, t);
  }
  const rows = guests.map(u => {
    const t = byOwner.get(u.id) || { sessions: 0, completed: 0 };
    const reached = {
      invited: true,
      signedIn: !!u.lastLoginAt,
      convened: t.sessions > 0,
      completed: t.completed > 0,
      returned: (u.loginDays || []).length >= 2,
    };
    // A later stage implies the earlier ones even if the data for them predates
    // the field that records it (e.g. a session from before loginDays).
    if (reached.returned || reached.completed || reached.convened) reached.signedIn = true;
    return { id: u.id, name: u.name, email: u.email, sessions: t.sessions, reached };
  });
  const stages = FUNNEL_STAGES.map(st => ({ ...st, count: rows.filter(r => r.reached[st.key]).length }));
  return { total: guests.length, stages, rows };
}

module.exports = { createFeedbackStore, computeFunnel, FUNNEL_STAGES, MAX_NOTE_CHARS };
