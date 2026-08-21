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
const {
  MAX_CITATIONS_PER_BEAT,
  CITATION_QUOTE_MAX_CHARS,
  CITATION_WORK_MAX_CHARS,
  CITATION_NOTE_MAX_CHARS,
} = require('./tuning');

const DISPOSITION_MAX_CHARS = 400; // a few sentences — hard cap so this can't balloon a speaker prompt over a long session
// #355: raised from 280 to make room for the optional citations array (up
// to MAX_CITATIONS_PER_BEAT items, each with a quote/work/note) on top of
// the reflection prose, target field, and #166's optional residue field.
// This is a ceiling, not a cost floor — billing follows tokens the model
// actually emits, and the ordinary no-citation turn's output shape (and
// cost) is unchanged.
const DISPOSITION_MAX_TOKENS = 900;

function buildDispositionToolSchema(presentIds, libraryIds = []) {
  return {
    name: 'update_disposition',
    description:
      "Record this member's private interior state after speaking, including whether they have unspent business with anyone present, and any citations they just made.",
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
        // #355: always-on citation capture, piggybacked here rather than a
        // separate whole-transcript pass (the old /verify-citations flow) —
        // bounded to this one turn's own text, with memberId already known
        // from the beat rather than string-matched out of formatted prose.
        // Left out of `required` for the same reason residueNote is: most
        // turns cite nothing, and an omitted/empty array says exactly that.
        citations: {
          type: 'array',
          maxItems: MAX_CITATIONS_PER_BEAT,
          description:
            'Every citation of a real (or purportedly real) text, author, or historical/scholarly claim made in the turn you just spoke — not this reflection. Most turns cite nothing; leave this empty then.',
          items: {
            type: 'object',
            properties: {
              quote: {
                type: 'string',
                description: `Verbatim ~10-25 word excerpt from your own turn's text containing the citation, copied exactly. Under ${CITATION_QUOTE_MAX_CHARS} characters.`,
              },
              work: {
                type: 'string',
                description: `The cited work, author, or claim as named. Under ${CITATION_WORK_MAX_CHARS} characters.`,
              },
              verdict: {
                type: 'string',
                enum: ['verified', 'unverified', 'uncertain'],
                description:
                  "Your own honest judgment from what you know: 'verified' if this is confidently a real work/claim, accurately represented; 'unverified' if it appears invented or misrepresented; 'uncertain' if you can't confidently judge either way.",
              },
              note: {
                type: 'string',
                description: `One-sentence reasoning for the verdict. Under ${CITATION_NOTE_MAX_CHARS} characters.`,
              },
              libraryMatch: {
                type: ['string', 'null'],
                description:
                  libraryIds.length
                    ? 'The matching archival library entry id if this citation clearly refers to one of the entries listed below, else null.'
                    : 'Always null — no archival library entries are available to match against.',
              },
            },
            required: ['quote', 'work', 'verdict', 'note'],
          },
        },
      },
      required: ['reflection', 'waitingOnMemberId'],
    },
  };
}

function buildDispositionSystemPrompt({ member, priorDisposition, presentMembers = [], priorResidue, libraryList }) {
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

  // #355: the archival library list, shown only so the model can flag a
  // clear match — the same short "id: title — source" form
  // /verify-citations used to build fresh from the whole transcript, now
  // computed once per round (pipeline.js's libraryContext) and reused
  // across every beat's piggybacked extraction.
  const libraryBlock = libraryList
    ? ` Check this list of archival library entries; if a citation clearly refers to one of them, set libraryMatch to that entry's id, else null:\n${libraryList}\n`
    : '';

  return `You are privately reflecting as ${member.name}, immediately after speaking your turn in tonight's salon. This reflection is never shown to anyone — not the other members, not the transcript, not the researcher who convened the evening. It is your own unspoken interior state, carried forward to color how you show up for the rest of the evening.

${priorBlock}${residueContextBlock}

Write 1-3 sentences, as private thought rather than speech: your current stance on the evening's argument, anything you haven't yet said but intend to, who you're aligned with or irritated by tonight. Be concrete and specific to what just happened, not a generic character summary. Keep it under ${DISPOSITION_MAX_CHARS} characters — this is a scratchpad, not an essay.

Separately, name whether there is one present person you have real unspent business with — something you'd want to answer or press if they spoke again. This is the exception, not the default: most turns, there is no one.

Separately again, and rarer still: name whether tonight left something that should genuinely outlast this evening — not tonight's mood, a durable turn. Most turns, there is nothing here either.

Separately from all of the above, and using the citations tool field rather than any of this private prose: extract every citation of a real (or purportedly real) text, author, or historical/scholarly claim from the turn you just spoke aloud (not this reflection). For each one, judge from your own knowledge whether it's a real work/claim and whether it's represented accurately — "verified", "unverified", or "uncertain".${libraryBlock} Most turns cite nothing; leave the citations field empty then.`;
}

function buildDispositionUserMessage({ roundSoFarText, turnText, member }) {
  return `--- WHAT JUST HAPPENED IN THE ROOM ---\n${roundSoFarText.trim()}\n\n--- WHAT YOU (${member.name}) JUST SAID ---\n${turnText}\n\n--- YOUR PRIVATE REFLECTION ---\nWrite your updated private disposition now.`;
}

// Deliberately no retry — this is a best-effort private-state update, not a
// user-visible turn. A failure just means the member's disposition doesn't
// move this beat; the caller keeps the prior value. `presentIds` excludes
// the reflecting member themself — waiting on yourself isn't a real state,
// and pickNextSpeaker's back-to-back weighting already covers that case.
const CITATION_VERDICTS = new Set(['verified', 'unverified', 'uncertain']);

// #355: sanitizes the raw citations array off the tool call the same way
// the rest of this function already hard-caps reflection/residueNote — a
// tool call is a request, not a guarantee, and this is written straight to
// the permanent record (beatsList) rather than shown once and discarded.
// A citation with no usable quote or work is dropped rather than kept with
// blanks; an unrecognized verdict downgrades to "uncertain" rather than
// silently passing through, per this room's own honesty requirement for
// citation verdicts (#153/#157) — quietly trusting an unparseable verdict
// would be worse than flagging it as unconfirmed. `libraryMatch` must
// resolve against the library ids actually offered this call, same
// fail-closed pattern as waitingOnMemberId above.
function sanitizeCitations(rawCitations, libraryIds) {
  if (!Array.isArray(rawCitations)) return [];
  return rawCitations
    .slice(0, MAX_CITATIONS_PER_BEAT)
    .map(c => {
      const quote = (c?.quote || '').trim().slice(0, CITATION_QUOTE_MAX_CHARS);
      const work = (c?.work || '').trim().slice(0, CITATION_WORK_MAX_CHARS);
      if (!quote || !work) return null;
      const verdict = CITATION_VERDICTS.has(c?.verdict) ? c.verdict : 'uncertain';
      const note = (c?.note || '').trim().slice(0, CITATION_NOTE_MAX_CHARS);
      const libraryMatch = c?.libraryMatch && libraryIds.includes(c.libraryMatch) ? c.libraryMatch : null;
      return { quote, work, verdict, note, libraryMatch };
    })
    .filter(Boolean);
}

async function callDispositionUpdate({ client, model, system, userMessage, presentIds = [], libraryIds = [] }) {
  const start = Date.now();
  const tool = buildDispositionToolSchema(presentIds, libraryIds);
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
  const { reflection, waitingOnMemberId, residueNote, citations } = block?.input || {};
  const text = (reflection || '').trim().slice(0, DISPOSITION_MAX_CHARS);
  const target =
    waitingOnMemberId && waitingOnMemberId !== 'none' && presentIds.includes(waitingOnMemberId)
      ? waitingOnMemberId
      : null;
  // #166: '' rather than undefined when absent, so callers can treat "no
  // residue this beat" uniformly without an extra undefined check.
  const residue = (residueNote || '').trim().slice(0, RESIDUE_NOTE_MAX_CHARS);
  return {
    text,
    waitingOnMemberId: target,
    residueNote: residue,
    citations: sanitizeCitations(citations, libraryIds),
    usage: response.usage,
    latencyMs,
  };
}

module.exports = {
  DISPOSITION_MAX_CHARS,
  buildDispositionToolSchema,
  buildDispositionSystemPrompt,
  buildDispositionUserMessage,
  callDispositionUpdate,
};
