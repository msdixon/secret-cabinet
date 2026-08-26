# Portrait candidates

Generated portraits waiting on human review — see [#435](https://github.com/msdixon/secret-cabinet/issues/435) and [STYLE_GUIDE.md](../STYLE_GUIDE.md)'s Process step 4.

`POST /api/members` writes `<id>.png` here automatically when `GEMINI_API_KEY` is set. Nothing here is canonical — `public/portraits/<id>.png` is the only path the app actually serves. Look at a candidate, and if it's good, run:

```
node scripts/promote-portrait.js <id>
```

That resizes it to 512px on the long edge, places it at `public/portraits/<id>.png`, deletes the candidate, and removes its entry from [PENDING-PROMPTS.md](../PENDING-PROMPTS.md). It won't write the `STYLE_GUIDE.md` Changelog line for you — that needs an actual look at the image against the register, same as every prior batch.

The `*.png` files in this directory aren't committed (see `.gitignore`) — this README is, so the directory and its purpose stay documented even when nothing's pending.
