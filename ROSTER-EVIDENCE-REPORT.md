# Roster Evidence Report

[#650](https://github.com/msdixon/secret-cabinet/issues/650) step 1: per-member usage and groundability facts for the 38-member roster. **Facts only** — no ranking, no recommendation, no representation assessment (that is step 2, the project owner's). Members appear in `docs/MANIFEST.md` order.

## Sample and caveats — read first

- **Sessions scanned: 0** (from `sessions/`).
- **Every usage column below is therefore empty, not zero-by-evidence.** `sessions/` is gitignored and per-user (#595); this report was generated where it holds none. Regenerate against real data with `RAILWAY_VOLUME_MOUNT_PATH=<volume> node scripts/roster-evidence.js` or `node scripts/roster-evidence.js <dir-of-session-json>`, run by someone entitled to read those sessions (owners can share a sitting with the keeper, #625).
- Sessions before [#244](https://github.com/msdixon/secret-cabinet/issues/244) (2026-08-11) have no per-beat records, so their members show as seated but never as speaking.
- **Casting source is not recoverable per member.** A saved session records who was seated, not whether each seat came from the casting proposal, a pinned regular, a starter's cast, or a hand pick; nor which members the director chose per passage. Session-level casting facts that *are* recorded: 0 session(s) made at least one casting call (0 call(s), 0 fell back to the deterministic first-N pick); 0 director call(s), 0 fell back. Whether the proposal was accepted is not stored. Answering "director/casting selection rate vs. manual seating" per member would need a new field written at convene time (a code change, out of scope here).
- Citation verdict columns exist only for sessions where Verify Citations has been run (`citationFlags`).
- Live citation-grounding accuracy (`scripts/eval-citation-grounding.js`) is a billed API call, gated to docs/MODEL-REVIEW.md's quarterly cadence, and its report is gitignored — none was run for this report. The "golden-set items" column shows only how many of the 18 curated items grade that member's own library entries.

## (a) Usage across sessions

| # | Member | Sessions seated | Sessions spoke | Turns | Passes | Side-conv. turns | Played by user | Raw citations | Verdicts (verified / unverified / uncertain) | In starter casts |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Aleister Crowley | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 3 |
| 2 | Arthur Edward Waite | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 1 |
| 3 | Pamela Colman Smith | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 1 |
| 4 | William Butler Yeats | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 2 |
| 5 | Helena Petrovna Blavatsky | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 1 |
| 6 | Éliphas Lévi | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 0 |
| 7 | Teresa of Ávila | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 1 |
| 8 | Ibn Arabi | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 1 |
| 9 | Maud Gonne | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 0 |
| 10 | Ramon Llull | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 0 |
| 11 | Ibn Khaldun | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 0 |
| 12 | John Dee | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 1 |
| 13 | Aby Warburg | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 1 |
| 14 | Henri Corbin | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 1 |
| 15 | Theodor Adorno | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 2 |
| 16 | Giordano Bruno | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 1 |
| 17 | Al-Hallaj | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 0 |
| 18 | Abraham Abulafia | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 0 |
| 19 | Lady Frieda Harris | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 1 |
| 20 | Dion Fortune | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 1 |
| 21 | William Blake | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 1 |
| 22 | Catherine Blake | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 0 |
| 23 | Frances Yates | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 0 |
| 24 | Gershom Scholem | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 0 |
| 25 | Moina Mathers | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 0 |
| 26 | Paschal Beverly Randolph | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 0 |
| 27 | Amadou Bamba | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 0 |
| 28 | Sun Ra | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 1 |
| 29 | Marguerite Porete | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 1 |
| 30 | Hildegard of Bingen | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 1 |
| 31 | Julian of Norwich | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 1 |
| 32 | Carl Jung | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 2 |
| 33 | Wolfgang Pauli | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 0 |
| 34 | Meister Eckhart | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 1 |
| 35 | Jakob Böhme | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 0 |
| 36 | Emanuel Swedenborg | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 0 |
| 37 | Paracelsus | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 1 |
| 38 | G.I. Gurdjieff | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | 2 |

## (b) Library excerpt coverage and (c) grounding eval coverage

`Authored` = entries in `prompts/library/library.json` whose `author` is this member (the voice-exemplar rule). `Assoc.` = entries that name them in `members` without being the author. Words are excerpt text with frontmatter removed.

| # | Member | Authored entries | Assoc. only | Licenses | Translated | Excerpt words | Golden-set items (v/u/unc) |
|---|---|---|---|---|---|---|---|
| 1 | Aleister Crowley | 2 | 3 | public-domain×2 | 0 | 447 | 3 (1/1/1) |
| 2 | Arthur Edward Waite | 1 | 2 | public-domain×1 | 0 | 277 | 0 (0/0/0) |
| 3 | Pamela Colman Smith | 1 | 1 | public-domain×1 | 0 | 200 | 0 (0/0/0) |
| 4 | William Butler Yeats | 2 | 3 | public-domain×2 | 0 | 375 | 0 (0/0/0) |
| 5 | Helena Petrovna Blavatsky | 2 | 1 | public-domain×2 | 0 | 408 | 3 (1/1/1) |
| 6 | Éliphas Lévi | 1 | 3 | public-domain×1 | 1 | 302 | 0 (0/0/0) |
| 7 | Teresa of Ávila | 2 | 5 | public-domain×2 | 2 | 467 | 0 (0/0/0) |
| 8 | Ibn Arabi | 1 | 4 | public-domain×1 | 1 | 269 | 3 (1/1/1) |
| 9 | Maud Gonne | 1 | 1 | public-domain×1 | 0 | 261 | 0 (0/0/0) |
| 10 | Ramon Llull | 1 | 0 | public-domain×1 | 1 | 189 | 0 (0/0/0) |
| 11 | Ibn Khaldun | 1 | 0 | public-domain×1 | 1 | 270 | 0 (0/0/0) |
| 12 | John Dee | 2 | 1 | public-domain×2 | 1 | 334 | 3 (1/1/1) |
| 13 | Aby Warburg | 1 | 0 | fair-use×1 | 1 | 187 | 0 (0/0/0) |
| 14 | Henri Corbin | 1 | 1 | fair-use×1 | 1 | 229 | 0 (0/0/0) |
| 15 | Theodor Adorno | 1 | 0 | fair-use×1 | 0 | 160 | 0 (0/0/0) |
| 16 | Giordano Bruno | 1 | 1 | public-domain×1 | 1 | 149 | 0 (0/0/0) |
| 17 | Al-Hallaj | 1 | 0 | public-domain×1 | 1 | 66 | 0 (0/0/0) |
| 18 | Abraham Abulafia | 1 | 0 | cc-by-4.0×1 | 1 | 212 | 0 (0/0/0) |
| 19 | Lady Frieda Harris | 1 | 0 | fair-use×1 | 0 | 189 | 0 (0/0/0) |
| 20 | Dion Fortune | 1 | 0 | public-domain×1 | 0 | 406 | 0 (0/0/0) |
| 21 | William Blake | 2 | 1 | public-domain×2 | 0 | 430 | 3 (1/1/1) |
| 22 | Catherine Blake | 1 | 0 | public-domain×1 | 0 | 358 | 0 (0/0/0) |
| 23 | Frances Yates | 1 | 0 | fair-use×1 | 0 | 127 | 0 (0/0/0) |
| 24 | Gershom Scholem | 1 | 0 | fair-use×1 | 1 | 160 | 0 (0/0/0) |
| 25 | Moina Mathers | 1 | 0 | public-domain×1 | 0 | 584 | 0 (0/0/0) |
| 26 | Paschal Beverly Randolph | 1 | 0 | public-domain×1 | 0 | 251 | 0 (0/0/0) |
| 27 | Amadou Bamba | 1 | 0 | fair-use×1 | 1 | 95 | 0 (0/0/0) |
| 28 | Sun Ra | 1 | 0 | fair-use×1 | 0 | 106 | 0 (0/0/0) |
| 29 | Marguerite Porete | 1 | 0 | public-domain×1 | 1 | 434 | 0 (0/0/0) |
| 30 | Hildegard of Bingen | 1 | 0 | public-domain×1 | 1 | 301 | 0 (0/0/0) |
| 31 | Julian of Norwich | 1 | 2 | public-domain×1 | 1 | 261 | 0 (0/0/0) |
| 32 | Carl Jung | 1 | 1 | public-domain×1 | 1 | 214 | 0 (0/0/0) |
| 33 | Wolfgang Pauli | 1 | 0 | fair-use×1 | 1 | 88 | 0 (0/0/0) |
| 34 | Meister Eckhart | 1 | 0 | public-domain×1 | 1 | 140 | 0 (0/0/0) |
| 35 | Jakob Böhme | 2 | 0 | public-domain×2 | 2 | 402 | 3 (1/1/1) |
| 36 | Emanuel Swedenborg | 2 | 0 | public-domain×2 | 2 | 492 | 0 (0/0/0) |
| 37 | Paracelsus | 1 | 0 | public-domain×1 | 1 | 117 | 0 (0/0/0) |
| 38 | G.I. Gurdjieff | 1 | 0 | fair-use×1 | 0 | 221 | 0 (0/0/0) |

## (d) Portrait facts and recorded sourcing/portrait difficulties

Tier is the project's own label from `public/portraits/*-PROMPTS.md` (see STYLE_GUIDE.md, "Known-vs-unknown likeness"). Likeness reference = a file in `public/portraits/likeness-refs/` (#541/#546). Difficulties are only what an issue or doc already records, with the link; absence means nothing recorded, not nothing wrong.

| # | Member | Tier | Likeness ref | Reaction set | Recorded difficulties |
|---|---|---|---|---|---|
| 1 | Aleister Crowley | Photographed | yes | yes | — |
| 2 | Arthur Edward Waite | Photographed | no | yes | — |
| 3 | Pamela Colman Smith | Photographed | yes | yes | — |
| 4 | William Butler Yeats | Photographed | no | yes | — |
| 5 | Helena Petrovna Blavatsky | Photographed | yes | yes | — |
| 6 | Éliphas Lévi | Photographed | yes | yes | — |
| 7 | Teresa of Ávila | Character study | no | yes | [#538](https://github.com/msdixon/secret-cabinet/issues/538) (closed): baseline portrait in a different visual sub-register than her reaction set |
| 8 | Ibn Arabi | Character study | no | yes | [#569](https://github.com/msdixon/secret-cabinet/issues/569) (open): deferred distinctiveness cluster with Ibn Khaldun |
| 9 | Maud Gonne | Photographed | no | yes | — |
| 10 | Ramon Llull | Character study | no | yes | [#569](https://github.com/msdixon/secret-cabinet/issues/569) (open): named "to a lesser extent" in the Eckhart/Bruno cluster |
| 11 | Ibn Khaldun | Character study | no | yes | [#569](https://github.com/msdixon/secret-cabinet/issues/569) (open): deferred distinctiveness cluster with Ibn Arabi |
| 12 | John Dee | Character study | no | yes | — |
| 13 | Aby Warburg | Photographed | yes | yes | — |
| 14 | Henri Corbin | Photographed | no | yes | [#574](https://github.com/msdixon/secret-cabinet/issues/574) (open): #558 regeneration rejected on review and reverted; no photographic grounding found<br>[#558](https://github.com/msdixon/secret-cabinet/issues/558): in the five-member distinctiveness batch |
| 15 | Theodor Adorno | Photographed | no | yes | — |
| 16 | Giordano Bruno | Character study | no | yes | [#569](https://github.com/msdixon/secret-cabinet/issues/569) (open): deferred distinctiveness cluster with Eckhart |
| 17 | Al-Hallaj | Character study | no | yes | [#569](https://github.com/msdixon/secret-cabinet/issues/569) (open): deferred distinctiveness cluster with Abulafia |
| 18 | Abraham Abulafia | Character study | no | yes | [#569](https://github.com/msdixon/secret-cabinet/issues/569) (open): deferred distinctiveness cluster with Al-Hallaj |
| 19 | Lady Frieda Harris | Photographed | no | yes | [#574](https://github.com/msdixon/secret-cabinet/issues/574) (open): #558 regeneration rejected on review and reverted; no archival photo confirmed<br>[#558](https://github.com/msdixon/secret-cabinet/issues/558): in the five-member distinctiveness batch |
| 20 | Dion Fortune | Photographed | no | yes | [#558](https://github.com/msdixon/secret-cabinet/issues/558): regrounded from a public-domain photo (fixed) |
| 21 | William Blake | Character study | no | yes | — |
| 22 | Catherine Blake | Character study | no | yes | — |
| 23 | Frances Yates | Photographed | no | yes | — |
| 24 | Gershom Scholem | Photographed | no | yes | [#558](https://github.com/msdixon/secret-cabinet/issues/558): regrounded from a photo (fixed) |
| 25 | Moina Mathers | Photographed | no | yes | — |
| 26 | Paschal Beverly Randolph | Photographed | yes | yes | — |
| 27 | Amadou Bamba | Photographed | no | no | [#474](https://github.com/msdixon/secret-cabinet/issues/474) (closed): reaction set held back at generation time (STYLE_GUIDE.md, 2026-08-29); routed to the generic silhouette |
| 28 | Sun Ra | Photographed | yes | yes | — |
| 29 | Marguerite Porete | Character study | no | yes | — |
| 30 | Hildegard of Bingen | Character study | no | yes | — |
| 31 | Julian of Norwich | Character study | no | yes | — |
| 32 | Carl Jung | Photographed | no | yes | — |
| 33 | Wolfgang Pauli | Photographed | yes | yes | [#558](https://github.com/msdixon/secret-cabinet/issues/558): regrounded from a photo (fixed) |
| 34 | Meister Eckhart | Character study | no | yes | [#569](https://github.com/msdixon/secret-cabinet/issues/569) (open): deferred distinctiveness cluster with Bruno (and Llull to a lesser extent) |
| 35 | Jakob Böhme | Character study | no | yes | — |
| 36 | Emanuel Swedenborg | Character study | no | yes | — |
| 37 | Paracelsus | Character study | no | yes | — |
| 38 | G.I. Gurdjieff | Photographed | no | yes | — |

---

_Generated by scripts/roster-evidence.js from 0 session(s), 46 library entries and 18 golden-set items. Read-only; changes no member, character file, portrait or MANIFEST row._
