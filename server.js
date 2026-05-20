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
// id must match what the frontend sends; file is the prompt filename

const ROSTER = [
  { id: 'crowley',  name: 'Crowley',         file: 'crowley.md',       guest: false },
  { id: 'waite',    name: 'Waite',            file: 'waite.md',         guest: false },
  { id: 'pixie',    name: 'Coleman-Smith',    file: 'coleman-smith.md', guest: false },
  { id: 'yeats',    name: 'Yeats',            file: 'yeats.md',         guest: false },
  { id: 'blavatsky',name: 'Blavatsky',        file: 'blavatsky.md',     guest: false },
  { id: 'levi',     name: 'Lévi',             file: 'levi.md',          guest: false },
  { id: 'teresa',   name: 'Teresa of Ávila',  file: 'teresa.md',        guest: false },
  { id: 'arabi',    name: 'Ibn Arabi',        file: 'ibn-arabi.md',     guest: false },
  { id: 'llull',    name: 'Llull',            file: null,               guest: true  },
  { id: 'khaldun',  name: 'Ibn Khaldun',      file: null,               guest: true  },
  { id: 'dee',      name: 'John Dee',         file: null,               guest: true  },
];

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

function buildSystemPrompt(memberIds) {
  const present = memberIds
    .map(id => ROSTER.find(m => m.id === id))
    .filter(Boolean);

  const regularMembers = present.filter(m => !m.guest);
  const guests = present.filter(m => m.guest);

  const presentNames = present.map(m => m.name).join(', ');
  const guestLine = guests.length ? `\nOCCASIONAL GUESTS PRESENT TONIGHT: ${guests.map(m => m.name).join(', ')}` : '';

  // Build character sections from full character files
  const characterSections = regularMembers
    .map(m => {
      const text = loadMemberFile(m.file);
      return text ? `---\n${text}` : '';
    })
    .filter(Boolean)
    .join('\n\n');

  // Guest sketches (no full files yet)
  const guestSketches = guests.map(m => {
    const sketches = {
      llull: 'Llull: Catalan combinatorialist and proto-computational mystic. Arrived mid-conversation having caught enough to orient himself. His Ars Generativa — the wheels within wheels — gives him a particular way of seeing combinatorial patterns in everything.',
      khaldun: 'Ibn Khaldun: North African historian and sociologist of civilizations. Has watched societies construct exactly this kind of esoteric architecture and has thoughts about the sociological function of it. Epistemological cold water when warranted.',
      dee: 'John Dee: Elizabethan mathematician, astrologer, and Enochian channeler. His presence makes everyone perform for an ancestor. His own reception of angelic language (through Kelley) gives him standing to speak on transmission and mediation.',
    };
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

Generate a salon transcript. Each speaker's name appears alone on a line, followed by their speech on the next line(s). 3-5 members speak per round — not every member speaks every round. Silences are valid. Members may address each other by name, quote each other, disagree, complete each other's sentences, let something drop. Be specific: cite real texts, real historical tensions. Do not address the user or acknowledge any observer. The conversation proceeds as if no one is watching.`;
}

// ─── Anthropic call helper ────────────────────────────────────────────────────

async function callClaude(systemPrompt, conversationHistory, userMessage, useDayOneMCP = false) {
  const messages = [...conversationHistory, { role: 'user', content: userMessage }];

  const params = {
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    system: systemPrompt,
    messages,
  };

  // Day One remote MCP (used for journal fetch/export)
  if (useDayOneMCP) {
    params.mcp_servers = [{ type: 'url', url: 'https://mcp.day-one.app/mcp', name: 'day-one' }];
  }

  const response = await client.messages.create(params);
  return response.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

// ─── Round prompts ────────────────────────────────────────────────────────────

const ROUND_PROMPTS = [
  (entry) => `The document has just been read aloud:\n\n"${entry}"\n\nThe room stirs. Write the first movement — initial reactions, the first voices. 3-5 members respond.`,
  () => `Continue. Members react to each other — disagreements surface, alliances form, unexpected connections emerge. 3-5 members speak.`,
  () => `The conversation moves toward its close. Final thoughts. Someone may say the thing that persists as an ember. 2-4 members. Let it end naturally.`,
  () => `A thread unresolved, a silence wanting breaking, a late arrival to the argument. 2-4 members speak.`,
];

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /api/convene — start a session and run round 1
app.post('/api/convene', async (req, res) => {
  const { entry, members } = req.body;
  if (!entry?.trim()) return res.status(400).json({ error: 'entry is required' });
  if (!members?.length) return res.status(400).json({ error: 'at least one member is required' });

  const id = makeSessionId(entry);
  const date = new Date().toISOString().slice(0, 10);
  const systemPrompt = buildSystemPrompt(members);
  const roundPrompt = ROUND_PROMPTS[0](entry);

  try {
    const text = await callClaude(systemPrompt, [], roundPrompt);
    const history = [
      { role: 'user', content: roundPrompt },
      { role: 'assistant', content: text },
    ];

    const session = {
      id,
      date,
      entry,
      members,
      systemPrompt,
      conversationHistory: history,
      rounds: [{ label: 'First Movement', text }],
      transcriptText: buildTranscriptHeader(entry, members, date) + `\n— First Movement —\n\n${text}\n`,
    };

    saveSession(session);
    res.json({ sessionId: id, round: 1, label: 'First Movement', text });
  } catch (err) {
    console.error('Convene error:', err);
    res.status(500).json({ error: 'Failed to convene lodge' });
  }
});

// POST /api/round — add the next round to an existing session
app.post('/api/round', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const session = loadSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const roundIndex = session.rounds.length;
  const promptFn = ROUND_PROMPTS[Math.min(roundIndex, ROUND_PROMPTS.length - 1)];
  const roundPrompt = promptFn(session.entry);

  const labels = ['First Movement', 'The Room Responds', 'Final Embers', 'One More Turn'];
  const label = labels[Math.min(roundIndex, labels.length - 1)];

  try {
    const text = await callClaude(session.systemPrompt, session.conversationHistory, roundPrompt);

    session.conversationHistory.push({ role: 'user', content: roundPrompt });
    session.conversationHistory.push({ role: 'assistant', content: text });
    session.rounds.push({ label, text });
    session.transcriptText += `\n— ${label} —\n\n${text}\n`;

    saveSession(session);
    res.json({ round: roundIndex + 1, label, text });
  } catch (err) {
    console.error('Round error:', err);
    res.status(500).json({ error: 'Failed to generate round' });
  }
});

// POST /api/interject — user speaks; room responds
app.post('/api/interject', async (req, res) => {
  const { sessionId, text } = req.body;
  if (!sessionId || !text?.trim()) return res.status(400).json({ error: 'sessionId and text required' });

  const session = loadSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const prompt = `A mysterious presence — an observer from outside time — has just spoken: "${text}"\n\nThe room reacts. 2-3 members respond to what was said.`;

  try {
    const response = await callClaude(session.systemPrompt, session.conversationHistory, prompt);

    session.conversationHistory.push({ role: 'user', content: prompt });
    session.conversationHistory.push({ role: 'assistant', content: response });
    session.transcriptText += `\n— A Presence Passes Through —\n\n— a voice from elsewhere —\n${text}\n\n${response}\n`;

    saveSession(session);
    res.json({ label: 'A Presence Passes Through', interjection: text, response });
  } catch (err) {
    console.error('Interject error:', err);
    res.status(500).json({ error: 'Failed to interject' });
  }
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
      .slice(0, 20)
      .map(({ file }) => {
        const d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
        return { id: d.id, date: d.date, entry: d.entry?.slice(0, 80) };
      });
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// GET /api/sessions/:id — load full session
app.get('/api/sessions/:id', (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
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
