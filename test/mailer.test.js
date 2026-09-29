'use strict';

// #594 chunk A — src/mailer.js. The Resend call is exercised against a
// fake fetch; nothing here touches the network.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMailer, loginCodeEmail, inviteEmail, RESEND_URL } = require('../src/mailer.js');

test('createMailer', async t => {
  await t.test('with no key on a deployed instance, email is disabled and sends nothing', async () => {
    const mailer = createMailer({ apiKey: undefined, isLocal: false });
    assert.equal(mailer.enabled, false);
    assert.equal(await mailer.send({ to: 'a@example.com', subject: 's', text: 't' }), false);
  });

  await t.test('with no key locally, messages go to the console instead', async () => {
    const lines = [];
    const mailer = createMailer({ isLocal: true, log: { log: l => lines.push(l) } });
    assert.equal(mailer.enabled, true);
    await mailer.send({ to: 'a@example.com', ...loginCodeEmail('123456') });
    assert.match(lines[0], /to=a@example\.com/);
    assert.match(lines[0], /123456/);
  });

  await t.test('with a key, POSTs to Resend with bearer auth and the configured sender', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { ok: true };
    };
    const mailer = createMailer({ apiKey: 're_test', from: 'Lodge <lodge@mail.example.org>', fetchImpl });
    await mailer.send({ to: 'a@example.com', subject: 'Hi', text: 'Body' });
    assert.equal(calls[0].url, RESEND_URL);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test');
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      from: 'Lodge <lodge@mail.example.org>',
      to: ['a@example.com'],
      subject: 'Hi',
      text: 'Body',
    });
  });

  await t.test('a non-2xx response throws with the status', async () => {
    const fetchImpl = async () => ({ ok: false, status: 422, text: async () => 'domain not verified' });
    const mailer = createMailer({ apiKey: 're_test', from: 'x@y.z', fetchImpl });
    await assert.rejects(mailer.send({ to: 'a@example.com', subject: 's', text: 't' }), /422.*domain not verified/);
  });
});

test('email templates', () => {
  assert.match(loginCodeEmail('042917').text, /042917/);
  const invite = inviteEmail({ name: 'Ada', appUrl: 'https://archon-salon.org/' });
  assert.match(invite.text, /^Ada,/);
  assert.match(invite.text, /https:\/\/archon-salon\.org\/login/);
});
