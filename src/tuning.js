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

// #362: a pass (a member declining the turn — see pipeline-speaker.js's
// isPassTurn) still occupies a beat, but its own text is a few words at
// most. Charging only that real word count would let a passage spend the
// same MAX_TOTAL_BEATS allowance while barely touching BREATH_BUDGET_WORDS,
// handing whatever's left to whoever speaks next — the issue's own warning
// against a pass reading as "free" room for the most expansive voice in the
// pool. Floored at the same threshold a real beat already has to clear
// (MIN_WORDS_FOR_ANOTHER_BEAT), so a pass costs what the smallest legitimate
// spoken beat would have.
const PASS_BUDGET_COST = MIN_WORDS_FOR_ANOTHER_BEAT;

// #362: meeting-level ledger credit (lodge-prompts.js's turnsSoFar) for a
// passed beat — more than the zero a failed turn gets (the room never heard
// a failed attempt at all), less than the full credit a spoken turn earns.
// A member who passed was called on and did have something to answer for,
// which is not nothing; but they still haven't actually been heard from,
// which is not the same as having spoken. Keeping it below 1 means the
// under-heard boost (pipeline-speaker.js) still nudges them back toward the
// floor faster than a member who used their turn to speak.
const PASS_TURN_CREDIT = 0.5;

// ── Speaker-order weighting (pipeline-speaker.js) ──────────────────────────

// #512 phase 1: was hand-tagged seed data — only the two personas the #164
// design doc named explicitly as needing room to run long, with the other
// 36+ members defaulting to 'medium' regardless of who they actually are.
// Replaced with a static, computed-once derivation from each member's own
// #187 voice exemplar (their authored library excerpt): average words per
// sentence, bucketed by quartile against the rest of the roster (bottom
// quartile 'terse', top quartile 'expansive', interquartile middle half
// left out of this map and so 'medium' by lengthTendencyOf's fallback
// below). See scripts/derive-length-tendency.js for the full method and
// rationale, and re-run it whenever the library changes — the object below
// is its output, not hand-edited.
//
// Notably, this reshuffles both of the old hand-picked entries: Crowley's
// own authored excerpt reads with short, declarative sentences (bottom
// quartile — 'terse'), and Yeats's lands in the interquartile middle
// ('medium'). That's the point of moving from a guess about reputation to
// the actual authored text, not a bug to chase.
//
// Deliberately still static config, not runtime-adaptive: deriving from a
// member's own *observed* turn lengths instead is a different, harder
// design (a self-reinforcing feedback loop, since observed turns are
// already shaped by the current weight, plus an unresolved interaction with
// #506's turn-scrub design, which assumes tuning.js values are static) —
// tracked separately as #542, not started.
// DERIVED-LENGTH-TENDENCY:START
const LENGTH_TENDENCY_OVERRIDES = {
  'al-hallaj': 'terse',
  arabi: 'terse',
  bohme: 'expansive',
  bruno: 'expansive',
  crowley: 'terse',
  'dion-fortune': 'expansive',
  eckhart: 'terse',
  gurdjieff: 'expansive',
  hildegard: 'expansive',
  khaldun: 'terse',
  maud: 'terse',
  'moina-mathers': 'expansive',
  paracelsus: 'terse',
  pauli: 'expansive',
  pixie: 'terse',
  randolph: 'expansive',
  'sun-ra': 'expansive',
  swedenborg: 'expansive',
  teresa: 'terse',
  'william-blake': 'terse',
};
// DERIVED-LENGTH-TENDENCY:END
// #539 note: this and LENGTH_TENDENCY_OVERRIDES above only weight *who* gets
// picked to speak — they don't touch how long a turn runs once that member
// is chosen. Not the lever for a floor-verbosity problem (see
// TYPICAL_TURN_WORDS below, in "Speaker prompt budgets") even though both
// live under the same "length" heading.
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

// #539: closes the gap #513's phase-3 re-measurement found — the un-nudged
// floor roughly doubled (88w -> 200w average) when the model default
// switched from claude-sonnet-4-6 to claude-sonnet-5 (#406), confirmed via
// a controlled on/off A/B against the model actually in production. The
// speaker prompt's only standing length guidance was permission-shaped
// ("there is no default length... if you have a lot to say, say it") with
// no concrete number for the model to react to in the common (uncrowded)
// case — CROWDED_WORDS_PER_VOICE above only supplies one once the round is
// already tight on room, which real sessions mostly aren't. Same finding as
// that constant's own rationale (#164: a vague "leave room for others"
// didn't move real turn length; naming the actual headcount did), applied
// to the case it doesn't cover.
//
// Set near phase 1's own un-nudged aggregate/median baseline (88w/43w,
// BREVITY-BASELINE-REPORT.md) — an anchor for "most turns," not a cap.
// SPEAKER_MAX_TOKENS below is the hard ceiling and is deliberately left
// alone by this change: the measured problem was the floor drifting up,
// not turns hitting the ceiling. LENGTH_WEIGHT/LENGTH_TENDENCY_OVERRIDES
// are a different lever entirely (who gets picked to speak, not how long a
// given turn runs once picked) and are left alone for the same reason.
//
// Unverified against a live re-measurement as of this change: this
// environment has no ANTHROPIC_API_KEY configured, so the controlled on/off
// A/B #513 phase 3 used to isolate the model-swap confound couldn't be
// re-run here. Before treating this number as calibrated rather than a
// reasoned first guess, re-run a live A/B (same shape as phase 3's table)
// against sessions generated after this change lands.
const TYPICAL_TURN_WORDS = 90;

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

// #513: the chosen phase-2 lever — a tuning-level nudge, not a weight and
// not a new beat type. lodge-context.md already *permits* a short, tangent,
// or citation-free turn (Drift, Convivialities, Silence), but nothing in the
// pipeline made that reading materially likelier: the citation instruction
// below (buildSpeakerSystemPrompt) fires unconditionally on every beat, and
// the phase-1 baseline — 88 words/turn average, docs/status/fragments/
// 513-brevity-baseline.md — reflects exactly that asymmetry. Chosen over the
// issue's other two candidate levers: widening LENGTH_TENDENCY_OVERRIDES
// would mean hand-tagging more of the 38-member roster the same week #512
// asks whether that hand-tagging should keep happening at all; a structural
// "banter beat" the director can propose is a bigger, higher-risk addition —
// a new beat type on the order of the splinter mechanism (#196/#458) — worth
// reaching for only if this lighter, reversible nudge proves insufficient
// once the baseline script is re-run against sessions that carry it. #512
// was still Backlog/unstarted when this shipped, so this doesn't build on
// its outcome; if #512 later derives real per-member tendencies, that's a
// second, independent lever layered on top, not a replacement for this one.
//
// Rate chosen to match SPLINTER_CHANCE's "rare but real" spirit: common
// enough across a passage's several beats to actually move the average,
// rare enough that most turns still read as themselves rather than
// performing brevity on cue because the prompt asked for it this time.
const TANGENT_NUDGE_CHANCE = 0.3;

// A few hundred words, per the issue — enough to carry a cadence, cheap
// enough to pay per speaker call (input tokens, uncached until #190). Sized
// against the real corpus and still holding as it grows: 30 of the 36
// authored entries pass through whole, and it only bites on the six long
// ones (Moina Mathers 584 words, Porete 434, Dion Fortune 406, Catherine
// Blake 358, Lévi 302, Hildegard 301). The whole section costs ~550 input
// tokens per beat when present.
const VOICE_EXEMPLAR_WORD_BUDGET = 300;

// #370 wave 2: a member's secondary (non-exemplar) authored entries — see
// library.js's loadSecondaryVoiceExemplars — are supplementary evidence, not
// the main register. Deliberately smaller than VOICE_EXEMPLAR_WORD_BUDGET so
// the primary passage stays the dominant signal and the secondary one reads
// as tone-tuning against it, not a second, competing exemplar. Applies per
// secondary entry — round 1 gives every covered member at most one, but the
// budget doesn't assume that stays true.
const SECONDARY_VOICE_EXEMPLAR_WORD_BUDGET = 120;

const RESIDUE_MAX_CHARS = 480; // same order of magnitude as disposition's 400, deliberately not larger — smaller and more conservative was the explicit mandate

// #449: the starter reaction taxonomy Rachel decided on 2026-08-28 — a
// smaller set than the 6-7 originally proposed (happy/thinking/listening/
// perplexed/impatient/angry), grows later if it proves out. 'none' is the
// expected default for an ordinary turn with no strong emotional read,
// same "most turns, nothing belongs here" spirit as residueNote below.
const REACTION_TAGS = ['happy', 'thinking', 'angry'];

// #355: always-on per-beat citation capture, piggybacked on the existing
// disposition call (#166's residueNote already established the pattern —
// a cheap optional field on a call that fires after every beat anyway,
// rather than a whole new call). Bounded to one turn's own text, so there's
// no analogue of the old whole-transcript truncation risk; these are a
// defensive ceiling on one beat's citation count/field sizes, not a cost
// lever — a turn citing more than a handful of works in ~a paragraph would
// be unusual on its own terms.
const MAX_CITATIONS_PER_BEAT = 6;
const CITATION_QUOTE_MAX_CHARS = 240; // ~25 words of transcript prose, generous over the "~10-25 word" ask
const CITATION_WORK_MAX_CHARS = 160;
const CITATION_NOTE_MAX_CHARS = 240;

// #356: a second, weaker tier piggybacked on the same call — a text, author,
// or tradition gestured at by name or unmistakable allusion without a
// quote (the "adjacent referenced texts" the bibliography appendix keeps
// separate from Works Cited). Same bounding rationale as the citations
// fields above; no verdict/quote here since nothing is being fact-checked,
// only recorded as invoked.
const MAX_INVOKED_PER_BEAT = 6;
const INVOKED_WORK_MAX_CHARS = 160;
const INVOKED_NOTE_MAX_CHARS = 240;

// ── User-supplied grounding (src/grounding.js) ─────────────────────────────

// #514: guardrail-by-default, session-scoped — a researcher's own uploaded
// bibliography only ever narrows/corrects a citation the model already made,
// never grows the material a member's turn is generated from. Caps below are
// this ticket's five cost levers made concrete; see grounding.js's header for
// how they fit together.

// A hard ceiling on total uploaded material per session, not per file — a
// Zotero export is realistically dozens of PDFs, and this is meant to bound
// worst-case memory/search cost (everything lives in-process, per #514's
// ephemeral-not-persisted decision) rather than accommodate any one
// document's full length. ~600K chars is generously a few hundred pages of
// plain text; well past that, per-claim keyword/TF-IDF search over it stops
// being "midline cost" and starts being the full-corpus RAG the issue
// explicitly ruled out.
const MAX_GROUNDING_CHARS_PER_SESSION = 600000;
const MAX_GROUNDING_SOURCES_PER_SESSION = 40; // a generous bibliography's worth of separate files, not an open-ended pile

// #514 cost lever 5 — size-gated retrieval. Below this many total characters
// of uploaded material, a claim is checked with plain keyword/containment
// search directly over chunked text (cheap, no precomputation); at or above
// it, a session-scoped chunk index is built once (with per-term document
// frequencies) and scored by TF-IDF instead, so retrieval quality doesn't
// collapse once a corpus is big enough that most chunks contain at least one
// query word. No embeddings provider is wired into this codebase (Anthropic
// doesn't offer one directly, and adding a separate provider/key is its own
// infrastructure decision) — TF-IDF over a session-scoped index is the
// concrete stand-in for the issue's "embedding-based retrieval" tier, same
// build-once/score-per-claim/discard-at-session-end shape.
const GROUNDING_KEYWORD_SEARCH_CHAR_THRESHOLD = 40000;
const GROUNDING_CHUNK_CHARS = 1200; // similar order of magnitude to a curated library excerpt (citations.js's groundAgainstLibraryText)
const GROUNDING_RETRIEVAL_TOP_K = 3; // passages shown per claim being checked — enough to give the model real context, not the whole corpus

// #514 cost lever 2 — triage before spending a call. A citation needs a real
// quote of some length to be checkable against retrieved text at all; below
// this, there's nothing substantive to search for (a bare name or a few
// words matches too much or too little to mean anything).
const GROUNDING_MIN_QUOTE_CHARS_FOR_CHECK = 20;

// #514 cost lever 3 — a hard cap on verification calls per session, counted
// as claims actually sent to the model for a judgment (a claim that comes up
// empty on retrieval is triaged out before this, and costs nothing). Same
// order of magnitude as MAX_WEB_ESCALATIONS (citations.js) — a bibliography
// upload is the user's own material, not a shared public resource, so the
// constraint here is model spend rather than rate-limiting someone else's
// API, but "keep it midline" argues for the same rough ceiling.
const MAX_GROUNDING_VERIFICATIONS_PER_SESSION = 30;
// Per invocation of the verify action, batched into one call (same "one
// batched call, not one each" discipline as groundAgainstLibraryText) —
// separate from the cumulative per-session cap above so one run can't spend
// the whole session's budget on a single burst of citations.
const MAX_GROUNDING_RESULTS_PER_VERIFY_CALL = 10;

// ── Splinter exchanges (pipeline-splinter.js) ──────────────────────────────

// #196: a splinter is the other resolution of the same interrupt-intent
// signal (#203's waitingOnMemberId) that INTERRUPT_INTENT_WEIGHT above
// already biases pickNextSpeaker toward — instead of raising the unspent
// business to the whole room, the two step aside for a private exchange run
// on its own context rather than the shared roundSoFar every other speaker
// call is conditioned on. See pipeline-splinter.js's header for the full
// design note.
const SPLINTER_EXCHANGE_BEATS = 2; // fixed length: "two members trade a barbed aside," per the issue, not an open thread
// #458: shared across both trigger sources (the reactive #203 signal and
// the director-initiated pairing) — one splinter budget per passage
// regardless of which one proposes it, not one each. Still a horizon
// mechanic proving itself against real sessions, not yet a structural
// feature of every passage.
const MAX_SPLINTERS_PER_PASSAGE = 1;

// The exception, not the default — most interrupt-intent picks still
// resolve as the existing #203 path (an ordinary front-of-room
// interruption). The speaker prompt's own "it's fine to let it pass"
// already licenses declining even a real interrupt; a splinter has to earn
// that same restraint rather than firing every time the signal is live.
const SPLINTER_CHANCE = 0.35;

// Needs headroom for both splinter beats *and* something left for the main
// thread to close on afterward — an aside that spent the entire remaining
// budget would end the passage mid-gesture, on a private exchange the room
// itself never heard. WORDS_PER_BEAT_ESTIMATE (above) times 3: two beats for
// the exchange, one beat's worth of slack for whatever the room does next.
const SPLINTER_MIN_BUDGET_WORDS = WORDS_PER_BEAT_ESTIMATE * 3;

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
  PASS_BUDGET_COST,
  PASS_TURN_CREDIT,
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
  TYPICAL_TURN_WORDS,
  SPEAKER_MAX_TOKENS,
  TANGENT_NUDGE_CHANCE,
  VOICE_EXEMPLAR_WORD_BUDGET,
  SECONDARY_VOICE_EXEMPLAR_WORD_BUDGET,
  RESIDUE_MAX_CHARS,
  REACTION_TAGS,
  MAX_CITATIONS_PER_BEAT,
  CITATION_QUOTE_MAX_CHARS,
  CITATION_WORK_MAX_CHARS,
  CITATION_NOTE_MAX_CHARS,
  MAX_INVOKED_PER_BEAT,
  INVOKED_WORK_MAX_CHARS,
  INVOKED_NOTE_MAX_CHARS,
  MAX_GROUNDING_CHARS_PER_SESSION,
  MAX_GROUNDING_SOURCES_PER_SESSION,
  GROUNDING_KEYWORD_SEARCH_CHAR_THRESHOLD,
  GROUNDING_CHUNK_CHARS,
  GROUNDING_RETRIEVAL_TOP_K,
  GROUNDING_MIN_QUOTE_CHARS_FOR_CHECK,
  MAX_GROUNDING_VERIFICATIONS_PER_SESSION,
  MAX_GROUNDING_RESULTS_PER_VERIFY_CALL,
  DEFAULT_POOL_SIZE,
  INTERJECT_SPEAKER_COUNT,
  ARC_STAGE_BOUNDARIES,
  SPLINTER_EXCHANGE_BEATS,
  MAX_SPLINTERS_PER_PASSAGE,
  SPLINTER_CHANCE,
  SPLINTER_MIN_BUDGET_WORDS,
};
