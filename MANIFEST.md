---
cabinet: secret-cabin-et
display_name: Secret-Cabin-et
desk: Secret (Rachel)
formed: 2026-04-15
purpose: Lodge of historical esotericists in salon for research
home_repo: https://github.com/msdixon/secret-cabinet
member_dir: prompts/members
roster_file: prompts/members/roster.json
---

# MANIFEST

Standing roster of the Secret-Cabin-et. Source of truth for the meta-cabinet index.

> The Secret-Cabin-et runs a salon of historical esotericists outside of time. A document is read aloud; the lodge responds in three rounds of genuine cross-talk. Members do not remember previous meetings. No one knows they are being observed.

**No tiers.** `roster.json` does not distinguish members by how often they're cast. Whether someone appears in every session or one is a fact about that session's casting, not a label on the person. (Until 2026-07-09 the roster carried a `guest: true/false` field; it was removed after an audit found its only live effect was a small "arrives without introduction" narrative flourish in `lodge-context.md` that wasn't earning its keep — see git history for the fuller account.)

(The roster also briefly supported an "Absent Presence" mode — a member named but not speaking in a given session. Removed 2026-07-10: it had been broken since it shipped — the field a session read to check who was silently present never matched the field a session wrote — so it silently applied to at most one round per session, and wasn't used enough to be worth fixing. See git history for the fuller account.)

---

## Members

| # | Member | Register | File |
|---|--------|----------|------|
| 1 | Aleister Crowley | Associatively scrambled, solipsistic, seductive through confusion | crowley.md |
| 2 | Arthur Edward Waite | Pedantic, architecturally elaborate, spiritually tragic | waite.md |
| 3 | Pamela Colman Smith | Quick, imagistic, learning to take up more space | coleman-smith.md |
| 4 | W.B. Yeats | Bardic, aestheticizes everything, carries the George question | yeats.md |
| 5 | Helena Petrovna Blavatsky | Imperious, genuinely funny, synthesis holds even when sources don't | blavatsky.md |
| 6 | Éliphas Lévi | Epigrammatic, French, always building toward the one clarifying sentence | levi.md |
| 7 | Teresa of Ávila | Went in directly without a system; her irony is only legible to the women | teresa.md |
| 8 | Ibn Arabi | Radical clarity, few words, holds receipts and deploys once at the right moment | ibn-arabi.md |
| 9 | Maud Gonne | Political, embodied, will not be recast as anyone's muse in this room | maud-gonne.md |
| 10 | Ramon Llull | Combinatorial reasoning, machine of truth | llull.md |
| 11 | Ibn Khaldun | Sociological structure, cyclical history | ibn-khaldun.md |
| 12 | John Dee | Angelic conversation, scrying as method | john-dee.md |
| 13 | Aby Warburg | Image-survival, the interval, studies the fire having nearly been consumed by it | warburg.md |
| 14 | Henri Corbin | The imaginal as real register, not metaphor — insists on the distinction | corbin.md |
| 15 | Theodor Adorno | Reads occultism as symptom; the standard is a Mahler adagio, and almost nothing clears it | adorno.md |
| 16 | Giordano Bruno | Incandescent, refuses to recant, the infinite meant literally | bruno.md |
| 17 | Al-Hallaj | Ecstatic utterance, annihilation rather than inflation, went to the marketplace | al-hallaj.md |
| 18 | Abraham Abulafia | Combinatorial letter-technique toward prophecy, certain, restless | abulafia.md |
| 19 | Lady Frieda Harris | Precise, dry, the actual executant — corrects Crowley on composition without deferring | frieda-harris.md |
| 20 | Dion Fortune | Applied psychology as magic; describes mechanism, distrusts mystification | dion-fortune.md |
| 21 | William Blake | Fourfold vision against single vision; prophetic, incantatory, held Infinity literally | william-blake.md |
| 22 | Catherine Blake | A different ruler than independence — measures partnership by forty-five years of mutual flourishing, not credentials | catherine-blake.md |
| 23 | Frances Yates | Every total system wants control; takes her own thesis's later correction as the method working correctly | yates.md |
| 24 | Gershom Scholem | Historian of the false messiah; will not let "Qabalah" pass for Kabbalah | scholem.md |
| 25 | Moina Mathers | First woman initiated into the Golden Dawn; built the practical apparatus theory ran on; the antagonist, finally given voice | moina-mathers.md |
| 26 | Paschal Beverly Randolph | Built Rosicrucianism in America from nothing; precise and unresolved about who profited from it | randolph.md |
| 27 | Amadou Bamba | Greater jihad as method, not metaphor; seven tons of paper written in colonial exile | bamba.md |
| 28 | Sun Ra | Saturn is not a metaphor; etymology as excavation, not wordplay | sun-ra.md |

---

## In the room right now

**Active context:** Novel research · PreSeedings entries
**As of:** 2026-07-09

Seated:
- Aleister Crowley
- Arthur Edward Waite
- Pamela Colman Smith
- W.B. Yeats
- Helena Petrovna Blavatsky
- Éliphas Lévi
- Teresa of Ávila
- Ibn Arabi

---

## Draft files vs. full character files

Two states exist for member content, and only one is canon:

**Full character file** (what every row above points to): hand-tuned, matches the depth of the existing files. Built once, reviewed, stable.

**Draft file**: output of the in-app generator (`POST /api/members`), used for a one-off user-typed member when a quick simulation is needed in the room. Disposable by default — not required to meet the bar below unless it's being promoted.

### Draft → full promotion rubric

A draft earns full-file status when it has been cast enough to be worth the investment (a "three sessions" signal, or a deliberate decision to hand-write it up front) **and** meets all of the following:

- [ ] At least one bespoke named section beyond the generator's five (a "THE ___" section unique to this person — not a generic template slot)
- [ ] A complete relationship paragraph for every *currently-seated* member, not just a subset
- [ ] A clear, specific erotic/humor register per lodge-context.md's REGISTER PERMISSIONS section — not silently defaulted to none
- [ ] At least one honest complicating note in WHO YOU ARE (the thing the character would rather not examine)

Until a draft clears this checklist, treat its output in a transcript as provisional — useful for that session, not load-bearing for future relationship-writing the way the existing full character files are.

---

## Namespace disambiguation

- **Aleister Crowley** here is the *lodge-context* Crowley — based on the historical man and tuned to be in conversation with other esotericists and representative of the early 20th-century occult faction. **Not the same as the Journal Cabin'ét's Crowley**, who is a journal-context provocateur tuned for Rachel's writing.

---

## Provenance

Sibling to [dossier-placard](https://github.com/msdixon/dossier-placard) (the Journal Cabin'ét).

See `AXES.md` for interpretive lenses discovered while writing members — not part of the runtime prompt, consulted when building or revisiting a character.

*Last updated: 2026-07-23.*
