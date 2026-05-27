'use strict';

require('dotenv').config({ override: true });
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const session = require('express-session');

const dayOne = require('./dayone');
const multer = require('multer');
const PDFParser = require('pdf2json');

// ─── Environment flags ────────────────────────────────────────────────────────
const IS_LOCAL = process.env.LOCAL === 'true' || process.env.NODE_ENV !== 'production';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function extractPdfText(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, true); // true = raw text mode
    parser.on('pdfParser_dataError', err => reject(err.parserError));
    parser.on('pdfParser_dataReady', () => {
      const text = parser.getRawTextContent()
        .replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
      resolve(text);
    });
    parser.parseBuffer(buffer);
  });
}

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PORT = process.env.PORT || 3132;
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const PROMPTS_DIR = path.join(__dirname, 'prompts');
const MEMBERS_DIR = path.join(PROMPTS_DIR, 'members');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: false }));

// ─── Auth (passphrase, deployed only) ────────────────────────────────────────

const PASSPHRASE = process.env.PASSPHRASE || null;

app.use(session({
  secret: process.env.SESSION_SECRET || 'local-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    secure: !IS_LOCAL,
    sameSite: 'lax',
  },
}));

// Login page — only served when PASSPHRASE is set and session is not authenticated
app.get('/login', (req, res) => {
  if (!PASSPHRASE || req.session.authed) return res.redirect('/');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>The Secret-Cabin-et</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #1a1510; color: #c8b89a; font-family: 'Georgia', serif;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .gate { text-align: center; width: 320px; }
    h1 { font-size: 1.1rem; letter-spacing: .2em; text-transform: uppercase;
         color: #8b7355; margin-bottom: 2rem; }
    input[type=password] { width: 100%; padding: .75rem 1rem; background: #0d0b08;
      border: 1px solid #3a3228; color: #c8b89a; font-family: inherit; font-size: 1rem;
      border-radius: 2px; outline: none; text-align: center; letter-spacing: .15em; }
    input[type=password]:focus { border-color: #8b7355; }
    button { margin-top: 1rem; width: 100%; padding: .75rem; background: transparent;
      border: 1px solid #5a4a3a; color: #a89070; font-family: inherit; font-size: .85rem;
      letter-spacing: .15em; text-transform: uppercase; cursor: pointer; border-radius: 2px; }
    button:hover { border-color: #8b7355; color: #c8b89a; }
    .error { margin-top: 1rem; color: #a05050; font-size: .85rem; }
  </style>
</head>
<body>
  <div class="gate">
    <h1>The Secret-Cabin-et</h1>
    <form method="POST" action="/login">
      <input type="password" name="passphrase" placeholder="Enter passphrase" autofocus>
      <button type="submit">Enter</button>
      ${req.query.error ? '<p class="error">Incorrect passphrase.</p>' : ''}
    </form>
  </div>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  if (req.body.passphrase === PASSPHRASE) {
    req.session.authed = true;
    return res.redirect('/');
  }
  res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Auth guard — applied to all routes except login/logout/static assets
function requireAuth(req, res, next) {
  if (!PASSPHRASE) return next(); // no passphrase set = open
  if (req.path === '/api/config') return next(); // health check — always public
  if (req.session.authed) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(requireAuth);

// ─── Lodge roster ────────────────────────────────────────────────────────────
// Loaded from roster.json; reloadRoster() refreshes in-memory copy after writes.

const ROSTER_FILE = path.join(MEMBERS_DIR, 'roster.json');
let ROSTER = [];

function reloadRoster() {
  const all = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));
  // Filter out any entry whose character file no longer exists on disk
  ROSTER = all.filter(m => !m.file || fs.existsSync(path.join(MEMBERS_DIR, m.file)));
  // Also rewrite roster.json to remove stale entries
  if (ROSTER.length < all.length) {
    fs.writeFileSync(ROSTER_FILE, JSON.stringify(ROSTER, null, 2) + '\n', 'utf8');
  }
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

// ─── Section extractor (shared by dossier route + abbreviated prompt) ────────

/**
 * Extract the first paragraph of a named `## SECTION` from a character file.
 * Returns the extracted text, or '' if not found.
 */
function extractSection(text, sectionName) {
  const re = new RegExp(`##\\s+${sectionName}\\s*\\n([\\s\\S]*?)(?=\\n##|$)`, 'i');
  const match = text.match(re);
  if (!match) return '';
  // Return first non-empty paragraph only
  const paragraphs = match[1].split(/\n\n+/).map(p => p.trim()).filter(Boolean);
  return paragraphs[0] || '';
}

/**
 * Extract the full bullet list from WHAT YOU DO NOT DO (all lines starting with - or *).
 */
function extractConstraints(text) {
  const re = /##\s+WHAT YOU DO NOT DO\s*\n([\s\S]*?)(?=\n##|$)/i;
  const match = text.match(re);
  if (!match) return '';
  return match[1].trim();
}

// ─── System prompt builder ────────────────────────────────────────────────────

function buildSystemPrompt(memberIds, artifact = null, shadowIds = [], notes = {}) {
  const present = memberIds
    .map(id => ROSTER.find(m => m.id === id))
    .filter(Boolean);

  const shadows = shadowIds
    .map(id => ROSTER.find(m => m.id === id))
    .filter(Boolean);

  const guests = present.filter(m => m.guest);
  // Guests with full character files are treated identically to core members
  const fullMembers = present.filter(m => m.file);
  const sketchOnlyGuests = guests.filter(m => !m.file);

  const presentNames = present.map(m => m.name).join(', ');
  const guestLine = guests.length ? `\nOCCASIONAL GUESTS PRESENT TONIGHT: ${guests.map(m => m.name).join(', ')}` : '';
  const shadowLine = shadows.length
    ? `\nABSENT PRESENCES — named but not speaking tonight: ${shadows.map(m => m.name).join(', ')}. The room is aware of them. Members may invoke their ideas, quote them, note their absence, or argue with their positions. They do not speak.`
    : '';

  // Build character sections — inject artifact as private context for the named recipient
  const artifactMember = artifact?.memberId ? ROSTER.find(m => m.id === artifact.memberId) : null;
  const characterSections = fullMembers
    .map(m => {
      const text = loadMemberFile(m.file);
      if (!text) return '';
      const artifactNote = (artifactMember && m.id === artifactMember.id && artifact.text?.trim())
        ? `\n\n---\n\n## PRIVATE — BEFORE THE MEETING BEGAN\n\nBefore the others arrived, you were shown the following. No one else in the room has seen it. You may reference it, produce it at the right moment, withhold it entirely, or let it colour what you say without naming it. The choice is yours.\n\n${artifact.text.trim()}`
        : '';
      const sessionNote = notes[m.id]?.trim()
        ? `\n\n---\n\n## SESSION NOTE\n\n${notes[m.id].trim()}`
        : '';
      return `---\n${text}${artifactNote}${sessionNote}`;
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

PRESENT: ${presentNames}${guestLine}${shadowLine}

${characterSections}

${guestSketches}

---

## FORMAT INSTRUCTIONS

Generate a salon transcript. Each speaker's name appears alone on a line, followed by their speech on the next line(s). 3-5 members speak per round — not every member speaks every round. Silences are valid. Members may address each other by name, quote each other, disagree, complete each other's sentences, let something drop, change the subject entirely.

Actions and stage business are written in *single asterisks* and used sparingly. The default for any contribution is no action line at all — most speech should stand without physical description. An action earns its place only when it reveals something the words cannot: a gesture that contradicts the speech, a significant silence, a physical act that changes the room's temperature. Do not describe speakers looking at fires, adjusting posture, or sitting down. One action per contribution is the maximum; zero is the norm. Do not use --- as a divider between contributions.

Unattributed room-level beats (*The fire shifts.*) may appear at most once or twice per round, between contributions, without a speaker name — not between every speaker.

Be specific: cite real texts, real historical tensions, real scholarship (including post-period scholarship — the room is atemporal and the receipts are real). Do not invent citations. If a member quotes a text, that text must exist and the quotation must be substantively accurate.

There is no author present. The document was read aloud by no one in particular. Do not praise, critique, address, summarize, or workshop the writer. The document is the night's occasion, not its subject. Members do not say things like "this is beautifully observed" or "the writer captures" — there is no writer in the room.

The conversation is not required to stay close to the document after the first round. It will drift where it drifts. This is the room.

Do not address the user or acknowledge any observer. The conversation proceeds as if no one is watching.`;
}

/**
 * Abbreviated system prompt for rounds 2+.
 * Keeps the full lodge context and FORMAT INSTRUCTIONS, but replaces each
 * character file with three short extracts: WHO YOU ARE (first para),
 * HOW YOU SPEAK (first para), WHAT YOU DO NOT DO (full constraint list).
 * Reduces per-round token cost by ~85 % vs. the full prompt.
 */
function buildSystemPromptAbbreviated(memberIds, shadowIds = []) {
  const present = memberIds
    .map(id => ROSTER.find(m => m.id === id))
    .filter(Boolean);

  const guests = present.filter(m => m.guest);
  const presentNames = present.map(m => m.name).join(', ');
  const guestLine = guests.length ? `\nOCCASIONAL GUESTS PRESENT TONIGHT: ${guests.map(m => m.name).join(', ')}` : '';

  const characterSections = present
    .filter(m => m.file)
    .map(m => {
      const text = loadMemberFile(m.file);
      if (!text) return '';
      const who = extractSection(text, 'WHO YOU ARE');
      const how = extractSection(text, 'HOW YOU SPEAK');
      const constraints = extractConstraints(text);
      const parts = [`## ${m.name}`];
      if (who) parts.push(`**WHO YOU ARE**\n${who}`);
      if (how) parts.push(`**HOW YOU SPEAK**\n${how}`);
      if (constraints) parts.push(`**WHAT YOU DO NOT DO**\n${constraints}`);
      return parts.join('\n\n');
    })
    .filter(Boolean)
    .join('\n\n---\n\n');

  return `${lodgeContext}

---

## ASSEMBLED TONIGHT

PRESENT: ${presentNames}${guestLine}

${characterSections}

---

## FORMAT INSTRUCTIONS

Generate a salon transcript. Each speaker's name appears alone on a line, followed by their speech on the next line(s). 3-5 members speak per round — not every member speaks every round. Silences are valid. Members may address each other by name, quote each other, disagree, complete each other's sentences, let something drop. Be specific: cite real texts, real historical tensions. Do not address the user or acknowledge any observer. The conversation proceeds as if no one is watching.`;
}

// ─── Anthropic call helpers ───────────────────────────────────────────────────

// Non-streaming call (Day One MCP routes only)
async function callClaude(systemPrompt, conversationHistory, userMessage, useDayOneMCP = false) {
  const messages = [...conversationHistory, { role: 'user', content: userMessage }];
  const params = {
    model: 'claude-sonnet-4-6',
    max_tokens: 2400,
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
    max_tokens: 2400,
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

  const { roundInstructions, artifact, shadows, notes } = req.body;
  const id = makeSessionId(entry);
  const date = new Date().toISOString().slice(0, 10);
  const systemPrompt = buildSystemPrompt(members, artifact || null, shadows || [], notes || {});
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
      shadows: shadows || [],
      notes: notes || {},
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

  const systemPrompt = buildSystemPromptAbbreviated(session.members, session.shadowMembers || []);

  openSSE(res);
  try {
    const text = await streamClaude(res, systemPrompt, session.conversationHistory.slice(-6), roundPrompt);

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

  const systemPrompt = buildSystemPromptAbbreviated(session.members, session.shadowMembers || []);

  openSSE(res);
  try {
    const response = await streamClaude(res, systemPrompt, session.conversationHistory.slice(-6), prompt);

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

// POST /api/ulysses/export — create a new Ulysses sheet via URL scheme (local only)
app.post('/api/ulysses/export', (req, res) => {
  if (!IS_LOCAL) return res.status(404).json({ error: 'Not available in deployed mode' });
  const { transcriptText, sessionDate, title, group } = req.body;
  if (!transcriptText) return res.status(400).json({ error: 'transcriptText required' });

  const sheetTitle = `[Secret-Cabin-et] ${title || sessionDate || 'Meeting Notes'}`;
  const markdown = `# ${sheetTitle}\n\n${transcriptText}`;

  // Build URL using new-sheet scheme — no temp file, no shell quoting issues
  const params = new URLSearchParams({ text: markdown });
  if (group?.trim()) params.set('group', group.trim());
  // URLSearchParams uses + for spaces; Ulysses needs %20 — replace manually
  const url = `ulysses://x-callback-url/new-sheet?${params.toString().replace(/\+/g, '%20')}`;

  const { execFile } = require('child_process');
  execFile('open', [url], err => {
    if (err) {
      console.error('Ulysses export error:', err);
      return res.status(500).json({ error: 'Could not open Ulysses. Is it installed?' });
    }
    res.json({ success: true });
  });
});

// POST /api/export/obsidian — write transcript as Markdown to an Obsidian vault (local only)
app.post('/api/export/obsidian', (req, res) => {
  if (!IS_LOCAL) return res.status(404).json({ error: 'Not available in deployed mode' });
  const { vaultPath, transcriptText, sessionDate, members, tags, sourceExcerpt, sessionId } = req.body;
  if (!vaultPath?.trim()) return res.status(400).json({ error: 'vaultPath required' });
  if (!transcriptText) return res.status(400).json({ error: 'transcriptText required' });

  const resolvedVault = vaultPath.trim().replace(/^~/, require('os').homedir());
  const cabinetDir = path.join(resolvedVault, 'Secret Cabinet');

  try {
    if (!fs.existsSync(resolvedVault)) return res.status(400).json({ error: `Vault not found: ${resolvedVault}` });
    if (!fs.existsSync(cabinetDir)) fs.mkdirSync(cabinetDir, { recursive: true });

    // Build filename from date + source slug
    const slug = (sourceExcerpt || 'meeting').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
    const filename = `${sessionDate || new Date().toISOString().slice(0,10)}-${slug}.md`;
    const filePath = path.join(cabinetDir, filename);

    // YAML frontmatter
    const memberList = (members || []).map(m => `  - ${m}`).join('\n');
    const tagList = ['secret-cabinet', 'meeting-notes', ...(tags || [])].map(t => `  - ${t}`).join('\n');
    const frontmatter = `---\ndate: ${sessionDate || ''}\nmembers:\n${memberList}\ntags:\n${tagList}\nsource: "${(sourceExcerpt || '').replace(/"/g, '\\"').slice(0, 120)}"\n---\n\n`;

    // Format transcript: bold speaker names for Obsidian scanning
    const MEMBER_NAMES_SET = new Set(ROSTER.map(m => m.name));
    const obsidianTranscript = transcriptText.split('\n').map(line => {
      const bare = line.replace(/ —$/, '').trim();
      return MEMBER_NAMES_SET.has(bare) ? `**${bare}**` : line;
    }).join('\n');

    fs.writeFileSync(filePath, frontmatter + obsidianTranscript, 'utf8');
    res.json({ success: true, filename, path: filePath });
  } catch (err) {
    console.error('Obsidian export error:', err);
    res.status(500).json({ error: err.message || 'Export failed' });
  }
});

// GET /api/sessions — list recent sessions, with optional ?q=, ?tag=, ?thread= filters
app.get('/api/sessions', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const tag = (req.query.tag || '').trim().toLowerCase();
  const thread = (req.query.thread || '').trim().toLowerCase();
  try {
    let sessions = fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ file: f, mtime: fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 200)
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
          tags: d.tags || [],
          threadId: d.threadId || null,
          threadName: d.threadName || null,
          _entry: (d.entry || '').toLowerCase(),
          _transcript: (d.transcriptText || '').toLowerCase(),
        };
      });

    if (thread) {
      sessions = sessions.filter(s => (s.threadId || '').toLowerCase() === thread);
      // For thread view, sort chronologically oldest-first
      sessions = sessions.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    }
    if (tag) {
      sessions = sessions.filter(s => s.tags.map(t => t.toLowerCase()).includes(tag));
    }
    if (q) {
      sessions = sessions.filter(s =>
        s._entry.includes(q) || s._transcript.includes(q) ||
        s.tags.some(t => t.toLowerCase().includes(q)) ||
        (s.threadName || '').toLowerCase().includes(q) ||
        (s.date || '').includes(q)
      );
    }

    res.json(sessions.slice(0, 40).map(({ _entry, _transcript, ...s }) => s));
  } catch (err) {
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// GET /api/threads — list all named threads with session counts
app.get('/api/threads', (req, res) => {
  try {
    const threads = {};
    fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json')).forEach(file => {
      const d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
      if (d.threadId && d.threadName) {
        if (!threads[d.threadId]) threads[d.threadId] = { id: d.threadId, name: d.threadName, count: 0 };
        threads[d.threadId].count++;
      }
    });
    res.json(Object.values(threads).sort((a, b) => a.name.localeCompare(b.name)));
  } catch (err) {
    res.status(500).json({ error: 'Failed to list threads' });
  }
});

// PATCH /api/sessions/:id/thread — set or clear thread on a session
app.patch('/api/sessions/:id/thread', (req, res) => {
  const { threadId, threadName } = req.body;
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (threadId && threadName) {
    session.threadId = threadId.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/(^-|-$)/g, '');
    session.threadName = threadName.trim();
  } else {
    delete session.threadId;
    delete session.threadName;
  }
  saveSession(session);
  res.json({ threadId: session.threadId || null, threadName: session.threadName || null });
});

// PATCH /api/sessions/:id/annotations — save annotations array
app.patch('/api/sessions/:id/annotations', (req, res) => {
  const { annotations } = req.body;
  if (!Array.isArray(annotations)) return res.status(400).json({ error: 'annotations must be an array' });
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.annotations = annotations;
  saveSession(session);
  res.json({ count: annotations.length });
});

// PATCH /api/sessions/:id/tags — replace tags array on a session
app.patch('/api/sessions/:id/tags', (req, res) => {
  const { tags } = req.body;
  if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be an array' });
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.tags = tags.map(t => t.trim()).filter(Boolean);
  saveSession(session);
  res.json({ tags: session.tags });
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

// GET /api/members/:id/dossier — parse and return brief + voice from character file
app.get('/api/members/:id/dossier', (req, res) => {
  const member = ROSTER.find(m => m.id === req.params.id);
  if (!member) return res.status(404).json({ error: 'Member not found' });
  const text = loadMemberFile(member.file);
  if (!text) return res.json({ id: member.id, name: member.name, bio: null, voice: null });

  // Extract first substantive paragraph after each section header
  const extractSection = (sectionName) => {
    const re = new RegExp(`## ${sectionName}[\\s\\S]*?\\n\\n([^#\\n][\\s\\S]*?)(?:\\n\\n---|\n\n##|$)`);
    const m = text.match(re);
    if (!m) return null;
    // First non-empty paragraph
    const para = m[1].split(/\n\n/)[0].trim()
      .replace(/\*([^*]+)\*/g, '$1') // strip asterisk emphasis
      .replace(/\n/g, ' ')
      .slice(0, 320);
    return para || null;
  };

  res.json({
    id: member.id,
    name: member.name,
    guest: member.guest,
    bio: extractSection('WHO YOU ARE'),
    voice: extractSection('HOW YOU SPEAK'),
  });
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

// POST /api/upload — extract text from .txt, .md, or .pdf file
app.post('/api/upload', (req, res, next) => {
  upload.single('file')(req, res, err => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'File too large — maximum 25 MB'
        : err.message || 'Upload failed';
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  const { originalname, mimetype, buffer } = req.file;
  const ext = path.extname(originalname).toLowerCase();

  try {
    let text = '';
    if (ext === '.pdf' || mimetype === 'application/pdf') {
      text = await extractPdfText(buffer);
    } else {
      // .txt and .md — read as UTF-8
      text = buffer.toString('utf8');
    }
    // Normalise whitespace
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!text) return res.status(422).json({ error: 'No readable text found in file' });
    res.json({ text, filename: originalname });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Could not extract text from file' });
  }
});

// GET /api/config — surface environment flags to the frontend
app.get('/api/config', (req, res) => {
  res.json({ isLocal: IS_LOCAL });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildTranscriptHeader(entry, memberIds, date) {
  const names = memberIds.map(id => ROSTER.find(m => m.id === id)?.name).filter(Boolean).join(', ');
  return `THE SECRET-CABIN-ET\nMeeting Notes — ${date}\nAssembled: ${names}\n\nSource material:\n${entry}\n`;
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`The Secret-Cabin-et is open at http://localhost:${PORT}`);
});
