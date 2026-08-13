'use strict';

// #284 seam-map, module 3 of 6 — casting the evening (#185).
//
// A different question from selectSpeakers'. The director asks "of the people
// already in the room, who speaks next"; casting asks "of the whole lodge,
// who turns up at all tonight" — once, before the meeting, from the document
// rather than from a round instruction.
//
// Deliberately *not* full auto-casting. The user's pinned regulars are fixed
// input, not a suggestion the model may drop: they are handed over as already
// coming, and the model only fills the rest of the room around them. Hand-
// casting from the full grid stays available either way — this proposes, it
// never applies.

const { runDirectorSelection } = require('./pipeline-director');

// Enough of the document to cast from without paying for a whole book. The
// opening of a text is where its subject announces itself; casting doesn't
// need the argument, only the territory.
const CASTING_DOCUMENT_LIMIT = 3000;

// Same 4–6 the roster badge has always recommended (larger casts thin out
// individual voices — see updateMemberCount in app.js).
const CASTING_TARGET_MIN = 4;
const CASTING_TARGET_MAX = 6;

function buildCastingToolSchema(candidateIds, minCount, maxCount) {
  return {
    name: 'cast_the_evening',
    description: 'Choose which further members of the lodge this document would draw to the room tonight.',
    input_schema: {
      type: 'object',
      properties: {
        speakers: {
          type: 'array',
          items: { type: 'string', enum: candidateIds },
          minItems: minCount,
          maxItems: maxCount,
          uniqueItems: true,
          description: `Member ids, in order of how strongly the document draws them, from those not already coming: ${candidateIds.join(', ')}.`,
        },
        reasoning: {
          // Unlike the per-round director's rationale, this one is shown —
          // it is the proposal's whole case for itself.
          type: 'string',
          description:
            'One or two sentences, in the register of the lodge, on what in this document draws these people. Shown to the user beside the proposed cast.',
        },
      },
      required: ['speakers', 'reasoning'],
    },
  };
}

function buildCastingPrompt({ lodgeContext, candidates, regulars, documentText, minCount, maxCount }) {
  const candidateLines = candidates.map(m => `- ${m.id} — ${m.name}${m.brief ? `: ${m.brief}` : ''}`).join('\n');

  const regularsBlock = regulars.length
    ? `ALREADY COMING TONIGHT — the user's regulars. They are always drawn to this room. They are not yours to choose, and not yours to drop:\n${regulars.map(m => `- ${m.name}`).join('\n')}`
    : 'No one is fixed for tonight. The whole room is yours to propose.';

  const document = documentText.trim().slice(0, CASTING_DOCUMENT_LIMIT);

  const system = `${lodgeContext}

---

## YOUR ROLE RIGHT NOW

You are not writing dialogue, and you are not choosing who speaks within a round. You are saying who the evening's document draws to the room at all — which members of the lodge would find their way in tonight, given what is about to be read aloud.

${regularsBlock}

THE REST OF THE LODGE — anyone here may be drawn tonight:
${candidateLines}

THE DOCUMENT TO BE READ ALOUD TONIGHT:
${document}

Choose between ${minCount} and ${maxCount} further members, ordered by how strongly the document draws them. Cast for friction as much as for affinity — a room where everyone agrees has nothing to say. Consider who the document's subject belongs to, who would dispute it, and who would hear something in it nobody else would. Do not choose for coverage, seniority, or roster order.${regulars.length ? ' The regulars above are already in the room; choose people who make something of what those regulars will say, not duplicates of them.' : ''}`;

  const userMessage = 'Say who this document draws tonight.';

  return { system, userMessage };
}

// Returns { cast, additions, regulars, reasoning, source }. `cast` is the
// full proposed room — regulars first, then the model's additions in the
// order it ranked them. `source` is 'director' | 'director-retry' |
// 'fallback' | 'regulars' (the last meaning no call was made at all).
//
// roster entries are { id, name, brief? }; `brief` is a one-line sketch used
// only for casting judgment. Must be in roster order — the deterministic
// fallback relies on it, exactly as selectSpeakers' does.
async function proposeCast({
  client,
  model,
  lodgeContext,
  roster,
  regularIds = [],
  documentText,
  targetMin = CASTING_TARGET_MIN,
  targetMax = CASTING_TARGET_MAX,
  onMetric,
}) {
  const rosterIds = roster.map(m => m.id);
  const regulars = roster.filter(m => regularIds.includes(m.id));
  const candidates = roster.filter(m => !regularIds.includes(m.id));

  // The regulars already fill (or overfill) the evening, or there is simply
  // nobody left to add. Either way the answer is known without a call —
  // #185's "one extra cheap call per session" is a ceiling, not a quota.
  if (regulars.length >= targetMax || candidates.length === 0) {
    return {
      cast: regulars.map(m => m.id),
      additions: [],
      regulars: regulars.map(m => m.id),
      reasoning: null,
      source: 'regulars',
    };
  }

  const maxCount = Math.min(targetMax - regulars.length, candidates.length);
  const minCount = Math.min(Math.max(targetMin - regulars.length, 1), maxCount);

  const candidateIds = candidates.map(m => m.id);
  const { system, userMessage } = buildCastingPrompt({
    lodgeContext,
    candidates,
    regulars,
    documentText,
    minCount,
    maxCount,
  });

  const { speakers, reasoning, source } = await runDirectorSelection({
    client,
    model,
    system,
    userMessage,
    candidateIds,
    minCount,
    maxCount,
    tool: buildCastingToolSchema(candidateIds, minCount, maxCount),
    phase: 'casting',
    onMetric,
    lodgeContext,
    invalidNote: ` Your previous selection was invalid — it must be between ${minCount} and ${maxCount} member ids, no duplicates, drawn only from: ${candidateIds.join(', ')}. Choose again.`,
    // Deterministic fallback: the first `minCount` candidates in roster order.
    // Roster order is roughly the order the lodge was founded in, which is a
    // defensible room to open with when the model can't be reached at all.
    fallbackIds: candidateIds.slice(0, minCount),
    fallbackNote: 'casting call failed twice — used deterministic fallback',
  });

  // rosterIds guards against a fallback list going stale mid-flight; the
  // model path is already enum-constrained and validated upstream.
  const additions = speakers.filter(id => rosterIds.includes(id));

  return {
    cast: [...regulars.map(m => m.id), ...additions],
    additions,
    regulars: regulars.map(m => m.id),
    reasoning: reasoning || null,
    source,
  };
}

module.exports = {
  CASTING_DOCUMENT_LIMIT,
  CASTING_TARGET_MIN,
  CASTING_TARGET_MAX,
  buildCastingToolSchema,
  buildCastingPrompt,
  proposeCast,
};
