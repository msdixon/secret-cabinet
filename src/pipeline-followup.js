'use strict';

// #165 Phase 1 — a single, direct answer from one member after the meeting.
//
// Deliberately NOT a runRound: no director, no multi-beat passage, no
// disposition call, no citation pass, and no residue write. Residue is
// global per member today (#595), so a follow-up from one visitor must not
// be able to shape how that member speaks for the next. Residue and
// disposition are read, never written.

const { buildSpeakerSystemPrompt, callSpeakerTurn, stripInternalBlankLines } = require('./pipeline-speaker');
const { makeMetric, withOneRetry } = require('./pipeline-core');
const { FOLLOWUP_MAX_TOKENS } = require('./tuning');

// buildSpeakerSystemPrompt tells the member there is no observer and not to
// address anyone — right for the room, wrong here. Appended last so it is
// the final word on who is being spoken to.
const FOLLOWUP_ADDENDUM = `

---

## THE MEETING IS OVER

The salon has ended. Someone who was observing from outside it — the one who convened it — now speaks to you directly, and only you. This overrides the earlier instruction to proceed as if no one is watching: answer them, in your own voice, plainly and in earnest. Stay entirely in character; do not break the fourth wall about being a simulation. You may refer to what was said in the room. Keep it conversational — a few sentences is usually right. Do not speak for anyone else.`;

async function runFollowUp({
  client,
  model,
  lodgeContext,
  member,
  otherPresentMembers = [],
  loadMemberFile,
  voiceExemplar = null,
  secondaryVoiceExemplars = [],
  residue = '',
  disposition = null,
  relationshipEdges = [],
  conversationHistory = [],
  question,
  onChunk,
  onSpeakerStart,
  onSpeakerEnd,
  onMetric,
}) {
  const system =
    buildSpeakerSystemPrompt({
      lodgeContext,
      member,
      artifact: null,
      notes: {},
      loadMemberFile,
      disposition,
      voiceExemplar,
      secondaryVoiceExemplars,
      residue,
      otherPresentMembers,
      relationshipEdges,
    }) + FOLLOWUP_ADDENDUM;

  const userMessage = `The observer, after the meeting, says to ${member.name}: "${question}"\n\n--- YOUR TURN ---\nAnswer them now, as ${member.name}.`;

  onSpeakerStart?.(member.id);
  try {
    // Thinking is off: a short in-voice answer doesn't need it, and adaptive thinking can eat the whole
    // max_tokens budget and leave no text at all (the #406 failure family). An empty result throws so
    // withOneRetry retries once and then the route reports failure, instead of storing a blank answer.
    const { result, attempts } = await withOneRetry(async () => {
      const r = await callSpeakerTurn({
        client,
        model,
        system,
        conversationHistory,
        userMessage,
        onChunk,
        lodgeContext,
        maxTokens: FOLLOWUP_MAX_TOKENS,
        thinking: { type: 'disabled' },
      });
      if (!r.text) throw new Error('Follow-up produced no text');
      return r;
    });
    const text = stripInternalBlankLines(result.text);
    onMetric?.(
      makeMetric('followup', {
        memberId: member.id,
        attempts,
        usage: result.usage,
        latencyMs: result.latencyMs,
        voiceExemplar: voiceExemplar?.id,
      })
    );
    onSpeakerEnd?.(member.id, member.name, text);
    return { memberId: member.id, name: member.name, text };
  } catch (err) {
    onMetric?.(
      makeMetric('followup', { memberId: member.id, attempts: err.attempts, skipped: true, error: err.message })
    );
    throw err;
  }
}

module.exports = { runFollowUp, FOLLOWUP_ADDENDUM };
