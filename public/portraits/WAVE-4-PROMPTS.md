# Wave 4 Portrait Prompts

Ready-to-paste generation prompts for the 5 members added in the Wave 4 roster expansion ([PR #249](https://github.com/msdixon/secret-cabinet/pull/249), 2026-08-10: Meister Eckhart, Jakob Böhme, Emanuel Swedenborg, Paracelsus, G.I. Gurdjieff), per [STYLE_GUIDE.md](STYLE_GUIDE.md)'s Process step 4 ("for each member added to the roster afterward, generate one portrait against this guide"). That step was missed when #249 shipped — [#258](https://github.com/msdixon/secret-cabinet/issues/258) is the backfill closing the gap. Each entry is self-contained, matching [BATCH-1-PROMPTS.md](BATCH-1-PROMPTS.md)'s convention — the baseline register (tone, palette, composition, line quality) is restated in every prompt so nothing depends on external context once pasted into a generation tool.

Save each result as `public/portraits/<id>.png`, portrait-oriented, resized to 512px on the long edge to match the rest of the set (see STYLE_GUIDE.md's batch 1 changelog entry for the resize precedent — full-res sources kept locally, not committed).

**Likeness tier**, per STYLE_GUIDE.md's known-vs-unknown-likeness section:
- **Photographed** — aim for recognizable likeness against surviving photographs.
- **Character study (known painted/engraved likeness)** — no photograph, but a well-known contemporary painted or engraved portrait survives; use it as a loose likeness anchor while keeping the set's etching register, not a direct reproduction (same treatment as John Dee's entry in BATCH-1-PROMPTS.md).

---

## Meister Eckhart (`eckhart`) — c.1260–1328 — Character study

Warm, etching-adjacent portrait of Meister Eckhart, German Dominican friar and mystical theologian, early 14th century — head-and-shoulders, Dominican habit (white tunic, black scapular and cappa, hood), the bearing of a senior churchman who administered an entire province (Vicar-General of Bohemia) rather than a cloistered contemplative — composed, level, unflinching gaze, appropriate to a man who defended his propositions before an inquisition rather than recanting. No photographic or contemporary likeness reference exists; render as a period-appropriate character study consistent with the set's register, not a specific likeness reproduction. Visible linework and texture (engraving/ink-wash register), not photorealistic or cartoon/flat-vector. Limited warm sepia/candlelit palette, consistent across a set. Plain dark background, no scene elements. Portrait-oriented, thumbnail resolution.

## Jakob Böhme (`bohme`) — 1575–1624 — Character study (known engraved likeness)

Warm, etching-adjacent portrait of Jakob Böhme, German shoemaker and mystic, early 17th century — head-and-shoulders, plain burgher/tradesman's dress (not scholar's robes or clerical dress — he had no Latin and no theological training), a cobbler's awl or scrap of leatherwork visible at the frame's edge as a concrete trade marker, an intense, inward, faintly startled expression consistent with a man describing what a beam of light off a pewter dish showed him. Surviving 17th-century engraved frontispiece portraits exist from posthumous editions of his work; use them as a loose likeness anchor while keeping the set's etching register, not a direct reproduction. Visible linework and texture (engraving/ink-wash register), not photorealistic or cartoon/flat-vector. Limited warm sepia/candlelit palette, consistent across a set. Plain dark background, no scene elements. Portrait-oriented, thumbnail resolution.

## Emanuel Swedenborg (`swedenborg`) — 1688–1772 — Character study (known painted likeness)

Warm, etching-adjacent portrait of Emanuel Swedenborg, Swedish scientist and visionary, 18th century — head-and-shoulders, formal 18th-century dress appropriate to a Swedish assessor of the Royal College of Mines (plain coat, natural or lightly-powdered white hair, no ostentation), a calm, level, almost clinical directness of gaze — the same observational bearing he brought to the anatomy of the brain and to his accounts of heaven and hell alike. A well-known contemporary oil portrait survives (Per Krafft the Elder); use it as a loose likeness anchor while keeping the set's etching register, not a direct reproduction. Visible linework and texture (engraving/ink-wash register), not photorealistic or cartoon/flat-vector. Limited warm sepia/candlelit palette, consistent across a set. Plain dark background, no scene elements. Portrait-oriented, thumbnail resolution.

## Paracelsus (`paracelsus`) — c.1493–1541 — Character study (known painted likeness)

Warm, etching-adjacent portrait of Paracelsus (Theophrastus von Hohenheim), Swiss-German physician and alchemist, early 16th century — head-and-shoulders, unconventional dress for a physician of his era (plain traveling clothes rather than an academic gown, no doctoral cap — he burned the authoritative medical text of his own field in front of his students), a combative, direct, faintly challenging expression. The hilt of his long sword — rumored among students to contain a store of his own medicines — visible at one shoulder as a concrete distinguishing detail. Surviving 16th-century painted and engraved portraits exist; use them as a loose likeness anchor while keeping the set's etching register, not a direct reproduction. Visible linework and texture (engraving/ink-wash register), not photorealistic or cartoon/flat-vector. Limited warm sepia/candlelit palette, consistent across a set. Plain dark background, no scene elements. Portrait-oriented, thumbnail resolution.

## G.I. Gurdjieff (`gurdjieff`) — c.1866–1949 — Photographed

Warm, etching-adjacent portrait of G.I. Gurdjieff, Greek-Armenian teacher born in the Caucasus, early 20th century — head-and-shoulders, shaved/bald head, heavy dark mustache, formal early-20th-century dress, an intense, magnetic, faintly amused direct gaze — the bearing of a man running an institute rather than a monastery. Aim for a recognizable likeness consistent with surviving photographs. Visible linework and texture (engraving/ink-wash register), not photorealistic or cartoon/flat-vector. Limited warm sepia/candlelit palette, consistent across a set. Plain dark background, no scene elements. Portrait-oriented, thumbnail resolution.

---

## Changelog

- 2026-08-12 — Prompt sheet drafted for the 5 Wave 4 members (#258), ready for external generation via Nano Banana, following BATCH-1-PROMPTS.md's format and STYLE_GUIDE.md's baseline register.
