'use strict';

// Ad hoc validation script for pipeline.js's director call (Stage 1 of #51).
// No test framework exists in this repo — this matches its existing style
// (see the rest of the codebase's lack of a test/ dir). Run with:
//   node scripts/test-director.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { selectSpeakers, isValidSelection } = require('../src/pipeline');

const ROOT = path.join(__dirname, '..');
const ROSTER = JSON.parse(fs.readFileSync(path.join(ROOT, 'prompts/members/roster.json'), 'utf8'));
const lodgeContext = fs.readFileSync(path.join(ROOT, 'prompts/lodge-context.md'), 'utf8');
const MODEL = 'claude-sonnet-4-6';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function loadRealSession() {
  const sessionsDir = path.join(ROOT, 'sessions');
  const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
  if (!files.length) return null;
  // Prefer the largest-cast real session available, for a realistic conversationHistory sample.
  const sessions = files.map(f => JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')));
  return sessions.sort((a, b) => (b.members?.length || 0) - (a.members?.length || 0))[0];
}

async function runCase(label, { presentMembers, minCount, maxCount, conversationHistory = [] }) {
  console.log(`\n--- ${label} (present=${presentMembers.length}, pool=${minCount}-${maxCount}) ---`);
  const metrics = [];
  const result = await selectSpeakers({
    client,
    model: MODEL,
    lodgeContext,
    presentMembers,
    instruction: 'The room stirs. Write the first movement — initial reactions to whatever the material woke up.',
    conversationHistory,
    minCount,
    maxCount,
    round: 0,
    onMetric: m => metrics.push(m),
  });

  const presentIds = presentMembers.map(m => m.id);
  const valid = isValidSelection(result.speakers, presentIds, minCount, maxCount);
  console.log('speakers:', result.speakers);
  console.log('reasoning:', result.reasoning);
  console.log('source:', result.source);
  console.log('metrics:', JSON.stringify(metrics, null, 2));
  console.log(valid ? '✅ valid selection' : '❌ INVALID SELECTION');
  return valid;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set — cannot run live director calls.');
    process.exit(1);
  }

  const results = [];

  // Small cast — pool covers the whole present set, trivial correctness check.
  results.push(
    await runCase('small cast (2 present)', {
      presentMembers: ROSTER.slice(0, 2),
      minCount: 2,
      maxCount: 2,
    })
  );

  // Medium cast, using a real session's actual members + conversation history.
  const realSession = loadRealSession();
  if (realSession) {
    const presentMembers = ROSTER.filter(m => realSession.members.includes(m.id));
    const minCount = Math.min(3, presentMembers.length);
    results.push(
      await runCase(`real session cast (${realSession.id})`, {
        presentMembers,
        minCount,
        maxCount: Math.min(presentMembers.length, minCount + 2),
        conversationHistory: (realSession.conversationHistory || []).slice(-6),
      })
    );
  } else {
    console.log('\n(no real sessions on disk — skipping real-session case)');
  }

  // Large cast — full roster.
  results.push(
    await runCase('large cast (full roster)', {
      presentMembers: ROSTER,
      minCount: 5,
      maxCount: 7,
    })
  );

  // Retry + fallback path, stubbed client (no real API call) — the director
  // "response" is always an invalid tool_use, so this proves selectSpeakers
  // retries once then falls back deterministically rather than throwing or
  // silently returning a bad selection.
  console.log('\n--- fallback path (stubbed invalid director) ---');
  const stubClient = {
    messages: {
      create: async () => ({
        content: [{ type: 'tool_use', input: { speakers: ['not-a-real-id'], reasoning: 'deliberately broken' } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    },
  };
  const fallbackPresent = ROSTER.slice(0, 4);
  const fallbackMetrics = [];
  const fallbackResult = await selectSpeakers({
    client: stubClient,
    model: MODEL,
    lodgeContext,
    presentMembers: fallbackPresent,
    instruction: 'test',
    conversationHistory: [],
    minCount: 3,
    maxCount: 3,
    round: 0,
    onMetric: m => fallbackMetrics.push(m),
  });
  console.log('speakers:', fallbackResult.speakers);
  console.log('source:', fallbackResult.source);
  console.log('metrics:', JSON.stringify(fallbackMetrics, null, 2));
  const expectedFallback = fallbackPresent.slice(0, 3).map(m => m.id);
  const fallbackOk =
    fallbackResult.source === 'fallback' &&
    JSON.stringify(fallbackResult.speakers) === JSON.stringify(expectedFallback) &&
    fallbackMetrics.length === 3; // 2 attempts + 1 metric for the fallback event itself
  console.log(fallbackOk ? '✅ fallback triggered correctly' : '❌ FALLBACK PATH BROKEN');
  results.push(fallbackOk);

  console.log(`\n${results.filter(Boolean).length}/${results.length} cases passed.`);
  process.exit(results.every(Boolean) ? 0 : 1);
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
