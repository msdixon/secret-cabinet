'use strict';

// #625 — guest → keeper feedback and the admin view of it.
//
// POST /api/feedback is for any signed-in user (requireAuth already 401s an
// anonymous /api/ call); GET /admin/feedback is behind auth.js's /admin/
// tier. The admin page shows three things in one place so Rachel opens one
// URL: the first-convene funnel, the notes, and the sittings guests chose to
// share (links go to the transcript, readable by the admin via canView).

const fs = require('fs');
const path = require('path');
const { gatePageHtml, escapeHtml } = require('../auth');
const { computeFunnel } = require('../feedback');
const { createFailureLimiter } = require('../rate-limit');

// 10 notes per user per hour: room to say several things, no use as a flood.
const NOTES_PER_HOUR = 10;

function formatTs(iso) {
  return iso ? iso.replace('T', ' ').slice(0, 16) : '';
}

function loadSessionSummaries(sessionsDir) {
  let files;
  try {
    files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
      out.push({
        id: d.id,
        ownerId: d.ownerId || null,
        rounds: d.rounds?.length || 0,
        date: d.date || null,
        entry: d.sharedWithKeeper ? (d.entry || '').slice(0, 140) : null,
        sharedWithKeeper: !!d.sharedWithKeeper,
        sharedAt: d.sharedWithKeeperAt || null,
      });
    } catch {
      // unreadable session — skip
    }
  }
  return out;
}

function feedbackPageHtml({ funnel, notes, shared, users }) {
  const nameOf = id => users.find(u => u.id === id)?.name || 'Removed guest';
  const top = funnel.stages[0].count;
  const stageRows = funnel.stages
    .map(st => `<tr><td>${escapeHtml(st.label)}</td><td>${st.count}${top ? ` of ${top}` : ''}</td></tr>`)
    .join('\n');
  const guestRows = funnel.rows
    .map(r => {
      const furthest = [...funnel.stages].reverse().find(st => r.reached[st.key]);
      return `<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(furthest.label)}</td><td>${r.sessions}</td></tr>`;
    })
    .join('\n');
  const noteRows = notes.length
    ? notes
        .map(
          n =>
            `<tr><td>${formatTs(n.ts)}</td><td>${escapeHtml(nameOf(n.userId))}${n.page ? ` <span class="tag">${escapeHtml(n.page)}</span>` : ''}</td><td class="body">${escapeHtml(n.text)}</td></tr>`
        )
        .join('\n')
    : '<tr><td colspan="3">No notes yet.</td></tr>';
  const sharedRows = shared.length
    ? shared
        .map(
          s =>
            `<tr><td>${formatTs(s.sharedAt)}</td><td>${escapeHtml(nameOf(s.ownerId))}</td><td class="body"><a href="/api/sessions/${encodeURIComponent(s.id)}/transcript">${escapeHtml(s.entry || s.id)}</a></td></tr>`
        )
        .join('\n')
    : '<tr><td colspan="3">No sittings shared yet.</td></tr>';

  return gatePageHtml(
    `    <style>
      table { width: 100%; border-collapse: collapse; font-size: .85rem; text-align: left; margin-bottom: 2rem; }
      th { color: #8b7355; font-weight: normal; letter-spacing: .1em; text-transform: uppercase; font-size: .7rem; }
      th, td { padding: .5rem .4rem; border-bottom: 1px solid #3a3228; vertical-align: top; overflow-wrap: anywhere; }
      td.body { white-space: pre-wrap; }
      .tag { font-size: .7rem; color: #8b7355; }
      h2 { font-size: .8rem; letter-spacing: .15em; text-transform: uppercase; color: #8b7355; margin: 1.5rem 0 .5rem; text-align: left; }
      .wrap { overflow-x: auto; }
    </style>
    <h2>First-convene funnel</h2>
    <p class="note">Guests only, counted at every stage they reached. “Came back” means sign-ins on two different days.</p>
    <div class="wrap"><table>${stageRows}</table></div>
    <div class="wrap"><table><tr><th>Guest</th><th>Furthest stage</th><th>Sittings</th></tr>
${guestRows}</table></div>
    <h2>Notes to the keeper</h2>
    <div class="wrap"><table><tr><th>When</th><th>From</th><th>Note</th></tr>
${noteRows}</table></div>
    <h2>Sittings shared with the keeper</h2>
    <p class="note">Only sittings a guest chose to share appear here; everything else stays private to its owner.</p>
    <div class="wrap"><table><tr><th>Shared</th><th>By</th><th>Opening</th></tr>
${sharedRows}</table></div>
    <p class="alt"><a href="/admin/users">Guest list</a> · <a href="/">Back to the lodge</a></p>`,
    { width: 720 }
  );
}

function registerFeedbackRoutes(
  app,
  { feedback, users, sessionsDir, limiter = createFailureLimiter({ windowMs: 60 * 60 * 1000, max: NOTES_PER_HOUR }) }
) {
  app.post('/api/feedback', (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (limiter.isBlocked(userId)) {
      return res.status(429).json({ error: 'That is a lot of notes at once. Try again in a little while.' });
    }
    const note = feedback.add({ userId, text: req.body?.text, page: req.body?.page });
    if (!note) return res.status(400).json({ error: 'Write a few words first.' });
    limiter.recordFailure(userId);
    res.json({ ok: true });
  });

  app.get('/admin/feedback', (req, res) => {
    const all = users.list();
    const sessions = loadSessionSummaries(sessionsDir);
    const shared = sessions
      .filter(s => s.sharedWithKeeper)
      .sort((a, b) => (b.sharedAt || '').localeCompare(a.sharedAt || ''));
    res.send(feedbackPageHtml({ funnel: computeFunnel(all, sessions), notes: feedback.list(), shared, users: all }));
  });
}

module.exports = { registerFeedbackRoutes, feedbackPageHtml, NOTES_PER_HOUR };
