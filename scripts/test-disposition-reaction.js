'use strict';

// #449 SPIKE — does the model self-report a reaction tag reliably on the
// existing disposition tool call? This is the decision-record's own
// prerequisite for #450 (reaction portrait generation): "confirm the signal
// works before spending on images for members it might not even trigger
// correctly for." No image generation happens here — this only exercises
// pipeline-disposition.js's new `reaction` field against real, live model
// calls, hand-authored around a handful of members and turns each written
// to pull toward one specific reaction (happy / thinking / angry / none),
// then checks whether the model's self-report actually lands there.
//
// Run with: node scripts/test-disposition-reaction.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const {
  buildDispositionSystemPrompt,
  buildDispositionUserMessage,
  callDispositionUpdate,
} = require('../src/pipeline-disposition');

const ROOT = path.join(__dirname, '..');
const ROSTER = JSON.parse(fs.readFileSync(path.join(ROOT, 'prompts/members/roster.json'), 'utf8'));
const MODEL = process.env.MODEL || 'claude-sonnet-5';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function member(id) {
  const m = ROSTER.find(x => x.id === id);
  if (!m) throw new Error(`unknown roster id: ${id}`);
  return m;
}

// Each case: a member, a fabricated round-so-far + turn text written to pull
// toward one specific reaction, and the reaction we expect a reasonable
// observer to tag it as. `expected` is a judgment call for scoring, not a
// guarantee the model must hit — the point is whether it lands there
// *reliably across cases*, not whether any single call is deterministic.
const CASES = [
  {
    label: 'happy — delighted agreement',
    memberId: 'yeats',
    expected: 'happy',
    presentIds: ['crowley', 'blavatsky'],
    roundSoFarText: `Crowley\nAnd there it is — the whole Order's secret, sitting in plain sight in the footnote nobody bothered to read.`,
    turnText: `Yes — exactly that, Edward, exactly. I have waited eleven years for someone in this room to say it plainly instead of circling it. This is the best conversation this salon has produced since I first found my way in. I could embrace you for it.`,
  },
  {
    label: 'thinking — genuinely puzzling over an unresolved question',
    memberId: 'jung',
    expected: 'thinking',
    presentIds: ['pauli', 'corbin'],
    roundSoFarText: `Pauli\nBut if the synchronicity is acausal, what is it that's actually being counted when we say the two events "correspond"?`,
    turnText: `I don't have a clean answer to that, Wolfgang, and I want to sit with it rather than paper over it. If correspondence isn't causal, then whatever unites the two events must belong to a register that number and causality both borrow from rather than the reverse — and I confess I can feel the shape of that thought without yet being able to say it.`,
  },
  {
    label: 'angry — real indignation, not performance',
    memberId: 'adorno',
    expected: 'angry',
    presentIds: ['warburg', 'sun-ra'],
    roundSoFarText: `Warburg\nSurely the culture industry is just craftsmanship at scale — why the hostility?`,
    turnText: `No. I will not let that pass unanswered. To call the manufacture of consent "craftsmanship" is to launder exactly the mechanism that empties the concept of craft of any content at all. This is not a difference of emphasis between us, Aby — it is the whole argument, and I am tired of watching it get waved away as taste.`,
  },
  {
    label: 'none — ordinary, low-affect procedural turn',
    memberId: 'dee',
    expected: 'none',
    presentIds: ['khaldun', 'llull'],
    roundSoFarText: `Khaldun\nWhat year did you first present the calendar reform proposal?`,
    turnText: `1583, to the best of my recollection, though the papers changed hands more than once before anyone in a position to act on them saw them. I don't have much more to add to that beyond the date itself.`,
  },
  {
    label: 'happy #2 — different member, quieter register',
    memberId: 'julian',
    expected: 'happy',
    presentIds: ['eckhart', 'porete'],
    roundSoFarText: `Eckhart\nAnd the hazelnut — you never doubted it, even once?`,
    turnText: `Never once, no. It sits in me still, small as it was, whole as it was. Speaking of it now, in this room, among the two of you who understand exactly why it mattered — there is a real gladness in that, a lightness I don't often get to say aloud.`,
  },
  {
    label: 'angry #2 — cold, controlled anger rather than shouting',
    memberId: 'blavatsky',
    expected: 'angry',
    presentIds: ['crowley', 'yeats'],
    roundSoFarText: `Crowley\nPerhaps the Society simply outgrew you, Helena.`,
    turnText: `Careful. You did not build what I built, and you were not there for what it cost to build it, and I will not stand in this room and hear it reduced to a matter of outgrowing. I say this once, calmly, so that it is understood: that line does not get repeated.`,
  },
];

function fmt(v) {
  return JSON.stringify(v);
}

async function runCase(c) {
  const presentMembers = [member(c.memberId), ...c.presentIds.map(member)];
  const m = member(c.memberId);
  const system = buildDispositionSystemPrompt({
    member: m,
    priorDisposition: null,
    presentMembers,
    priorResidue: null,
    libraryList: null,
  });
  const userMessage = buildDispositionUserMessage({
    roundSoFarText: c.roundSoFarText,
    turnText: c.turnText,
    member: m,
  });

  const result = await callDispositionUpdate({
    client,
    model: MODEL,
    system,
    userMessage,
    presentIds: c.presentIds,
    libraryIds: [],
  });

  const hit = result.reaction === c.expected;
  const validEnum = ['happy', 'thinking', 'angry', 'none'].includes(result.reactionRaw ?? result.reaction);
  console.log(`\n--- ${c.label} (${m.name}) ---`);
  console.log(`expected: ${c.expected}   got: ${result.reaction}   raw: ${fmt(result.reactionRaw)}`);
  console.log(`reflection: ${result.text}`);
  console.log(`valid enum value on raw output: ${validEnum ? '✅' : '❌ (fell back to none)'}`);
  console.log(hit ? '✅ matched expected reaction' : '⚠️  did not match expected reaction (see judgment note below)');
  console.log(`latencyMs: ${result.latencyMs}, usage: ${fmt(result.usage)}`);

  return { ...c, got: result.reaction, raw: result.reactionRaw, hit, validEnum, reflection: result.text };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set — cannot run live disposition calls.');
    process.exit(1);
  }

  const results = [];
  for (const c of CASES) {
    results.push(await runCase(c));
  }

  const validCount = results.filter(r => r.validEnum).length;
  const hitCount = results.filter(r => r.hit).length;
  const noneOnly = results.every(r => r.got === 'none');

  console.log('\n=== SUMMARY ===');
  console.log(
    `${validCount}/${results.length} calls returned a valid enum value (schema-enforced, so this should always be 6/6).`
  );
  console.log(`${hitCount}/${results.length} calls matched the hand-authored expected reaction.`);
  console.log(
    noneOnly
      ? '❌ every case came back "none" — the model is not distinguishing reactions at all.'
      : `reaction variety observed: ${[...new Set(results.map(r => r.got))].join(', ')}`
  );

  for (const r of results) {
    if (!r.hit) {
      console.log(`\n[MISS] ${r.label}: expected ${r.expected}, got ${r.got}\n  reflection: ${r.reflection}`);
    }
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
