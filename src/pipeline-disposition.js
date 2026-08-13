'use strict';

// #284 seam-map, module 5 of 6 — disposition scratchpad (#188, structured
// target #203).
//
// A per-member private note — current stance, unspent intentions, tonight's
// alignments and irritations — carried forward within the session and
// re-injected into that member's *next* speaker call via
// pipeline-speaker.js's buildSpeakerSystemPrompt dispositionSection. Never
// shown in the transcript. Cadence: piggybacked as a cheap follow-up call
// right after a member's own turn, not a once-per-round sweep of every
// present member — that would mean an extra call per present member per
// round regardless of whether they spoke, which cuts against the same cost
// discipline #164's word-budget work was built around. A member who sits
// out a round simply carries their prior disposition forward unchanged.
//
// #203: alongside the free prose, the model also names — as a separate
// structured field, not parsed out of the prose — which present member (if
// any) it privately has unspent business with. Real #188 sessions (see the
// issue's dependency note) showed prose is the wrong thing to key
// scheduling off of: a member's stated target is as often a bare pronoun
// ("I want to press *him* on...") as a name, and the hard truncation cap
// sometimes cuts the sentence naming the target before it arrives. A
// same-call tool field costs no extra latency and can't be misread the way
// a name-scan through freeform prose can. `disposition[memberId]` is
// therefore `{ text, waitingOnMemberId }`, not a bare string — see
// pipeline-speaker.js's pickNextSpeaker for the consumer.

const { RESIDUE_NOTE_MAX_CHARS } = require('./pipeline-speaker');

const DISPOSITION_MAX_CHARS = 400; // a few sentences — hard cap so this can't balloon a speaker prompt over a long session
const DISPOSITION_MAX_TOKENS = 280; // reflection prose plus the tool-call JSON wrapper, target field, and #166's optional residue field

function buildDispositionToolSchema(presentIds) {
  return {
    name: 'update_disposition',
    description:
      "Record this member's private interior state after speaking, including whether they have unspent business with anyone present.",
    input_schema: {
      type: 'object',
      properties: {
        reflection: {
          type: 'string',
          description: `1-3 sentences of private thought — current stance, anything unsaid but intended, who they're aligned with or irritated by. Under ${DISPOSITION_MAX_CHARS} characters.`,
        },
        waitingOnMemberId: {
          type: 'string',
          enum: [...presentIds, 'none'],
          description:
            'The one present member (by id) this member has unspent business with and would want to answer or press if that person speaks again — or "none" if that is not true right now. Most turns are "none"; only name someone when it is real.',
        },
        // #166: cross-session residue, piggybacked on this same call rather
        // than a second one — see pipeline-speaker.js's "Cross-session
        // residue" section for the full mechanism. Left out of `required` on
        // purpose: an omitted field is how the model expresses "nothing
        // belongs here", which is the common case by design.
        residueNote: {
          type: 'string',
          description: `Optional, and rare. Only when this beat genuinely shifted or confirmed something that should outlast tonight — a durable turn in stance, a new alliance or grudge, a tendency proven true. One short sentence, written in your own private register, under ${RESIDUE_NOTE_MAX_CHARS} characters. Leave this out entirely on ordinary turns — most turns, nothing belongs here.`,
        },
      },
      required: ['reflection', 'waitingOnMemberId'],
    },
  };
}

function buildDispositionSystemPrompt({ member, priorDisposition, presentMembers = [], priorResidue }) {
  const priorText = priorDisposition?.text?.trim();
  const priorTarget = priorDisposition?.waitingOnMemberId
    ? presentMembers.find(m => m.id === priorDisposition.waitingOnMemberId)?.name
    : null;
  const priorTargetNote = priorTarget ? ` You were privately waiting to answer or press ${priorTarget}.` : '';
  const priorBlock = priorText
    ? `Your private state going into this turn was:\n"${priorText}"\n\nUpdate it — don't just repeat it back.${priorTargetNote}`
    : 'This is your first private reflection tonight — there is no prior state yet.';

  // #166: shown so the model doesn't re-mint a fragment that's already
  // there — the point of residue is what's new or confirmed, not a running
  // restatement of what's already settled.
  const priorResidueText = priorResidue?.trim();
  const residueContextBlock = priorResidueText
    ? `\n\nResidue already carried from other evenings, beneath this member's own conscious recall: "${priorResidueText}" Only add to it below if tonight genuinely shifted or confirmed something beyond what's already there — most turns, it didn't.`
    : '';

  return `You are privately reflecting as ${member.name}, immediately after speaking your turn in tonight's salon. This reflection is never shown to anyone — not the other members, not the transcript, not the researcher who convened the evening. It is your own unspoken interior state, carried forward to color how you show up for the rest of the evening.

${priorBlock}${residueContextBlock}

Write 1-3 sentences, as private thought rather than speech: your current stance on the evening's argument, anything you haven't yet said but intend to, who you're aligned with or irritated by tonight. Be concrete and specific to what just happened, not a generic character summary. Keep it under ${DISPOSITION_MAX_CHARS} characters — this is a scratchpad, not an essay.

Separately, name whether there is one present person you have real unspent business with — something you'd want to answer or press if they spoke again. This is the exception, not the default: most turns, there is no one.

Separately again, and rarer still: name whether tonight left something that should genuinely outlast this evening — not tonight's mood, a durable turn. Most turns, there is nothing here either.`;
}

function buildDispositionUserMessage({ roundSoFarText, turnText, member }) {
  return `--- WHAT JUST HAPPENED IN THE ROOM ---\n${roundSoFarText.trim()}\n\n--- WHAT YOU (${member.name}) JUST SAID ---\n${turnText}\n\n--- YOUR PRIVATE REFLECTION ---\nWrite your updated private disposition now.`;
}

// Deliberately no retry — this is a best-effort private-state update, not a
// user-visible turn. A failure just means the member's disposition doesn't
// move this beat; the caller keeps the prior value. `presentIds` excludes
// the reflecting member themself — waiting on yourself isn't a real state,
// and pickNextSpeaker's back-to-back weighting already covers that case.
async function callDispositionUpdate({ client, model, system, userMessage, presentIds = [] }) {
  const start = Date.now();
  const tool = buildDispositionToolSchema(presentIds);
  const response = await client.messages.create({
    model,
    max_tokens: DISPOSITION_MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: userMessage }],
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
  });
  const latencyMs = Date.now() - start;
  const block = response.content.find(b => b.type === 'tool_use');
  const { reflection, waitingOnMemberId, residueNote } = block?.input || {};
  const text = (reflection || '').trim().slice(0, DISPOSITION_MAX_CHARS);
  const target =
    waitingOnMemberId && waitingOnMemberId !== 'none' && presentIds.includes(waitingOnMemberId)
      ? waitingOnMemberId
      : null;
  // #166: '' rather than undefined when absent, so callers can treat "no
  // residue this beat" uniformly without an extra undefined check.
  const residue = (residueNote || '').trim().slice(0, RESIDUE_NOTE_MAX_CHARS);
  return { text, waitingOnMemberId: target, residueNote: residue, usage: response.usage, latencyMs };
}

module.exports = {
  DISPOSITION_MAX_CHARS,
  buildDispositionToolSchema,
  buildDispositionSystemPrompt,
  buildDispositionUserMessage,
  callDispositionUpdate,
};
