# PROJECT.md — Secret-Cabin-et

The living project doc. Answers what this is, why it exists, where it's heading, and what's still undecided. Update this when direction or milestones shift — not on every PR (that's what [STATUS.md](STATUS.md) is for).

---

## What this is

A local/private web app that convenes a salon of historical esotericists — see [MANIFEST.md](MANIFEST.md) for the current full roster — to discuss a document the user provides, across multiple rounds of in-character cross-talk. Sessions are saved, searchable, taggable, and exportable to Day One, Obsidian, or Ulysses.

## Why it exists

Two and a half purposes — the first two are both real *whys*; the third is a *how*, not a competing purpose:

1. **Research for *The Affected*, Rachel's novel-in-progress.** The novel deals with western esotericism, identity, secret societies, and why humans reach for the mystical and the profane — especially during periods of great personal upheaval — and how those impulses resurface in modern life under different names. Talking *to* the esotericists, rather than only reading their work, has made the research fun and replayable, which is what's kept her interest in the novel alive. That durability matters in its own right: a novel can span years, and that's a genuine hurdle most novels-in-progress don't survive.
2. **An MVP of a bigger idea: the playable archive.** This mirrors a proposal from Rachel's grad program — characters who guide, converse with, challenge, and befriend the researcher, so that working an archive has the same delight academic *life* already has (camaraderie, argument, surprise) but academic *tools* usually lack. Secret-Cabin-et is the proof-of-concept for a platform Rachel may eventually pursue further — as a grant application or as part of a PhD program application — so it's worth treating as something that could need to stand on its own as a portfolio artifact, not just a private tool.
3. **Rachel's own PM practice** — methodology, not purpose. She has decades of PM experience and is keeping those muscles active by running this project the way she'd run a real one: staged work, observability, explicit trade-off discussion. This is closer to "LARPing the old job" during a stretch of unemployment than to learning something new, and it shapes *how* work gets scoped and discussed here, not *what* gets built or why the project exists.

Because of (1) and (2), research/citation/export-adjacent features should be scoped to be directly reusable — as writing material for the novel, and as demonstrable substance for the platform pitch — not just in-app polish or gamification.

## Where it's heading

**North star:** a fully 3D, inhabited interactive experience — a "Second Life" or "The Sims" for the archive/library, not a chat window. The lodge members exist as embodied presences in a persistent room the researcher can actually walk into, not just a transcript to read. This is the ambitious, easy-to-let-quietly-die version of the vision, so it's stated here explicitly rather than left implicit — most real projects don't die from a bad decision, they die from the ambitious version never getting named as the target and just fading into whatever the current text-based tool already does.

The architectural frontier (previously tracked under the now-retired `tier-3` label — see the labeling note below) splits into three mostly-independent threads. The middle one is the direct path toward the north star:

| Thread | Status | Items |
|---|---|---|
| **Interactivity / agency** | 2 of 3 shipped | #31 player-as-member (done), #33 branching sessions (done), #32 investigation mode (parked — see below) |
| **Atmosphere / presence — the north-star thread** | defaults-inversion arc complete | #26 3D salon ✅, #27 portraits ✅, #28 avatar presence ✅, #184 stage-as-default-view ✅, #185 director-cast-with-regulars ✅ — next: #186 Continue/Preserve after-panel. #29 voice synth and #17 ambient audio deliberately iceboxed (2026-08-06): less important, buildable at any later point |
| **Research-grounding** | v2 complete | #36 citation verification ✅ (v1), #153 retrieval-grounded v2 ✅ — shipped in three parts (library grounding PR #171, provenance field PR #173, web-escalation PR #183; #111 closed as subsumed), #37 scholarly export ✅ (carries the provenance data), #30 archival image integration ✅ — ongoing: #35a hand-curated library growth, which now also feeds #187 (voice exemplars) |
| **Voices / interiority — opened by the 2026-08-06 review** | 3 of 4 shipped | #187 library excerpts as register exemplars ✅, #188 intra-session disposition state ✅, #203 interruption-as-intent scheduling ✅ (split back out from #188 as a fast-follow, shipped 2026-08-08) — next: #166 cross-session residue (implementation vehicle for whichever rung the #195 amnesia spike chooses) |

[#24 multi-user](https://github.com/msdixon/secret-cabinet/issues/24) is explicitly **orthogonal** to this frontier work — a large infra decision with its own cost/benefit case, not to be pulled in opportunistically just because it's adjacent. (It would matter a great deal *if* the platform-pitch path in purpose #2 above is ever pursued seriously — a shared room is part of what makes a playable archive a platform rather than a solo tool — but that's a future-scope note, not a reason to start it now.)

Full sequencing rationale lives in [issue #118](https://github.com/msdixon/secret-cabinet/issues/118) — treat it as the detail view under this doc's summary, not a competing source of truth.

**Idea provenance (2026-08-03):** the retrieval-grounded verification work (#153) was directly inspired by reading [MOiRA](https://github.com/tajhlande/moira), an open-source research agent that verifies claims against retrieved evidence with visible provenance rather than model self-recall. Noted here rather than left implicit, for a future bibliography of the project's own making — see #153 and the revised #35 for what actually transfers and what doesn't.

**Research grounding tool evaluation (2026-08-07):** surveyed four external tool families — Unpaywall (DOI-to-OA-PDF), [Imbad0202/academic-research-skills](https://github.com/Imbad0202/academic-research-skills) (paper-writing pipeline with claim-faithfulness auditing), mcpmarket research-content-access (retrieval workflow skill), and [lnilya/effortless-academic-skills](https://github.com/lnilya/effortless-academic-skills) (scholar workflow, Obsidian export). Decision: don't install any; mine the claim-faithfulness audit pattern from the first for scoping #141 (see that issue for the detailed design note). Retrieval APIs (Unpaywall for secondary scholarship; archive.org/IAPSOP for primary texts) are the right 35b components once hand-curation becomes the bottleneck — not before. OpenAlex's citation-graph data is the most project-novel idea: co-citation between members' corpora could seed the "relationships as assembled data layer" option in #197.

## What needs to happen to get there

**Against the north star specifically:** the atmosphere/presence thread was stalled behind two undecided, non-technical questions since 2026-07-13. Both were decided 2026-07-27:

- [#116](https://github.com/msdixon/secret-cabinet/issues/116) — **decided: phased AI-generation.** Batch 1 generates portraits for the full current roster against a checked-in baseline ([public/portraits/STYLE_GUIDE.md](public/portraits/STYLE_GUIDE.md)), reconvene to human-validate before generating anything further (including portraits for members added after batch 1). AI-generated placeholders for this stage, not commissioned/licensed art — disclosed in [MANIFEST.md](MANIFEST.md). Post-MVP path to move beyond AI generation is intentionally still open, tracked as a follow-up to revisit rather than decided now. Unblocks #27; #26/#28 (3D texture use) still wait on #117 for format requirements.
- [#117](https://github.com/msdixon/secret-cabinet/issues/117) — **decided: Babylon.js.** Taken deliberately over Three.js for its built-in physics/WebXR/character-animation tooling — a bet that pays off as the Atmosphere/presence thread continues into #28 and beyond, accepted against ~8-9x Three.js's bundle size since this is a local/personal tool, not a public product. A real architectural step-change for a codebase that's otherwise stayed framework-free; taken on purpose because the north star is being treated as a real target. Unblocked #26, which shipped through three phases (2026-07-28 → 2026-07-31); #28 avatar presence followed 2026-08-01.

**Separately, codebase health:**

- [#142](https://github.com/msdixon/secret-cabinet/issues/142) — **done.** All three extractions shipped (`witness.js` PR #169, `export.js` PR #172, `sessions.js` PR #182, merged 2026-08-06), each following the `window.X` + `configure(deps)` script-tag/IIFE convention with core state staying in `app.js` as sole owner. [#137](https://github.com/msdixon/secret-cabinet/issues/137) (frontend tests) is now unblocked — its scope also covers pipeline.js's pure scheduling functions. The 2026-08-06 review filed the sequel: [#193](https://github.com/msdixon/secret-cabinet/issues/193), extending the same discipline to the 1,645-line `server.js`, plus the rest of the infra-hardening batch ([#189](https://github.com/msdixon/secret-cabinet/issues/189) model-id constant, [#190](https://github.com/msdixon/secret-cabinet/issues/190) prompt caching, [#191](https://github.com/msdixon/secret-cabinet/issues/191) metrics surface, [#192](https://github.com/msdixon/secret-cabinet/issues/192) demo-survives-redeploy).

Current Todo-status backlog (no ranking implied — pick next tranche with Rachel). Refreshed 2026-08-08 after #184, #185, #187, #188, #137, and #90 shipped; the first item below advances the north star directly:

- [#186](https://github.com/msdixon/secret-cabinet/issues/186) Continue/Preserve after-panel — completes the defaults-inversion arc
- [#35](https://github.com/msdixon/secret-cabinet/issues/35) archival ingestion pipeline, 35a track (hand-curated growth continues; 35b bulk tooling deferred)
- [#141](https://github.com/msdixon/secret-cabinet/issues/141) evaluation harness (unscoped — what "conversation quality" means is the decision, not the code)

The full workflow/priority tracker — including Backlog-status items, bugs, and parked spikes — is the [GitHub Project board](https://github.com/msdixon/secret-cabinet/projects/2) ("Secret-Cabin-et Roadmap", project #2). This doc names the shape of the plan; the board is where status actually lives.

## Other open decisions

(#116, #117, and #142 are covered above.)

- **[#32](https://github.com/msdixon/secret-cabinet/issues/32) — investigation mode scoping.** Not blocked technically, blocked on a design conversation: who authors the hidden "truth state," what granularity clue-evaluation runs at, and how it reads a player's own turns (per #31's mechanism). **Deliberately parked (2026-07-27):** large scope, one complex mechanic, not required to unlock the playable-archive concept — stays on the back burner until well after #116/#117 land.
- **[#194](https://github.com/msdixon/secret-cabinet/issues/194) — do rounds still earn their place?** Day-0 constraint under active reevaluation (2026-08-06): rounds were adopted for performance, and #164's word-budget beat loop already dissolved the *inside* of a round — what remains is the boundary, and it's no longer clear what it's for ("it's not a boxing match — not intentionally"). Spike scopes three directions (continuous stream with diegetic lulls, coarse movements, or rounds kept as invisible internal pacing) and enumerates what currently hangs off the boundary (#73's selector, per-round instructions, #33 branch points, player-turn timing, stored session shape). Decision memo before any implementation.
- **[#195](https://github.com/msdixon/secret-cabinet/issues/195) — loosen or lose the amnesia.** The "you will not remember this meeting" conceit is day-0 lore whose original narrative purpose is no longer reconstructable, and it has doubled as the excuse for members having no memory at all (2026-08-06). Spike scopes an options ladder: (a) keep amnesia + subconscious *residue* — the fiction-preserving rung the lodge context already licenses, and Rachel's own framing on #166; (b) dream-memory (themes, not transcripts); (c) full continuity (which would make #12 and #165 in-fiction). Costs per rung: prompt growth, contradiction management, character-drift risk, and the lodge-context rewrite itself. #166 is the implementation vehicle for whichever rung is chosen.
- **[#197](https://github.com/msdixon/secret-cabinet/issues/197) — cap the roster, or restructure relationships as data?** Persona files hand-author O(n²) relationship webs, and at 33 members they silently thin (crowley.md knows no one from Wave 2/3 except Scholem). The undecided question: is the roster roughly capped (salons have walls — new members stay rare, deliberate, fully-authored events), or do relationships eventually become an assembled data layer the prompt builder composes per-evening (possibly seeded from #22's knowledge graph)? The character-addition workflow keeps making invites easier, which silently assumes the second answer — decide it deliberately.

## How this doc relates to everything else

- **[README.md](README.md)** — setup and usage for actually running the app. User-facing, not a planning doc. (Currently stale on roster size — flagged, not yet fixed.)
- **[MANIFEST.md](MANIFEST.md)** — standing member roster, kept current, same format as sibling repos for the meta-cabinet index.
- **[GitHub Project board #2](https://github.com/msdixon/secret-cabinet/projects/2)** — workflow and priority tracker. Houses bugs, milestone markers, and parked "spikes" (investigation issues like #118 that surface a decision or non-urgent finding mid-work, get filed, and wait in Backlog rather than blocking the thing in progress). **Review at a high level weekly** to catch stale or unprioritized issues — that review is a standing responsibility, not a one-off.
  **Labeling (revised 2026-08-05):** priority lives entirely in the **Status** field — `Icebox → Backlog → Todo → In Progress → Done`, arranged left-to-right by readiness to be worked, Eisenhower-style (urgency × importance), not by technical horizon. Issue labels carry a separate, orthogonal signal — `complexity: small | moderate | large | unscoped` — an effort/maturity estimate decoupled from both timing and priority; `unscoped` marks work that's important enough to keep but not yet estimable (needs a scoping pass/spike first), which is where most of the old long-horizon vision items landed. This replaced the old `tier-0`–`tier-3` labels, which had drifted stale by binding scope to fixed time windows ("months 3-9") in a project with no fixed start date — see STATUS.md, 2026-08-05.
- **[STATUS.md](STATUS.md)** — dated, one-line-per-entry log of what shipped or changed, appended to as it happens.
- **Claude's memory files** — narrative context: why a decision was made, what was tried and rejected, collaboration-style notes. Not authoritative for current state — if memory and this doc disagree, this doc (and the board) win.

---

*Last updated: 2026-08-08 (drift fix via /cabinet-next: #187, #188, #137, and #90 all shipped but still listed as active — trimmed from the Todo backlog, voices/interiority thread table updated to 2 of 3 shipped; see STATUS.md for implementation details).*
