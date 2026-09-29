'use strict';

// #594 (chunk A) — outbound email for sign-in codes and invites, via
// Resend's HTTP API with plain fetch (no SDK dependency for one POST).
// Sends from a mail.<domain> subdomain so the root domain's reputation
// stays separate from transactional mail.
//
// Three modes, decided once at startup by server.js:
// - RESEND_API_KEY set: real sends.
// - No key, local dev: codes and invites are printed to the server console
//   instead, so the whole emailed-code flow can be exercised without an
//   account or DNS.
// - No key, deployed: `enabled` is false and the login page offers only the
//   passphrase, rather than accepting an email and never sending anything.

const { logCost } = require('./cost-log');

const RESEND_URL = 'https://api.resend.com/emails';

function createMailer({ apiKey, from, isLocal = false, fetchImpl = fetch, log = console } = {}) {
  if (!apiKey) {
    if (!isLocal) return { enabled: false, send: async () => false };
    return {
      enabled: true,
      async send({ to, subject, text }) {
        log.log(`[mail] (not sent — no RESEND_API_KEY) to=${to} subject=${JSON.stringify(subject)}\n${text}`);
        return true;
      },
    };
  }

  return {
    enabled: true,
    async send({ to, subject, text, html }) {
      const res = await fetchImpl(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text, ...(html ? { html } : {}) }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Resend send failed (${res.status}): ${detail.slice(0, 200)}`);
      }
      logCost(null, 'resend', { emails: 1 });
      return true;
    },
  };
}

function loginCodeEmail(code) {
  return {
    subject: 'Your Secret-Cabin-et sign-in code',
    text:
      `Your sign-in code is ${code}\n\n` +
      'It expires in 10 minutes and can be used once. ' +
      "If you didn't ask to sign in, you can ignore this email.",
  };
}

function inviteEmail({ name, appUrl }) {
  const greeting = name ? `${name},\n\n` : '';
  return {
    subject: "You're invited to the Secret-Cabin-et",
    text:
      `${greeting}You've been added to the guest list for the Secret-Cabin-et, a salon outside of time.\n\n` +
      `To come in, go to ${appUrl.replace(/\/$/, '')}/login and enter this email address. ` +
      "You'll be sent a one-time code to sign in with. No password needed.",
  };
}

module.exports = { createMailer, loginCodeEmail, inviteEmail, RESEND_URL };
