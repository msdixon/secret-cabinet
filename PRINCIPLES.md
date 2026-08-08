# PRINCIPLES
### Design and code-architecture guardrails for Secret-Cabin-et

*A living decision-reference, in the same spirit as [AXES.md](AXES.md) — but AXES.md governs how individual members are written (voice, historical framing, casting), while this file governs how the app itself is designed and built (UI, features, architecture trade-offs). When a design or architecture decision has to be made — build this feature or not, which of two implementations, how far to push polish — check here first. If a new case reveals a principle was framed too narrowly, refine the entry itself; don't just resolve the one decision in front of you and let the principle quietly drift.*

Established 2026-08-08, at Rachel's request, stress-tested against [PROJECT.md](PROJECT.md)'s stated purposes and existing precedent (mainly AXES.md) before being locked in — not written speculatively from scratch.

---

## How to use this file

Five principles, below. They aren't ranked, but **two explicit precedence rules exist** (under Principle 3 and Principle 4) for the cases where principles pull against each other — check those first when a decision feels like a genuine conflict rather than reaching for a default.

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

## Principle 3 — Entertainment (in service of engagement, not instead of rigor)

**What it means:** The room should be fun, dramatically alive, and replayable — surprise, argument, camaraderie, the things Rachel named in PROJECT.md as what's actually kept her returning to the novel research. This is a real principle, not a guilty pleasure tolerated alongside the serious ones.

**Why it's a principle:** Per PROJECT.md purpose #1: talking *to* the esotericists rather than only reading them "made the research fun and replayable, which is what's kept her interest in the novel alive" — and a novel spanning years needs exactly that durability. Entertainment isn't decoration on top of the research purpose; it's load-bearing for the research purpose surviving at all.

**Precedence rule (the one real conflict with Principle 1):** When entertainment and verifiability/academic register pull in different directions — softening a controversial figure to make them more likable, inventing dramatic beats the historical record doesn't support, resolving a genuinely contested figure into a clean villain or a clean hero because a clean story is more satisfying — **verifiability wins.** This is not a new rule invented for this doc; it's [AXES.md](AXES.md) Axis 3's "accuracy is the design priority; comfort is not," carried up from character-writing into a general design rule. Drama has to be found *in* the accurate version of events, not manufactured by distorting them.

**Where this principle actually points, in practice:** toward investment in pacing, staging, presence, and interactivity (the Atmosphere/presence thread, #26–#28, #184–#186; #33 branching; #32 investigation mode, parked) — not toward loosening Principle 1 to make any individual member more crowd-pleasing.

---

## Principle 4 — Accessibility

**What it means:** Two genuinely different facets, kept distinct on purpose so one doesn't quietly stand in for the other:

- **(a) Approachability.** Esoteric and academic material shouldn't require the researcher to already have expertise to engage with it — this is close to the actual thesis of the playable-archive purpose (#2): the room should give a newcomer the delight and legibility that academic *life* has but academic *tools* usually don't.
- **(b) Technical/WCAG accessibility.** Contrast, keyboard navigation, screen-reader behavior, touch target size — standard a11y practice.

**Precedence / sequencing rule:** (a) is a live constraint now — every design decision can be checked against it today. (b) is currently low-stakes, because this is a solo local tool with one user (Rachel) who isn't relying on assistive technology for this app. **(b) becomes a gate, not a nice-to-have, the moment either the small-audience closed demo idea or the portfolio/grant path (purpose #2) actually moves forward** — it should be cleared *before* the app is shown to anyone outside this one-person context, not retrofitted after. Don't let (a) being satisfied stand in for (b) being done; they're independent checks.

**Existing precedent:** none yet in code — this is the one principle with the least implementation behind it so far, which is worth naming plainly rather than implying otherwise.

---

## Principle 5 — Sustainability / Maintainability

**What it means:** The codebase stays legible and extensible as it grows — modules stay small and separable, conventions stay consistent, technical debt gets named and tracked rather than silently accumulating.

**Why it's a principle:** This is what makes the other four sustainable *over time* rather than just in the current snapshot — a project this ambitious (north star: full 3D inhabited archive) fails more often from architecture that can't take the next step than from any single bad feature decision.

**Existing precedent this formalizes:** #142 and #193's module extractions (`witness.js`, `export.js`, `sessions.js`, nine `server.js` modules), the `window.X` + `configure(deps)` script-tag/IIFE convention used consistently across those extractions, and the "codebase health" thread PROJECT.md already tracks as separate from feature work.

**Portfolio modifier (same shape as Principle 1's):** a codebase shown as a portfolio artifact needs to hold up to a technical reviewer, not just run correctly — raises the bar on this principle exactly when purpose #2 is in play, same as Principle 1.

---

## Considered and rejected (noted so they aren't reintroduced without cause)

**"Portfolio-readiness" as its own, sixth principle.** Considered during the 2026-08-08 stress-test pass. Rejected: it isn't a standalone design constraint with its own trade-offs — it's a lens that raises the bar on Principles 1 and 5 specifically, whenever purpose #2 (the platform pitch / grant / PhD path) is actively being pursued rather than sitting in the background. Handled as an explicit modifier under those two principles instead of a separate entry. Revisit only if a case surfaces where portfolio-readiness genuinely pulls against one of the other four principles in a way the modifier framing can't express.

**"Privacy / local-first" as its own principle.** Considered, same pass. Rejected for now: not yet a live constraint while [#24](https://github.com/msdixon/secret-cabinet/issues/24) (multi-user) stays explicitly orthogonal and unpursued per PROJECT.md. Revisit if #24 or the small-audience closed-demo idea actually moves from consideration into scoped work — at that point this may deserve to become a real principle rather than an assumption.

---

*Next entry — or next refinement of an existing one — goes here. Add or sharpen principles as real design/architecture decisions reveal a gap, the same discipline AXES.md holds for character writing: not speculatively in advance of a decision that needs it.*
