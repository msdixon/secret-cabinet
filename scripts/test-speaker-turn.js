'use strict';

// Ad hoc validation script for pipeline.js's per-speaker call (Stage 2 of #51).
// Run with: node scripts/test-speaker-turn.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const {
  buildMemberSection,
  buildSpeakerSystemPrompt,
  buildSpeakerUserMessage,
  callSpeakerTurn,
} = require('../src/pipeline');

const ROOT = path.join(__dirname, '..');
const ROSTER = JSON.parse(fs.readFileSync(path.join(ROOT, 'prompts/members/roster.json'), 'utf8'));
const lodgeContext = fs.readFileSync(path.join(ROOT, 'prompts/lodge-context.md'), 'utf8');
const MODEL = 'claude-sonnet-4-6';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function loadMemberFile(filename) {
  const p = path.join(ROOT, 'prompts/members', filename);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function loadRealSession() {
  const sessionsDir = path.join(ROOT, 'sessions');
  const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
  if (!files.length) return null;
  const sessions = files.map(f => JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')));
  return sessions.sort((a, b) => (b.members?.length || 0) - (a.members?.length || 0))[0];
}

// Rough proxy for "does a per-speaker call cost meaningfully less than the
// old all-members-in-one-prompt approach" — compare character counts of the
// character-file sections that would go into each prompt shape. Real
// usage.input_tokens for the speaker call itself is reported separately
// below, which is the ground-truth number.
function compareSectionSize(allPresentMembers, member) {
  const allSections = allPresentMembers
    .map(m => buildMemberSection(m, null, {}, loadMemberFile))
    .filter(Boolean)
    .join('\n\n');
  const oneSection = buildMemberSection(member, null, {}, loadMemberFile);
  return { allChars: allSections.length, oneChars: oneSection.length };
}

async function runCase(label, { member, presentMembers, roundPrompt, roundSoFarText, conversationHistory = [] }) {
  console.log(`\n--- ${label} (member=${member.name}) ---`);
  const system = buildSpeakerSystemPrompt({ lodgeContext, member, artifact: null, notes: {}, loadMemberFile });
  const userMessage = buildSpeakerUserMessage({ roundPrompt, roundSoFarText, member });

  let streamed = '';
  const result = await callSpeakerTurn({
    client,
    model: MODEL,
    system,
    conversationHistory,
    userMessage,
    onChunk: chunk => {
      streamed += chunk;
    },
  });

  console.log('text:', result.text);
  console.log('usage:', result.usage);
  console.log('latencyMs:', result.latencyMs);

  const streamedMatchesFinal = streamed.trim() === result.text;
  const noSelfSignature = !new RegExp(`^${member.name}\\s*\\n`, 'i').test(result.text);
  const { allChars, oneChars } = compareSectionSize(presentMembers, member);
  console.log(
    `character-section size: full cast ${allChars} chars vs. this speaker alone ${oneChars} chars (${Math.round((1 - oneChars / allChars) * 100)}% smaller)`
  );

  console.log(streamedMatchesFinal ? '✅ streamed chunks match final text' : '❌ STREAMING MISMATCH');
  console.log(noSelfSignature ? '✅ model did not sign its own name' : '❌ MODEL SIGNED ITSELF');

  return streamedMatchesFinal && noSelfSignature;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set — cannot run live speaker calls.');
    process.exit(1);
  }

  const results = [];

  // Real session, real member, fabricated round-so-far — the realistic case.
  const realSession = loadRealSession();
  if (realSession) {
    const presentMembers = ROSTER.filter(m => realSession.members.includes(m.id));
    const member = presentMembers[0];
    results.push(
      await runCase(`real session (${realSession.id})`, {
        member,
        presentMembers,
        roundPrompt: 'The document recedes. The conversation follows what it raised.',
        roundSoFarText: `${presentMembers[1]?.name || 'Someone'}\n*A log shifts in the grate.*\nThe thing about footnotes is that they are where the real argument hides.`,
        conversationHistory: (realSession.conversationHistory || []).slice(-4),
      })
    );
  } else {
    console.log('\n(no real sessions on disk — skipping real-session case)');
  }

  // Fresh round 1, no round-so-far yet — the opening-speaker case.
  results.push(
    await runCase('opening speaker, no round-so-far', {
      member: ROSTER.find(m => m.id === 'crowley'),
      presentMembers: ROSTER.slice(0, 3),
      roundPrompt: 'The room stirs. Write the first movement — initial reactions to whatever the material woke up.',
      roundSoFarText: '',
    })
  );

  console.log(`\n${results.filter(Boolean).length}/${results.length} cases passed.`);
  process.exit(results.every(Boolean) ? 0 : 1);
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
