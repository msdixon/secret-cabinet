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
| Pamela Colman Smith | Quick, imagistic, visual talker |
| W.B. Yeats | Bardic, aestheticizes everything, has thoughts about some of his Golden Dawn alums |
| Helena Petrovna Blavatsky | Imperious, genuinely funny, synthesis holds even when sources don't |
| Éliphas Lévi | Epigrammatic, Frenchified, always building toward the one clarifying sentence |
| Teresa of Ávila | Went in directly without a system; depth for centuries |
| Ibn Arabi | Radical clarity, few words, holds receipts and deploys once at the right moment |

The roster keeps growing — every member is cast per session. See `docs/MANIFEST.md` for the current full list; it's the source of truth, so this README doesn't go stale every time a member is added.

The room exists outside time. ~~Members do not remember previous meetings. No one knows they are being observed.~~

---

## Architecture

- **`server.js`** — Express server, and the only application file at the repo root. Proxies all Anthropic API calls server-side. A session is a continuous stream of passages separated by lulls — no preordained round count — each passage building on the last (genuine cross-talk, not parallel independent responses).
- **`src/`** — Everything `server.js` requires: the salon engine (`pipeline.js`), roster/library/citation/graph logic, auth, and session persistence.
- **`src/routes/`** — One module per route group (`convene`, `session`, `library`, `member`, `export`, `graph`, `upload`). Each exports a single `register<X>Routes(app, deps)` and takes its dependencies as an explicit parameter rather than reaching for module-level singletons.
- **`src/dayone.js`** — MCP client that spawns `/usr/local/bin/dayone mcp` via stdio. Handles journal fetch and transcript export.
- **`prompts/lodge-context.md`** — The shared system prompt foundation: the conceit of the room, the terms of being there, the voice parameters.
- **`prompts/members/`** — One file per lodge member. Each character is built on top of the lodge context.
- **`public/`** — Frontend served statically. `index.html` and `lodge.html` sit at the top, scripts live in `public/js/` (each an IIFE assigning one `window.X`, loaded as plain `<script>` tags), styles in `public/css/`, and portraits/archival images in their own folders.
- **`sessions/`** — Session JSON persisted locally. Not committed.

### Sibling relationship

This app is the main individual project of many collision room efforts - a full breakdown is available at  [dossier-placard](https://github.com/msdixon/dossier-placard) (the meta-cabinet / Journal Cabin'ét). They share no files, no state, and no characters - duplicates (such as Crowley) notwithstanding.

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

Fetches the latest DayOne entry in a specialized journal, and runs the full lodge conversation inline, passage by passage until the room reaches a lull. `/secret-lodge 2` uses the second most recent entry. The server must be running.

---

## Usage

1. Start the server: `npm run dev`
2. Open `http://localhost:3132`
3. Paste a research note, ask a question, or fetch the latest Day One entry
4. Adjust which members are present for this session
5. **Convene the Lodge** — the room speaks in passages until it reaches a lull, then waits: **Continue**, or let it end
6. Participate during the session as a "player",getting a prompt to respond in real time. Alternately, ask a question of the room once they have concluded. 
7. **Stir the room again** — after a meeting ends, you can replay it or redo it it from the side-panel
8. Export the transcript to Day One, Ulysses, or Obsidian — or download as `.txt`
9. Gather bibliographic information from any texts listed in the conversation, validated by source (WorldCat, Archive.org etc)
10. Check out how each member of the lodge is linked (virtually and historically) and review their texts from the lodge members page.

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
