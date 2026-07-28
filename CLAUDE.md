# CLAUDE.md — Secret-Cabin-et

Standing instructions for any Claude Code session working in this repo. See [PROJECT.md](PROJECT.md) for direction/roadmap and [STATUS.md](STATUS.md) for what's already shipped — read those first for context on the work itself. This file is process only.

## After merging any PR to main

Append a one-line, dated entry to `STATUS.md` before ending your turn — don't wait to be asked, and don't batch it up for later. This has already been missed twice in one sitting (PR #123, #124) and had to be backfilled; treat "merged a PR" and "logged it in STATUS.md" as the same action, not two.

## Worktree hygiene

This project accumulates a git worktree per task under `.claude/worktrees/`. Left alone, they silently pile up — some have sat for months with real uncommitted work nobody circled back to.

- **Once a worktree's branch is merged into `main`, remove both the worktree and the local branch as part of wrapping up that task** — don't leave it for a future cleanup pass. Exception: the worktree actively in use for the current conversation — leave that one, but say it's safe to remove once the session ends.
- **Before creating a new worktree, if `.claude/worktrees/` already has more than a few entries, do a quick pass first**: for each, check whether its branch is merged (`git merge-base --is-ancestor <branch> origin/main`) and whether it has uncommitted changes (`git status --short`).
  - Merged + clean → remove it outright.
  - Merged + uncommitted changes → **do not delete.** Surface the diff to the user — it may be real work that never got committed (this happened once already; see `STATUS.md`, 2026-07-23). Only remove after the user confirms it's rescued, discarded, or not needed.
  - Not merged → leave it; it's active work, not clutter.

## Before ending a session that touched issues or merged PRs

Confirm every issue referenced this session is in the right state — closed if genuinely done, left open with a progress comment if partially done. Don't leave "decide X" tickets open once the decision's recorded (this happened to #116/#117: decided and commented on 2026-07-28, but not closed until a later housekeeping pass caught it).

Also prune local branches whose remote was deleted after merge — `git fetch --prune` only cleans up remote-tracking refs, it does **not** delete the local branch itself, so these silently pile up (22 had accumulated in this repo by 2026-07-28). Check `git branch -vv` for branches with no `[origin/...]` tracking info, confirm each with `git merge-base --is-ancestor <branch> origin/main` before deleting, and leave any that aren't merged for the user to look at rather than guessing.
