# Secret-Cabin-et — Project Update
*June 22, 2026*

## What it is

The Secret-Cabin-et is a research tool that convenes a salon of historical esotericists — Crowley, Waite, Coleman-Smith, Yeats, Blavatsky, Lévi, Teresa of Ávila, Ibn Arabi, plus occasional guests Maud Gonne, Ramon Llull, Ibn Khaldun, and John Dee — to discuss a document the user provides. The lodge debates across multiple rounds in each member's distinct historical voice. Sessions are saved, searchable, taggable, and exportable to Day One, Obsidian, or Ulysses.

It's deployed and live, privately, for personal research use, accessible from any device.

## What shipped this cycle

**Foundational features**
- Archival material library — 10 curated primary-source excerpts (Crowley's Golden Dawn schism account, Yeats's first automatic-writing session, Blavatsky on the Astral Light, and more) usable as document sources alongside pasted text and Day One entries
- Knowledge graph — historical relationships between members, texts, and themes, accumulating automatically as sessions are run
- Speaker identity glyphs — each member has a historically-grounded symbol (Crowley's Mercury sigil, Dee's Monas Hieroglyphica mark, etc.) rendered beside their name

**The recursive feature I'm most excited about**
"The Lodge Beyond the Lodge" — a finished transcript can become the document for a *new* session. The lodge reads and responds to its own prior conversation as a found historical record, with a deliberate framing ("a record has been passed around the table, authorship uncertain") that creates critical distance even when the same cast reconvenes. User annotations from the first session travel into the document as inline marginalia, so the new lodge encounters both the original exchange and the reader's reactions to it.

**Witness mode** — a theatrical, auto-advancing playback of any finished session, paced to reading speed, with chat-bubble presentation (alternating speaker sides, centered stage directions). Turns a transcript into something you watch rather than just read.

**Infrastructure**
- Deployed to Railway with passphrase-protected access — private but usable from any device
- Abbreviated system prompts for rounds 2+ cut per-round token cost by ~85%, meaningfully speeding up longer sessions
- Various UX fixes: clearer shadow-member (absent presence) controls, plain-text export fidelity, chat-bubble transcript layout

## What's next

Near-term: small UX polish items (Witness go-back navigation, consolidated post-session actions, library search UI).

The next architecturally significant step is moving from one model call generating the whole round to one model call per speaker — this unlocks more distinct voices, sets up live theatrical playback (rather than replay-only), and is a prerequisite for eventually giving each member true agency in the room.

Longer-horizon vision (unscheduled): a 3D salon environment with seated member avatars, voice synthesis, illustrated portraits, and a "player-as-member" mode where the user writes as one historical figure while the rest of the lodge responds in character.

---
*Built with Claude Code. Full backlog tracked on GitHub: github.com/msdixon/secret-cabinet*
