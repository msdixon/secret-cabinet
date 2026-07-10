'use strict';

// Per-member agent architecture (#51) — Stage 1: the director call.
//
// Express-agnostic by design: no req/res, no module-level ROSTER/client
// singletons. Everything is passed in as a parameter, so the same functions
// work in a standalone test script (Stages 1-2) and inside a live route
// (Stage 4), following the sibling-module pattern already used by dayone.js.

// ── Member section (shared with the legacy full-blob prompt builder) ──────

// Extracted from server.js's buildSystemPrompt so both the legacy full-blob
// builder and the new per-speaker builder (Stage 2) share identical
// artifact/session-note injection logic.
function buildMemberSection(member, artifact, notes, loadMemberFile) {
  const text = loadMemberFile(member.file);
  if (!text) return '';
  const artifactNote = (artifact?.memberId === member.id && artifact.text?.trim())
    ? `\n\n---\n\n## PRIVATE — BEFORE THE MEETING BEGAN\n\nBefore the others arrived, you were shown the following. No one else in the room has seen it. You may reference it, produce it at the right moment, withhold it entirely, or let it colour what you say without naming it. The choice is yours.\n\n${artifact.text.trim()}`
    : '';
  const sessionNote = notes[member.id]?.trim()
    ? `\n\n---\n\n## SESSION NOTE\n\n${notes[member.id].trim()}`
    : '';
  return `---\n${text}${artifactNote}${sessionNote}`;
}

// ── Metrics ─────────────────────────────────────────────────────────────────

// Cost/latency/failure observability is a first-class requirement, not an
// afterthought — every director and per-speaker call attempt (including
// retries, skips, and fallbacks) produces one of these, persisted alongside
// the session so it's reviewable after the fact, not just an ephemeral
// console line.
function makeMetric(phase, { round, memberId, attempts, usage, latencyMs, skipped, error, reasoning } = {}) {
  return {
    phase, // 'director' | 'speaker'
    round: round ?? null,
    memberId: memberId || null,
    attempts: attempts ?? 1,
    usage: usage ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } : null,
    latencyMs: latencyMs ?? null,
    skipped: !!skipped,
    error: error || null,
    reasoning: reasoning || null,
    timestamp: new Date().toISOString(),
  };
}

// ── Shared retry helper (used by the per-speaker call in Stage 2) ─────────

async function withOneRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    return await fn();
  }
}

// ── Director ────────────────────────────────────────────────────────────────

function buildDirectorToolSchema(presentIds, count) {
  return {
    name: 'select_speakers',
    description: 'Choose exactly which present lodge members speak this round, and in what order.',
    input_schema: {
      type: 'object',
      properties: {
        speakers: {
          type: 'array',
          items: { type: 'string', enum: presentIds },
          minItems: count,
          maxItems: count,
          uniqueItems: true,
          description: `Member ids, in speaking order, drawn only from the present roster: ${presentIds.join(', ')}.`,
        },
        reasoning: {
          type: 'string',
          description: 'Brief internal rationale for this ordering — not shown to users, for review/logging only.',
        },
      },
      required: ['speakers', 'reasoning'],
    },
  };
}

function buildDirectorPrompt({ lodgeContext, presentMembers, instruction, count }) {
  const rosterLines = presentMembers.map(m => `- ${m.name}`).join('\n');

  const system = `${lodgeContext}

---

## YOUR ROLE RIGHT NOW

You are not writing dialogue. You are deciding who speaks next in this round of the salon, and in what order — a casting decision, not a performance. You will not write any of their words.

PRESENT TONIGHT:
${rosterLines}

THIS ROUND'S INSTRUCTION:
${instruction}

Choose exactly ${count} of the present members to speak this round, in the order they should speak. Base the choice on who has something to react to, who hasn't been heard from, and what this round's instruction calls for — not on alphabetical or arbitrary order.`;

  const userMessage = 'Choose this round\'s speakers.';

  return { system, userMessage };
}

async function callDirector({ client, model, system, conversationHistory, userMessage, presentIds, count }) {
  const start = Date.now();
  const messages = [...conversationHistory, { role: 'user', content: userMessage }];
  const response = await client.messages.create({
    model,
    max_tokens: 500,
    system,
    messages,
    tools: [buildDirectorToolSchema(presentIds, count)],
    tool_choice: { type: 'tool', name: 'select_speakers' },
  });
  const latencyMs = Date.now() - start;
  const block = response.content.find(b => b.type === 'tool_use');
  const { speakers, reasoning } = block?.input || {};
  return { speakers, reasoning, usage: response.usage, latencyMs };
}

function isValidSelection(speakers, presentIds, count) {
  return Array.isArray(speakers)
    && speakers.length === count
    && new Set(speakers).size === speakers.length
    && speakers.every(id => presentIds.includes(id));
}

// Retry-once + deterministic-fallback wrapper around callDirector.
// presentMembers must already be in roster order — the fallback pick
// (first `count` present members) relies on that ordering.
async function selectSpeakers({ client, model, lodgeContext, presentMembers, instruction, conversationHistory, count, round, onMetric }) {
  const presentIds = presentMembers.map(m => m.id);
  const { system, userMessage } = buildDirectorPrompt({ lodgeContext, presentMembers, instruction, count });

  let lastReasoning = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const correctiveNote = attempt === 2
      ? ` Your previous selection was invalid — it must be exactly ${count} present member ids, no duplicates, drawn only from: ${presentIds.join(', ')}. Choose again.`
      : '';
    try {
      const { speakers, reasoning, usage, latencyMs } = await callDirector({
        client, model, system, conversationHistory,
        userMessage: userMessage + correctiveNote,
        presentIds, count,
      });
      lastReasoning = reasoning || lastReasoning;
      onMetric?.(makeMetric('director', { round, attempts: attempt, usage, latencyMs, reasoning }));
      if (isValidSelection(speakers, presentIds, count)) {
        return { speakers, reasoning, source: attempt === 1 ? 'director' : 'director-retry' };
      }
    } catch (err) {
      onMetric?.(makeMetric('director', { round, attempts: attempt, error: err.message }));
    }
  }

  // Deterministic fallback: first `count` present members, in roster order.
  const speakers = presentMembers.slice(0, count).map(m => m.id);
  onMetric?.(makeMetric('director', { round, attempts: 2, skipped: true, error: 'director failed twice — used deterministic fallback', reasoning: lastReasoning }));
  return { speakers, reasoning: lastReasoning, source: 'fallback' };
}

module.exports = {
  buildMemberSection,
  makeMetric,
  withOneRetry,
  buildDirectorToolSchema,
  buildDirectorPrompt,
  callDirector,
  isValidSelection,
  selectSpeakers,
};
