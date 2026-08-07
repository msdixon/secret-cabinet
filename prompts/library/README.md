# Library entries

Hand-curated primary-source excerpts, one Markdown file per entry (frontmatter + full excerpt text) plus `library.json` as the index the app reads at runtime. This is the 35a track of [#35](https://github.com/msdixon/secret-cabinet/issues/35) — grow the library by hand, same format, no new tooling required.

## Before adding an entry

**Fetch `source_url` yourself and confirm it resolves to the actual cited work before committing.** Do not construct a plausible-looking identifier from memory or pattern-match against similar ones — [#157](https://github.com/msdixon/secret-cabinet/issues/157) found that 6 of the original 10 entries had fabricated archive.org identifiers that 404, undetected until something else (image sourcing for #30) needed the URL to actually work.

These `source_url` values aren't just bibliographic decoration — `/verify-citations` (#36) surfaces them to users as "grounded in" provenance for a flagged citation. An unverified `source_url` is worse than no `source_url`: it reads as trustworthy without having earned it.

After adding or editing entries, run:

```bash
node scripts/verify-library-sources.js
```

It checks every entry's `source_url` against its host (archive.org entries via the `/metadata/<id>` API, which reliably distinguishes a real item from an invented one — the `/details/<id>` page alone does not). Non-zero exit if anything's broken.

## `author` and `translated` — required on every `library.json` entry

Since [#187](https://github.com/msdixon/secret-cabinet/issues/187), an entry is not only a citation source — it is also fed back to its own author as a voice-register exemplar in their speaker prompt ("this is how you actually write"). Two index fields carry that, and both are enforced by `test/library.test.js` (`npm test`):

- **`author`** — the single roster member id whose hand the text is in. **This is not the same as `members`.** `members` is an association list: it names everyone the entry concerns, so Waite's 1911 preface lists `pixie` and Jung's 1916 text lists `corbin` because those entries are *about* them. Handing a member someone else's prose under the heading "how you actually write" would fabricate a voice — precisely what this library exists to prevent. `author` must also appear in `members`.
- **`translated`** — `true` when the English on the page is a translator's rather than the author's, which is the case for 12 of the current 21 entries. It makes the prompt tell that member to take the cadence and shape of the argument but not the specific diction, so Teresa doesn't inherit E. Allison Peers's vocabulary as her own. Read the citation rather than grepping it for "trans.": Moina Mathers's 1926 preface is her own English, and the "trans." in its citation refers to S.L. MacGregor Mathers translating the book she was prefacing.

An entry with no `author` is silently skipped by the exemplar path — it still works for citation grounding and the graph, but its author never sees their own prose. The test is what stops that going unnoticed.

Coverage as an exemplar is therefore counted by distinct `author`, not by union of `members`: 21 of 33 roster members, not the 23 that `members` gives.
