'use strict';

require('dotenv').config({ override: true });
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dayOne = require('./dayone');

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PORT = process.env.PORT || 3132;
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const PROMPTS_DIR = path.join(__dirname, 'prompts');
const MEMBERS_DIR = path.join(PROMPTS_DIR, 'members');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Lodge roster ────────────────────────────────────────────────────────────
// Loaded from roster.json; reloadRoster() refreshes in-memory copy after writes.

const ROSTER_FILE = path.join(MEMBERS_DIR, 'roster.json');
let ROSTER = [];

function reloadRoster() {
  ROSTER = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));
}
reloadRoster();

const lodgeContext = fs.readFileSync(path.join(PROMPTS_DIR, 'lodge-context.md'), 'utf8');

function loadMemberFile(filename) {
  if (!filename) return '';
  const p = path.join(MEMBERS_DIR, filename);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

// ─── Session persistence ──────────────────────────────────────────────────────

function makeSessionId(entry) {
  const date = new Date().toISOString().slice(0, 10);
  const slug = entry.trim().slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const hash = crypto.createHash('md5').update(entry).digest('hex').slice(0, 6);
  return `${date}-${slug}-${hash}`;
}

function saveSession(session) {
  fs.writeFileSync(path.join(SESSIONS_DIR, `${session.id}.json`), JSON.stringify(session, null, 2));
}

function loadSession(id) {
  const p = path.join(SESSIONS_DIR, `${id}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

// ─── System prompt builder ────────────────────────────────────────────────────

function buildSystemPrompt(memberIds, artifact = null) {
  const present = memberIds
    .map(id => ROSTER.find(m => m.id === id))
    .filter(Boolean);

  const guests = present.filter(m => m.guest);
  // Guests with full character files are treated identically to core members
  const fullMembers = present.filter(m => m.file);
  const sketchOnlyGuests = guests.filter(m => !m.file);

  const presentNames = present.map(m => m.name).join(', ');
  const guestLine = guests.length ? `\nOCCASIONAL GUESTS PRESENT TONIGHT: ${guests.map(m => m.name).join(', ')}` : '';

  // Build character sections — inject artifact as private context for the named recipient
  const artifactMember = artifact?.memberId ? ROSTER.find(m => m.id === artifact.memberId) : null;
  const characterSections = fullMembers
    .map(m => {
      const text = loadMemberFile(m.file);
      if (!text) return '';
      const artifactNote = (artifactMember && m.id === artifactMember.id && artifact.text?.trim())
        ? `\n\n---\n\n## PRIVATE — BEFORE THE MEETING BEGAN\n\nBefore the others arrived, you were shown the following. No one else in the room has seen it. You may reference it, produce it at the right moment, withhold it entirely, or let it colour what you say without naming it. The choice is yours.\n\n${artifact.text.trim()}`
        : '';
      return `---\n${text}${artifactNote}`;
    })
    .filter(Boolean)
    .join('\n\n');

  // Fallback sketches for guests without files (future-proofing)
  const guestSketches = sketchOnlyGuests.map(m => {
    const sketches = {};
    return sketches[m.id] ? `---\n**${m.name}** (occasional guest)\n${sketches[m.id]}` : '';
  }).filter(Boolean).join('\n\n');

  return `${lodgeContext}

---

## ASSEMBLED TONIGHT

PRESENT: ${presentNames}${guestLine}

${characterSections}

${guestSketches}

---

## FORMAT INSTRUCTIONS

Generate a salon transcript. Each speaker's name appears alone on a line, followed by their speech on the next line(s). 3-5 members speak per round — not every member speaks every round. Silences are valid. Members may address each other by name, quote each other, disagree, complete each other's sentences, let something drop, change the subject entirely.

Physical actions, gestures, stage business, and pauses are written in *single asterisks*, either inline within speech or on their own line. Unattributed room-level beats (*The fire shifts. No one speaks for a moment.*) may appear between contributions on their own line, without a speaker name.

Be specific: cite real texts, real historical tensions, real scholarship (including post-period scholarship — the room is atemporal and the receipts are real). Do not invent citations. If a member quotes a text, that text must exist and the quotation must be substantively accurate.

There is no author present. The document was read aloud by no one in particular. Do not praise, critique, address, summarize, or workshop the writer. The document is the night's occasion, not its subject. Members do not say things like "this is beautifully observed" or "the writer captures" — there is no writer in the room.

The conversation is not required to stay close to the document after the first round. It will drift where it drifts. This is the room.

Do not address the user or acknowledge any observer. The conversation proceeds as if no one is watching.`;
}

// ─── Anthropic call helpers ───────────────────────────────────────────────────

// Non-streaming call (Day One MCP routes only)
async function callClaude(systemPrompt, conversationHistory, userMessage, useDayOneMCP = false) {
  const messages = [...conversationHistory, { role: 'user', content: userMessage }];
  const params = {
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    system: systemPrompt,
    messages,
  };
  if (useDayOneMCP) {
    params.mcp_servers = [{ type: 'url', url: 'https://mcp.day-one.app/mcp', name: 'day-one' }];
  }
  const response = await client.messages.create(params);
  return response.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

// Streaming call — writes SSE chunks to res, returns accumulated full text
async function streamClaude(res, systemPrompt, conversationHistory, userMessage) {
  const messages = [...conversationHistory, { role: 'user', content: userMessage }];
  const stream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    system: systemPrompt,
    messages,
  });

  let fullText = '';
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      const chunk = event.delta.text;
      fullText += chunk;
      res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
    }
  }
  return fullText;
}

function openSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
}

// Post-process raw Claude transcript text: append ' —' after speaker name lines
// so plain-text exports clearly distinguish speakers from speech.
const MEMBER_NAMES = new Set(ROSTER.map(m => m.name));
function formatTranscriptText(text) {
  return text.split('\n').map(line => {
    const t = line.trim();
    const bare = t.endsWith(':') ? t.slice(0, -1) : t;
    return MEMBER_NAMES.has(bare) ? `${bare} —` : line;
  }).join('\n');
}

// ─── Round prompts ────────────────────────────────────────────────────────────

const DEFAULT_ROUND_INSTRUCTIONS = [
  'The room stirs. Write the first movement — initial reactions to whatever the material woke up. Not every member must engage with the document directly; some may respond to the room\'s reaction to it before responding to it themselves. 3-5 members speak. There is no author to address.',
  'The document recedes. The conversation follows what it raised. Members are now talking to each other about the actual question that has surfaced — disagreements crystallize, alliances form, citations come out, someone is irritated, someone is more interested than they wanted to be. References to the document are welcome but not required; the room is no longer obliged to it. 3-5 members speak. Receipts may be deployed. Actions in asterisks.',
  'The conversation has gone where it has gone. It may have left the document entirely. Final movement: the room arrives somewhere, or it doesn\'t. Someone may say the thing that persists as an ember. Someone may push back hard at a point that has been allowed to stand too long. Someone may simply observe the fire. 2-4 members. Let it end as it ends.',
];
const EXTRA_ROUND_INSTRUCTION = 'A thread unresolved, a silence wanting breaking, a late arrival to the argument, a member who passed earlier returning with something they have just thought of. 2-4 members speak.';

function buildRoundPrompt(index, entry, instructions, artifact = null) {
  const instr = instructions?.[index] || DEFAULT_ROUND_INSTRUCTIONS[index] || EXTRA_ROUND_INSTRUCTION;
  if (index === 0) {
    const artifactMember = artifact?.memberId ? ROSTER.find(m => m.id === artifact.memberId) : null;
    const artifactHint = artifactMember
      ? `\n\n${artifactMember.name} has private context from before the meeting. They should speak in this round.`
      : '';
    return `The document has just been read aloud:\n\n"${entry}"\n\n${instr}${artifactHint}`;
  }
  return instr;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /api/convene — start a session and stream round 1
app.post('/api/convene', async (req, res) => {
  const { entry, members } = req.body;
  if (!entry?.trim()) return res.status(400).json({ error: 'entry is required' });
  if (!members?.length) return res.status(400).json({ error: 'at least one member is required' });

  const { roundInstructions, artifact } = req.body;
  const id = makeSessionId(entry);
  const date = new Date().toISOString().slice(0, 10);
  const systemPrompt = buildSystemPrompt(members, artifact || null);
  const roundPrompt = buildRoundPrompt(0, entry, roundInstructions, artifact || null);

  openSSE(res);
  try {
    const text = await streamClaude(res, systemPrompt, [], roundPrompt);
    const history = [
      { role: 'user', content: roundPrompt },
      { role: 'assistant', content: text },
    ];
    const session = {
      id, date, entry, members, systemPrompt,
      roundInstructions: roundInstructions || null,
      artifact: artifact || null,
      conversationHistory: history,
      rounds: [{ label: 'First Movement', text }],
      transcriptText: buildTranscriptHeader(entry, members, date) + `\n— First Movement —\n\n${formatTranscriptText(text)}\n`,
    };
    saveSession(session);
    res.write(`data: ${JSON.stringify({ done: true, sessionId: id, round: 1, label: 'First Movement' })}\n\n`);
  } catch (err) {
    console.error('Convene error:', err);
    res.write(`data: ${JSON.stringify({ error: 'Failed to convene lodge' })}\n\n`);
  }
  res.end();
});

// POST /api/round — stream the next round into an existing session
app.post('/api/round', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const session = loadSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const roundIndex = session.rounds.length;
  const roundPrompt = buildRoundPrompt(roundIndex, session.entry, session.roundInstructions);

  const labels = ['First Movement', 'The Room Responds', 'Final Embers', 'One More Turn'];
  const label = labels[Math.min(roundIndex, labels.length - 1)];

  // Keep only the last 6 messages (3 round-trips) to cap context growth in long sessions
  const recentHistory = session.conversationHistory.slice(-6);

  openSSE(res);
  try {
    const text = await streamClaude(res, session.systemPrompt, recentHistory, roundPrompt);

    session.conversationHistory.push({ role: 'user', content: roundPrompt });
    session.conversationHistory.push({ role: 'assistant', content: text });
    session.rounds.push({ label, text });
    session.transcriptText += `\n— ${label} —\n\n${formatTranscriptText(text)}\n`;

    saveSession(session);
    res.write(`data: ${JSON.stringify({ done: true, round: roundIndex + 1, label })}\n\n`);
  } catch (err) {
    console.error('Round error:', err);
    res.write(`data: ${JSON.stringify({ error: 'Failed to generate round' })}\n\n`);
  }
  res.end();
});

// POST /api/interject — user speaks; room streams a response
app.post('/api/interject', async (req, res) => {
  const { sessionId, text } = req.body;
  if (!sessionId || !text?.trim()) return res.status(400).json({ error: 'sessionId and text required' });

  const session = loadSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const prompt = `A mysterious presence — an observer from outside time — has just spoken: "${text}"\n\nThe room reacts. 2-3 members respond to what was said.`;
  const recentHistory = session.conversationHistory.slice(-6);

  openSSE(res);
  try {
    const response = await streamClaude(res, session.systemPrompt, recentHistory, prompt);

    session.conversationHistory.push({ role: 'user', content: prompt });
    session.conversationHistory.push({ role: 'assistant', content: response });
    session.transcriptText += `\n— A Presence Passes Through —\n\n— a voice from elsewhere —\n${text}\n\n${formatTranscriptText(response)}\n`;

    saveSession(session);
    res.write(`data: ${JSON.stringify({ done: true, label: 'A Presence Passes Through' })}\n\n`);
  } catch (err) {
    console.error('Interject error:', err);
    res.write(`data: ${JSON.stringify({ error: 'Failed to interject' })}\n\n`);
  }
  res.end();
});

// POST /api/dayone/journals — list Day One journals
app.post('/api/dayone/journals', async (req, res) => {
  try {
    const journals = await dayOne.listJournals();
    // Normalise to [{id, name}] regardless of what the MCP returns
    const list = Array.isArray(journals)
      ? journals.map(j => ({ id: j.id || j.journal_id, name: j.name || j.journal_name }))
      : [];
    res.json({ journals: list });
  } catch (err) {
    console.error('Journals error:', err);
    res.status(500).json({ error: 'Could not load journals' });
  }
});

// POST /api/dayone/entries — return recent non-generated entries for a journal
app.post('/api/dayone/entries', async (req, res) => {
  const { journalId, limit = 3 } = req.body;
  if (!journalId) return res.status(400).json({ error: 'journalId required' });
  try {
    const raw = await dayOne.getRecentEntries(journalId, limit);
    const entries = raw.map(e => {
      const body = (e.body || e.text || '').replace(/\\([.()[\]{}])/g, '$1');
      return {
        date: (e.date || e.creation_date || '').slice(0, 10),
        preview: body.replace(/\n+/g, ' ').slice(0, 80),
        text: body,
      };
    });
    res.json({ entries });
  } catch (err) {
    console.error('Entries error:', err);
    res.status(500).json({ error: 'Could not fetch entries' });
  }
});

// POST /api/dayone/fetch — fetch latest entry from a journal
app.post('/api/dayone/fetch', async (req, res) => {
  const { journalId, journalName } = req.body;
  if (!journalId) return res.status(400).json({ error: 'journalId required' });

  try {
    const entry = await dayOne.getLatestEntry(journalId);
    if (!entry) return res.status(404).json({ error: 'No entries found' });

    const text = (entry.body || entry.text || entry.content || '').replace(/\\([.()[\]{}])/g, '$1');
    const date = (entry.date || entry.creation_date || entry.creationDate || '').slice(0, 10);
    res.json({ text, date, journal: journalName });
  } catch (err) {
    console.error('Fetch entry error:', err);
    res.status(500).json({ error: 'Could not fetch entry' });
  }
});

// POST /api/dayone/export — save transcript to Day One
app.post('/api/dayone/export', async (req, res) => {
  const { journalId, journalName, transcriptText, sessionDate } = req.body;
  if (!journalId || !transcriptText) return res.status(400).json({ error: 'journalId and transcriptText required' });

  const markdown = `# Secret-Cabin-et — Meeting Notes\n*${sessionDate} — This is the generated transcript, not the source material.*\n\n${transcriptText}`;

  try {
    await dayOne.createEntry(journalId, markdown, ['secret-cabinets', 'meeting-notes', 'generated']);
    res.json({ success: true, journal: journalName });
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Export failed' });
  }
});

// GET /api/sessions — list recent sessions
app.get('/api/sessions', (req, res) => {
  try {
    const files = fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ file: f, mtime: fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 40)
      .map(({ file }) => {
        const d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
        const memberNames = (d.members || [])
          .map(id => ROSTER.find(m => m.id === id)?.name)
          .filter(Boolean);
        return {
          id: d.id,
          date: d.date,
          entry: d.entry?.slice(0, 100),
          members: memberNames,
          rounds: d.rounds?.length || 0,
        };
      });
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// DELETE /api/sessions/:id — remove a session
app.delete('/api/sessions/:id', (req, res) => {
  const p = path.join(SESSIONS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Session not found' });
  try {
    fs.unlinkSync(p);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// GET /api/sessions/:id — load full session
app.get('/api/sessions/:id', (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// GET /api/members — return current roster
app.get('/api/members', (req, res) => {
  res.json(ROSTER);
});

// POST /api/members — draft + save a new character file, update roster
app.post('/api/members', async (req, res) => {
  const { name, bio, voiceRegister, cognitiveStyle, relationships, isGuest } = req.body;
  if (!name?.trim() || !bio?.trim()) return res.status(400).json({ error: 'name and bio are required' });

  // Build a safe filename + id from the name
  const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const file = `${id}.md`;
  const filePath = path.join(MEMBERS_DIR, file);

  if (fs.existsSync(filePath)) {
    return res.status(409).json({ error: `A member file already exists for "${name}". Choose a different name or edit the file directly.` });
  }

  // Read one canonical character file as a format exemplar
  const exemplar = loadMemberFile('crowley.md');

  const systemPrompt = `You are a researcher and writer helping build a character prompt for a historical salon simulation called The Secret-Cabin-et. The salon is atemporal — members from different centuries speak together as equals. You will write a character system prompt in the exact style and structure of the exemplar below.

The character file must contain these sections, in order:
- # [NAME IN CAPS]
- ### Character System Prompt — the Secret-Cabin-et
- *Builds on: Lodge Context Document*
- ## WHO YOU ARE — 2–3 paragraphs: historical identity, expertise, self-understanding, and one honest complicating note
- ## HOW YOU SPEAK — 3–4 paragraphs: register, rhythm, rhetorical moves, what they do with disagreement
- ## YOUR RELATIONSHIPS IN THIS ROOM — one paragraph per relevant member present in the room (use only the members listed in the existing roster: Crowley, Waite, Coleman-Smith, Yeats, Blavatsky, Lévi, Teresa of Ávila, Ibn Arabi, Maud Gonne, Llull, Ibn Khaldun, John Dee)
- ## WHAT YOU DO WITH THE DOCUMENT — 2 paragraphs about how this member engages with a journal entry read aloud
- ## WHAT YOU DO NOT DO — bullet list of 4–6 hard constraints on this character's voice
- *Character prompt complete. Deploy on top of Lodge Context Document.*

Rules:
- Write in second person ("You are…", "You speak…")
- Be specific: cite real texts, real positions, real historical tensions
- Do not invent citations or relationships
- Keep the same section headers, formatting, and tone as the exemplar
- Do not summarize or editorialize — write the prompt as if deploying it directly

EXEMPLAR FORMAT (Crowley):
${exemplar}`;

  const userMessage = `Write a character prompt for: ${name}

Biography / background:
${bio}

Voice and register:
${voiceRegister || '(not specified — infer from the biography)'}

Cognitive style:
${cognitiveStyle || '(not specified — infer from the biography)'}

Relationship notes:
${relationships || '(not specified — infer from historical record)'}`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2400,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });
    const characterFile = response.content.filter(b => b.type === 'text').map(b => b.text).join('');

    fs.writeFileSync(filePath, characterFile, 'utf8');

    const newMember = { id, name: name.trim(), file, guest: !!isGuest };
    ROSTER.push(newMember);
    fs.writeFileSync(ROSTER_FILE, JSON.stringify(ROSTER, null, 2), 'utf8');

    res.json({ member: newMember, characterFile });
  } catch (err) {
    console.error('Member creation error:', err);
    res.status(500).json({ error: 'Failed to draft character file' });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildTranscriptHeader(entry, memberIds, date) {
  const names = memberIds.map(id => ROSTER.find(m => m.id === id)?.name).filter(Boolean).join(', ');
  return `THE SECRET-CABIN-ET\nMeeting Notes — ${date}\nAssembled: ${names}\n\nSource material:\n${entry}\n`;
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`The Secret-Cabin-et is open at http://localhost:${PORT}`);
});
