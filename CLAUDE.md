# CLAUDE.md — Secret-Cabin-et

Standing instructions for any Claude Code session working in this repo. See [PROJECT.md](PROJECT.md) for direction/roadmap and [STATUS.md](STATUS.md) for what's already shipped — read those first for context on the work itself. This file is process only.

## After merging any PR to main

Append a one-line, dated entry to `STATUS.md` before ending your turn — don't wait to be asked, and don't batch it up for later. This has already been missed twice in one sitting (PR #123, #124) and had to be backfilled; treat "merged a PR" and "logged it in STATUS.md" as the same action, not two.

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
