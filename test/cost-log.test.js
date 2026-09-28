'use strict';

// #594 — src/cost-log.js. The Anthropic client is faked (the same approach
// test/pipeline.test.js takes) — what matters is that each call logs one
// line attributed to the user current when the call was *made*.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const costLog = require('../src/cost-log.js');

const USAGE = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 };

function fakeClient() {
  const streams = [];
  return {
    streams,
    messages: {
      create: async () => ({ usage: USAGE }),
      stream: () => {
        const s = new EventEmitter();
        streams.push(s);
        return s;
      },
    },
  };
}

test('formatCostLine', () => {
  assert.equal(
    costLog.formatCostLine('u1', 'elevenlabs', { voice: 'v', chars: 12, skipped: undefined }),
    '[cost] user=u1 provider=elevenlabs voice=v chars=12'
  );
  assert.equal(costLog.formatCostLine(null, 'anthropic', {}), '[cost] user=none provider=anthropic');
});

test('runWithUser / currentUserId', async () => {
  assert.equal(costLog.currentUserId(), null);
  await costLog.runWithUser('u1', async () => {
    await new Promise(r => setImmediate(r));
    assert.equal(costLog.currentUserId(), 'u1');
  });
});

test('instrumentAnthropicClient', async t => {
  await t.test('messages.create logs usage against the calling user and still returns the response', async () => {
    const lines = [];
    const client = costLog.instrumentAnthropicClient(fakeClient(), l => lines.push(l));
    const response = await costLog.runWithUser('u1', () => client.messages.create({ model: 'claude-x' }));
    await new Promise(r => setImmediate(r));
    assert.deepEqual(response, { usage: USAGE });
    assert.deepEqual(lines, [
      '[cost] user=u1 provider=anthropic model=claude-x in=100 out=20 cache_read=50 cache_write=0',
    ]);
  });

  await t.test('a failed create logs nothing and the rejection still reaches the caller', async () => {
    const lines = [];
    const raw = fakeClient();
    raw.messages.create = async () => {
      throw new Error('boom');
    };
    const client = costLog.instrumentAnthropicClient(raw, l => lines.push(l));
    await assert.rejects(client.messages.create({ model: 'claude-x' }), /boom/);
    assert.deepEqual(lines, []);
  });

  await t.test('messages.stream logs on finalMessage, attributed to the user current at call time', async () => {
    const lines = [];
    const raw = fakeClient();
    const client = costLog.instrumentAnthropicClient(raw, l => lines.push(l));
    costLog.runWithUser('u2', () => client.messages.stream({ model: 'claude-y' }));
    raw.streams[0].emit('finalMessage', { usage: USAGE });
    assert.deepEqual(lines, [
      '[cost] user=u2 provider=anthropic model=claude-y in=100 out=20 cache_read=50 cache_write=0',
    ]);
  });

  await t.test('a call outside any request logs user=none', async () => {
    const lines = [];
    const client = costLog.instrumentAnthropicClient(fakeClient(), l => lines.push(l));
    await client.messages.create({ model: 'claude-x' });
    await new Promise(r => setImmediate(r));
    assert.match(lines[0], /^\[cost\] user=none /);
  });
});
