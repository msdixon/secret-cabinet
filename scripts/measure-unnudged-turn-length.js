'use strict';

// #561 — reproducible live harness for the un-nudged speaker-turn length
// floor. Builds the real speaker prompt (buildSpeakerSystemPrompt /
// buildSpeakerUserMessage / callSpeakerTurn) for a fixed set of member/topic
// pairs with `tangentNudge: false`, no disposition, exemplar, residue or
// history, and reports words per turn. The earlier phase 3/4 harnesses
// (BREVITY-BASELINE-REPORT.md) were never committed, so their numbers could
// not be re-run; this one can, and compares like-for-like across prompt
// changes and models.
//
// Calls the live API (credit-metered) — run manually, never from tests:
//   ANTHROPIC_API_KEY=... [MODEL=claude-sonnet-5-5] [TRIALS=3] \
//     node scripts/measure-unnudged-turn-length.js
//
// Absolute numbers from this harness are not comparable to phase 1's 88w
// (which came from full real sessions); use it to compare runs of itself.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const CASES = [
  ['crowley', 'A dispute over whether the vault of Christian Rosenkreuz was ever really opened, and by whom.'],
  ['yeats', "Whether automatic writing is dictation from outside or the sitter's own deep mind, as in A Vision."],
  ['teresa', "The interior castle and whether obedience to a confessor can bind a mystic's inner light."],
];

function wordCount(text) {
  return (text || '').split(/\s+/).filter(Boolean).length;
}

function mean(nums) {
  return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0;
}

// results: { [memberId]: number[] } of per-trial word counts.
function summarize(results) {
  const perMember = Object.fromEntries(Object.entries(results).map(([id, counts]) => [id, mean(counts)]));
  return { perMember, overall: mean(Object.values(results).flat()) };
}

async function run({ model, trials }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const speaker = require('../src/pipeline-speaker');
  const roster = require('../src/roster');
  const membersDir = path.join(ROOT, 'prompts', 'members');
  const members = JSON.parse(fs.readFileSync(path.join(membersDir, 'roster.json'), 'utf8'));
  const lodgeContext = fs.readFileSync(path.join(ROOT, 'prompts', 'lodge-context.md'), 'utf8');
  const client = new Anthropic();
  const results = {};
  for (const [id, topic] of CASES) {
    const member = members.find(m => m.id === id);
    results[id] = [];
    for (let i = 0; i < trials; i++) {
      const system = speaker.buildSpeakerSystemPrompt({
        lodgeContext,
        member,
        artifact: topic,
        notes: '',
        loadMemberFile: f => roster.loadMemberFile(membersDir, f),
        otherPresentMembers: [],
      });
      const userMessage = speaker.buildSpeakerUserMessage({
        roundPrompt: `The room turns to: ${topic}`,
        roundSoFarText: '',
        member,
        remainingBudgetWords: 900,
        unheardCount: 3,
        tangentNudge: false,
      });
      const { text } = await speaker.callSpeakerTurn({
        client,
        model,
        system,
        conversationHistory: [],
        userMessage,
        lodgeContext,
      });
      results[id].push(wordCount(text));
    }
  }
  return results;
}

if (require.main === module) {
  const model = process.env.MODEL || 'claude-sonnet-5-5';
  const trials = Number(process.env.TRIALS) || 3;
  run({ model, trials })
    .then(results => {
      const { perMember, overall } = summarize(results);
      console.log(`${model}, ${trials} trial(s) per case, un-nudged`);
      console.log(JSON.stringify(results));
      Object.entries(perMember).forEach(([id, avg]) => console.log(`${id}: ${avg}w`));
      console.log(`overall: ${overall}w`);
    })
    .catch(err => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { CASES, wordCount, mean, summarize };
