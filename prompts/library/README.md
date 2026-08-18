# Library entries

Hand-curated primary-source excerpts, one Markdown file per entry (frontmatter + full excerpt text) plus `library.json` as the index the app reads at runtime. This is the 35a track of [#35](https://github.com/msdixon/secret-cabinet/issues/35) — grow the library by hand, same format, no new tooling required.

## Before adding an entry

**Fetch `source_url` yourself and confirm it resolves to the actual cited work before committing.** Do not construct a plausible-looking identifier from memory or pattern-match against similar ones — [#157](https://github.com/msdixon/secret-cabinet/issues/157) found that 6 of the original 10 entries had fabricated archive.org identifiers that 404, undetected until something else (image sourcing for #30) needed the URL to actually work.

These `source_url` values aren't just bibliographic decoration — `/verify-citations` (#36) surfaces them to users as "grounded in" provenance for a flagged citation. An unverified `source_url` is worse than no `source_url`: it reads as trustworthy without having earned it.

After adding or editing entries, run:

```bash
node scripts/verify-library-sources.js
```

It checks every entry's `source_url` against its host: archive.org entries via the `/metadata/<id>` API (which reliably distinguishes a real item from an invented one — the `/details/<id>` page alone does not) and `doi.org` links via Crossref, both for the same reason — a plain HTTP check can pass for a plausible-but-wrong identifier, not just a fabricated one. Non-zero exit if anything's broken.

## `author` and `translated` — required on every `library.json` entry

Since [#187](https://github.com/msdixon/secret-cabinet/issues/187), an entry is not only a citation source — it is also fed back to its own author as a voice-register exemplar in their speaker prompt ("this is how you actually write"). Two index fields carry that, and both are enforced by `test/library.test.js` (`npm test`):

- **`author`** — the single roster member id whose hand the text is in. **This is not the same as `members`.** `members` is an association list: it names everyone the entry concerns, so Waite's 1911 preface lists `pixie` and Jung's 1916 text lists `corbin` because those entries are *about* them. Handing a member someone else's prose under the heading "how you actually write" would fabricate a voice — precisely what this library exists to prevent. `author` must also appear in `members`.
- **`translated`** — `true` when the English on the page is a translator's rather than the author's, which is the case for 17 of the current 29 entries. It makes the prompt tell that member to take the cadence and shape of the argument but not the specific diction, so Teresa doesn't inherit E. Allison Peers's vocabulary as her own. Read the citation rather than grepping it for "trans.": Moina Mathers's 1926 preface is her own English, and the "trans." in its citation refers to S.L. MacGregor Mathers translating the book she was prefacing.

An entry with no `author` is silently skipped by the exemplar path — it still works for citation grounding and the graph, but its author never sees their own prose. The test is what stops that going unnoticed.

Coverage as an exemplar is therefore counted by distinct `author`, not by union of `members`: 29 of 38 roster members, not the 30 that `members` gives. (The roster grew from 33 to 38 in the 2026-08-10 TV-personas addition — see the 2026-08-10 #35a entry in STATUS.md for the five new members this increment covered.)

## `license` — public domain vs. licensed/fair-use excerpts

By [2026-08-08](https://github.com/msdixon/secret-cabinet/issues/35#issuecomment-5224588027), five #35a increments had reduced the roster gap to 10 members with no viable public-domain English text — some because the work itself won't be public domain for decades (e.g. a member who died in the 1980s), not because it's undiscoverable. Waiting out a 70-year copyright term isn't a real option for those, so entries may now also be sourced under an explicit open license or under fair use, provided they're **independently verifiable and honestly labeled as what they are** — the same standard `source_url` has always had to meet (#157), extended to cover *why* the excerpt is legally usable, not just whether the link resolves.

Every `library.json` entry requires a `license` field, one of:

- `"public-domain"` — the existing rule, unchanged. Full excerpt, no restriction.
- `"cc0"` — public-domain-equivalent dedication. Treat like `public-domain`.
- `"cc-by-4.0"` / `"cc-by-nc-4.0"` — openly licensed with attribution required. The license grants full-excerpt reuse; still needs a `rights_note`.
- `"fair-use"` — no license grant at all; legality rests on the excerpt being short, attributed, and used for the transformative purpose this library actually serves (citation-grounding and voice-register modeling, not republishing the work). **Keep fair-use excerpts short — a paragraph or a few, not a chapter.** The existing full-length-excerpt convention is a public-domain-only privilege; a fair-use entry that reproduces most of a short work or a large fraction of a long one doesn't qualify no matter how it's labeled.

Any value other than `public-domain`/`cc0` also requires a **`rights_note`** field in the entry's `.md` frontmatter (alongside `citation`/`source_url`) stating: the rights holder, the specific license or fair-use rationale, and — for `fair-use` — a rough sense of the excerpt's length/proportion against the source (e.g. "~180 words from a 4,000-word letter"). `test/library.test.js` enforces both the `license` value and the `rights_note` presence; it can't judge whether the fair-use reasoning is *sound*, only that someone wrote it down and it's there to be checked.

`source_url` for a non-public-domain entry should point to something a reader can independently verify the license or provenance from — a DOI, a publisher/journal page, a Google Scholar or institutional-repository link — not just a PDF with no bibliographic trail. `scripts/verify-library-sources.js` checks `doi.org` links against Crossref the same way it checks archive.org identifiers against `/metadata`, so a fabricated DOI fails the same way a fabricated archive.org id does.

This does not relax the bar for entries that qualify as public domain — check that first, always. `license` only exists to open a second, honestly-labeled path for the members where public domain genuinely isn't available within a useful timeframe.
