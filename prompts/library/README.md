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
