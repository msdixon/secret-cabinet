# AXES
### Interpretive lenses tracked across the Secret-Cabin-et roster

*A writer's reference, not part of the runtime prompt. Not loaded into `lodge-context.md` or any character's system prompt — this file is consulted by whoever is building or revisiting a member, human or Claude Code, not by the live app. Keeping it separate protects the per-round token cost the room already worked to reduce (~85% per round, per the original roadmap).*

---

## How to use this file

When a new member's situation echoes an existing pairing or tension already worked out elsewhere in the roster, check here first. If the new case reveals the existing framing was too narrow — as happened below — refine the entry itself. Don't just patch the one character file in front of you and let the lens quietly diverge across the rest of the roster. An axis is only useful if every member built on it agrees with each other.

---

## Axis 1 — Credit, dependency, and the right ruler for a partnership

**Discovered:** 2026-07-07, writing Catherine Blake's file, in direct response to a correction: an initial draft ranked her below Coleman-Smith and Harris on an "independence" axis, and the ranking didn't survive scrutiny.

**The wrong version (do not reintroduce):** Ranking under-credited creative partners by whether they arrived at the collaboration already independently trained or credentialed. This treats prior professional standing as the measure of a partnership's legitimacy, and makes any partnership built through teaching or dependency look lesser by definition — regardless of what the partnership actually became.

**The refined version:**
- Independence-in-craft (arriving already trained) and independence-in-reception (being seen and credited on your own name) are different things. Coleman-Smith and Harris had the first. None of the three women currently in this thread had much of the second — Waite's courtesy toward Pamela is, by her own file's account, "the shape of an apology that will never arrive in its actual form"; the Thoth deck is still called Crowley's more often than Harris's.
- A more honest measure: what did the collaboration build, for both people, across the whole shape of their time together — one commission, or a whole life? Mutual flourishing over time is a different ruler than credentials-at-the-start, and it can produce a different, even reversed, ranking.
- **Worked example:** `catherine-blake.md` ("A DIFFERENT RULER" section) and `frieda-harris.md` (her Catherine entry, where she genuinely reconsiders rather than simply restating the old comparison). Coleman-Smith and Waite made one deck. Harris and Crowley had five years. Catherine and William had forty-five, a shared home, and a mythology she appears inside of. The axis is explicit about not resolving into a tidy hierarchy — it's a different ruler, not a claim that one ruler always wins.
- **Deliberately untouched:** `coleman-smith.md` was not revised to reflect this axis. It's one of the three original canonical files, not something to silently rewrite, and her own file already carries a mature, non-naive account of her own erasure. Revisit only if a future session shows it's actually needed — per Rachel, 2026-07-07: "we'll see how a few runs of the room go."

---

## Axis 2 — Scholar as a kind of member, not a mechanism (rejected axis, noted so it isn't reintroduced)

**Considered:** 2026-07-07, while building Warburg, Corbin, and Adorno.

**What was proposed and dropped:** A formal "Scholar's Chair" casting category, split into sympathetic and suspicious registers, intended to structure how scholarly members interrogate the room.

**Why it was dropped, in Rachel's own reasoning:** Scholars are simply a new *kind* of member — an academic/critical formation rather than an initiate/practitioner one — cast and written exactly like everyone else. No special tag, no forced antagonist or interrogator function. The room's existing dynamics and each scholar's own real historical position already do this work; a mechanism would have been solving a problem the room didn't have. The atemporal citation rule in `lodge-context.md` is a room-wide permission, not a scholar-exclusive unlock.

**Standing implication:** Do not add a `chair` field, register split, or similar casting mechanism for scholarly members. If a future member is a scholar, write them the way Warburg, Corbin, and Adorno were written — full relationship web, real citations, no tag.

---

## Axis 3 — Historical accuracy over authorial gloss, for controversial figures

**Established:** 2026-07-07, after Rachel read primary Crowley material directly and identified that `crowley.md` omitted well-documented complicating facts — antisemitism, colonial racism — that the historical record does not allow to be quietly absent.

**The principle:** For any historical figure whose documented life includes genuinely controversial material — prejudice, cruelty, violence, complicity — the character file should represent that material accurately and proportionately, without either inflating it into caricature or omitting it for the room's comfort. Per Rachel: "An inaccurate or partial representation could be hurtful to the kind of research I'm doing, which should be holistic and vast." Accuracy is the design priority; comfort is not.

**How to do this responsibly:**
- Verify via real biographical/scholarly sources before writing — don't guess at the shape or severity of a historical figure's documented views. Standard critical biographies (not advocacy pieces on either side) are the best anchor when available.
- Represent contested claims as contested, not as settled fact in either direction. If two serious sources disagree, say so in the sourcing rather than picking a winner silently.
- Show the actual complexity the record shows, rather than resolving it into a clean verdict. Most controversial historical figures are neither uniformly villainous nor uniformly redeemable — flattening in either direction is its own inaccuracy, and the "villain" flattening is exactly as dishonest as the gloss this axis exists to correct.
- These are system-prompt / character-description documents, not dialogue transcripts. Accurately noting that a figure held and expressed a prejudice is different from writing extended bigoted material as sample dialogue. Proportion the material to what actually mattered in the person's documented history — the phrase "persistent minor element" (Sutin, on Crowley) is a model for how to calibrate weight, not just a specific finding about one person.
- Applies going forward to any new or revised member whose documented history includes this kind of material. Not a one-time Crowley fix.

**Worked example:** `crowley.md`, "THE PERSISTENT MINOR ELEMENT" section. Also applied to `jung.md`, "THE SOCIETY, RENAMED" section (Wave 3) — his 1933 acceptance of the presidency of the German General Medical Society for Psychotherapy under Nazi-era Germany, held as genuine unresolved controversy rather than a clean verdict. Applied proactively this time, without a specific request about Jung — the intended test of whether the policy generalizes rather than requiring a fresh correction each time.

---

## Axis 4 — Cross-session residue must never become a second character file

**Discovered:** 2026-08-08, scoping #166 (cross-session residue, rung (a) of #195's amnesia ladder) — flagged in #195's own cost list as a risk this axis file "may need an axis for" before the mechanism shipped.

**The risk:** #166 gives every member a small, persistent store of stances and tendencies that accrue across sessions and get read back into their speaker prompt on every future convening. That store is generated by the model itself, turn after turn, unsupervised — the exact conditions under which a system tends to regress toward the mean. Left unchecked, residue could quietly become a second, model-authored character file that competes with the real one: generic, drifting toward whatever register the model defaults to, and — across enough members and enough sessions — pulling the roster's genuinely distinct voices toward a shared sameness. That failure would be slow and cumulative, the hardest kind to notice in review.

**The principle:** Residue is evidence of an *instance*, not a restatement of a *trait*. "Grew certain Crowley's charm is a weapon, not a warmth" is residue — concrete, tied to what actually happened, addable to or contradicted by a later evening. "Is skeptical of charismatic men" is a personality trait masquerading as residue, and belongs in the character file (if it belongs anywhere) — not here, and never written by a per-turn model call with no editorial review.

**How this is enforced structurally, not just by instruction:**
- A hard character cap (`RESIDUE_MAX_CHARS` in `pipeline.js`) that's deliberately *not* larger than #188's intra-session disposition cap, even though residue spans many sessions and disposition spans one evening — smaller and more conservative was the explicit mandate, not a default.
- Oldest fragments erode off the cap as new ones accrue (`mergeResidue`) — there is no synthesis step that could smooth accumulated fragments into a cleaner, more generic-sounding summary. What's kept is always literal instance-level fragments, never a model's abstraction over them.
- The tool schema's `residueNote` field is optional and explicitly "rare" — "most turns, nothing belongs here" — so silence is the default outcome, not a fragment manufactured to fill space.
- Injection order in `buildSpeakerSystemPrompt`: character file, then #187's voice exemplar (evidence of the fixed register), then residue, then #188's disposition. Residue is read *after* the exemplar has already anchored how the member sounds — it colors, it does not define.

**Standing implication:** If a future session considers letting residue grow larger, get synthesized/rewritten by a periodic summarization call, or move earlier in the prompt stack (ahead of the exemplar or character file), that is exactly the direction this axis warns against — revisit only with a real case for why voice fidelity isn't at risk, the same bar Axis 1 sets for revising `coleman-smith.md`.

---

*Next entry goes here. Add axes as they're discovered through the actual work of writing a member, not speculatively in advance of one.*
