# MODEL-REVIEW

### Quarterly checklist for revisiting the `MODEL` default in `server.js`

Established by [#216](https://github.com/msdixon/secret-cabinet/issues/216), 2026-08-08. `MODEL` (`server.js`) is a single constant read by every salon generation call — director selection, per-speaker turns, disposition updates, casting proposals, and citation verification (extraction, library-grounding, web-escalation). This file is the repeatable process that #216 was filed to build, because the one-time evaluation it also did isn't enough on its own — model generations turn over faster than anyone remembers to re-check a hardcoded default.

**Cadence:** at least quarterly, via the scheduled task `secret-cabinet-model-review` (mirrors `secret-cabinet-project-doc-checkin`'s pattern — see that task's config for the mechanism). The task files a `gh issue` reminder linking back to this file and the previous review's outcome, rather than running the review itself — the review needs judgment (reading transcripts, weighing a switch), so a scheduled task should prompt a session to do it, not substitute for one.

---

## What to compare

Run through all of these before concluding. Skipping a section because "it's probably fine" is how the default goes stale again.

1. **Cost per session.** Pull `generationMetrics` from a few recent real sessions (`sessions/*.json` — `.generationMetrics[]`, has `phase`, `usage.input_tokens`/`usage.output_tokens`, `skipped`). Multiply by current per-token pricing for the model under review. Compare against the current default at the same call volume.
   - **[#225](https://github.com/msdixon/secret-cabinet/issues/225) closed 2026-08-08:** `generationMetrics` now also carries `casting`, `citation-extraction`, and `citation-grounding` phases, so cost estimates cover the whole call surface — but only for sessions convened/verified after that date. Any session predating the fix still has director/speaker/disposition-only metrics; don't assume an older session's total is the full picture just because the field itself now exists.
   - **[#190](https://github.com/msdixon/secret-cabinet/issues/190) closed 2026-08-10:** director and speaker calls now carry `cache_control` breakpoints on the lodge-context prefix and the shared round history, and `usage` gained `cache_read_input_tokens`. A plain `input_tokens × price` multiplication now overstates real spend on sessions convened after this date — a cache read is billed far below the base input rate, a cache write somewhat above it. Pull `cache_read_input_tokens` alongside `input_tokens` per call and price them separately (check current per-token cache-read/cache-write rates for the model under review) rather than treating `input_tokens` alone as the full input cost.
2. **Voice-fidelity spot-check.** Run one real convene end-to-end (`MODEL=<candidate>` per `.env.example`, local dev). Read the transcript specifically for whether members still sound distinct from each other — this is the dimension automated metrics can't see, and #187's exemplar system exists because voice fidelity is the app's whole premise. Compare side-by-side against a transcript from the current default on the same or a similar prompt if you can.
3. **Citation-grounding accuracy** (#36/#153). Run `/api/sessions/:id/verify-citations` on a session with real citations and check a handful of verdicts by hand against the library excerpts they were graded against — does "verified" actually mean supported by the excerpt text, not just plausible-sounding?
4. **Tool-call reliability.** Check `generationMetrics` for `skipped: true` entries (director/speaker calls that exhausted the retry-then-fallback path) and any `disposition` entries with `waitingOnMemberId` that don't look right. The app already tolerates schema failures gracefully (`withOneRetry` + deterministic fallback in `pipeline.js`), so this is about frequency of degradation, not catastrophic failure.
5. **Context window headroom.** Sessions accumulate `conversationHistory` (capped to the last 6 entries per round in `/api/round` and `/api/interject`, but `transcriptText` grows unbounded and gets fed whole into citation verification). Check the candidate model's context window against the longest real session's `transcriptText` length.
6. **Breaking parameter changes.** Grep `pipeline.js` and `server.js` for `temperature|top_p|top_k|thinking|prefill` and re-check each against the target model's migration notes. As of 2026-08-08 this app sets none of them, which is what makes a swap close to a pure model-ID change — if that's changed by the time you're reading this, the check matters a lot more.
7. **Deprecation/sunset notices.** Check the current `MODEL` value against Anthropic's model catalog for a retirement date. A model heading toward retirement is a forcing function on its own, independent of everything else in this list.

## Decision rule

- **Switch** when the candidate model is a strict-or-better fit on cost *and* doesn't regress voice fidelity or citation-grounding accuracy on the spot-check, *and* any breaking-parameter changes have a concrete, cheap fix (a config flag, not a rewrite). A meaningful capability gain (e.g. materially better instruction-following on a documented weak spot) can justify switching even at slightly higher cost — this app's absolute spend per session is low enough (well under $1 even at Opus-tier pricing, per #216's evaluation) that cost alone should rarely be the blocking factor.
- **Stay** when the current model isn't near a deprecation date, the spot-checks don't show a clear improvement, or a candidate's breaking changes need real engineering work to absorb safely (not just a flag) and nothing forces the move yet.
- **Investigate further, don't guess** when the spot-check is ambiguous (e.g. voice sounds *different* but not clearly *worse*) — that's a signal to widen the sample, not to round to either conclusion.

Either outcome is a valid close for the review. "Reviewed, keeping X" is not a non-event.

## Where the outcome gets recorded

A STATUS.md entry, every time the review runs — a decision to stay is exactly as loggable as a decision to switch, per this file's own decision rule. Follow STATUS.md's standing convention: the entry ships inside the PR that makes the change (if switching) or inside a small PR that touches only this file's "last reviewed" note (if staying) — never as a bare comment with no code to anchor it. Grep STATUS.md for `MODEL-REVIEW` or the relevant issue number before adding an entry, same as any other STATUS.md addition, to avoid duplicates.

## Review log

| Date | Outcome | Notes |
|---|---|---|
| 2026-08-08 | Recommended switch to `claude-sonnet-5`, not yet applied | [#216](https://github.com/msdixon/secret-cabinet/issues/216) — one-time evaluation. Cost is trivial at any current-gen tier (~$0.38/session for director+speaker at 4.6 pricing, ~$0.64 at Opus, ~$0.13 at Haiku — not the deciding axis). No breaking params in use except the `thinking`-default change: `claude-sonnet-5` runs adaptive thinking by default when `thinking` is omitted, and several calls (director/casting `select_speakers`: 500 max_tokens, disposition update: 220) are too tight for that to share budget safely — needs `thinking: {type: "disabled"}` added explicitly before switching, or the budgets raised and re-verified. Voice-fidelity spot-check not completed live (environment couldn't make API calls this session) — do that before flipping the default. See the full write-up on the issue. |
| 2026-08-24 | Switched to `claude-sonnet-5` | [#406](https://github.com/msdixon/secret-cabinet/issues/406) — follow-through on the 2026-08-08 recommendation. Added `thinking: {type: "disabled"}` to both calls #216 flagged as too tight for adaptive thinking's default budget (`callDirector`'s `select_speakers`, still 500 max_tokens; `callDispositionUpdate`, now 1100 max_tokens — grown from the 220 the original review measured, since #354–#356's citation-capture fields widened the schema, but disabled explicitly regardless rather than relying on headroom that could shrink again). **Voice-fidelity spot-check still outstanding** — this pass had no `ANTHROPIC_API_KEY` available in its worktree to run a live convene; do that comparison before treating this switch as fully verified, and log the result here as a follow-up note. |
