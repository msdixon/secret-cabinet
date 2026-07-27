# STATUS.md

Dated, one-line-per-entry log of what shipped or changed. Newest first. Append a new entry whenever something ships, a decision gets made, or a notable bug gets found/fixed — don't rewrite history above it.

For the *why* behind any entry, check the linked PR/issue first; deeper narrative context (what was tried, what was rejected, collaboration notes) lives in Claude's memory, not here. For current direction and open decisions, see [PROJECT.md](PROJECT.md).

---

- **2026-07-24** — Wave 3 roster: five new members (Marguerite Porete, Hildegard of Bingen, Julian of Norwich, Carl Jung, Wolfgang Pauli) — gives Teresa of Ávila medieval peers for the first time, closes the Jung/Scholem citation `corbin.md` has carried since Wave 1. Jung's 1933 Nazi-era Society presidency handled per `AXES.md` Axis 3, applied proactively without a specific request; Axis 3's worked-example line updated to reflect it. Reissue of a bundle originally drafted 2026-07-07 against a stale (pre-#101) schema — regenerated against current `roster.json`/`MANIFEST.md`/`AXES.md` as of 2026-07-23. [PR #130](https://github.com/msdixon/secret-cabinet/pull/130)
- **2026-07-23** — Added `CLAUDE.md`: standing instructions to log STATUS.md entries at merge time and to treat worktree cleanup as part of wrapping up a task. [PR #128](https://github.com/msdixon/secret-cabinet/pull/128)
- **2026-07-23** — Worktree audit: pruned stale worktrees, rescued a ~2-month-old uncommitted fix (worktree-aware `.env` loader; real convene error messages instead of a generic string) that would otherwise have been lost. [PR #126](https://github.com/msdixon/secret-cabinet/pull/126)
- **2026-07-23** — Wave 2 roster: six new guest members (Yates, Scholem, Moina Mathers, Randolph, Bamba, Sun Ra), Crowley patched for historical accuracy per new AXES.md Axis 3, roster.json/MANIFEST.md reconciled to the post-2026-07-09 no-guest-field schema. [PR #124](https://github.com/msdixon/secret-cabinet/pull/124)
- **2026-07-21** — `PROJECT.md` and `STATUS.md` landed (drafted 2026-07-21, merged 2026-07-23 after sitting unmerged on a stale branch). [PR #123](https://github.com/msdixon/secret-cabinet/pull/123)
- **2026-07-20** — [#33](https://github.com/msdixon/secret-cabinet/issues/33) Branching session trees shipped. [PR #122](https://github.com/msdixon/secret-cabinet/pull/122)
- **2026-07-20** — Railway production deploy found unauthenticated at `/` since day one, fixed. [#120](https://github.com/msdixon/secret-cabinet/issues/120), [PR #121](https://github.com/msdixon/secret-cabinet/pull/121)
- **2026-07-16** — [#31](https://github.com/msdixon/secret-cabinet/issues/31) Player-as-member mode shipped — first Tier 3 item to ship. [PR #119](https://github.com/msdixon/secret-cabinet/pull/119)
- **2026-07-13** — Tier 3 roadmap audit: three threads mapped, art-pipeline (#116) and 3D-engine (#117) decisions split out as their own blocking issues. [#118](https://github.com/msdixon/secret-cabinet/issues/118)
- **2026-07-12** — [#113](https://github.com/msdixon/secret-cabinet/issues/113) Cumulative cross-session citation manifest shipped. [PR #114](https://github.com/msdixon/secret-cabinet/pull/114)
- **2026-07-12** — [#36](https://github.com/msdixon/secret-cabinet/issues/36) Citation verification layer shipped. [PR #112](https://github.com/msdixon/secret-cabinet/pull/112)
- **2026-07-11** — [#73](https://github.com/msdixon/secret-cabinet/issues/73) Shape the Arc UX (round-count selector) shipped. [PR #110](https://github.com/msdixon/secret-cabinet/pull/110)
- **2026-07-11** — [#51](https://github.com/msdixon/secret-cabinet/issues/51) Per-member agent architecture shipped, staged across 6 PRs (#99, #104–#109).
- **2026-07-09** — Guest/core roster distinction removed entirely — one flat 22-member roster. [#101](https://github.com/msdixon/secret-cabinet/issues/101)
- **2026-07-09** — Speaker attribution bug (Wave 1 guests with formal names broke rendering) fixed; alias derivation now automatic from roster data. [#96](https://github.com/msdixon/secret-cabinet/issues/96), [PR #102](https://github.com/msdixon/secret-cabinet/pull/102)
- **2026-06-22** — Status snapshot: Wave 1 roster, archival material library, knowledge graph, speaker glyphs, "Lodge Beyond the Lodge," Witness mode, Railway deploy. Full detail in [SECRET-CABINET-UPDATE-2026-06-22.md](SECRET-CABINET-UPDATE-2026-06-22.md) (historical snapshot, superseded by this file going forward).
- **~2026-05** — Wave 1 roster bundle (10 new guest members) landed. [PR #95](https://github.com/msdixon/secret-cabinet/pull/95)
