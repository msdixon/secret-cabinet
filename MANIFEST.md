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

**No tiers.** Membership is `guest: true/false` in `roster.json`, full stop. Whether someone is cast often or rarely is a fact about sessions, not a label on the person — see *Promotion by use* below.

**No separate cadre for absent presences, either.** Any member — core or guest — can be cast as a silent, named-but-not-speaking presence in a given session (see `lodge-context.md`, ABSENT PRESENCE). This is a per-session casting choice, not a fixed property of the member.

---

## Members (core, guest: false)

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

---

## In the room right now

**Active context:** Novel research · PreSeedings entries
**As of:** 2026-07-07

Seated:
- Aleister Crowley
- Arthur Edward Waite
- Pamela Colman Smith
- W.B. Yeats
- Helena Petrovna Blavatsky
- Éliphas Lévi
- Teresa of Ávila
- Ibn Arabi

Guest stars:
- (none currently toggled in)

---

## Guests (guest: true)

Full character files. Not automatically seated; cast per session same as core members, just not defaulted-in.

| Member | Register | File |
|--------|----------|------|
| Maud Gonne | Political, embodied, will not be recast as anyone's muse in this room | maud-gonne.md |
| Ramon Llull | Combinatorial reasoning, machine of truth | llull.md |
| Ibn Khaldun | Sociological structure, cyclical history | ibn-khaldun.md |
| John Dee | Angelic conversation, scrying as method | john-dee.md |
| Aby Warburg | Image-survival, the interval, studies the fire having nearly been consumed by it | warburg.md |
| Henri Corbin | The imaginal as real register, not metaphor — insists on the distinction | corbin.md |
| Theodor Adorno | Reads occultism as symptom; the standard is a Mahler adagio, and almost nothing clears it | adorno.md |
| Giordano Bruno | Incandescent, refuses to recant, the infinite meant literally | bruno.md |
| Al-Hallaj | Ecstatic utterance, annihilation rather than inflation, went to the marketplace | al-hallaj.md |
| Abraham Abulafia | Combinatorial letter-technique toward prophecy, certain, restless | abulafia.md |
| Lady Frieda Harris | Precise, dry, the actual executant — corrects Crowley on composition without deferring | frieda-harris.md |
| Dion Fortune | Applied psychology as magic; describes mechanism, distrusts mystification | dion-fortune.md |
| William Blake | Fourfold vision against single vision; prophetic, incantatory, held Infinity literally | william-blake.md |
| Catherine Blake | A different ruler than independence — measures partnership by forty-five years of mutual flourishing, not credentials | catherine-blake.md |

---

## Promotion by use

Guest status is not permanent and not a judgment — it just means "not yet shown to be load-bearing." Mirroring Eastern Cabin'ét's precedent:

> If a guest appears in three or more sessions, they're considered for promotion (guest → core, i.e. `guest: false`, defaulted into the room).

This is a `roster.json` flip, not a rewrite — a promoted guest's file doesn't need new content, only reclassification. Track session appearances via the existing session logs / knowledge graph co-convened-member data (`/api/graph`), not by memory.

---

## Draft files vs. full character files

Two states exist for member content, and only one is canon:

**Full character file** (what every row above points to): hand-tuned, matches the depth of the twelve existing files. Built once, reviewed, stable.

**Draft file**: output of the in-app generator (`POST /api/members`), used for a one-off user-typed member when a quick simulation is needed in the room. Disposable by default — not required to meet the bar below unless it's being promoted.

### Draft → full promotion rubric

A draft earns full-file status when it has been cast enough to be worth the investment (use the same "three sessions" signal as guest promotion, or a deliberate decision to hand-write it up front) **and** meets all of the following:

- [ ] At least one bespoke named section beyond the generator's five (a "THE ___" section unique to this person — not a generic template slot)
- [ ] A complete relationship paragraph for every *currently-seated* member, not just a subset
- [ ] A clear, specific erotic/humor register per lodge-context.md's REGISTER PERMISSIONS section — not silently defaulted to none
- [ ] At least one honest complicating note in WHO YOU ARE (the thing the character would rather not examine)

Until a draft clears this checklist, treat its output in a transcript as provisional — useful for that session, not load-bearing for future relationship-writing the way the twelve core files are.

---

## Namespace disambiguation

- **Aleister Crowley** here is the *lodge-context* Crowley — based on the historical man and tuned to be in conversation with other esotericists and representative of the early 20th-century occult faction. **Not the same as the Journal Cabin'ét's Crowley**, who is a journal-context provocateur tuned for Rachel's writing.

---

## Provenance

Sibling to [dossier-placard](https://github.com/msdixon/dossier-placard) (the Journal Cabin'ét). Promotion-by-use rule adapted from Eastern Cabin'ét (`cabin-et/MANIFEST.md`, wagscrum), which established the "three cases → considered for permanent membership" precedent this document mirrors in the original collision room practice.

See `AXES.md` for interpretive lenses discovered while writing members — not part of the runtime prompt, consulted when building or revisiting a character.

*Last updated: 2026-07-07.*
