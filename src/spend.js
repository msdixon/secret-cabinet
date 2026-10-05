'use strict';

// #624 — month-to-date spend, built on #594's cost log. The `[cost]` console
// lines are the audit trail but don't survive a redeploy and can't be summed
// from inside the app, so each billable call is also appended to a small
// JSONL ledger on DATA_DIR (wired in via cost-log's setCostSink).
//
// Visibility, not enforcement (decided 2026-10-05): nothing here blocks a
// call. The one active piece is a once-per-month alert when Anthropic spend
// crosses ALERT_FRACTION of MONTHLY_BUDGET_USD — a prompt for Rachel to
// decide whether a per-guest cap is warranted. ElevenLabs is tracked
// separately (characters, and dollars only if a rate is configured) and is
// not counted against the Anthropic budget.

const fs = require('fs');
const path = require('path');

const ALERT_FRACTION = 0.8;
const ALERT_RETRY_MS = 60 * 60 * 1000;

// USD per million tokens. Matched by model-id prefix; an unlisted model is
// priced at the Sonnet rate and flagged as estimated rather than dropped.
const ANTHROPIC_RATES = [{ prefix: 'claude-sonnet', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }];

function rateFor(model) {
  const known = ANTHROPIC_RATES.find(r => typeof model === 'string' && model.startsWith(r.prefix));
  return { rate: known || ANTHROPIC_RATES[0], estimated: !known };
}

function anthropicCostUsd({ model, in: input, out, cache_read, cache_write }) {
  const { rate } = rateFor(model);
  const tokens = (n, perMillion) => ((Number(n) || 0) * perMillion) / 1e6;
  return (
    tokens(input, rate.input) +
    tokens(out, rate.output) +
    tokens(cache_read, rate.cacheRead) +
    tokens(cache_write, rate.cacheWrite)
  );
}

const monthKey = date => date.toISOString().slice(0, 7);

function emptyTotals() {
  return { anthropicUsd: 0, elevenlabsChars: 0, byUser: new Map() };
}

function userTotals(totals, userId) {
  const key = userId || 'none';
  if (!totals.byUser.has(key)) totals.byUser.set(key, { anthropicUsd: 0, elevenlabsChars: 0 });
  return totals.byUser.get(key);
}

function addToTotals(totals, rec) {
  const user = userTotals(totals, rec.userId);
  if (rec.provider === 'anthropic') {
    totals.anthropicUsd += rec.usd;
    user.anthropicUsd += rec.usd;
  } else if (rec.provider === 'elevenlabs') {
    totals.elevenlabsChars += rec.chars;
    user.elevenlabsChars += rec.chars;
  }
}

// Reduces a cost-log event to the one number worth storing, or null for
// providers the ledger doesn't track (Resend).
function toRecord({ userId, provider, fields }, now) {
  const ts = now.toISOString();
  if (provider === 'anthropic') return { ts, userId: userId || null, provider, usd: anthropicCostUsd(fields) };
  if (provider === 'elevenlabs') return { ts, userId: userId || null, provider, chars: Number(fields.chars) || 0 };
  return null;
}

function createSpendLedger(filePath, { clock = () => new Date() } = {}) {
  let month = null;
  let totals = emptyTotals();

  function load(now) {
    month = monthKey(now);
    totals = emptyTotals();
    let raw = '';
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        if (typeof rec.ts === 'string' && rec.ts.startsWith(month)) addToTotals(totals, rec);
      } catch {
        // A torn last line from a crash mid-append shouldn't poison the sum.
      }
    }
  }

  function current() {
    const now = clock();
    if (monthKey(now) !== month) load(now);
    return now;
  }

  return {
    record(event) {
      const now = current();
      const rec = toRecord(event, now);
      if (!rec) return null;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, JSON.stringify(rec) + '\n');
      addToTotals(totals, rec);
      return rec;
    },
    monthToDate() {
      current();
      return { month, ...totals };
    },
  };
}

// Once per calendar month, when Anthropic spend first reaches 80% of the
// budget, email the admin. The admin page shows the same condition as a
// banner for as long as it holds, so a missing or failed email isn't a
// silent miss. The "already sent" marker is a file so a redeploy mid-month
// doesn't re-send.
function createBudgetAlert({
  ledger,
  budgetUsd,
  stateFile,
  mailer,
  adminEmail,
  log = console,
  clock = () => new Date(),
}) {
  let lastAttempt = 0;

  function alertedMonth() {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8')).month;
    } catch {
      return null;
    }
  }

  return {
    async check() {
      if (!(budgetUsd > 0)) return false;
      const { month, anthropicUsd } = ledger.monthToDate();
      if (anthropicUsd < budgetUsd * ALERT_FRACTION || alertedMonth() === month) return false;
      const nowMs = clock().getTime();
      if (nowMs - lastAttempt < ALERT_RETRY_MS) return false;
      lastAttempt = nowMs;
      if (mailer?.enabled && adminEmail) {
        try {
          await mailer.send({ to: adminEmail, ...budgetAlertEmail({ month, anthropicUsd, budgetUsd }) });
        } catch (err) {
          log.error(`[spend] budget alert email failed: ${err.message}`);
          return false;
        }
      }
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ month, alertedAt: clock().toISOString() }));
      log.log(`[spend] ${month}: Anthropic spend $${anthropicUsd.toFixed(2)} reached 80% of $${budgetUsd} budget`);
      return true;
    },
  };
}

function budgetAlertEmail({ month, anthropicUsd, budgetUsd }) {
  const pct = Math.round((anthropicUsd / budgetUsd) * 100);
  return {
    subject: `Secret-Cabin-et: Anthropic spend at ${pct}% of the ${month} budget`,
    text:
      `Anthropic spend for ${month} is $${anthropicUsd.toFixed(2)}, ${pct}% of the $${budgetUsd} monthly budget.\n\n` +
      'This is the checkpoint to decide whether guests need a per-guest cap. Nothing has been blocked. ' +
      'Per-user spend is on the guest list page (/admin/users).\n\n' +
      'You will not be emailed again this month.',
  };
}

module.exports = { ALERT_FRACTION, anthropicCostUsd, rateFor, createSpendLedger, createBudgetAlert, budgetAlertEmail };
