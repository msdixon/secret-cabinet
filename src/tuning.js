'use strict';

// #364: the pacing/scheduling constants previously lived scattered across
// pipeline.js, pipeline-speaker.js, and lodge-prompts.js — each carrying its
// own rationale comment, but with no single place to see them as the
// interacting system they actually are (the review that filed this issue
// found two of them, POOL_SLACK and the mid-passage re-consult threshold,
// mutually incompatible in a way only visible side by side). This is a pure
// move: values and their rationale comments relocated here, logic left where
// it was. Not a config file or env vars — these are design decisions with
// reasoning attached, not deployment settings; the goal is that a future
// calibration pass is a single-file diff with the reasoning still visible.

// ── Passage/round shape (pipeline.js) ──────────────────────────────────────

// #164: total words a round budgeted for itself. #244 reframes it, per
// #194's migration sketch: not "the size of a round" any more (rounds are
// gone) but the breath budget per passage — how long the room goes between
// chances to draw breath. Same starting number, different meaning. Rachel's
// original calibration: "about the length of a writer's morning pages." A
// starting number, not a hard requirement — due for review against real
// sessions at the 2026-08-19 follow-up, now folded into a combined
// passage-length/lull-cadence calibration review (see #244).
const BREATH_BUDGET_WORDS = 1000;
const MIN_WORDS_FOR_ANOTHER_BEAT = 40; // below this, not enough room left for a meaningful beat
const POOL_SLACK = 1; // the director's candidate pool runs a little larger than the round's target speaker count

// #353: was 150 — a deliberately conservative placeholder that, worked
// backwards, sized every candidate pool (opening and mid-passage alike)
// larger than BREATH_BUDGET_WORDS could ever actually serve: a 7-seat pool
// (5 requested + POOL_SLACK 2) needs 14 beats to exhaust at
// MAX_TURNS_PER_POOL_MEMBER, but real passages run ~4.3. 220 is the same
// real-observed-turn-length figure test/pipeline.test.js's #352 simulation
// already uses (BREATH_BUDGET_WORDS / 220 ≈ the ~4.3 beats/passage the
// #353 issue measured) — sizing the pool against it, not the old
// placeholder, is what makes pool exhaustion reachable at all.
const WORDS_PER_BEAT_ESTIMATE = 220;

// #353: below this fraction of BREATH_BUDGET_WORDS spent since the last
// consult, don't bother the director again — 0.9 was chosen by simulating
// the real pickNextSpeaker/isPoolExhausted against realistic (varying, not
// fixed-length) beat lengths: it lands the mid-passage check-in inside the
// last tenth of a typical passage's budget, catching passages that run
// long without firing on every ordinary one (~29% of simulated passages;
// see test/pipeline.test.js's '#353' suite).
const RECONSULT_BUDGET_FRACTION = 0.9;
const MAX_TOTAL_BEATS = 16; // hard safety net — budget/pool logic should always end the round before this binds

// ── Speaker-order weighting (pipeline-speaker.js) ──────────────────────────

// Seed data, not a researched claim about every historical figure's real
// prose style — only the two personas the #164 design doc named explicitly
// as needing room to run long. Expand this as real sessions surface more
// per-member tendencies (see the 2026-08-19 follow-up).
const LENGTH_TENDENCY_OVERRIDES = {
  crowley: 'expansive',
  yeats: 'expansive',
};
const LENGTH_WEIGHT = { terse: 0.7, medium: 1, expansive: 1.35 };

const MAX_TURNS_PER_POOL_MEMBER = 2; // a 3rd turn for anyone needs a fresh director consult, not another local pick
const REPEAT_BACK_TO_BACK_WEIGHT = 0.12; // rare but real — reads as an interruption/quick reply when it happens
const REPEAT_DECAY = 0.45; // each earlier appearance this round further discounts a repeat pick
const LOW_BUDGET_WORDS = 120; // below this, favor members who tend to land a short beat and let the round close

// #203: a member whose disposition names someone they privately have
// unspent business with should be meaningfully likelier to get the next
// beat once that person actually speaks — an interruption reading as a
// character choice, not a scheduling accident. Well above LENGTH_WEIGHT's
// ~1.35x ceiling so ordinary length-tendency variance can't swamp it, but
// still a weight, not a forced pick: other pool weighting (repeat discount,
// budget throttle) still applies on top, and the room doesn't stop for
// every unspent intention the instant it becomes eligible.
const INTERRUPT_INTENT_WEIGHT = 3;

// #330: `pool` arrives in the director's priority order (buildDirectorToolSchema
// asks for the candidate pool "ordered by priority", and selectSpeakers
// returns that order verbatim) but until this fix pickNextSpeaker never read
// it — every pool member had equal odds regardless of how strongly the
// director judged them relevant, so a member ranked as the single most
// relevant voice for a provocation could still simply never come up before
// the round's word budget closed. Each rank step down from the top discounts
// by this factor, applied uniformly whether `pool` came from the round's
// opening consult or a mid-round re-consult — both are asked for and return
// the same "ordered by priority" shape, so there's no signal here to treat
// them differently. Chosen so the top-ranked member is meaningfully likelier
// (~2.4x a bottom-ranked member in a 5-seat pool) without making the
// ranking a forced pick — same "a weight, not a guarantee" spirit as
// INTERRUPT_INTENT_WEIGHT above, and it stacks with every other factor here.
const PRIORITY_RANK_DECAY = 0.8;

// #352: until now nothing in the pipeline had a meeting-level view of who
// had spoken. `spokenCounts` covers a single passage and is rebuilt from
// scratch on every mid-passage re-consult, and REPEAT_DECAY is a *penalty*
// for having just spoken rather than a boost for never having spoken — so a
// member silent through four passages entered the fifth weighted identically
// to one who had spoken eight times. Simulated against this function, the
// bottom-ranked member of a 7-seat pool was silent in 71% of passages: a
// 3.3x weight gap opens before anyone has said a word, because
// PRIORITY_RANK_DECAY and LENGTH_WEIGHT both push toward the top of the pool
// with nothing pushing back.
//
// The counterweight is a boost, not a forced pick — same spirit as
// INTERRUPT_INTENT_WEIGHT and PRIORITY_RANK_DECAY above. Each whole turn a
// member sits below the pool's own average for the night multiplies their
// weight by this, so silence accumulates pressure across passages instead of
// being forgotten at each passage boundary. Pool-relative rather than
// roster-relative because the pool is the only thing this function can draw
// from: a member the director never shortlisted cannot be picked however
// long they have been quiet, which is what the director half of #352 (the
// explicit who-hasn't-spoken line in buildDirectorPrompt) addresses instead.
const UNDER_HEARD_BOOST = 1.8;
// Ceiling on the deficit, so one runaway talker can't turn every other seat
// into a near-certainty. At the cap the boost is ~5.8x, enough to overcome a
// bottom-of-pool PRIORITY_RANK_DECAY (0.8^6 ≈ 0.26) and land such a member
// slightly ahead of an at-par top-ranked one — a real thumb on the scale,
// still well short of a queue.
const MAX_UNDER_HEARD_DEFICIT = 3;

// ── Speaker prompt budgets (pipeline-speaker.js) ───────────────────────────

// Below this words-per-remaining-voice ratio, the round is "crowded" — there
// isn't room for everyone still waiting to get a full turn at the length
// speakers have been running. A vague "leave room for others" didn't move
// real turn length (see #164's 2026-08-06 live tests — 900-token+ turns
// regardless of how many voices were still unheard); naming the actual
// headcount is a concrete constraint the model can react to instead of an
// abstraction it can shrug off. Set above the even split for a full 5-voice
// pool on the default 1000-word budget (1000/5 = 200 words/voice) — those
// live tests were exactly that shape, and the *first* speaker (the one most
// responsible for spending the budget) needs the pressure too, not just
// whoever's left once it's already gone.
const CROWDED_WORDS_PER_VOICE = 220;

// #164: still well under the pre-#164 1500-token cap, but raised from an
// initial 900 after a live convene showed 900 gets hit routinely — not just
// by designated-expansive personas (Crowley, Yeats) but by default-tendency
// members too (Waite and Lévi both hit 900 in one round of that test,
// Lévi's turn visibly cut off mid-sentence). The model's baseline verbosity
// for this salon's philosophical-debate register runs long across the
// board; 1100 buys more headroom against mid-sentence truncation while
// still sitting well below the old cap. Expect this to need more tuning at
// the 2026-08-19 follow-up.
const SPEAKER_MAX_TOKENS = 1100;

// A few hundred words, per the issue — enough to carry a cadence, cheap
// enough to pay per speaker call (input tokens, uncached until #190). Sized
// against the real corpus and still holding as it grows: 30 of the 36
// authored entries pass through whole, and it only bites on the six long
// ones (Moina Mathers 584 words, Porete 434, Dion Fortune 406, Catherine
// Blake 358, Lévi 302, Hildegard 301). The whole section costs ~550 input
// tokens per beat when present.
const VOICE_EXEMPLAR_WORD_BUDGET = 300;

const RESIDUE_MAX_CHARS = 480; // same order of magnitude as disposition's 400, deliberately not larger — smaller and more conservative was the explicit mandate

// ── Pool/arc sizing (lodge-prompts.js) ─────────────────────────────────────

// #194 touchpoint 2: SPEAKER_COUNTS/speakerCountForRound retire — pool
// sizing beyond the opening consult is already dynamic on re-consult
// (pipeline.js's selectSpeakers mid-passage re-ask). The opening consult of
// any passage just needs one flat default now, not a per-round taper.
const DEFAULT_POOL_SIZE = 5;
const INTERJECT_SPEAKER_COUNT = 3; // today's prose only ever suggested "2-3", never enforced — a new explicit assumption

// Multiples of the breath budget (BREATH_BUDGET_WORDS, above) at which the
// arc note advances to the next stage. Starting calibration, not tuned —
// due for review alongside the breath budget itself at the 2026-08-19
// pacing follow-up, now folded into #244's combined passage-length/
// lull-cadence review.
const ARC_STAGE_BOUNDARIES = { crosstalk: 1, embers: 3, extended: 5 };

module.exports = {
  BREATH_BUDGET_WORDS,
  MIN_WORDS_FOR_ANOTHER_BEAT,
  POOL_SLACK,
  WORDS_PER_BEAT_ESTIMATE,
  RECONSULT_BUDGET_FRACTION,
  MAX_TOTAL_BEATS,
  LENGTH_TENDENCY_OVERRIDES,
  LENGTH_WEIGHT,
  MAX_TURNS_PER_POOL_MEMBER,
  REPEAT_BACK_TO_BACK_WEIGHT,
  REPEAT_DECAY,
  LOW_BUDGET_WORDS,
  INTERRUPT_INTENT_WEIGHT,
  PRIORITY_RANK_DECAY,
  UNDER_HEARD_BOOST,
  MAX_UNDER_HEARD_DEFICIT,
  CROWDED_WORDS_PER_VOICE,
  SPEAKER_MAX_TOKENS,
  VOICE_EXEMPLAR_WORD_BUDGET,
  RESIDUE_MAX_CHARS,
  DEFAULT_POOL_SIZE,
  INTERJECT_SPEAKER_COUNT,
  ARC_STAGE_BOUNDARIES,
};
