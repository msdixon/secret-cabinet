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
- **After the meeting** — unchanged tooling (highlight, cite, tag). The expand control gives the room a long annotation pass needs.
- **State ownership** — annotation state stays in `app.js`, shared. `witness.js` renders and plays back; it does not own annotation.

**Known cost: tooltip clipping.** Citation tooltips and annotation popups currently expand into a full-page column. Inside a bounded scroll container they will clip at the edges. Fix is to portal them to the page root rather than positioning them inside the scroller — real work, not free, and it belongs in Phase 1 rather than being discovered in Phase 2.

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

**Phase 1 — structure.** Replace the transcript/witness panel pair with the stacked stage + record assembly. Delete `toggleLive()`'s re-parenting. Height budget, internal scroll, stick-to-bottom + "↓ live" pill, expand control, tooltip portaling. Behavior otherwise unchanged.

**Phase 2 — linkage and polish.** Current-beat marker in the record. Touch-handler scoping. Live-annotation flow end to end.

Phases 1–2 are the whole of #184. The stage view switcher, previously Phase 3, is now [#202](https://github.com/msdixon/secret-cabinet/issues/202).

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
| Pane linkage | Record never drives the stage; beat marker only | Preserves read-back-while-playing |
| Mobile | Same stack, smaller budget — no tabs | Stacking is already the mobile idiom |
| Scene placement | View switcher **on the stage**, not a sibling tab | The room becomes the stage; a tab encodes the wrong relationship |
| Building that switcher | Split to [#202](https://github.com/msdixon/secret-cabinet/issues/202) | Keeps #184 shippable; not lower value — should follow soon |
| `toggleLive()` re-parenting | Deleted | Two permanent containers make it unnecessary |

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

- [ ] A live convene renders in the stage by default; the record scrolls beneath it without growing the page
- [ ] Assembly never exceeds the viewport at any window size
- [ ] Scrolling the record up stops auto-scroll; the "↓ live" pill re-attaches
- [ ] Annotation works during a live convene, from the record
- [ ] Citation tooltips render fully — no clipping at the record's edges
- [ ] Go-back works in the stage with no regression from #90; swipes in the record scroll it instead
- [ ] Exiting the stage gives the record full height; `◎ Watch` restores it
- [ ] Exiting mid-convene does not stop the convene — the record keeps streaming
- [ ] `toggleLive()`'s DOM re-parenting is gone
- [ ] Past sessions replay correctly; no console errors
