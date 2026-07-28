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

- 2026-07-27 — Guide established ahead of batch 1. No baseline images generated yet.
