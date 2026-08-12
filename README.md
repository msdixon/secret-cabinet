# The Secret-Cabin-et

A local web application for research into the novel. Runs AI-powered salon conversations between historical esotericists, scientists, other thinkers in a room outside of time, for the purposes of uncovering new work/frictions/intersections/questions and general drama, to make online research as sparkly as it is in the meatspace.

(An MVP of a proposal from my DH grad program: what if the archives were "playable"?)

A document is read aloud. The lodge responds.

---

## The Lodge

The founding eight — cast per session like everyone else, not permanently seated (see below):

| Member | Register |
|--------|----------|
| Aleister Crowley | Associatively scrambled, solipsistic, seductive through confusion |
| Arthur Edward Waite | Pedantic, architecturally elaborate, spiritually tragic |
| Pamela Colman Smith | Quick, imagistic, learning to take up more space in this room |
| W.B. Yeats | Bardic, aestheticizes everything, carries the George question |
| Helena Petrovna Blavatsky | Imperious, genuinely funny, synthesis holds even when sources don't |
| Éliphas Lévi | Epigrammatic, French, always building toward the one clarifying sentence |
| Teresa of Ávila | Went in directly without a system; her irony is only legible to the women |
| Ibn Arabi | Radical clarity, few words, holds receipts and deploys once at the right moment |

The roster keeps growing — every member above is cast per session rather than always seated. See `docs/MANIFEST.md` for the current full list; it's the source of truth, so this README doesn't go stale every time a member is added.

The room exists outside time. Members do not remember previous meetings. No one knows they are being observed.

---

## Architecture

- **`server.js`** — Express server. Proxies all Anthropic API calls server-side. A session is a continuous stream of passages separated by lulls — no preordained round count — each passage building on the last (genuine cross-talk, not parallel independent responses).
- **`dayone.js`** — MCP client that spawns `/usr/local/bin/dayone mcp` via stdio. Handles journal fetch and transcript export.
- **`prompts/lodge-context.md`** — The shared system prompt foundation: the conceit of the room, the terms of being there, the voice parameters.
- **`prompts/members/`** — One file per lodge member. Each character is built on top of the lodge context.
- **`public/`** — Frontend served statically. Dark fire aesthetic. No framework.
- **`sessions/`** — Session JSON persisted locally. Not committed.

### Sibling relationship

This app is a sibling to [dossier-placard](https://github.com/msdixon/dossier-placard) (the meta-cabinet / Journal Cabin'ét). They share no files, no state, and no characters. The Crowley here is tuned specifically for the lodge context and is not the same as any Crowley in the meta-cabinet.

---

## Setup

```bash
git clone https://github.com/msdixon/secret-cabinet
cd secret-cabinet
npm install
cp .env.example .env   # add your Anthropic API key
npm run dev
```

Open `http://localhost:3132`.

**Requirements:**
- Node.js 18+
- Day One CLI installed at `/usr/local/bin/dayone` (for journal integration)
- Anthropic API key

---

## Day One Integration

Connected to the **PreSeedings of the Secret Cabinet** journal only.

- **Fetch** — Select "fetch from Day One" in the source dropdown to pull the latest entry directly into the document field.
- **Export** — After a session, the export panel saves the full transcript back to the same journal, tagged `secret-cabinets, meeting-notes, generated`.

### `/secret-lodge` skill

From any Claude Code session:

```
/secret-lodge
```

Fetches the latest PreSeedings entry and runs the full lodge conversation inline, passage by passage until the room reaches a lull. `/secret-lodge 2` uses the second most recent entry. The server must be running.

---

## Usage

1. Start the server: `npm run dev`
2. Open `http://localhost:3132`
3. Paste a research note, or fetch the latest Day One entry
4. Adjust which members are present for this session
5. **Convene the Lodge** — the room speaks in passages until it reaches a lull, then waits: **Continue**, or let it end
6. **Silent Bob Protocol** — interject into the conversation as an anonymous presence; the room responds
7. **Stir the room again** — after a meeting ends, re-open it from the after-panel
8. Export the transcript to Day One or download as `.txt`

---

## Environment

```
ANTHROPIC_API_KEY=your-key-here
PORT=3132
```

The `.env` file is never committed. On a fresh clone, create it manually or copy from a secure location.

**Running multiple worktrees at once:** every worktree shares the same root `.env`, so they all default to `PORT=3132`. Either run `PORT=3200 npm run dev` in a given worktree to pick your own port, or just start it with no override — if 3132 is taken, the server scans upward (3133, 3134, ...) and logs whichever port it actually bound.

---

*The fire is lit. The room remembers nothing. The document waits.*
