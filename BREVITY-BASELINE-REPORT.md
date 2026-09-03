# Brevity/Tangent Baseline — #513 Phase 1

[#513](https://github.com/msdixon/secret-cabinet/issues/513) phase 1 — measurement only, not the lever. 11 local session(s) (2026-05-20 to 2026-08-05), 430 total beats, 324 spoken.

**Data-availability caveat:** every session measured here predates [#355](https://github.com/msdixon/secret-cabinet/issues/355) (always-on per-beat citation capture, shipped 2026-08-20) — none carry a `beats` array or usable `citationFlags`. Citation figures below come from a conservative text heuristic (`looksLikeCitation`), not the real per-beat model verdict — treat them as a lower bound, not an exact count. Turn length and passed-proportion are exact regardless. Re-run this script once sessions generated after 2026-08-20 accumulate — it will use the real structured data automatically wherever a round carries `beats`.

## Aggregate

- Average spoken-turn length: **88 words** (median 43)
- Turns carrying a citation: **6.5%** of spoken turns (21/324)
- Beats resolving as `passed`/pure-action: **24.7%** of all beats (106/430)

## By member

| Member | Length tendency | Beats | Passed % | Avg words (spoken) | Median words | Citation % |
|---|---|---|---|---|---|---|
| Teresa of Ávila | medium | 84 | 29.8% | 37 | 30 | 1.7% |
| Crowley | expansive | 56 | 28.6% | 146 | 47 | 15.0% |
| Yeats | expansive | 54 | 33.3% | 48 | 38 | 5.6% |
| Waite | medium | 52 | 23.1% | 46 | 32 | 7.5% |
| Maud Gonne | medium | 45 | 33.3% | 37 | 29 | 3.3% |
| Ibn Arabi | medium | 42 | 4.8% | 52 | 50 | 0.0% |
| Coleman-Smith | medium | 34 | 20.6% | 37 | 18 | 3.7% |
| John Dee | medium | 22 | 22.7% | 179 | 63 | 11.8% |
| Blavatsky | medium | 19 | 21.1% | 41 | 41 | 0.0% |
| Lévi | medium | 10 | 20.0% | 61 | 63 | 0.0% |
| Frances Yates | medium | 3 | 0.0% | 708 | 739 | 0.0% |
| Gershom Scholem | medium | 3 | 0.0% | 749 | 793 | 0.0% |
| Moina Mathers | medium | 3 | 0.0% | 662 | 601 | 66.7% |
| Hildegard of Bingen | medium | 1 | 0.0% | 419 | 419 | 100.0% |
| William Blake | medium | 1 | 0.0% | 564 | 564 | 100.0% |
| Sun Ra | medium | 1 | 0.0% | 1123 | 1123 | 100.0% |

---

_Repeatable — run `node scripts/measure-brevity-baseline.js` again once more sessions accumulate, especially post-#355 ones with real per-beat citation data. This script does not modify `tuning.js` or any pipeline behavior; picking a lever (director-prompt nudge, widening `LENGTH_TENDENCY_OVERRIDES`, a structural banter beat) is deferred to a follow-up per the issue._

---

## Phase 3 — real-session re-measurement (2026-09-03)

Phase 2 shipped `TANGENT_NUDGE_CHANCE` (PR #530) with its own live A/B on individual beats (269→17, 247→31 words). This phase asks the question phase 2 left open: does that per-beat effect actually move a full, real live session?

**3 new local sessions, 85 beats (all post-#355, real per-beat citation flags — no text-heuristic caveat).** Ran against current `main` with the nudge live: **146 words/turn average**, up from phase 1's 88-word baseline — the opposite of what a working nudge should do at face value.

**Confound found before concluding the nudge is broken:** `server.js`'s default model changed from `claude-sonnet-4-6` to `claude-sonnet-5` on 2026-08-24 ([#406](https://github.com/msdixon/secret-cabinet/issues/406)) — after every phase-1 baseline session was recorded (last: 2026-08-05), and just before PR #530 merged (2026-09-02). Phase 1's 88-word number and today's 146-word number are not measuring the same model.

**Controlled nudge-on/off A/B against the current production model**, mirroring PR #530's own methodology (identical context, `tangentNudge: true` vs. `false`, same member) but with 3 trials per condition instead of 1, to separate a real effect from single-sample noise:

| Case | OFF avg (3 trials) | ON avg (3 trials) | Δ |
|---|---|---|---|
| Crowley — vault/Golden Dawn dispute | 137w | 69w | −49% |
| Yeats — automatic writing / *A Vision* | 261w | 85w | −68% |
| Teresa — interior castle / obedience | 202w | 109w | −46% |
| **Grand average** | **200w** | **88w** | **−56%** |

Two things fall out of this table:

1. **The nudge still works, undiminished, on the current model.** −56% average is in the same direction and same order of magnitude as PR #530's own single-shot numbers. The lever isn't the problem.
2. **The un-nudged floor roughly doubled.** OFF averages 200 words here vs. phase 1's 88-word *aggregate* (which was effectively an all-off measurement — the nudge didn't exist yet). That's not a citation/tangent regression; it's `claude-sonnet-5` running more verbose by default than `claude-sonnet-4-6` did, independent of anything #513 touches. (Note `tuning.js`'s own comment on `SPEAKER_MAX_TOKENS`, written before the switch: "the model's baseline verbosity for this salon's philosophical-debate register runs long across the board... expect this to need more tuning.")
3. Worth flagging: the ON average here (88w) lands almost exactly on phase 1's original 88-word target — small sample (n=9), so treat the precision as coincidental, not proof, but directionally the nudge is pulling nudged beats back down to roughly where the room used to sit before either the nudge or the model switch existed.

**Reading the 146-word aggregate against this:** at `TANGENT_NUDGE_CHANCE = 0.3`, a session mixing ~70% off-beats (~200w) and ~30% on-beats (~88w) predicts an aggregate around 165w — close to the measured 146w given the small sample and topic variance. The lever is doing real, measured work against a floor that rose for reasons outside #513's scope.

**Conclusion:** `TANGENT_NUDGE_CHANCE` is not under-tuned — it cuts turn length by roughly half whenever it fires, on the model actually in production today, matching phase 2's original validation. Raising the rate further would be tuning against the wrong variable: the residual essayism the aggregate still shows is downstream of #406's model swap raising the un-nudged floor for *every* turn, nudged or not, not of the coin-flip rate being too low. Closing #513 on this record rather than raising the rate on unmeasured guesswork; the model-verbosity question gets its own follow-up ([#539](https://github.com/msdixon/secret-cabinet/issues/539)) since it's a different variable with a different fix (`SPEAKER_MAX_TOKENS`, length tendencies) than anything #513 was ever scoped to touch.