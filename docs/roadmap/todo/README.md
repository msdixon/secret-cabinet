# PROJECT.md Todo-list fragments

[PROJECT.md](../../../PROJECT.md)'s flat Todo-status backlog list — the plain bullet items under "What needs to happen to get there," not the thread-status table above it — is assembled from one fragment file per item **here**, same idea as [STATUS.md's fragments](../../status/fragments/README.md) but adapted for a list that shrinks as well as grows: parallel PRs editing near the same lines in one shared list were producing avoidable merge conflicts, and items also get removed when they ship rather than only appended.

## Adding, changing, or removing an item

1. **New Todo item:** create a file named `<issue-number>-<slug>.md` — e.g. `287-room-scrollback.md`. `slug` is a short kebab-case description, only there to make the filename greppable; it isn't parsed.
2. **Item ships, or moves off Todo (Done, Backlog, Icebox):** delete its file. That's the entire "mark done" action — there's no shared list line to remove by hand.
3. **Item's description changes:** edit the file in place.

A file's contents are exactly the bullet text that follows `- ` in the assembled list — **do not** include the leading `- ` yourself, [`scripts/assemble-todo.js`](../../../scripts/assemble-todo.js) adds that when it regenerates the list.

## What happens next

Unlike STATUS.md's fragments (which get consumed into a permanent dated entry), this directory's current contents *are* the list's source of truth at any given moment — nothing here is ever "spent." Run `node scripts/assemble-todo.js` (manually, or weekly as a step in the `secret-cabinet-project-doc-checkin` scheduled task) to regenerate the Todo bullet list in PROJECT.md between its `<!-- TODO-FRAGMENTS:START -->` / `<!-- TODO-FRAGMENTS:END -->` markers from whatever fragment files exist right now. It's idempotent — running it with no fragment changes since the last run reproduces the same list — and sorts fragments by issue number, ascending.

This file itself (and this directory) stays even when no fragments are pending, so the directory is always tracked.

## What this doesn't cover

PROJECT.md's thread-status table (the "Interactivity / agency," "Atmosphere / presence," etc. rows above the Todo list) is hand-curated narrative, not append/remove-shaped, and isn't fragmented here — see PROJECT.md's own header and its "How this doc relates to everything else" section for how that table gets kept current instead.
