# Portrait Style Guide

Source of truth for generating member portraits (#116, #27). Every generation run — the initial batch and any member added afterward — should be checked against this file first. If a run has to deviate to get a usable result, record it in the Changelog below so the next run doesn't silently drift further.

## Status

AI-generated, proof-of-concept register for this stage of the project. Not commissioned or licensed illustration. See [MANIFEST.md](../../MANIFEST.md) for the standing disclosure note.

## Baseline register (from #27)

- **Tone:** warm, etching-adjacent — not photorealistic, not cartoon/flat-vector.
- **Palette:** limited, warm-toned (sepia/candlelit register), consistent across the set — no member should read as lit or colored differently from the rest of the roster.
- **Composition:** head-and-shoulders, period-appropriate dress, plain/dark background (no scene elements — scene context is the 3D salon's job, not the portrait's, per #26/#28).
- **Line quality:** visible linework/texture (etching, engraving, ink-wash adjacent) rather than smooth airbrushed rendering.

## Known-vs-unknown likeness

- **Photographed figures** (e.g. Crowley, Yeats): generations should aim for recognizable likeness where reference material exists.
- **Pre-photographic or iconography-bound figures** (e.g. Llull, Teresa of Ávila, Ibn Arabi): there is no photographic ground truth — treat these as period-appropriate character studies consistent with the set's register, not likeness reproductions. For figures with an existing devotional/iconographic tradition, favor a secular character-study framing over reproducing religious iconography.

## Downstream use and format

Per #116, the dossier thumbnail and the eventual 3D avatar texture (#26/#28, blocked on #117) likely need different crops/resolutions. Until #117 resolves, generate for the dossier-sidebar use case only (`public/portraits/<id>.png`, portrait-oriented, thumbnail-appropriate resolution). Treat 3D-texture suitability as unverified until the rendering approach is chosen — don't assume today's crop drops straight into a texture later.

## Process

1. Batch 1: generate the full current roster (see `prompts/members/roster.json`) in one run to establish the baseline and catch consistency problems before they're spread across separate sessions.
2. Human-validate batch 1 against this guide before treating the style as locked.
3. Reconvene to confirm the baseline (or amend this guide) before generating any member added after batch 1.
4. For each member added to the roster afterward, generate one portrait against this guide, at the same time the member is added.

## Changelog

- 2026-07-30 — 30 of 33 batch 1 portraits placed in `public/portraits/`, resized from source (~1700-2050px) to 512px on the long edge (277MB → 10MB total — full-res sources are not committed, kept locally in `~/Downloads` as the archival copies pending #117's 3D-texture format decision). Two mechanical fixes applied before placement, not caught until inspecting every file individually (an automated dark-pixel heuristic proved unreliable — both false positives and negatives against the set's varying image dimensions and border styles): 5 files (crowley, waite, pixie/Coleman-Smith, yeats, blavatsky) had an identification label baked into the bottom of the image from whatever tool split them out of the review grid — cropped out at the source resolution before the resize. Levi and Teresa each had extra duplicate generations (`levi1.png`, `teresa2.png`, `teresa3.png`) — base-named files used as canonical per direction, duplicates left unplaced. Held back, not yet placed: Julian, Hildegard, Porete (see prior entry — still converged even after the v2 prompt revisions, per direct visual comparison; a William+Catherine Blake two-up image was also generated as an extra alongside working individual portraits for both and was discarded, not placed).
- 2026-07-30 — First generation pass run against the batch 1 prompts (external tool). Most of the set reads well and distinctly. One real issue found: Julian of Norwich, Hildegard of Bingen, and Marguerite Porete converged on near-identical images — their v1 prompts shared the same shape ("plain habit/veil, medieval woman, no likeness reference") with nothing structurally distinct for the generator to anchor on. Revised in [BATCH-1-PROMPTS.md](BATCH-1-PROMPTS.md) (marked v2) with one concrete, secular, non-devotional distinguishing detail per figure — Porete: informal lay veil with visible hair + a held book; Hildegard: severe wimple, elderly bearing, quill and manuscript corner; Julian: shadowed/downcast face, faint anchorhold-window detail in the background. Also surfaced: a two-up William Blake + Catherine Blake image generated together rather than as separate portraits — needs a re-run, since the two need independent `william-blake.png`/`catherine-blake.png` files. Batch still mid-validation; not yet placed into `public/portraits/`.
- 2026-07-30 — Batch 1 prompts drafted for the full 33-member roster: [BATCH-1-PROMPTS.md](BATCH-1-PROMPTS.md). No image-generation tool is connected in this project's Claude Code environment, so prompts are written for external generation (Midjourney/DALL-E/etc.) rather than run in-repo. Actual images not yet generated — pending Rachel running the prompts and dropping results into `public/portraits/<id>.png`.
- 2026-07-27 — Guide established ahead of batch 1. No baseline images generated yet.
