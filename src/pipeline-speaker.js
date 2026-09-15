'use strict';

// #284 seam-map, module 4 of 6 — the speaker turn: local pacing (#164),
// voice-register exemplar (#187), cross-session residue (#166), and the
// per-speaker call itself.

const { buildCachedSystem, withHistoryCacheControl } = require('./pipeline-core');
const { buildRelationshipSection, hasChargedTie } = require('./relationships');
const {
  LENGTH_TENDENCY_OVERRIDES,
  LENGTH_WEIGHT,
  MAX_TURNS_PER_POOL_MEMBER,
  REPEAT_BACK_TO_BACK_WEIGHT,
  REPEAT_DECAY,
  LOW_BUDGET_WORDS,
  INTERRUPT_INTENT_WEIGHT,
  RELATIONAL_CALLBACK_WEIGHT,
  CHARGED_REACTIONS,
  PRIORITY_RANK_DECAY,
  UNDER_HEARD_BOOST,
  MAX_UNDER_HEARD_DEFICIT,
  CROWDED_WORDS_PER_VOICE,
  TYPICAL_TURN_WORDS,
  SPEAKER_MAX_TOKENS,
  TANGENT_NUDGE_CHANCE,
  VOICE_EXEMPLAR_WORD_BUDGET,
  SECONDARY_VOICE_EXEMPLAR_WORD_BUDGET,
  RESIDUE_MAX_CHARS,
} = require('./tuning');

// ── Member section (shared with the legacy full-blob prompt builder) ──────

// Extracted from server.js's buildSystemPrompt so both the legacy full-blob
// builder and the new per-speaker builder (Stage 2) share identical
// artifact/session-note injection logic.
//
// #268: `otherPresentMembers`/`relationshipEdges` are optional — omitting
// them (existing callers, e.g. the prototype route) just skips the
// assembled-relationship fallback, same degrade-gracefully contract as
// artifact/notes being absent.
function buildMemberSection(member, artifact, notes, loadMemberFile, otherPresentMembers, relationshipEdges) {
  const text = loadMemberFile(member.file);
  if (!text) return '';
  const artifactNote =
    artifact?.memberId === member.id && artifact.text?.trim()
      ? `\n\n---\n\n## PRIVATE — BEFORE THE MEETING BEGAN\n\nBefore the others arrived, you were shown the following. No one else in the room has seen it. You may reference it, produce it at the right moment, withhold it entirely, or let it colour what you say without naming it. The choice is yours.\n\n${artifact.text.trim()}`
      : '';
  const sessionNote = notes[member.id]?.trim() ? `\n\n---\n\n## SESSION NOTE\n\n${notes[member.id].trim()}` : '';
  const relationshipSection = buildRelationshipSection(text, member, otherPresentMembers, relationshipEdges);
  return `---\n${text}${artifactNote}${sessionNote}${relationshipSection}`;
}

// ── Local hybrid speaker pacing (#164) ─────────────────────────────────────
//
// Who speaks next, beat by beat, is a cheap local weighted pick — no API
// call — drawing from the director's candidate pool. This is what makes the
// round feel like back-and-forth rather than a queue of monologues: it can
// send the same voice back in (rare, weighted low — reads as an
// interruption when it happens) and it paces against the round's remaining
// word budget rather than a fixed per-member turn count.

// #364: LENGTH_TENDENCY_OVERRIDES, LENGTH_WEIGHT, MAX_TURNS_PER_POOL_MEMBER,
// REPEAT_BACK_TO_BACK_WEIGHT, REPEAT_DECAY, LOW_BUDGET_WORDS,
// INTERRUPT_INTENT_WEIGHT, PRIORITY_RANK_DECAY, UNDER_HEARD_BOOST, and
// MAX_UNDER_HEARD_DEFICIT moved to tuning.js (imported above), alongside the
// rest of the pacing constants — see that file for values and rationale.

function lengthTendencyOf(memberId) {
  return LENGTH_TENDENCY_OVERRIDES[memberId] || 'medium';
}

// Mean turns-tonight across the pool, or 0 when no ledger was supplied — by
// a caller predating #352, or for a session predating #244's `beats` (see
// lodge-prompts.js's turnsSoFar). A zero mean makes every deficit zero and
// every boost exactly 1x, so an absent ledger reproduces the old weighting
// precisely rather than approximating it.
function poolAverageTurns(pool, meetingTurns) {
  if (!meetingTurns || !pool.length) return 0;
  return pool.reduce((sum, id) => sum + (meetingTurns[id] || 0), 0) / pool.length;
}

// How far below the pool's average for the night this member sits, clamped
// to [0, MAX_UNDER_HEARD_DEFICIT]. Fractional by design — the boost should
// rise smoothly as a member falls behind, not step at whole turns.
function underHeardDeficit(id, meetingTurns, averageTurns) {
  return Math.min(MAX_UNDER_HEARD_DEFICIT, Math.max(0, averageTurns - (meetingTurns?.[id] || 0)));
}

// Returns a memberId from `pool`, or null if every pool member has already
// hit MAX_TURNS_PER_POOL_MEMBER (the caller should re-consult the director).
// `disposition`, if given, is the { [memberId]: { waitingOnMemberId } } map
// built by callDispositionUpdate (#188/#203) — read-only here.
// `meetingTurns`, if given, is the { [memberId]: turns } meeting-level
// ledger from lodge-prompts.js's turnsSoFar (#352) — also read-only, and
// omitting it is a supported no-op, not a degraded mode.
// `relationshipEdges`, if given, is #268's full graph edge list (the same
// data buildSpeakerSystemPrompt already threads through) — used only to
// check a candidate's tie to `lastSpeakerId`, read-only, and omitting it
// (or omitting `disposition`) is a supported no-op: RELATIONAL_CALLBACK_WEIGHT
// simply never applies.
function pickNextSpeaker({
  pool,
  spokenCounts,
  lastSpeakerId,
  remainingBudget,
  disposition,
  meetingTurns,
  relationshipEdges,
  rng = Math.random,
}) {
  const averageTurns = poolAverageTurns(pool, meetingTurns);
  const lastSpeakerReaction = lastSpeakerId ? disposition?.[lastSpeakerId]?.reaction : null;
  const lastSpeakerRanRoomHot = CHARGED_REACTIONS.includes(lastSpeakerReaction);
  const weights = pool.map((id, rank) => {
    const timesSpoken = spokenCounts.get(id) || 0;
    if (timesSpoken >= MAX_TURNS_PER_POOL_MEMBER) return 0;
    const tendency = lengthTendencyOf(id);
    let w = LENGTH_WEIGHT[tendency];
    if (id === lastSpeakerId) w *= REPEAT_BACK_TO_BACK_WEIGHT;
    else if (timesSpoken > 0) w *= Math.pow(REPEAT_DECAY, timesSpoken);
    if (remainingBudget < LOW_BUDGET_WORDS && tendency === 'expansive') w *= 0.4;
    if (lastSpeakerId && disposition?.[id]?.waitingOnMemberId === lastSpeakerId) w *= INTERRUPT_INTENT_WEIGHT;
    else if (lastSpeakerRanRoomHot && id !== lastSpeakerId && hasChargedTie(relationshipEdges, id, lastSpeakerId))
      w *= RELATIONAL_CALLBACK_WEIGHT;
    w *= Math.pow(UNDER_HEARD_BOOST, underHeardDeficit(id, meetingTurns, averageTurns));
    w *= Math.pow(PRIORITY_RANK_DECAY, rank);
    return w;
  });

  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;

  let roll = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0 && weights[i] > 0) return pool[i];
  }
  return pool[pool.length - 1]; // floating-point fallback
}

function isPoolExhausted(pool, spokenCounts) {
  return pool.every(id => (spokenCounts.get(id) || 0) >= MAX_TURNS_PER_POOL_MEMBER);
}

function countWords(text) {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

// ── Passing (#362) ──────────────────────────────────────────────────────────
//
// lodge-context.md licenses silence three times over ("Absence is a form of
// response," "A member who has nothing to add says nothing") but until now
// the only way a picked member could produce nothing was to *fail* — a
// dropped API call recorded as an error, indistinguishable in the record
// from a member never called on at all. This gives the choice a real shape:
// a member passes by responding with nothing but a single action in
// *asterisks* — the room's own idiom for "someone lets a silence sit,"
// already named in lodge-context.md's register permissions — and nothing
// else. No dialogue, no second line.
//
// Deliberately the room's existing action-line idiom, not a new format
// bolted onto the transcript — every client renderer (app.js, sessions.js,
// reading-room.js) already knows how to typeset a turn that's nothing but
// one action, since #354's beats shape and the room's own register already
// allow a turn to be action-only. #362 gives that shape a name in the record
// (`passed: true`, below) rather than inventing a new one.
function isPassTurn(text) {
  const match = (text || '').trim().match(/^\*([^*\n]+)\*$/);
  return !!match && match[1].trim().length > 0;
}

// ── Voice-register exemplar (#187) ──────────────────────────────────────────
//
// The library (#35a) holds a verified primary-source excerpt authored by a
// roster member, and until #187 that text was read only by citation
// verification (#36/#153) — never by the member whose prose it is. Each
// member's voice therefore rested entirely on their character file's
// *description* of a register rather than on evidence of one. This injects
// a trimmed slice of a member's own writing into their speaker prompt as an
// exemplar of how they actually sound on the page.
//
// Coverage was 21 of 33 roster members when this shipped; #316's curation
// track has since taken it to 36 of 38 (measured 2026-08-20). The remaining
// gap is Corbin and Sun Ra, and only those two — they get nothing extra and
// behave exactly as before, on the voice doc's description alone. That is the
// intended degradation, not a gap to paper over: a member is only ever shown
// text they actually wrote.
//
// The gap is measured on `author`, not on library *coverage*, which counts a
// member as covered if they appear in an entry's `members` list at all. That
// is the right measure for the graph and for citation matching but the wrong
// one here: Pamela Colman Smith is listed on Waite's 1911 preface and Corbin
// on Jung's 1916 text because those entries concern them, not because they
// wrote a word of them. Handing Waite's prose to Pixie as "how you actually
// write" would be a fabrication of exactly the kind this project's citation
// work exists to prevent — hence the explicit `author` field in library.json
// (added by #187) rather than a reuse of `members`.

// #364: VOICE_EXEMPLAR_WORD_BUDGET moved to tuning.js (imported above) —
// see that file for the value and rationale.

// Trims from the top of the excerpt on the largest natural boundary that
// fits — whole paragraphs first, then whole sentences, and only as a last
// resort mid-sentence. A register exemplar cut mid-clause is a worse
// exemplar: the model reads the truncation itself as a stylistic habit.
function trimToWordBudget(text, maxWords) {
  const trimmed = (text || '').trim();
  if (!trimmed || countWords(trimmed) <= maxWords) return trimmed;

  const paragraphs = trimmed
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean);
  const kept = [];
  let used = 0;
  for (const paragraph of paragraphs) {
    const words = countWords(paragraph);
    if (used + words > maxWords) break;
    kept.push(paragraph);
    used += words;
  }
  if (kept.length) return `${kept.join('\n\n')}\n\n[…]`;

  // The opening paragraph alone overruns the budget — fall back to whole
  // sentences within it.
  const sentences = paragraphs[0].match(/[^.!?]+(?:[.!?]+|$)/g) || [];
  const keptSentences = [];
  used = 0;
  for (const sentence of sentences) {
    const words = countWords(sentence);
    if (used + words > maxWords) break;
    keptSentences.push(sentence.trim());
    used += words;
  }
  if (keptSentences.length) return `${keptSentences.join(' ')} […]`;

  // One unbroken sentence longer than the whole budget (verse without
  // terminal punctuation does this too) — hard cut.
  return `${trimmed.split(/\s+/).slice(0, maxWords).join(' ')} […]`;
}

// Half the corpus's titles already name the work they're drawn from ("The
// Voice of the Devil — The Marriage of Heaven and Hell", source "The
// Marriage of Heaven and Hell"), so a naive join prints it twice. Drop the
// redundant half rather than hand the model a line that reads like a
// stutter — this is the one place in the prompt claiming to be evidence.
function exemplarProvenance(exemplar) {
  const parts = [exemplar.title];
  if (exemplar.source && !exemplar.title?.includes(exemplar.source)) parts.push(exemplar.source);
  parts.push(exemplar.date);
  return parts.filter(Boolean).join(' — ');
}

// Most of the corpus is in translation, so for many members the specific
// English words are a translator's choice, not theirs. Naming that keeps
// the model from adopting Rosenthal's or Peers's vocabulary as Ibn
// Khaldun's or Teresa's own.
function exemplarTranslationNote(exemplar) {
  return exemplar.translated
    ? " The English here is a translator's, not yours: take the cadence, the shape of the argument, and the habits of attention as your own — not the particular vocabulary."
    : '';
}

// #370 wave 2: a member's *other* authored entries, in a different genre
// from the primary exemplar above — see library.js's
// loadSecondaryVoiceExemplars. Rendered smaller and explicitly framed as
// supplementary, not a second competing exemplar: it exists to sharpen or
// correct the read the primary passage gives, the way a second data point
// narrows an estimate rather than replacing the first. '' for a member with
// none, which is still most of the roster.
function buildSecondaryExemplarBlock(secondaryExemplars) {
  const blocks = (secondaryExemplars || [])
    .map(exemplar => {
      const text = trimToWordBudget(exemplar?.text, SECONDARY_VOICE_EXEMPLAR_WORD_BUDGET);
      if (!text) return '';
      return `\n\n${exemplarProvenance(exemplar)}\n\n${text}${exemplarTranslationNote(exemplar)}`;
    })
    .filter(Boolean);
  if (!blocks.length) return '';

  return `\n\n---\n\nBelow is a shorter, second page of your own writing — a different genre, a different room, sometimes a different moment of your life. It doesn't replace the passage above; it sharpens or corrects it, the way a second sighting narrows an estimate the first alone couldn't. Weight it lighter than the passage above, but let both shape *how* you speak. Same rule as above: do not quote, cite, allude to, or steer toward either text's subject.${blocks.join('')}`;
}

// `exemplar` is { title, source, date, text, translated } — see server.js's
// loadVoiceExemplar. `secondaryExemplars` is an array of the same shape —
// see loadSecondaryVoiceExemplars — empty or absent for the ordinary case
// of a member with just one authored entry. Returns '' for a member with no
// primary entry, which is what makes the degradation invisible rather than
// a hole in the prompt.
function buildVoiceExemplarSection(exemplar, secondaryExemplars = []) {
  const text = trimToWordBudget(exemplar?.text, VOICE_EXEMPLAR_WORD_BUDGET);
  if (!text) return '';

  const provenance = exemplarProvenance(exemplar);
  const translationNote = exemplarTranslationNote(exemplar);
  const secondarySection = buildSecondaryExemplarBlock(secondaryExemplars);

  return `\n\n---\n\n## HOW YOU ACTUALLY WRITE — A PAGE IN YOUR OWN HAND

Below is a passage of your own writing, from the lodge's archive. It is here as evidence of your register — your sentence rhythm, how you build and qualify a thought, what you reach for and what you leave alone. It is not a topic, an assignment, or a thing to bring up.

${provenance}

${text}

Let this govern *how* you speak tonight, never *what* you speak about. Do not quote it, cite it, allude to it, or steer the room toward its subject — no one here is discussing this text, and producing it would read as a non sequitur. It is also written prose, and you are speaking aloud in a room: what carries over is the mind and the movement, not the punctuation of the page.${translationNote}${secondarySection}`;
}

// ── Cross-session residue (#166) ───────────────────────────────────────────
//
// Rung (a) of #195's amnesia ladder: members stay amnesiac — no recall of
// prior meetings — but drift the way the lodge context already licenses:
// "the meeting deposits itself in you below the threshold of conscious
// recall... a quality of readiness." Where #188's disposition is a member's
// stance *tonight*, residue is the same mechanism's slow accumulation
// *across* tonights — a small, capped, per-member store of stances,
// tendencies, warmths and grudges that outlives the session that produced
// it, read back into every future session's speaker prompt regardless of
// which room convenes it.
//
// Piggybacks on the exact disposition tool call (see pipeline-disposition.js's
// callDispositionUpdate) rather than adding a second one: `residueNote` is
// populated only on the rare beat that earns it. Zero added latency, zero
// added API calls.
//
// Voice fidelity is the paramount constraint (per #166's scoping) — see
// docs/AXES.md's Axis 4 for the drift-toward-sameness risk this format resists:
// fragments must stay short, concrete, and instance-grounded, and the
// oldest erode off the cap long before accumulated residue could ever
// outweigh the character file's fixed voice.

// #364: RESIDUE_MAX_CHARS moved to tuning.js (imported above) — see that
// file for the value and rationale.
const RESIDUE_NOTE_MAX_CHARS = 200; // one fragment's ceiling before it ever reaches the merge
const RESIDUE_SEPARATOR = ' · ';

// Deterministic, no model call: appends the new fragment and drops whole
// fragments from the *oldest* end until back under the cap — never a
// mid-fragment cut, same principle as #187's trimToWordBudget (a note
// sheared mid-clause reads to the model as a stylistic habit, not an
// elision). Oldest residue simply erodes off the cap as new residue
// accrues — sediment, not a narrative a second call would have to compose.
function mergeResidue(priorText, note) {
  const trimmedNote = (note || '').trim().slice(0, RESIDUE_NOTE_MAX_CHARS);
  if (!trimmedNote) return (priorText || '').trim();

  const priorFragments = (priorText || '')
    .split(RESIDUE_SEPARATOR)
    .map(f => f.trim())
    .filter(Boolean);
  const fragments = [...priorFragments, trimmedNote];

  const kept = [];
  let used = 0;
  for (let i = fragments.length - 1; i >= 0; i--) {
    const fragment = fragments[i];
    const cost = fragment.length + (kept.length ? RESIDUE_SEPARATOR.length : 0);
    if (used + cost > RESIDUE_MAX_CHARS) break;
    kept.unshift(fragment);
    used += cost;
  }
  return kept.join(RESIDUE_SEPARATOR);
}

// `residueText` is the merged, on-disk cross-session store for this member
// — see server.js's loadResidue. Empty for a member with no accumulated
// residue yet, which is what makes the degradation invisible (same contract
// as buildVoiceExemplarSection). The framing is deliberately never a claim
// of memory — rung (a) keeps the amnesia; this is instinct, not recall.
function buildResidueSection(residueText) {
  const text = (residueText || '').trim();
  if (!text) return '';

  return `\n\n---\n\n## WHAT LINGERS, THOUGH YOU COULDN'T SAY WHY

${text}

This is not memory. You have no meetings to recall, and if pressed, you would honestly deny remembering any of them — because you don't. It surfaces only as instinct: a tone you reach for without knowing its source, a wariness or a warmth that arrives ahead of any reason you could give for it. Let it color how you carry yourself tonight — never mention it, explain it, or gesture at where it comes from. As far as you know, there is nothing to gesture at.`;
}

// ── Per-speaker call ────────────────────────────────────────────────────────

// Only this member's own character file goes in — no other present members'
// files. That's the whole point: each speaker gets the model's full
// attention instead of a fraction of it split across the whole cast.
function buildSpeakerSystemPrompt({
  lodgeContext,
  member,
  artifact,
  notes,
  loadMemberFile,
  disposition,
  voiceExemplar,
  secondaryVoiceExemplars,
  residue,
  otherPresentMembers,
  relationshipEdges,
}) {
  const memberSection = buildMemberSection(
    member,
    artifact,
    notes,
    loadMemberFile,
    otherPresentMembers,
    relationshipEdges
  );
  // #187: sits directly after the character file, since it's evidence for
  // the same thing that file describes — and before the disposition, which
  // is about tonight specifically and wants to be the last thing read.
  const exemplarSection = buildVoiceExemplarSection(voiceExemplar, secondaryVoiceExemplars);
  // #166: slower-moving than disposition (spans sessions, not just tonight)
  // so it sits between the exemplar and the disposition — evidence of
  // register, then accumulated drift, then tonight specifically, in that
  // order of how far back each one reaches.
  const residueSection = buildResidueSection(residue);
  // #203: disposition is now { text, waitingOnMemberId } (see
  // pipeline-disposition.js's scratchpad section) — only the prose goes in
  // the speaker prompt, the structured target is read by pickNextSpeaker.
  const dispositionText = disposition?.text?.trim();
  const dispositionSection = dispositionText
    ? `\n\n---\n\n## YOUR PRIVATE STATE TONIGHT (no one else in the room can see this)\n\n${dispositionText}`
    : '';

  return `${lodgeContext}

---

${memberSection}${exemplarSection}${residueSection}${dispositionSection}

---

## YOUR TURN RIGHT NOW

You are about to contribute your turn in this round of the salon. Generate only your own contribution — not other members' dialogue, not a transcript of the whole room, just what you say and do right now.

Do not sign your own name at the start of your response — that is handled automatically, outside this call. Begin directly with your action (if any) or your speech.

Write your entire turn as one continuous block — no blank line anywhere inside it, even across multiple sentences or beats. A blank line marks a change of speaker to whoever reads this afterward; leaving one in the middle of your own turn would read as someone else taking over mid-thought. If you need a pause or a shift, use a single line break, never a blank one.

There is no fixed length for a turn — let who you are and what's just happened decide it. Most turns are short, on the order of ${TYPICAL_TURN_WORDS} words or well under. Some members think out loud at length once something has actually engaged them; when that's genuinely true tonight, say what needs saying — but that length has to be earned by the moment, not the default reach for any turn. A one-line interjection is not a lesser contribution than a paragraph; more often it's the harder, more disciplined choice.

You do not have to speak. If nothing in the room has actually moved you — someone else has already said the truer version of your point, or you are simply not there yet — you may pass instead of manufacturing a reaction. To pass, write nothing but a single action in *asterisks*, and stop: a look, a stillness, a hand gone still around a glass. No dialogue, no second line, nothing after it. This is a real choice with its own weight, not an escape from a turn that's merely hard — reach for it because the silence is the truer thing tonight, not because speaking would cost you more effort. Being called on and staying quiet is itself something that happened in the room; use it rarely enough that it still means something when you do.

Actions and stage business are written in *single asterisks* and used sparingly. The default for any contribution is no action line at all — most speech should stand without physical description. An action earns its place only when it reveals something the words cannot: a gesture that contradicts the speech, a significant silence, a physical act that changes the room's temperature. Do not describe yourself looking at fires, adjusting posture, or sitting down. One action is the maximum; zero is the norm. Do not use --- as a divider.

A citation is available when it is genuinely the sharpest thing at hand — real texts, real historical tensions, real scholarship, including post-period scholarship, since the room is atemporal. Do not invent citations; if you invoke a text, that text must exist and any claim about it must be substantively accurate. But a turn does not need one to be complete: stating a position with real conviction is sufficient on its own, without relitigating the evidence behind it in the same breath. And reaching for a citation does not mean reciting it in full — naming the work, or gesturing at what it says, is enough for the room; you do not need to speak the quotation aloud to ground a claim in it. The fuller citation is captured separately, after you speak, and surfaces in the record on its own — that is not something this turn needs to perform.

There is no author present. The provocation was set before the room by no one in particular. Do not praise, critique, address, summarize, or workshop the writer — there is no writer in the room.

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

// #364: CROWDED_WORDS_PER_VOICE moved to tuning.js (imported above) — see
// that file for the value and rationale.

// ── Tangent/brevity nudge (#513) ────────────────────────────────────────────
//
// #513 phase 2: budgetHint below already *permits* a short beat, but only
// when the round is actually crowded — it's a scheduling accommodation, not
// a standing counterweight to the citation instruction that fires on every
// beat regardless of budget. This is that counterweight: a per-beat coin
// flip, independent of budget or persona, that — when it lands — tells this
// speaker specifically that a short reaction, a real tangent, or an
// unfinished thought is what's wanted from them right now, not a lesser
// version of a fuller turn they didn't have room for. See tuning.js's
// TANGENT_NUDGE_CHANCE for why this shape and rate were chosen over the
// issue's other two candidate levers.
function shouldNudgeTangent({ rng = Math.random } = {}) {
  return rng() < TANGENT_NUDGE_CHANCE;
}

// `interruptingName`, when set, is the just-spoken member this pick's own
// disposition named as unfinished business (see pickNextSpeaker's
// INTERRUPT_INTENT_WEIGHT, #203) — told to the speaker as an option, not an
// instruction, since a real interruption is sometimes let go rather than
// taken.
function buildSpeakerUserMessage({
  roundPrompt,
  roundSoFarText,
  member,
  remainingBudgetWords,
  unheardCount,
  interruptingName,
  tangentNudge,
}) {
  const soFar = roundSoFarText?.trim() ? `\n\n--- THE ROUND SO FAR ---\n${roundSoFarText.trim()}\n` : '';
  let budgetHint = '';
  if (typeof remainingBudgetWords === 'number') {
    const crowded =
      typeof unheardCount === 'number' &&
      unheardCount > 0 &&
      remainingBudgetWords / (unheardCount + 1) < CROWDED_WORDS_PER_VOICE;
    budgetHint = crowded
      ? `\n\n(Roughly ${remainingBudgetWords} words of room left in the round, and ${unheardCount} other${unheardCount === 1 ? '' : 's'} who haven't spoken yet still waiting on it. If everyone's going to fit, this is a moment where a line lands harder than a paragraph — but read the room; don't cut yourself off if something genuinely needs the space.)`
      : `\n\n(The round has roughly ${remainingBudgetWords} words of room left before it should start wrapping up — a felt sense of how much space remains, not a hard limit. Most turns land around ${TYPICAL_TURN_WORDS} words regardless of how much room is technically available; a short reaction is as valid a turn as a long one.)`;
  }
  // #513: unconditional on budget — this is a register nudge, not a
  // scheduling one, so it can land in the same beat as budgetHint above
  // without contradicting it.
  const tangentNote = tangentNudge
    ? `\n\n(This turn doesn't need to build a case or reach for a citation. A short reaction, a genuine tangent, an unfinished thought, or a Convivial gesture is a complete turn tonight — not a placeholder for a fuller one you didn't have time for.)`
    : '';
  const interruptNote = interruptingName
    ? `\n\n(You have unfinished business with ${interruptingName}, who just spoke — this is your moment for it. Take the thought mid-stride if it's still hot, or let the room settle a beat first and strike after. Your call; it's fine to let it pass.)`
    : '';
  return `${roundPrompt}${soFar}${budgetHint}${tangentNote}${interruptNote}

--- YOUR TURN ---
Generate ${member.name}'s contribution now.`;
}

// #364: SPEAKER_MAX_TOKENS moved to tuning.js (imported above) — see that
// file for the value and rationale.

// Streams the response (same delta shape streamClaude already forwards to
// the client), and still captures usage/latency via stream.finalMessage() —
// live streaming and per-call metrics are not mutually exclusive.
async function callSpeakerTurn({ client, model, system, conversationHistory, userMessage, onChunk, lodgeContext }) {
  const start = Date.now();
  const messages = [...withHistoryCacheControl(conversationHistory), { role: 'user', content: userMessage }];
  const stream = client.messages.stream({
    model,
    max_tokens: SPEAKER_MAX_TOKENS,
    system: buildCachedSystem(system, lodgeContext),
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

module.exports = {
  buildMemberSection,
  lengthTendencyOf,
  pickNextSpeaker,
  PRIORITY_RANK_DECAY,
  UNDER_HEARD_BOOST,
  MAX_UNDER_HEARD_DEFICIT,
  poolAverageTurns,
  underHeardDeficit,
  isPoolExhausted,
  countWords,
  isPassTurn,
  VOICE_EXEMPLAR_WORD_BUDGET,
  SECONDARY_VOICE_EXEMPLAR_WORD_BUDGET,
  trimToWordBudget,
  buildVoiceExemplarSection,
  RESIDUE_MAX_CHARS,
  RESIDUE_NOTE_MAX_CHARS,
  RESIDUE_SEPARATOR,
  mergeResidue,
  buildResidueSection,
  buildSpeakerSystemPrompt,
  buildSpeakerUserMessage,
  shouldNudgeTangent,
  stripInternalBlankLines,
  callSpeakerTurn,
};
