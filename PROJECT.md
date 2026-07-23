# PROJECT.md — Secret-Cabin-et

The living project doc. Answers what this is, why it exists, where it's heading, and what's still undecided. Update this when direction or milestones shift — not on every PR (that's what [STATUS.md](STATUS.md) is for).

---

## What this is

A local/private web app that convenes a salon of historical esotericists — currently a 22-member roster (see [MANIFEST.md](MANIFEST.md)) — to discuss a document the user provides, across multiple rounds of in-character cross-talk. Sessions are saved, searchable, taggable, and exportable to Day One, Obsidian, or Ulysses.

## Why it exists

Two and a half purposes — the first two are both real *whys*; the third is a *how*, not a competing purpose:

1. **Research for *The Affected*, Rachel's novel-in-progress.** The novel deals with western esotericism, identity, secret societies, and why humans reach for the mystical and the profane — especially during periods of great personal upheaval — and how those impulses resurface in modern life under different names. Talking *to* the esotericists, rather than only reading their work, has made the research fun and replayable, which is what's kept her interest in the novel alive. That durability matters in its own right: a novel can span years, and that's a genuine hurdle most novels-in-progress don't survive.
2. **An MVP of a bigger idea: the playable archive.** This mirrors a proposal from Rachel's grad program — characters who guide, converse with, challenge, and befriend the researcher, so that working an archive has the same delight academic *life* already has (camaraderie, argument, surprise) but academic *tools* usually lack. Secret-Cabin-et is the proof-of-concept for a platform Rachel may eventually pursue further — as a grant application or as part of a PhD program application — so it's worth treating as something that could need to stand on its own as a portfolio artifact, not just a private tool.
3. **Rachel's own PM practice** — methodology, not purpose. She has decades of PM experience and is keeping those muscles active by running this project the way she'd run a real one: staged work, observability, explicit trade-off discussion. This is closer to "LARPing the old job" during a stretch of unemployment than to learning something new, and it shapes *how* work gets scoped and discussed here, not *what* gets built or why the project exists.

Because of (1) and (2), research/citation/export-adjacent features should be scoped to be directly reusable — as writing material for the novel, and as demonstrable substance for the platform pitch — not just in-app polish or gamification.

## Where it's heading

**North star:** a fully 3D, inhabited interactive experience — a "Second Life" or "The Sims" for the archive/library, not a chat window. The lodge members exist as embodied presences in a persistent room the researcher can actually walk into, not just a transcript to read. This is the ambitious, easy-to-let-quietly-die version of the vision, so it's stated here explicitly rather than left implicit — most real projects don't die from a bad decision, they die from the ambitious version never getting named as the target and just fading into whatever the current text-based tool already does.

Tier 3 (the current architectural frontier) splits into three mostly-independent threads. The middle one is the direct path toward the north star:

| Thread | Status | Items |
|---|---|---|
| **Interactivity / agency** | 2 of 3 shipped | #31 player-as-member (done), #33 branching sessions (done), #32 investigation mode (blocked — see below) |
| **Atmosphere / presence — the north-star thread** | blocked on 2 decisions | #26 3D salon, #27 portraits, #28 avatar presence, #29 voice synth, #17 ambient audio |
| **Research-grounding** | actively unblocking | #36 citation verification (done), #37 scholarly export (unblocked by #36), #30 archival image integration (unblocked, easier than scoped) |

[#24 multi-user](https://github.com/msdixon/secret-cabinet/issues/24) is explicitly **orthogonal** to Tier 3 — a large infra decision with its own cost/benefit case, not to be pulled in opportunistically just because it's adjacent. (It would matter a great deal *if* the platform-pitch path in purpose #2 above is ever pursued seriously — a shared room is part of what makes a playable archive a platform rather than a solo tool — but that's a future-scope note, not a reason to start it now.)

Full sequencing rationale lives in [issue #118](https://github.com/msdixon/secret-cabinet/issues/118) — treat it as the detail view under this doc's summary, not a competing source of truth.

## What needs to happen to get there

**Against the north star specifically:** the atmosphere/presence thread is currently stalled behind two undecided, non-technical questions — not a lack of scheduling, an actual absence of a decision:

- [#116](https://github.com/msdixon/secret-cabinet/issues/116) — how portrait art actually gets produced (commission, generate, license?), which blocks #27 and, downstream, #26 and #28.
- [#117](https://github.com/msdixon/secret-cabinet/issues/117) — which 3D rendering approach, which blocks #26 outright.

Neither has a default answer, and both have been sitting in Backlog since 2026-07-13. If the north star is meant to be real rather than aspirational, these two need an actual decision session at some point — not more Tier-3 polish shipped around them. That's the fork in the road: keep shipping Todo-list items indefinitely (real, useful, but adjacent to the north star), or deliberately spend a session resolving #116/#117 to unstick the thread that actually leads there.

Current Todo-status backlog (no ranking implied — pick next tranche with Rachel; note none of these advance the north star directly):

- [#35](https://github.com/msdixon/secret-cabinet/issues/35) archival ingestion pipeline
- [#37](https://github.com/msdixon/secret-cabinet/issues/37) scholarly export
- [#69](https://github.com/msdixon/secret-cabinet/issues/69) Ulysses subfolder targeting
- [#74](https://github.com/msdixon/secret-cabinet/issues/74) consolidate post-session actions
- [#80](https://github.com/msdixon/secret-cabinet/issues/80) auto-assign glyph for generated members
- [#82](https://github.com/msdixon/secret-cabinet/issues/82) library search/filter UI
- [#90](https://github.com/msdixon/secret-cabinet/issues/90) Witness go-back navigation

The full workflow/priority tracker — including Backlog-status items, bugs, and parked spikes — is the [GitHub Project board](https://github.com/msdixon/secret-cabinet/projects/2) ("Secret-Cabin-et Roadmap", project #2). This doc names the shape of the plan; the board is where status actually lives.

## Other open decisions

(#116 and #117, the two north-star-blocking decisions, are covered above rather than repeated here.)

- **[#32](https://github.com/msdixon/secret-cabinet/issues/32) — investigation mode scoping.** Not blocked technically, blocked on a design conversation: who authors the hidden "truth state," what granularity clue-evaluation runs at, and how it reads a player's own turns (per #31's mechanism).

## How this doc relates to everything else

- **[README.md](README.md)** — setup and usage for actually running the app. User-facing, not a planning doc. (Currently stale on roster size — flagged, not yet fixed.)
- **[MANIFEST.md](MANIFEST.md)** — standing member roster, kept current, same format as sibling repos for the meta-cabinet index.
- **[GitHub Project board #2](https://github.com/msdixon/secret-cabinet/projects/2)** — workflow and priority tracker. Houses bugs, milestone markers, and parked "spikes" (investigation issues like #118 that surface a decision or non-urgent finding mid-work, get filed, and wait in Backlog rather than blocking the thing in progress). **Review at a high level weekly** to catch stale or unprioritized issues — that review is a standing responsibility, not a one-off.
- **[STATUS.md](STATUS.md)** — dated, one-line-per-entry log of what shipped or changed, appended to as it happens.
- **Claude's memory files** — narrative context: why a decision was made, what was tried and rejected, collaboration-style notes. Not authoritative for current state — if memory and this doc disagree, this doc (and the board) win.

---

*Last updated: 2026-07-21 (purpose and north star expanded same day).*
