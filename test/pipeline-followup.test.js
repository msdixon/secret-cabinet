'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runFollowUp, FOLLOWUP_ADDENDUM } = require('../src/pipeline-followup');

// A client whose stream yields one text delta and a final usage message,
// capturing what it was asked so the test can inspect the prompt.
function fakeClient(captured) {
  return {
    messages: {
      stream(params) {
        captured.params = params;
        const events = [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'First.\n\nSecond.' } }];
        return {
          async *[Symbol.asyncIterator]() {
            yield* events;
          },
          finalMessage: async () => ({ usage: { input_tokens: 1, output_tokens: 1 } }),
        };
      },
    },
  };
}

const member = { id: 'crowley', name: 'Crowley' };

test('runFollowUp', async t => {
  await t.test('makes one turn, overrides the no-observer rule, and reports a followup metric', async () => {
    const captured = {};
    const metrics = [];
    const ended = [];
    const result = await runFollowUp({
      client: fakeClient(captured),
      model: 'm',
      lodgeContext: 'ctx',
      member,
      loadMemberFile: () => 'character',
      question: 'Why did you leave?',
      onSpeakerEnd: (...args) => ended.push(args),
      onMetric: m => metrics.push(m),
    });
    assert.equal(result.memberId, 'crowley');
    assert.ok(!result.text.includes('\n\n'), 'internal blank lines are stripped');
    assert.deepEqual(ended, [['crowley', 'Crowley', result.text]]);
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].phase, 'followup');
    const systemText = JSON.stringify(captured.params.system);
    assert.ok(systemText.includes('THE MEETING IS OVER'));
    assert.ok(FOLLOWUP_ADDENDUM.includes('overrides'));
    assert.match(captured.params.messages.at(-1).content, /Why did you leave\?/);
  });

  await t.test('a failing call records a skipped metric and rethrows', async () => {
    const metrics = [];
    const client = {
      messages: {
        stream() {
          throw new Error('api down');
        },
      },
    };
    await assert.rejects(
      runFollowUp({
        client,
        model: 'm',
        lodgeContext: 'ctx',
        member,
        loadMemberFile: () => 'character',
        question: 'q',
        onMetric: m => metrics.push(m),
      }),
      /api down/
    );
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].skipped, true);
  });

  await t.test('disables thinking, and an empty answer is retried then rejected, never returned blank', async () => {
    const calls = [];
    const client = {
      messages: {
        stream(params) {
          calls.push(params);
          return {
            async *[Symbol.asyncIterator]() {},
            finalMessage: async () => ({ usage: { input_tokens: 1, output_tokens: 700 } }),
          };
        },
      },
    };
    const metrics = [];
    await assert.rejects(
      runFollowUp({
        client,
        model: 'm',
        lodgeContext: 'ctx',
        member,
        loadMemberFile: () => 'character',
        question: 'q',
        onMetric: m => metrics.push(m),
      }),
      /no text/
    );
    assert.equal(calls.length, 2, 'retried once');
    assert.deepEqual(calls[0].thinking, { type: 'between_tools' });
    assert.equal(metrics[0].skipped, true);
  });
});
