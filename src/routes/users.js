'use strict';

// #594 (chunk A) — the guest list: who can sign in with an emailed code.
// Server-rendered HTML forms under /admin/users, admin-only via auth.js's
// ADMIN_ROUTES (checked before the public app-shell tier, which would
// otherwise let any GET outside /api/ through). Not "members": in this app
// that word already means the roster of historical figures, and "+ Invite
// to the Lodge" already means adding one of them.
//
// Plain POST forms with no CSRF token: the session cookie is sameSite=lax
// (server.js), so a cross-site form POST arrives without it and is
// redirected to /login rather than acted on.
//
// Deps passed in, same pattern as the other route modules: users (the
// src/users.js store), mailer (src/mailer.js), appUrl for the invite link.

const { gatePageHtml, escapeHtml } = require('../auth');
const { inviteEmail } = require('../mailer');
const { ALERT_FRACTION } = require('../spend');

function formatDate(iso) {
  return iso ? iso.slice(0, 10) : 'never';
}

const usd = n => `$${n.toFixed(2)}`;

// #624 — month-to-date spend per user, or null when no ledger is wired in.
// The Anthropic budget and ElevenLabs rate are optional: without them the
// page still shows spend, just no percentage or voice dollars.
function spendView(spend, users) {
  if (!spend?.ledger) return null;
  const mtd = spend.ledger.monthToDate();
  const voiceCell = chars => {
    if (!chars) return '–';
    const dollars = spend.elevenlabsUsdPer1kChars ? ` (≈${usd((chars / 1000) * spend.elevenlabsUsdPer1kChars)})` : '';
    return `${chars.toLocaleString('en-US')} chars${dollars}`;
  };
  const byId = new Map(users.map(u => [u.id, u]));
  const perUser = id => mtd.byUser.get(id) || { anthropicUsd: 0, elevenlabsChars: 0 };
  const unattributed = [...mtd.byUser.keys()].filter(id => id === 'none' || !byId.has(id));
  const pct = spend.budgetUsd > 0 ? mtd.anthropicUsd / spend.budgetUsd : null;
  return { mtd, perUser, voiceCell, unattributed, pct, budgetUsd: spend.budgetUsd };
}

function spendSummaryHtml(sv) {
  if (!sv) return '';
  const budget = sv.pct === null ? '' : ` — ${Math.round(sv.pct * 100)}% of the ${usd(sv.budgetUsd)} monthly budget`;
  const banner =
    sv.pct !== null && sv.pct >= ALERT_FRACTION
      ? `<p class="error">Anthropic spend has reached ${Math.round(ALERT_FRACTION * 100)}% of the monthly budget. Time to decide whether guests need a per-guest cap. Nothing is blocked.</p>`
      : '';
  return `${banner}<p class="note">${sv.mtd.month}: Anthropic ${usd(sv.mtd.anthropicUsd)}${budget}; voice ${sv.voiceCell(sv.mtd.elevenlabsChars)}. Estimated from token counts at list prices; the Anthropic console is authoritative.</p>`;
}

function guestListHtml({ users, mailerEnabled, flash, error, spend }) {
  const sv = spendView(spend, users);
  const spendCells = id => {
    if (!sv) return '';
    const t = sv.perUser(id);
    return `<td>${usd(t.anthropicUsd)}</td><td>${sv.voiceCell(t.elevenlabsChars)}</td>`;
  };
  const unattributedRows = sv
    ? sv.unattributed
        .map(
          id =>
            `      <tr><td>${id === 'none' ? 'Unattributed' : 'Removed guest'}</td><td></td><td></td>${spendCells(id)}<td></td></tr>`
        )
        .join('\n')
    : '';
  const rows = users
    .map(
      u => `      <tr>
        <td>${escapeHtml(u.name)}${u.isAdmin ? ' <span class="tag">admin</span>' : ''}</td>
        <td>${escapeHtml(u.email || '(no email set)')}</td>
        <td>${formatDate(u.lastLoginAt)}</td>
        ${spendCells(u.id)}
        <td>${
          u.isAdmin
            ? ''
            : `<form method="POST" action="/admin/users/${encodeURIComponent(u.id)}/remove" onsubmit="return confirm('Remove this guest from the guest list?')"><button class="small" type="submit">Remove</button></form>`
        }</td>
      </tr>`
    )
    .join('\n');
  const spendHeaders = sv ? '<th>Anthropic (month)</th><th>Voice (month)</th>' : '';

  return gatePageHtml(
    `    <style>
      table { width: 100%; border-collapse: collapse; font-size: .85rem; text-align: left; margin-bottom: 2rem; }
      th { color: #8b7355; font-weight: normal; letter-spacing: .1em; text-transform: uppercase; font-size: .7rem; }
      th, td { padding: .5rem .4rem; border-bottom: 1px solid #3a3228; vertical-align: middle; overflow-wrap: anywhere; }
      .tag { font-size: .7rem; color: #8b7355; }
      button.small { margin: 0; width: auto; padding: .3rem .6rem; font-size: .7rem; }
      form.add { text-align: left; }
      form.add label { display: flex; gap: .5rem; align-items: center; font-size: .85rem; margin-top: .75rem; }
      form.add label input { width: auto; }
      .wrap { overflow-x: auto; }
    </style>
    ${flash ? `<p class="flash">${escapeHtml(flash)}</p>` : ''}
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    ${spendSummaryHtml(sv)}
    <p class="note">Guest list: everyone here can sign in with a code emailed to their address.
      Until <a href="https://github.com/msdixon/secret-cabinet/issues/595">#595</a> gives meetings owners,
      every guest can see and delete every meeting.</p>
    <div class="wrap"><table>
      <tr><th>Name</th><th>Email</th><th>Last sign-in</th>${spendHeaders}<th></th></tr>
${rows}
${unattributedRows}
    </table></div>
    <form class="add" method="POST" action="/admin/users">
      <input type="email" name="email" placeholder="guest@example.com" required>
      <input type="text" name="name" placeholder="Name (optional)">
      ${
        mailerEnabled
          ? '<label><input type="checkbox" name="sendInvite" value="1" checked> Email them an invitation</label>'
          : '<p class="note" style="margin-top:.75rem">Email is not configured, so no invitation will be sent.</p>'
      }
      <button type="submit">Add to guest list</button>
    </form>
    <p class="alt"><a href="/">Back to the lodge</a></p>`,
    { width: 640 }
  );
}

// Post/redirect/get, with the outcome as a fixed code in the query string.
// Not a one-shot session flash: a browser that re-fetches the redirect
// target (prefetch, a preview pane) would consume it before the page the
// admin actually sees. The codes never carry an email address, so nothing
// personal lands in a URL or access log; the table itself shows who.
const OUTCOMES = {
  added: { flash: 'Guest added. No invitation was sent.' },
  invited: { flash: 'Guest added and invitation sent.' },
  removed: { flash: 'Guest removed. They are signed out as of their next request.' },
  'invite-failed': { error: 'Guest added, but the invitation email failed to send.' },
  'invalid-email': { error: 'A valid email address is required.' },
  'duplicate-email': { error: 'That address is already on the guest list.' },
  'remove-failed': { error: 'That guest could not be removed.' },
};

function registerUserAdminRoutes(app, { users, mailer, appUrl, spend, log = console }) {
  app.get('/admin/users', (req, res) => {
    const outcome = OUTCOMES[req.query?.done] || {};
    res.send(guestListHtml({ users: users.list(), mailerEnabled: !!mailer?.enabled, spend, ...outcome }));
  });

  const done = (res, code) => res.redirect(`/admin/users?done=${code}`);

  app.post('/admin/users', async (req, res) => {
    let user;
    try {
      user = users.addUser({ email: req.body.email, name: req.body.name });
    } catch (err) {
      return done(res, err.code === 'duplicate-email' ? 'duplicate-email' : 'invalid-email');
    }
    if (!req.body.sendInvite || !mailer?.enabled) return done(res, 'added');
    try {
      await mailer.send({ to: user.email, ...inviteEmail({ name: user.name, appUrl }) });
      done(res, 'invited');
    } catch (err) {
      log.error(`[users] invite email failed: ${err.message}`);
      done(res, 'invite-failed');
    }
  });

  app.post('/admin/users/:id/remove', (req, res) => {
    done(res, users.removeUser(req.params.id) ? 'removed' : 'remove-failed');
  });
}

module.exports = { registerUserAdminRoutes, guestListHtml };
