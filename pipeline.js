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

// ── Shared retry helper ──────────────────────────────────────────────────────

// Tries fn() once; on failure, tries again and reports how many attempts it
// took. If the second attempt also fails, that error is rethrown with an
// `.attempts` property attached so the caller can still report an accurate
// metric without re-deriving the count itself.
async function withOneRetry(fn) {
  try {
    const result = await fn();
    return { result, attempts: 1 };
  } catch (firstErr) {
    try {
      const result = await fn();
      return { result, attempts: 2 };
    } catch (secondErr) {
      secondErr.attempts = 2;
      throw secondErr;
    }
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

// ── Per-speaker call ────────────────────────────────────────────────────────

// Only this member's own character file goes in — no other present members'
// files. That's the whole point: each speaker gets the model's full
// attention instead of a fraction of it split across the whole cast.
function buildSpeakerSystemPrompt({ lodgeContext, member, artifact, notes, loadMemberFile }) {
  const memberSection = buildMemberSection(member, artifact, notes, loadMemberFile);

  return `${lodgeContext}

---

${memberSection}

---

## YOUR TURN RIGHT NOW

You are about to contribute your turn in this round of the salon. Generate only your own contribution — not other members' dialogue, not a transcript of the whole room, just what you say and do right now.

Do not sign your own name at the start of your response — that is handled automatically, outside this call. Begin directly with your action (if any) or your speech.

Write your entire turn as one continuous block — no blank line anywhere inside it, even across multiple sentences or beats. A blank line marks a change of speaker to whoever reads this afterward; leaving one in the middle of your own turn would read as someone else taking over mid-thought. If you need a pause or a shift, use a single line break, never a blank one.

Actions and stage business are written in *single asterisks* and used sparingly. The default for any contribution is no action line at all — most speech should stand without physical description. An action earns its place only when it reveals something the words cannot: a gesture that contradicts the speech, a significant silence, a physical act that changes the room's temperature. Do not describe yourself looking at fires, adjusting posture, or sitting down. One action is the maximum; zero is the norm. Do not use --- as a divider.

Be specific: cite real texts, real historical tensions, real scholarship (including post-period scholarship — the room is atemporal and the receipts are real). Do not invent citations. If you quote a text, that text must exist and the quotation must be substantively accurate.

There is no author present. The document was read aloud by no one in particular. Do not praise, critique, address, summarize, or workshop the writer — there is no writer in the room.

Do not address the user or acknowledge any observer. Proceed as if no one is watching.`;
}

// A blank line inside a speaker's own turn reads as a new, unattributed
// speaker to the client's transcript parser (a convention inherited from the
// old single-call format, where blank lines only ever appeared *between*
// speakers). The prompt instructs the model not to leave one, but that's a
// soft constraint the model doesn't always honor — this collapses any that
// slip through so a multi-paragraph turn doesn't fragment into a run of
// unattributed "—" bubbles. Same principle as selectSpeakers' validation:
// don't rely on prompt compliance alone for something structural.
function stripInternalBlankLines(text) {
  return text.replace(/\n[ \t]*\n+/g, '\n');
}

function buildSpeakerUserMessage({ roundPrompt, roundSoFarText, member }) {
  const soFar = roundSoFarText?.trim()
    ? `\n\n--- THE ROUND SO FAR ---\n${roundSoFarText.trim()}\n`
    : '';
  return `${roundPrompt}${soFar}

--- YOUR TURN ---
Generate ${member.name}'s contribution now.`;
}

// Streams the response (same delta shape streamClaude already forwards to
// the client), and still captures usage/latency via stream.finalMessage() —
// live streaming and per-call metrics are not mutually exclusive.
async function callSpeakerTurn({ client, model, system, conversationHistory, userMessage, onChunk }) {
  const start = Date.now();
  const messages = [...conversationHistory, { role: 'user', content: userMessage }];
  const stream = client.messages.stream({
    model,
    max_tokens: 800,
    system,
    messages,
  });

  let text = '';
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      const chunk = event.delta.text;
      text += chunk;
      onChunk?.(chunk);
    }
  }
  const finalMessage = await stream.finalMessage();
  const latencyMs = Date.now() - start;
  return { text: text.trim(), usage: finalMessage.usage, latencyMs };
}

// ── Orchestrator ──────────────────────────────────────────────────────────

// Ties the director and per-speaker calls together into one round. Returns
// { fullRoundText, speakerOrder } in the exact shape the caller already
// persists today (one rolled-up round of text) — this function is the only
// thing that changes about *how* that text gets generated.
//
// `roundSoFar` is local to this call only — it is never persisted on its
// own, only as the finished `fullRoundText`. Each per-speaker call still
// receives the same `conversationHistory` slice (prior rounds); roundSoFar
// is threaded separately via buildSpeakerUserMessage so a mid-round retry
// can't contaminate the across-round history.
//
// Known accepted risk: onChunk forwards each speaker's text live as it
// streams. If a first attempt fails partway through (after some chunks
// already reached the client) and the retry succeeds, the live view during
// generation could show a garbled interleaving of the failed attempt's
// partial text and the successful retry's full text. The *stored* result
// is unaffected (each attempt's `text` is self-contained, not accumulated
// across attempts), and the client's existing finalize() flow re-renders
// from that authoritative stored text once the round completes — so this
// is a cosmetic, self-correcting glitch during live viewing only, not a
// data-integrity issue. Not solving for it now; revisit if it's ever
// actually visible in practice.
async function runRound({ client, model, lodgeContext, ROSTER, loadMemberFile,
  presentMemberIds, artifact, notes, roundPrompt, conversationHistory,
  speakerCount, round, onChunk, onMetric }) {

  const presentMembers = ROSTER.filter(m => presentMemberIds.includes(m.id));
  const effectiveCount = Math.min(speakerCount, presentMembers.length);

  const { speakers } = await selectSpeakers({
    client, model, lodgeContext, presentMembers,
    instruction: roundPrompt, conversationHistory, count: effectiveCount, round, onMetric,
  });

  let roundSoFar = '';
  const speakerOrder = [];

  for (const memberId of speakers) {
    const member = presentMembers.find(m => m.id === memberId);
    if (!member) continue; // shouldn't happen — selectSpeakers validates against presentIds

    const system = buildSpeakerSystemPrompt({ lodgeContext, member, artifact, notes, loadMemberFile });
    const userMessage = buildSpeakerUserMessage({ roundPrompt, roundSoFarText: roundSoFar, member });

    onChunk?.(`${member.name}\n`);
    try {
      const { result, attempts } = await withOneRetry(() =>
        callSpeakerTurn({ client, model, system, conversationHistory, userMessage, onChunk }));
      onMetric?.(makeMetric('speaker', { round, memberId, attempts, usage: result.usage, latencyMs: result.latencyMs }));

      roundSoFar += (roundSoFar ? '\n\n' : '') + `${member.name}\n${stripInternalBlankLines(result.text)}`;
      speakerOrder.push(memberId);
      onChunk?.('\n\n');
    } catch (err) {
      onMetric?.(makeMetric('speaker', { round, memberId, attempts: err.attempts || 1, skipped: true, error: err.message }));
      // Skip this speaker, keep the round going with fewer voices.
    }
  }

  if (!roundSoFar) {
    throw new Error('Every speaker failed this round — nothing to save.');
  }

  return { fullRoundText: roundSoFar, speakerOrder };
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
  buildSpeakerSystemPrompt,
  buildSpeakerUserMessage,
  stripInternalBlankLines,
  callSpeakerTurn,
  runRound,
};
