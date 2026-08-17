# STATUS.md fragments

Every PR that changes something worth logging in [STATUS.md](../../../STATUS.md) drops a fragment file **here** instead of editing `STATUS.md` directly. Same pattern Towncrier (Python) and Changesets (JS monorepos) use: parallel branches all editing the same spot at the top of one file produces avoidable merge conflicts on every overlap — not real logical conflicts, just git seeing concurrent edits to the same location. A fragment per PR means PRs never touch the same line, so they never conflict on this.

## Adding a fragment

1. Create a file named `<issue-or-PR-number>-<slug>.md` — e.g. `312-fix-export-crash.md`. Use the issue number if there is one, otherwise the PR number. `slug` is a short kebab-case description, only there to make the filename greppable; it isn't parsed.
2. The file's contents are exactly the entry text that would have followed `- **date** —` in the old convention — **do not** include the leading `- **date** —` yourself, [`scripts/assemble-status.js`](../../../scripts/assemble-status.js) adds that when it assembles the fragment into `STATUS.md`.
3. Follow the same entry rules `STATUS.md`'s own header describes: 1-3 sentences plus the PR/issue link, not a restatement of the PR body.

## What happens next

Fragments sit here, tracked in git, until someone runs `node scripts/assemble-status.js` (see that script's header for when/how — it also runs weekly as a step in the `secret-cabinet-project-doc-checkin` scheduled task, which opens a PR when it finds pending fragments to fold in). That run turns every pending fragment into one dated entry at the top of `STATUS.md`, newest-first as always, and deletes the fragment files it consumed. Multiple fragments landing in the same run all get that run's date and are ordered by issue/PR number, highest first.

This file itself (and this directory) stays even when no fragments are pending, so the directory is always tracked.
