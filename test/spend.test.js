'use strict';

// #624 — src/spend.js: ledger sums, month rollover, the once-a-month 80%
// alert, and the guest-list page's spend columns.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const costLog = require('../src/cost-log.js');
const { anthropicCostUsd, createSpendLedger, createBudgetAlert } = require('../src/spend.js');
const { guestListHtml } = require('../src/routes/users.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sc-spend-'));
const sonnet = (inTok, outTok) => ({ model: 'claude-sonnet-5', in: inTok, out: outTok });

test('anthropicCostUsd prices tokens, cache included', () => {
  assert.equal(anthropicCostUsd(sonnet(1e6, 1e6)), 18);
  assert.equal(anthropicCostUsd({ model: 'claude-sonnet-5', cache_read: 1e6, cache_write: 1e6 }), 0.3 + 3.75);
});

test('ledger sums per user and survives a restart', () => {
  const file = path.join(tmp(), 'spend.jsonl');
  const clock = () => new Date('2026-10-10T12:00:00Z');
  const a = createSpendLedger(file, { clock });
  a.record({ userId: 'u1', provider: 'anthropic', fields: sonnet(1e6, 0) });
  a.record({ userId: 'u2', provider: 'anthropic', fields: sonnet(0, 1e6) });
  a.record({ userId: 'u1', provider: 'elevenlabs', fields: { chars: 500 } });
  assert.equal(a.record({ userId: 'u1', provider: 'resend', fields: { emails: 1 } }), null);

  const mtd = createSpendLedger(file, { clock }).monthToDate();
  assert.equal(mtd.anthropicUsd, 18);
  assert.equal(mtd.elevenlabsChars, 500);
  assert.deepEqual(mtd.byUser.get('u1'), { anthropicUsd: 3, elevenlabsChars: 500 });
});

test('ledger resets on a new month and tolerates a torn line', () => {
  const file = path.join(tmp(), 'spend.jsonl');
  let now = new Date('2026-10-31T23:00:00Z');
  const ledger = createSpendLedger(file, { clock: () => now });
  ledger.record({ userId: 'u1', provider: 'anthropic', fields: sonnet(1e6, 0) });
  fs.appendFileSync(file, '{"ts":"2026-11');
  now = new Date('2026-11-01T01:00:00Z');
  assert.equal(ledger.monthToDate().anthropicUsd, 0);
  assert.equal(ledger.monthToDate().month, '2026-11');
});

test('cost-log sink receives events and cannot break logging', () => {
  const seen = [];
  costLog.setCostSink(e => seen.push(e));
  costLog.logCost('u1', 'elevenlabs', { chars: 5 }, () => {});
  assert.equal(seen[0].userId, 'u1');
  costLog.setCostSink(() => {
    throw new Error('x');
  });
  const origError = console.error;
  console.error = () => {};
  assert.doesNotThrow(() => costLog.logCost('u1', 'elevenlabs', { chars: 5 }, () => {}));
  console.error = origError;
  costLog.setCostSink(null);
});

test('budget alert fires once at 80%, not before, not again that month', async () => {
  const dir = tmp();
  const now = new Date('2026-10-10T12:00:00Z');
  const ledger = createSpendLedger(path.join(dir, 'spend.jsonl'), { clock: () => now });
  const sent = [];
  const alert = createBudgetAlert({
    ledger,
    budgetUsd: 100,
    stateFile: path.join(dir, 'alert.json'),
    mailer: { enabled: true, send: async m => sent.push(m) },
    adminEmail: 'rachel@example.com',
    log: { log: () => {}, error: () => {} },
    clock: () => now,
  });

  ledger.record({ userId: 'u1', provider: 'anthropic', fields: sonnet(0, 5e6) }); // $75
  assert.equal(await alert.check(), false);
  ledger.record({ userId: 'u1', provider: 'anthropic', fields: sonnet(0, 0.5e6) }); // $82.50
  assert.equal(await alert.check(), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'rachel@example.com');
  assert.equal(await alert.check(), false);
  assert.equal(sent.length, 1);
});

test('a failed alert email is not marked sent, and retries are throttled', async () => {
  const dir = tmp();
  let now = new Date('2026-10-10T12:00:00Z');
  const ledger = createSpendLedger(path.join(dir, 'spend.jsonl'), { clock: () => now });
  ledger.record({ userId: 'u1', provider: 'anthropic', fields: sonnet(0, 6e6) });
  let attempts = 0;
  const alert = createBudgetAlert({
    ledger,
    budgetUsd: 100,
    stateFile: path.join(dir, 'alert.json'),
    mailer: {
      enabled: true,
      send: async () => {
        attempts++;
        throw new Error('down');
      },
    },
    adminEmail: 'rachel@example.com',
    log: { log: () => {}, error: () => {} },
    clock: () => now,
  });
  assert.equal(await alert.check(), false);
  assert.equal(await alert.check(), false);
  assert.equal(attempts, 1);
  now = new Date('2026-10-10T14:00:00Z');
  await alert.check();
  assert.equal(attempts, 2);
  assert.equal(fs.existsSync(path.join(dir, 'alert.json')), false);
});

test('no budget configured means no alert', async () => {
  const dir = tmp();
  const ledger = createSpendLedger(path.join(dir, 'spend.jsonl'));
  ledger.record({ userId: 'u1', provider: 'anthropic', fields: sonnet(0, 9e6) });
  const alert = createBudgetAlert({ ledger, budgetUsd: 0, stateFile: path.join(dir, 'a.json') });
  assert.equal(await alert.check(), false);
});

test('guest list shows per-user spend, unattributed spend, and the 80% banner', () => {
  const dir = tmp();
  const ledger = createSpendLedger(path.join(dir, 'spend.jsonl'));
  ledger.record({ userId: 'u1', provider: 'anthropic', fields: sonnet(0, 5e6) });
  ledger.record({ userId: null, provider: 'anthropic', fields: sonnet(0, 0.4e6) });
  ledger.record({ userId: 'u1', provider: 'elevenlabs', fields: { chars: 1200 } });
  const users = [{ id: 'u1', name: 'Ada', email: 'ada@example.com' }];

  const html = guestListHtml({ users, spend: { ledger, budgetUsd: 100, elevenlabsUsdPer1kChars: 0.3 } });
  assert.match(html, /\$75\.00/);
  assert.match(html, /Unattributed/);
  assert.match(html, /1,200 chars \(≈\$0\.36\)/);
  assert.match(html, /81% of the \$100\.00 monthly budget/);
  assert.match(html, /per-guest cap/);

  const quiet = guestListHtml({ users, spend: { ledger, budgetUsd: 1000 } });
  assert.doesNotMatch(quiet, /per-guest cap/);
  assert.doesNotMatch(guestListHtml({ users }), /Anthropic \(month\)/);
});
