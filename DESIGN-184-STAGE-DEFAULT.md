# Design: Make the Stage the Default — Witness as the Live View

**Issue:** [#184](https://github.com/msdixon/secret-cabinet/issues/184)
**Status:** Design doc (before implementation)
**Related:** [#90](https://github.com/msdixon/secret-cabinet/issues/90) go-back navigation · [#87](https://github.com/msdixon/secret-cabinet/issues/87) live witness toggle · [#28](https://github.com/msdixon/secret-cabinet/issues/28) avatar presence · [#194](https://github.com/msdixon/secret-cabinet/issues/194) rounds spike

---

## Summary

Two bounded, vertically-stacked panes replace the current unfurling column:

- **The stage** (top) — the Witness presentation, now the default live view.
- **The record** (bottom) — the transcript, in a fixed-height window that *scrolls as speech arrives* rather than lengthening the page. Full transcript stays downloadable for pagination and legibility.

The `toggleLive()` DOM re-parenting hack dies as a consequence: with two permanent containers, nothing ever swaps parents.

**The core problem being solved is not "the transcript is in the wrong place" — it is "the page unfurls."** Today a live convene grows a ~2,200px column, pushing the performance out of view and stranding the 3D room below the fold. Bounding both panes and giving each its own internal scroll fixes that directly.

---

## Current State (before)

Vertical stack in `.lodge-body`:

1. Input controls (journal, members, rounds, Convene)
2. **Transcript panel** — default view, grows unbounded as the session runs
3. Witness panel — hidden by default, toggled via `#witness-live-toggle`, which **re-parents DOM nodes** between the two containers
4. After-meeting controls (additional round, interject, export)
5. Scene panel — 16:9, ~553px, at the bottom of the column

What's wrong:

- The performance — the part closest to the original intent — is opt-in and buried.
- The annotated transcript, a control surface, is positioned as the thing to read first.
- `toggleLive()` physically moves the same DOM nodes between containers to keep the two views consistent. This has already caused two real bugs (duplicate `entryId`s breaking annotation saving; stale nodes colliding after `_entryCounter` reset — both fixed in [#87](https://github.com/msdixon/secret-cabinet/issues/87)).
- The scene is visually isolated from the conversation it depicts.

---

## Proposed layout

### Structure (all viewports)

Vertically stacked, no horizontal split — the same structure on desktop and mobile, with only the height budget changing.

```
┌────────────────────────────────────────────┐
│  Input controls (document, members,        │
│  rounds, Convene)                          │
├────────────────────────────────────────────┤
│                                            │
│  THE STAGE                    [text ⇄ room]│  ← view switcher lives here
│  Witness presentation, one beat at a time  │
│  ← back · advance · Exit                   │
│  ~55% of available height                  │
│                                            │
├────────────────────────────────────────────┤
│  THE RECORD                    [⤢ expand]  │
│  ┌──────────────────────────────────────┐  │
│  │ …earlier speech (scrolled up)        │▲ │
│  │ Yeats: …                             │║ │  ← internal scroll,
│  │ Crowley: …                    ▸ ← now │║ │     does NOT grow page
│  └──────────────────────────────────────┘▼ │
│  ~45% of available height, min ~240px      │
├────────────────────────────────────────────┤
│  After the meeting (round, interject,      │
│  verify, export)                           │
└────────────────────────────────────────────┘
```

### Why not a two-column split

Considered and rejected. Side-by-side buys simultaneous visibility, which stacking already provides here, at the cost of a desktop-only layout that needs a separate mobile answer (tabs or a drawer). Stacking is one layout everywhere. It also reads correctly: the performance happens, and the record accumulates beneath it.

---

## Height budget

The two panes are **similarly sized, not identical** — the intent is visual balance, not matched pixels. Literal equality would defeat the purpose: a 16:9 stage at ~900px wide is ~506px tall, so a matching record makes 1,012px before any controls — taller than a laptop viewport, and the page unfurls again, just differently.

Spec instead: **the pair shares the viewport.**

| | Desktop | Mobile |
|---|---|---|
| Stage | ~55% of available height | ~40vh |
| Record | ~45%, floor of ~240px | ~40vh, floor of ~180px |
| Assembly | `max-height: calc(100vh - <controls>)` | same |

Optically near-equal on most screens, and structurally incapable of overflowing.

### Giving the record full height — no new control

A bounded ~450px record is *worse* than today's full-page transcript when the point is to sit and annotate a long past session. But this does **not** need a new control.

The inversion frees controls rather than adding them: `◎ Witness` (the live toggle in the transcript toolbar) becomes meaningless once the stage is the default — it is precisely the toggle whose re-parenting hack this work deletes. And the stage already carries `✕ Exit`.

**Decision: exiting the stage collapses it, and the record takes the full assembly height.** Re-enter via the existing `◎ Watch` in *After the Meeting*.

This is the mental model that already exists — "exit Witness" has always meant "go back to reading the transcript full-page." The inversion changes which view you start in, not the vocabulary.

- Exiting mid-convene does **not** stop the convene; the record keeps streaming. (Matches today's `toggleLive()` behavior.)
- Tradeoff: the state is binary — stage full or stage gone, no intermediate slim strip.

*Alternatives considered:* a maximize (⤢) button on the record header, or a draggable divider between panes. Both add a control to a UI that already has many, to buy an intermediate state with no established demand. Deferred; the divider remains the natural upgrade if binary proves too blunt in use.

---

## Scroll behavior — the one real interaction hazard

If the record auto-scrolls on every new speech, a user who has scrolled up to re-read gets yanked back mid-sentence. This must be specified now; retrofitting it is painful.

**Stick-to-bottom, conditionally:**

1. While the record is scrolled to (or near) the bottom, new speech auto-scrolls it — default behavior during a live convene.
2. The moment the user scrolls up, **decouple**. No further auto-scroll.
3. Show a "**↓ live**" pill while decoupled. Clicking it re-attaches and jumps to the newest speech.
4. Reaching the bottom by manual scroll also re-attaches (no pill click needed).

Threshold: treat "within ~40px of bottom" as attached, so a scroll-momentum overshoot doesn't spuriously decouple.

---

## Are the two panes linked?

They can desync: the stage advances beat-by-beat under user control ([#90](https://github.com/msdixon/secret-cabinet/issues/90) go-back), while the record scrolls continuously.

**Decision: the record is the record, not a second controller.**

- Scrolling the record **never** moves the stage.
- Stage go-back/advance **never** scroll-jumps the record.
- The stage's current beat carries a **subtle marker** on the corresponding entry in the record (a left-edge rule or a dim caret). Linkage is visible; neither pane hijacks the other.

*Alternative considered:* fully-linked scrub, where dragging the record scrubs the stage. More impressive, but it fights the thing the scrolling window exists for — reading back and ahead *while* the performance continues. Rejected for now; the marker keeps the door open.

---

## Annotation

Annotation stays in the record, which is now always present rather than a swapped-out sibling. Both panes render from the same live SSE stream; neither is a snapshot of the other.

- **During a live convene** — annotate in the record while the stage performs. Newly annotated passages mark immediately.
- **After the meeting** — unchanged tooling (highlight, cite, tag). Exiting the stage gives the record the full height a long pass needs.
- **State ownership** — annotation state stays in `app.js`, shared. `witness.js` renders and plays back; it does not own annotation.

**Tooltip clipping, checked and ruled out.** Citation tooltips render through the native `title` attribute (`speechEl.title = ...`, `applyCitationFlags` in `app.js`), and the annotation editor is normal-flow content inside the entry, not an absolutely-positioned overlay — neither is subject to a scroll container's `overflow` clipping. No portaling needed; flagged here so the concern doesn't get silently re-raised.

---

## Go-back navigation ([#90](https://github.com/msdixon/secret-cabinet/issues/90))

No behavioral change. #90 was already built for stage-as-primary; this promotes that stage to the default surface.

- Keyboard: ← / ↑ back · → / ↓ / space advance · Escape exits
- Click advances; hint text `← back · Exit to leave`
- Mobile: swipe right = back, swipe left = advance, 40px threshold, `passive:false` touchend

**New interaction to guard:** swipes inside *the record* must scroll it, not drive the stage. Scope the stage's touch handlers to the stage container only.

---

## The scene — where the room actually goes

The instinct to make Scene a tab is close, but a tab makes the room a **peer of the transcript**, and that encodes the wrong relationship. The north star is the room *becoming* the stage — a walkable space replacing witness-text-on-a-stage. Filing it as a sibling of the minutes means ripping it out later.

**Decision: the switcher lives on the stage container.** The top pane gets a view control — *text presentation ⇄ room* — because those are two renderings of **the same thing**. The record below is unaffected by which is showing.

Consequences:

- The room becomes a first-class way to watch the meeting, not a panel below the fold.
- As 2.5D matures ([#28](https://github.com/msdixon/secret-cabinet/issues/28) Phase 2 — portrait cards with dialogue in-scene), the room simply becomes the stage's default renderer. **No layout change.**
- Long-term, the text presentation can retire to a fallback without disturbing the IA.

**Split out to [#202](https://github.com/msdixon/secret-cabinet/issues/202).** The switcher is not built in #184 — this doc only reserves its home and records why that home is the stage rather than a sibling tab. #184 ships the layout; #202 proves the layout claim. Note that the "no rework when 2.5D matures" assertion above is *unproven* until #202 lands, which is why #202 should be picked up soon after this rather than allowed to drift.

Scene *content* (portrait cards, in-scene dialogue, ambient motion) is out of scope for both — that is #28's.

---

## Interaction with [#194](https://github.com/msdixon/secret-cabinet/issues/194) (do rounds still earn their place?)

The record's only structural landmark today is the round header. If the rounds spike dissolves the boundary, that landmark disappears.

**Not a blocker, but a build constraint:** treat round headers as *a style of divider* the record renders when present — not as something the scroll logic, virtualization, or marker-positioning depends on. The pane should degrade to a continuous stream with no structural change.

---

## Implementation phases

**Phase 1 — structure. Shipped.** Replaced the transcript/witness panel pair with the stacked stage + record assembly (`public/index.html`, `public/style.css`). Deleted `toggleLive()`'s re-parenting — `witness.js` now exposes `liveRoundHeader`/`liveSpeech`/`liveTyping*` for the stage's own lightweight mirror, called from `app.js`'s existing render call sites (`addRoundHeader`, `startStreamEntry`) right after each writes the record. Height budget, internal scroll, stick-to-bottom + "↓ live" pill (`app.js`'s `recordFollow`/`initRecordScroll`), and exit-collapses/`◎ Watch`-reopens in place of a new expand control, all built and verified live (129/129 tests, manual browser pass covering live mirroring, collapse/reopen, scroll stickiness, and replay go-back). Superseded by the Revision below before merge.

**Phase 2 — linkage and polish. Superseded by the Revision below** (current-beat marker and live-annotation-in-the-record are dropped, not just deferred — see Revision). Touch-handler scoping remains correct as a side effect of Phase 1 (`witness.js`'s touch listeners are bound to `#witness-stage` specifically).

Phases 1–2 are the whole of #184. The stage view switcher, previously Phase 3, is now [#202](https://github.com/msdixon/secret-cabinet/issues/202).

---

## Revision (mutually exclusive panes, not simultaneous)

Phase 1 as first built rendered both panes live and simultaneously, per every section above. In review, that surfaced a real problem this doc didn't anticipate: **the same streaming text visible in two places at once reads as a bug, not as "linked."** A reader can't tell which copy to follow, and during a live convene the stage's mirroring intentionally ignores its own pacing — "live beats appear as fast as the room actually speaks" — so the two panes weren't offering different experiences, just the same one twice.

That reopened a bigger question first: if the stage is meant to become the room (per this doc's own "Scene placement" section, and per `PROJECT.md`'s "2.5D composition direction" for #184), should the fix be to put the room in the stage's slot now, rather than patch pane visibility? Checked and deferred: `scene.js` already exists and is already live-reactive (`setSpeaking()` fires on every streamed beat today), so it's not a large lift — but PROJECT.md's own phrase, "2.5D composition," means dialogue rendered **into** the room, not a wordless room replacing text. Building that is a real design pass (#202), not a canvas relocation, and doing it here would risk building the wrong shape twice. A three-tier stack (stage-text / room / record-text) was also considered and rejected — it doesn't resolve "why two text renderers," it just adds a third box between them.

**Revised decision: only one pane is ever visible at a time — and the record is never a live-competing view.** This is #184's own title taken literally: Witness is the live view, the record is the minutes.

- A live convene defaults to **stage-only**. The record keeps accumulating underneath, unseen — this is not a new mechanism, `witness.js`'s mirroring already wrote to both; only visibility changes.
- The record becomes visible — and the stage collapses — **automatically the moment the convene reaches its natural pause** (`app.js`'s `convene()`/`resumeRounds()`, right where `showSessionControls()` already fired), or **any time via Exit**, which still doesn't stop a still-running convene (unchanged from the original decision).
- Reopening the stage (`▲ The Stage` / `◎ Watch`) hides the record again. Both states reuse `#stage-record`'s existing `.collapsed` class (record showing) plus a new symmetric `.stage-only` class (stage showing) — no new toggle vocabulary, no third button.
- Revealing a record that was hidden through an entire convene needed one real fix: `display:none` zeroes `scrollHeight`, so the existing stick-to-bottom scroll (`recordFollow()`) was inert the whole time it was hidden. `collapseStage()` now force-scrolls the record to its latest content the moment it becomes visible again.

**Consequence: live annotation, deferred, not built around.** The "During a live convene — annotate in the record while the stage performs" bullet under Annotation above no longer describes this ticket, and Phase 2's current-beat marker (which only mattered if both panes could be visible together) is dropped rather than built. Annotation now happens once a convene reaches its pause (record auto-revealed, full read/annotate experience unchanged), or on any past session via Past Meetings / export — unchanged from before #184 existed. `addRound()`/`interject()` (the after-panel's "One More Turn"/"Interject") stream into whichever pane is currently showing, same mirroring, no special-casing needed.

**Why not "room becomes the stage" now, concretely:** `PROJECT.md`'s "2.5D composition direction" and this doc's own §Scene placement both describe dialogue composited **into** the room, not a wordless room standing in for text. That's a UI design question — how does dialogue actually render against a portrait card? — not a relocation of `#scene-canvas`. Building it prematurely here risks the wrong shape shipping first. Witness-mode's bubbles are the stand-in for that until #202, not a rival to it.

---

## Decisions recorded

| Question | Decision | Why |
|---|---|---|
| New default view | Witness stage | Closer to intent, more fun; the review's finding |
| Layout | Vertically stacked, both panes bounded | Fixes the unfurl directly; one layout on every viewport |
| Two-column desktop | Rejected | Solves a different problem, forces a separate mobile answer |
| Record height | Fixed window, internal scroll, viewport-shared | Keeps live text above the fold without truncating |
| Long reading / annotation pass | Exit the stage → record takes full height | Reuses an existing control; adds no new vocabulary |
| Auto-scroll | Stick-to-bottom while attached, "↓ live" pill when not | Prevents yanking a re-reading user |
| Pane linkage | Superseded — only one pane is ever visible, so nothing to link | See Revision: simultaneous visibility was the actual problem, not the fix |
| Mobile | Same stack, smaller budget — no tabs | Stacking is already the mobile idiom |
| Scene placement | View switcher **on the stage**, not a sibling tab | The room becomes the stage; a tab encodes the wrong relationship |
| Building that switcher | Split to [#202](https://github.com/msdixon/secret-cabinet/issues/202) | Keeps #184 shippable; not lower value — should follow soon |
| `toggleLive()` re-parenting | Deleted | Two permanent containers make it unnecessary |
| Simultaneous live visibility | Reverted — only one pane visible at a time | Same streaming text in two places read as a bug, not "linked" (Revision) |
| Room in the stage's slot now | Deferred to #202, not built here | PROJECT.md's "2.5D" means dialogue *in* the room, not a wordless room instead of text — a real design pass, not a relocation |

---

## Out of scope

- [#202](https://github.com/msdixon/secret-cabinet/issues/202) stage view switcher — this doc reserves its home and records the reasoning; building it is its own issue
- [#185](https://github.com/msdixon/secret-cabinet/issues/185) director-proposes-cast · [#186](https://github.com/msdixon/secret-cabinet/issues/186) Continue/Preserve — the rest of the defaults-inversion arc
- [#28](https://github.com/msdixon/secret-cabinet/issues/28) Phase 2 scene content
- [#194](https://github.com/msdixon/secret-cabinet/issues/194) rounds decision — constrains how the record is built, decided elsewhere

---

## Backward compatibility

- Sessions, transcripts, and stored data formats unchanged.
- Export (Day One, Obsidian, Ulysses, scholarly) unchanged.
- Past sessions replay in the same unified stage.
- No API endpoint changes.

---

## Success criteria

- [x] A live convene renders in the stage by default, stage-only — the record never renders visibly alongside it (revised from "the record scrolls beneath it")
- [x] Assembly never exceeds the viewport at any window size
- [x] Scrolling the record up stops auto-scroll; the "↓ live" pill re-attaches, whenever the record is the visible pane
- [ ] ~~Annotation works during a live convene, from the record~~ — deferred, see Revision
- [ ] Citation tooltips render fully — no clipping at the record's edges
- [x] Go-back works in the stage with no regression from #90; swipes in the record scroll it instead
- [x] Exiting the stage gives the record full height; `◎ Watch` restores it (and now hides the record again)
- [x] Exiting mid-convene does not stop the convene — the record keeps streaming, unseen until revealed
- [x] `toggleLive()`'s DOM re-parenting is gone
- [x] A convene reaching its natural pause automatically reveals the record, scrolled to its latest content, and hides the stage
- [x] Past sessions replay correctly; no console errors — re-verified after this revision: `◎ Watch` defaults to stage-only, Exit returns to a fully-scrolled record
