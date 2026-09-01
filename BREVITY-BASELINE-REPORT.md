# Brevity/Tangent Baseline — #513 Phase 1

[#513](https://github.com/msdixon/secret-cabinet/issues/513) phase 1 — measurement only, not the lever. 11 local session(s) (2026-05-20 to 2026-08-05), 430 total beats, 324 spoken.

**Data-availability caveat:** every session measured here predates [#355](https://github.com/msdixon/secret-cabinet/issues/355) (always-on per-beat citation capture, shipped 2026-08-20) — none carry a `beats` array or usable `citationFlags`. Citation figures below come from a conservative text heuristic (`looksLikeCitation`), not the real per-beat model verdict — treat them as a lower bound, not an exact count. Turn length and passed-proportion are exact regardless. Re-run this script once sessions generated after 2026-08-20 accumulate — it will use the real structured data automatically wherever a round carries `beats`.

## Aggregate

- Average spoken-turn length: **88 words** (median 43)
- Turns carrying a citation: **6.5%** of spoken turns (21/324)
- Beats resolving as `passed`/pure-action: **24.7%** of all beats (106/430)

## By member

| Member | Length tendency | Beats | Passed % | Avg words (spoken) | Median words | Citation % |
|---|---|---|---|---|---|---|
| Teresa of Ávila | medium | 84 | 29.8% | 37 | 30 | 1.7% |
| Crowley | expansive | 56 | 28.6% | 146 | 47 | 15.0% |
| Yeats | expansive | 54 | 33.3% | 48 | 38 | 5.6% |
| Waite | medium | 52 | 23.1% | 46 | 32 | 7.5% |
| Maud Gonne | medium | 45 | 33.3% | 37 | 29 | 3.3% |
| Ibn Arabi | medium | 42 | 4.8% | 52 | 50 | 0.0% |
| Coleman-Smith | medium | 34 | 20.6% | 37 | 18 | 3.7% |
| John Dee | medium | 22 | 22.7% | 179 | 63 | 11.8% |
| Blavatsky | medium | 19 | 21.1% | 41 | 41 | 0.0% |
| Lévi | medium | 10 | 20.0% | 61 | 63 | 0.0% |
| Frances Yates | medium | 3 | 0.0% | 708 | 739 | 0.0% |
| Gershom Scholem | medium | 3 | 0.0% | 749 | 793 | 0.0% |
| Moina Mathers | medium | 3 | 0.0% | 662 | 601 | 66.7% |
| Hildegard of Bingen | medium | 1 | 0.0% | 419 | 419 | 100.0% |
| William Blake | medium | 1 | 0.0% | 564 | 564 | 100.0% |
| Sun Ra | medium | 1 | 0.0% | 1123 | 1123 | 100.0% |

---

_Repeatable — run `node scripts/measure-brevity-baseline.js` again once more sessions accumulate, especially post-#355 ones with real per-beat citation data. This script does not modify `tuning.js` or any pipeline behavior; picking a lever (director-prompt nudge, widening `LENGTH_TENDENCY_OVERRIDES`, a structural banter beat) is deferred to a follow-up per the issue._