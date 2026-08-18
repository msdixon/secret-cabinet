# CLAUDE.md — Secret-Cabin-et

Standing instructions for any Claude Code session working in this repo. See [PROJECT.md](PROJECT.md) for direction/roadmap and [STATUS.md](STATUS.md) for what's already shipped — read those first for context on the work itself. This file is process only.

## Logging to STATUS.md

**The STATUS.md entry ships inside the PR it describes, as a fragment — never as a direct edit to STATUS.md itself, and never as a follow-up commit to `main` after merging.** Add a file to [`docs/status/fragments/`](docs/status/fragments/README.md) on the branch itself, as one of the last commits before the PR is ready to merge (open the PR first if you need its number to link; see that directory's README for the filename/content convention). Do not edit STATUS.md directly — `node scripts/assemble-status.js` later folds pending fragments into a dated STATUS.md entry, run manually or weekly via the `secret-cabinet-project-doc-checkin` scheduled task. The fragment and the code it describes still land in the same merge, atomically, with no separate step to remember or forget.

**Why this replaced "append after merging, before ending your turn":** that instruction was racy in practice, not just occasionally forgotten. Once a PR merges, whoever notices — a different session wrapping up, or Rachel merging by hand — may reasonably try to log it, and nothing prevents two sessions from doing so independently. On 2026-08-07 that happened for real: two concurrent sessions both backfilled a STATUS.md entry for the same PR (#206) within minutes of each other, producing an actual merge conflict on `main` — not a close call, a collision. Shipping the entry inside the PR removes the race entirely: if the PR merged, the entry is already there; no session ever needs to guess whether someone beat them to it.

**Before adding any entry — including a backfill for older history — grep `STATUS.md` for the PR or issue number first.** If it's already logged, don't add a second entry; if you have real detail the existing one lacks, that's a judgment call about whether it's worth a short addendum, not grounds for a duplicate paragraph. This guards the one gap the new rule doesn't close on its own: PRs merged before this convention existed, or where a session skipped the step, still need occasional backfilling — but backfilling should stay rare, deliberate, and checked-for-duplicates now, not a standing "after every merge" habit.

**Keep the entry itself to 1–3 sentences plus the PR/issue link.** The PR body is where the reasoning, alternatives, and verification steps belong — it's attached to the diff permanently, so restating it in STATUS.md is pure duplication. Entries drifted to ~4x their intended length between 2026-07 and 2026-08 (see [#275](https://github.com/msdixon/secret-cabinet/issues/275)), pushing the file to 139KB in 12 days at one point; it's read into context at the start of most sessions, so length there is a recurring cost, not a one-time one. STATUS.md's own header carries the same rule and the size-triggered archive convention (`docs/status/ARCHIVE-<range>.md` once the file crosses ~60KB) — this is a second reminder, not a separate rule.

## Updating PROJECT.md's Todo section

PROJECT.md's "What needs to happen to get there" section has two parts that are kept current two different ways — don't hand-edit either inline per-PR.

**The flat Todo-status backlog list is fragment-based, same mechanism as STATUS.md.** When an item ships, gets reprioritized off Todo, or a new one lands on Todo, add or delete a file in [`docs/roadmap/todo/`](docs/roadmap/todo/README.md) instead of editing PROJECT.md's list directly — see that directory's README for the filename/content convention. `node scripts/assemble-todo.js` regenerates the list between its markers from whatever fragments currently exist, run manually or weekly via the `secret-cabinet-project-doc-checkin` scheduled task. Ship the fragment file inside the PR that closes or adds the item, same atomicity reasoning as STATUS.md above.

**The thread-status table above it is different — hand-curated narrative, not append/remove-shaped, and not touched per-PR at all.** The [GitHub Project board](https://github.com/msdixon/secret-cabinet/projects/2) is the authoritative source for per-item status; a PR that ships, reprioritizes, or scopes work updates the board directly (`gh project item-edit`, or the board UI), not PROJECT.md's table. The table only gets refreshed during the periodic/weekly review pass (`secret-cabinet-project-doc-checkin`'s Step 4, or a `/cabinet-review`/`/cabinet-next` pass), which reconciles it against the board in one deliberate sweep.

**Why the split:** the old rule ("update both before merge") kept drifting anyway — #184 and #185 both shipped (PRs #206 and #209) but PROJECT.md still listed them as open until a manual pass caught it on 2026-08-08, and days later it happened again across #187, #188, #137, #90, and separately #203. "Before merge" competes with everything else a PR is already trying to land, and nothing enforced it — the exact gap STATUS.md's own drift showed before it moved to fragments. The flat list gets the same fix STATUS.md got: fragments instead of a shared edit point in a file, so parallel PRs never collide and nothing needs a human to remember. The table doesn't fit that fix — it's prose that needs judgment to keep coherent, not a list of interchangeable items — so instead of continuing to ask for per-PR discipline that wasn't holding, it moved fully to the board (real-time, per-item, already the "authoritative" source in name) plus a periodic doc sync (batched, deliberate), and PRs stopped touching it at all. A reactive backstop (`/cabinet-next`'s board-drift check, added 2026-08-08) still exists as a periodic catch-up, but it's no longer plugging a gap the primary mechanism leaves open — for the flat list, fragments are the source fix; for the table, the board plus scheduled review is.

## Filing new issues

**Every new issue gets added to the GitHub Project board (#2, "Secret-Cabin-et Roadmap") at creation time** — not left to be picked up in a later triage pass:

```bash
gh issue create --repo msdixon/secret-cabinet --title "..." --body "..." --label "..."
gh project item-add 2 --owner msdixon --url <the issue URL just created>
```

**Why:** PROJECT.md and this file both say the board is where status actually lives, but that's only true if issues land on it. An issue that exists only in the repo's Issues tab is invisible to `/cabinet-next`'s board query and to the weekly doc-checkin's reconciliation — it doesn't get triaged, doesn't get a Status column, and just sits there until someone happens to notice it exists outside the normal flow. Filed 2026-08-08 after #218 was created without this step and had to be added to the board as an explicit follow-up.

New items land in whatever Status the project's default assigns (observed as **Backlog** as of 2026-08-08) — that's fine as a landing spot; deciding whether it's actually Backlog-worthy vs. Icebox vs. something more urgent is what triage is for, not something to guess at the moment of filing.

## Worktree hygiene

This project accumulates a git worktree per task under `.claude/worktrees/`. Left alone, they silently pile up — some have sat for months with real uncommitted work nobody circled back to.

- **Once a worktree's branch is merged into `main`, remove both the worktree and the local branch as part of wrapping up that task** — don't leave it for a future cleanup pass. Exception: the worktree actively in use for the current conversation — leave that one, but say it's safe to remove once the session ends.
- **Before creating a new worktree, if `.claude/worktrees/` already has more than a few entries, do a quick pass first**: for each, check whether its branch is merged and whether it has uncommitted changes (`git status --short`).
  - Merged + clean → remove it outright.
  - Merged + uncommitted changes → **do not delete.** Surface the diff to the user — it may be real work that never got committed (this happened once already; see `STATUS.md`, 2026-07-23). Only remove after the user confirms it's rescued, discarded, or not needed. A `.DS_Store`-only diff is macOS noise, not work.
  - Not merged → leave it; it's active work, not clutter.

  **`git merge-base --is-ancestor <branch> origin/main` is not sufficient on its own.** This repo squash-merges, and a squash-merged branch is never an ancestor of `main` — the check reports "not merged" for work that shipped weeks ago. On 2026-08-07 it gave false negatives on 6 of 12 worktrees, every one of which would have been left behind as "active work." Ask GitHub instead, which is authoritative:

  ```bash
  gh pr list --repo msdixon/secret-cabinet --head <branch> --state all --json number,state
  ```

  Treat a `MERGED` PR as merged regardless of what the ancestry check says. A branch with no PR *and* no ancestry is the genuinely-unmerged case — leave it.

## Dependencies in new worktrees

Each worktree gets its own `node_modules` — it is **not** shared with the main checkout, and a missing dependency fails silently rather than erroring (e.g. `babylonjs` missing just makes the 3D room never render, no console error; hit this twice — see `STATUS.md` 2026-07-30 and PR #152).

**`npm run dev` installs dependencies for you.** A `predev` script in `package.json` runs `npm install` before the dev server starts — idempotent, about a second when everything's already there. This is the reliable guard; prefer it over trusting any hook.

A tracked `post-checkout` hook at `.githooks/post-checkout` also runs `npm install` whenever a checkout leaves `node_modules` missing. It needs `core.hooksPath` pointed at it — already set for this clone, but **a fresh clone needs it set once**: `git config core.hooksPath .githooks`.

**The hook does not fire for the worktrees this project actually creates.** Verified 2026-08-07: it works for a manual `git worktree add`, but Claude Code's harness creates worktrees without a checkout step, and `post-checkout` only runs on a checkout. The signature is visible in the reflog — `cat .git/worktrees/<name>/logs/HEAD` shows a lone branch-creation line with no `reset: moving to HEAD` entry, identical to what `git worktree add --no-checkout` produces. This is why the silent-`babylonjs` failure kept recurring despite the hook existing. Don't assume a session's worktree has dependencies just because the hook is installed.

If a worktree ever turns up with 3D/scene features silently not working, check that `node_modules/babylonjs` exists before assuming it's a code bug — `npm install` in that worktree is the fix.

## Before ending a session that touched issues or merged PRs

Confirm every issue referenced this session is in the right state — closed if genuinely done, left open with a progress comment if partially done. Don't leave "decide X" tickets open once the decision's recorded (this happened to #116/#117: decided and commented on 2026-07-28, but not closed until a later housekeeping pass caught it).

Also prune local branches whose remote was deleted after merge — `git fetch --prune` only cleans up remote-tracking refs, it does **not** delete the local branch itself, so these silently pile up (22 had accumulated by 2026-07-28; 17 again by 2026-08-07). Check `git branch -vv` for branches marked `[origin/...: gone]` or carrying no tracking info at all, confirm each is merged before deleting — using **both** the ancestry check and the `gh pr list --head <branch>` check described under Worktree hygiene, since squash-merged branches fail ancestry — and leave any that aren't merged for the user to look at rather than guessing. Deleting a squash-merged branch needs `git branch -D`; `-d` refuses it.
