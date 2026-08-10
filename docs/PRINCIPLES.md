# PRINCIPLES
### Design and code-architecture guardrails for Secret-Cabin-et

*A living decision-reference, in the same spirit as [AXES.md](AXES.md) — but AXES.md governs how individual members are written (voice, historical framing, casting), while this file governs how the app itself is designed and built (UI, features, architecture trade-offs). When a design or architecture decision has to be made — build this feature or not, which of two implementations, how far to push polish — check here first. If a new case reveals a principle was framed too narrowly, refine the entry itself; don't just resolve the one decision in front of you and let the principle quietly drift.*

Established 2026-08-08, at Rachel's request, stress-tested against [PROJECT.md](../PROJECT.md)'s stated purposes and existing precedent (mainly AXES.md) before being locked in — not written speculatively from scratch.

---

## How to use this file

Five principles, below — plus one explicit interaction to understand before treating any of the first three as standalone: **Voice, Verifiability, and Entertainment (Principles 1–3) form a deliberate, productive triangle, not a hierarchy** — see the section right after Principle 3. Principle 4 (Accessibility) is unconditional, not gated on anything. One further principle, Security, is tracked but deliberately not yet promoted to full weight — see the closing section.

This is written-principles-only, for now. It does not yet include the code-level "design system" layer (tokens, component conventions) or a redesign — those are deliberately separate future work ([#236](https://github.com/msdixon/secret-cabinet/issues/236)), because Rachel isn't sold on the current UI and wants the principles settled before scaffolding is built on top of them.

**This file is meant to change.** Cadence: reviewed opportunistically any time a principle gets invoked in an actual decision and doesn't quite fit; formally revisited at each `/cabinet-review` strategic pass while the project's architecture is still moving; expected to need that formal revisit less often as the project matures and the shape of the app stabilizes. No standalone calendar cadence of its own — it rides on `/cabinet-review` rather than inventing a new schedule to track.

---

## Principle 1 — Verifiability & Academic Register

**What it means:** Two facets of one principle, not two principles. (a) *Verifiability* — claims the app makes or lets members make should be sourced and checkable, not model self-recall presented as fact. (b) *Academic register* — the app's default tone and depth aim at serious scholarship, not trivia-night esotericism.

**Why it's a principle, not just a feature:** Directly serves both real purposes in PROJECT.md — research material for *The Affected* has to be trustworthy enough to actually cite, and the playable-archive pitch (purpose #2) only works as a portfolio artifact if it demonstrates real rigor, not just a fun chat toy wearing academic clothing.

**Existing precedent this formalizes:** #153 retrieval-grounded verification (provenance over self-recall), #37 scholarly export, #36 citation verification, and [AXES.md](AXES.md) Axis 3 (historical accuracy over authorial gloss for controversial figures) — that axis is this principle applied to one specific case (character writing); this principle is the general form.

**Portfolio modifier:** When purpose #2 (the platform pitch / grant / PhD path) is actively in play, the bar on this principle goes up — a demo shown to an academic audience needs to survive real scrutiny, not just read well casually.

---

## Principle 2 — Voice

**What it means:** Each member's register stays distinct and doesn't drift toward a shared, model-default sameness — the failure mode is slow and easy to miss precisely because no single session shows it.

**Why it's a principle:** This is most of what makes the room worth talking to rather than reading a summary — replayability (purpose #1) depends on each member sounding like themselves, not like the same assistant in different costumes.

**Existing precedent this formalizes:** [AXES.md](AXES.md) Axes 1 and 4, #187 (library excerpts as register exemplars), #188 (intra-session disposition), #166 (cross-session residue, deliberately capped smaller than disposition and never synthesized/genericized — see Axis 4). Injection order in `buildSpeakerSystemPrompt` (character file → voice exemplar → residue → disposition) is itself an expression of this principle: the exemplar anchors sound before anything else can color it.

**No change from status quo** — this principle already has the deepest existing enforcement of the five; nothing here should be read as loosening it.

---

## Principle 3 — Entertainment

**What it means:** The room should be fun, dramatically alive, and replayable — surprise, argument, camaraderie, the things Rachel named in PROJECT.md as what's actually kept her returning to the novel research. This is a real principle, not a guilty pleasure tolerated alongside the serious ones.

**Why it's a principle:** Per PROJECT.md purpose #1: talking *to* the esotericists rather than only reading them "made the research fun and replayable, which is what's kept her interest in the novel alive" — and a novel spanning years needs exactly that durability. Entertainment isn't decoration on top of the research purpose; it's load-bearing for the research purpose surviving at all.

**Its relationship to Verifiability is not a precedence rule.** An earlier draft of this principle resolved Entertainment-vs-Verifiability conflicts with a fixed hierarchy — verifiability always wins. Rachel corrected that (2026-08-08): the tension between them is deliberate and generative, likely the actual source of the project's appeal, not a conflict to adjudicate away. See the section immediately below, "Voice, Verifiability, Entertainment — the casting triangle."

**Where this principle actually points, in practice:** toward investment in pacing, staging, presence, and interactivity (the Atmosphere/presence thread, #26–#28, #184–#186; #33 branching; #32 investigation mode, parked), and toward casting decisions that seek out — not avoid — figures where the tension with Verifiability and Voice is real and productive.

---

## Voice, Verifiability, Entertainment — the casting triangle

**Why this gets its own section instead of living inside Principle 3:** Per Rachel (2026-08-08), the tension between Entertainment and Verifiability isn't a problem for either principle to win — it's deliberate, and it's plausibly where the project's actual frisson comes from. Finding the right lodge members, in her words, "can feel like casting reality show members" — a figure like Crowley, Sun Ra, or Blake gives endless entertainment value, while having enough documented material to make their voice sound authentic and enough that's verifiable to cite. Voice, Verifiability, and Entertainment together may be the actual mechanic that makes the room work: "the vibes of a perfect Real Housewives season, but with more useful content."

**What this changes in practice:**
- Casting and scoping decisions (which historical figure to add, how much material to gather before writing them) should actively look for members where all three land at once — inherently dramatic, well-documented enough for real voice fidelity, well-sourced enough to verify — rather than defaulting to whichever is easiest to satisfy alone. A figure who's fascinating but too thin in the record to voice or verify well is a weaker candidate than the drama alone suggests; so is a figure who's easy to verify but has no dramatic charge.
- Within a single member's portrayal, once cast, [AXES.md](AXES.md) Axis 3's rule still holds and hasn't changed: the drama has to be found *in* the accurate record, not manufactured by softening a figure to be more likable or inventing beats the record doesn't support. That's not in tension with the triangle framing above — it's what keeps the tension productive instead of collapsing into either flattering fiction or dry accuracy with no charge.
- Worth reading as a filter on the roster overall, not just a rule for any one member: if casting is trending toward figures who are easy but flat, that's a sign this triangle isn't being used as a design tool — worth surfacing at a `/cabinet-review` pass rather than waiting for it to become obvious.

---

## Principle 4 — Accessibility

**What it means:** Technical accessibility — contrast, keyboard navigation, screen-reader behavior, touch target size, standard WCAG practice. This principle is specifically about the app being built accessibly; it is not a claim about how approachable the esoteric subject matter is to a non-expert (a different question this doc isn't taking a position on — see the revision note below).

**Why it's a principle from day one, not gated on audience size:** Baked in now, deliberately, even though the app currently has exactly one user. Two reasons, both Rachel's own, not inferred: it's part of her professional values and her academic practice, full stop, independent of whether this specific tool "needs" it yet — and building accessibly from the start produces better design generally, not just a future-proofing hedge for a hypothetical multi-user audience.

**Revision note (2026-08-08):** An earlier draft split this principle into two facets — this one, plus a second "approachability" facet (esoteric material shouldn't require existing expertise), with technical accessibility gated behind a future multi-user or demo step. Rachel corrected both: approachability wasn't a principle she'd actually proposed, and gating technical accessibility on audience size was an unconfirmed assumption about her needs, not something she'd said. The facet and the gate are both removed; recorded here so neither gets silently reintroduced.

**Existing precedent:** none yet in code — the one principle with the least implementation behind it so far, worth naming plainly rather than implying otherwise. Starts now, with intent, rather than waiting for an audit to reveal gaps.

---

## Principle 5 — Sustainability / Maintainability

**What it means:** The codebase stays legible and extensible as it grows — modules stay small and separable, conventions stay consistent, technical debt gets named and tracked rather than silently accumulating.

**Why it's a principle:** This is what makes the other four sustainable *over time* rather than just in the current snapshot — a project this ambitious (north star: full 3D inhabited archive) fails more often from architecture that can't take the next step than from any single bad feature decision.

**Existing precedent this formalizes:** #142 and #193's module extractions (`witness.js`, `export.js`, `sessions.js`, nine `server.js` modules), the `window.X` + `configure(deps)` script-tag/IIFE convention used consistently across those extractions, and the "codebase health" thread PROJECT.md already tracks as separate from feature work.

**Portfolio modifier (same shape as Principle 1's):** a codebase shown as a portfolio artifact needs to hold up to a technical reviewer, not just run correctly — raises the bar on this principle exactly when purpose #2 is in play, same as Principle 1.

---

## Considered and rejected (noted so they aren't reintroduced without cause)

**"Portfolio-readiness" as its own, sixth principle.** Considered during the 2026-08-08 stress-test pass. Rejected: it isn't a standalone design constraint with its own trade-offs — it's a lens that raises the bar on Principles 1 and 5 specifically, whenever purpose #2 (the platform pitch / grant / PhD path) is actively being pursued rather than sitting in the background. Handled as an explicit modifier under those two principles instead of a separate entry. Revisit only if a case surfaces where portfolio-readiness genuinely pulls against one of the other four principles in a way the modifier framing can't express.

---

## Considered, deliberately not yet promoted — Security

**Not the same as "Privacy / local-first"** (an earlier draft's framing, rejected by Rachel 2026-08-08 in favor of this). Security is the right frame here, not privacy-by-default: the concern isn't keeping the app private, it's the app being built securely as its surface area grows.

**Why it's real but correctly weighted low right now:** today's surface area is a solo local tool with one user — most classic web-app security concerns (auth boundaries between users, data isolation across accounts, abuse surfaces) don't yet exist to defend against, so treating this as a full, actively-checked principle today would be solving a problem that isn't there yet.

**What activates it:** the moment the small-audience closed demo idea, or [#24](https://github.com/msdixon/secret-cabinet/issues/24) multi-user, actually moves from consideration into scoped work. At that point this should become a full principle with its own entry here, reviewed before the app is shown to anyone outside this one-person context — not retrofitted after. The passphrase-gated `auth.js` module (extracted under #193) is the one piece of real surface that already exists and is the natural first thing to review when that trigger fires.

---

*Next entry — or next refinement of an existing one — goes here. Add or sharpen principles as real design/architecture decisions reveal a gap, the same discipline AXES.md holds for character writing: not speculatively in advance of a decision that needs it.*
