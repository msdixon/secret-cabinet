'use strict';

const fs = require('fs');
const path = require('path');

// Walk up from __dirname to find the nearest .env file (supports git worktrees
// where the .env lives in the main project root, not the worktree directory).
// override:true refreshes stale shell-exported vars (e.g. an old API key) from
// .env — but since every worktree shares that same root .env, it would also
// clobber a PORT set on the command line to avoid a collision with another
// worktree's dev server (#211). Re-assert a shell-set PORT after loading so
// `PORT=3200 npm run dev` actually wins.
(function loadEnv() {
  const shellPort = process.env.PORT;
  let dir = __dirname;
  while (true) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      require('dotenv').config({ path: candidate, override: true, quiet: true });
      if (shellPort) process.env.PORT = shellPort;
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
})();

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const session = require('express-session');
const FileStore = require('session-file-store')(session);

const dayOne = require('./dayone');
const multer = require('multer');
const PDFParser = require('pdf2json');
const { buildMemberSection, runRound, stripInternalBlankLines, proposeCast, makeMetric, countWords, BREATH_BUDGET_WORDS } = require('./pipeline');
const roster = require('./roster');
const transcriptFormat = require('./transcript-format');
const readingRoom = require('./reading-room');
const lodgePrompts = require('./lodge-prompts');
const library = require('./library');
const citations = require('./citations');
const graph = require('./graph');
const sessionsStore = require('./sessions-store');
const auth = require('./auth');

// ─── Environment flags ────────────────────────────────────────────────────────
const IS_LOCAL = process.env.LOCAL === 'true' || process.env.NODE_ENV !== 'production';
const MODEL = process.env.MODEL || 'claude-sonnet-4-6';

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
// Railway (and any single-hop PaaS proxy) terminates TLS at the edge and
// forwards plain HTTP internally — without this, Express never sees the
// connection as secure, so express-session's `cookie.secure: true` silently
// refuses to send Set-Cookie at all. Harmless locally (no proxy in front).
app.set('trust proxy', 1);
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PORT = Number(process.env.PORT) || 3132;
// Railway auto-injects RAILWAY_VOLUME_MOUNT_PATH when a volume is attached to
// the service. Reading it here (rather than hardcoding a path) means convene
// data and auth sessions start landing on the mounted volume — and surviving
// redeploys — the moment a volume is attached in the Railway dashboard, with
// no further code change. Falls back to __dirname for local dev and for any
// deployed instance that hasn't attached a volume yet (still ephemeral there).
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const AUTH_SESSIONS_DIR = path.join(DATA_DIR, '.auth-sessions');
// #166 — cross-session residue (rung (a) of #195's amnesia ladder). A
// sibling of SESSIONS_DIR, deliberately not inside it: residue belongs to
// the member across every session that ever convenes them, not to any one
// session's record.
const RESIDUE_DIR = path.join(DATA_DIR, 'residue');
const PROMPTS_DIR = path.join(__dirname, 'prompts');
const MEMBERS_DIR = path.join(PROMPTS_DIR, 'members');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(RESIDUE_DIR)) fs.mkdirSync(RESIDUE_DIR, { recursive: true });

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: false }));

// ─── Auth (passphrase, deployed only) ────────────────────────────────────────
// See auth.js (#193) for the extracted login page/routes/guard. Mounting
// order stays explicit here: session middleware, then the login/logout
// routes, then the requireAuth guard applied last — requireAuth must run
// before express.static below (a prior bug let static short-circuit the
// gate; see auth.js's createRequireAuth comment).

const PASSPHRASE = process.env.PASSPHRASE || null;

// A gated deploy with no real secret means every restart mints a fresh
// server-side signing key in effect (since the fallback is a shared, public
// string) — cookies from a previous secret verify against whichever process
// happens to be running. Fail loudly at startup rather than silently serving
// a passphrase gate that isn't actually gating anything.
if (!IS_LOCAL && PASSPHRASE && !process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET must be set when PASSPHRASE is set on a deployed instance. ' +
    'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

app.use(session({
  store: new FileStore({ path: AUTH_SESSIONS_DIR }),
  secret: process.env.SESSION_SECRET || 'local-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    secure: !IS_LOCAL,
    sameSite: 'lax',
  },
}));

auth.registerAuthRoutes(app, PASSPHRASE);
app.use(auth.createRequireAuth(PASSPHRASE));

// #84 — member page + knowledge-graph visualization, a clean URL for the
// meta-level research view (not tucked in a drawer, per the issue).
app.get('/lodge', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'lodge.html'));
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/babylonjs', express.static(path.join(__dirname, 'node_modules/babylonjs')));

// ─── Lodge roster ────────────────────────────────────────────────────────────
// Loaded from roster.json; reloadLodgeRoster() refreshes in-memory copy after
// writes. See roster.js for the extracted, Express-agnostic implementation
// (#193) — this section just owns the in-memory ROSTER singleton and the
// brief cache that the module's functions take as explicit parameters.

const ROSTER_FILE = path.join(MEMBERS_DIR, 'roster.json');
let ROSTER = [];

// Cache for roster.memberBrief(), cleared whenever the roster is reloaded —
// the only point at which member character files can change.
const briefCache = new Map();

function reloadLodgeRoster() {
  ROSTER = roster.reloadRoster(ROSTER_FILE, MEMBERS_DIR);
  briefCache.clear();
}
reloadLodgeRoster();

const lodgeContext = fs.readFileSync(path.join(PROMPTS_DIR, 'lodge-context.md'), 'utf8');
const axesDoc = fs.readFileSync(path.join(__dirname, 'docs', 'AXES.md'), 'utf8');

function loadMemberFile(filename) {
  return roster.loadMemberFile(MEMBERS_DIR, filename);
}

function memberBrief(member) {
  return roster.memberBrief(MEMBERS_DIR, briefCache, member);
}

function castingRoster() {
  return roster.castingRoster(MEMBERS_DIR, briefCache, ROSTER);
}

// ─── Session persistence ──────────────────────────────────────────────────────
// See sessions-store.js (#193) for the extracted implementation.

function makeSessionId(entry) {
  return sessionsStore.makeSessionId(entry);
}

function makeBranchId(parent, roundIndex) {
  return sessionsStore.makeBranchId(parent, roundIndex);
}

function saveSession(session) {
  return sessionsStore.saveSession(SESSIONS_DIR, session);
}

function loadSession(id) {
  return sessionsStore.loadSession(SESSIONS_DIR, id);
}

// ─── Anthropic call helpers ───────────────────────────────────────────────────

function openSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
}

// ─── Reading room (public, read-only) — #38 ───────────────────────────────────
// A session explicitly marked published renders at /reading-room/:id with no
// login and no client JS: just the source document and the transcript, typeset.
// Whole-session only for this MVP — no per-round curation, no portraits, no
// annotations (matches the issue's "no generation controls, no member grid").
// Rendering itself lives in reading-room.js (#193); server.js just wires the
// current ROSTER in.
//
// Speaker-header recognition lives in transcript-format.js (#193); aliased
// here for the Obsidian exporter below.
const { buildSpeakerHeaderSet, normalizeSpeaker } = transcriptFormat;

function renderReadingRoomPage(session) {
  return readingRoom.renderReadingRoomPage(session, ROSTER);
}

function formatTranscriptText(text) {
  return transcriptFormat.formatTranscriptText(text, ROSTER);
}

// ─── Passage prompts ──────────────────────────────────────────────────────────
// See lodge-prompts.js (#193, reshaped for #244 per #194's migration
// sketch) for the extracted, Express-agnostic implementation. Thin wrappers
// here supply the current ROSTER so existing call sites are unchanged.

// Total words spent across a session's segments so far — the "words spent"
// half of the arc note's progress key (see lodge-prompts.js's
// arcNoteForProgress). Segments predating #244 count too; a word is a word
// regardless of which round-vs-passage era generated it.
function wordsSpentSoFar(rounds) {
  return (rounds || []).reduce((sum, r) => sum + countWords(r.text || ''), 0);
}

function buildPassagePrompt({ entry, meetingNote, isFirst, artifact = null, isTranscriptSource = false, wordsSpent = 0 }) {
  return lodgePrompts.buildPassagePrompt({
    entry, meetingNote, isFirst, artifact, isTranscriptSource, roster: ROSTER,
    wordsSpent, breathBudget: BREATH_BUDGET_WORDS,
  });
}

function playerDirectorPool(memberIds, playerMode, playerMemberId) {
  return lodgePrompts.playerDirectorPool(memberIds, playerMode, playerMemberId);
}

function resolvePlayerName(playerMode, playerMemberId, playerName) {
  return lodgePrompts.resolvePlayerName(playerMode, playerMemberId, playerName, ROSTER);
}

function buildPrecedingTurn(speakerName, playerTurn) {
  return lodgePrompts.buildPrecedingTurn(speakerName, playerTurn, stripInternalBlankLines);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /api/convene — start a session and stream its first passage
app.post('/api/convene', async (req, res) => {
  const { entry, members } = req.body;
  if (!entry?.trim()) return res.status(400).json({ error: 'entry is required' });
  if (!members?.length) return res.status(400).json({ error: 'at least one member is required' });

  const { roundInstructions, meetingNote, roundCount, artifact, notes, sourceSessionId,
    playerMode, playerMemberId, playerName, playerTurn, castMetrics } = req.body;
  const isTranscriptSource = !!sourceSessionId;
  const id = makeSessionId(entry);
  const date = new Date().toISOString().slice(0, 10);
  // #194 touchpoint 2: roundInstructions (array) collapses to meetingNote
  // (single free-text field). deriveMeetingNote handles both since nothing
  // stops a caller from still sending the old shape.
  const effectiveMeetingNote = lodgePrompts.deriveMeetingNote({ meetingNote, roundInstructions });
  const passagePrompt = buildPassagePrompt({ entry, meetingNote: effectiveMeetingNote, isFirst: true, artifact: artifact || null, isTranscriptSource, wordsSpent: 0 });
  // #225 — the pre-convene casting call's usage rides in on the request body
  // (see /api/cast) rather than being held server-side; validate the shape
  // rather than trusting it wholesale since it's client-supplied.
  const generationMetrics = Array.isArray(castMetrics)
    ? castMetrics.filter(m => m && typeof m === 'object' && typeof m.phase === 'string')
    : [];

  const effectivePlayerMode = playerMode || 'none';
  const effectivePlayerMemberId = effectivePlayerMode === 'member' ? (playerMemberId || null) : null;
  const effectivePlayerName = resolvePlayerName(effectivePlayerMode, effectivePlayerMemberId, playerName);
  const precedingTurn = buildPrecedingTurn(effectivePlayerName, playerTurn);

  openSSE(res);
  try {
    const { fullRoundText: text, disposition, residueUpdates, beats, endedBy, lullNote } = await runRound({
      client, model: MODEL, lodgeContext, ROSTER, loadMemberFile, loadVoiceExemplar, loadResidue,
      presentMemberIds: playerDirectorPool(members, effectivePlayerMode, effectivePlayerMemberId),
      artifact: artifact || null, notes: notes || {},
      roundPrompt: passagePrompt, conversationHistory: [],
      speakerCount: lodgePrompts.DEFAULT_POOL_SIZE, round: 0, precedingTurn,
      disposition: {},
      onChunk: chunk => res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`),
      onSpeakerStart: memberId => res.write(`data: ${JSON.stringify({ speaking: memberId })}\n\n`),
      onSpeakerEnd: (memberId, name, text) => res.write(`data: ${JSON.stringify({ speakerDone: { memberId, name, text } })}\n\n`),
      onMetric: m => {
        generationMetrics.push(m);
        if (m.skipped) console.warn('[degraded]', m.phase, m.memberId || '', '—', m.error);
      },
    });
    const history = [
      { role: 'user', content: passagePrompt },
      { role: 'assistant', content: text },
    ];
    const session = {
      id, date, entry, members,
      meetingNote: effectiveMeetingNote || null,
      roundCount: roundCount || 3,
      artifact: artifact || null,
      notes: notes || {},
      sourceSessionId: sourceSessionId || null,
      conversationHistory: history,
      // #244: label is now the passage's own lull note (director-authored
      // or stock fallback) rather than a fixed "First Movement" — see
      // #194 touchpoint 4. beats/endedBy are new, forward-provision fields
      // (#194 touchpoint 8); existing renderers only ever read label/text.
      rounds: [{ label: lullNote, text, historyLength: history.length, beats, endedBy }],
      transcriptText: buildTranscriptHeader(entry, members, date) + `\n— ${lullNote} —\n\n${formatTranscriptText(text)}\n`,
      generationMetrics,
      playerMode: effectivePlayerMode,
      playerMemberId: effectivePlayerMemberId,
      playerName: effectivePlayerMode === 'custom' ? effectivePlayerName : null,
      playerTurns: precedingTurn ? [{ round: 0, speakerName: precedingTurn.speakerName, text: precedingTurn.text }] : [],
      disposition: disposition || {},
    };
    saveSession(session);
    saveResidueUpdates(residueUpdates);
    res.write(`data: ${JSON.stringify({ done: true, sessionId: id, round: 1, label: lullNote, text })}\n\n`);
  } catch (err) {
    console.error('Convene error:', err);
    res.write(`data: ${JSON.stringify({ error: err.message || 'Failed to convene lodge' })}\n\n`);
  }
  res.end();
});

// POST /api/cast — propose tonight's cast from the document (#185)
//
// Pre-convene and deliberately outside the session lifecycle: nothing is
// saved, nothing is started, and the answer is a suggestion the user accepts
// or ignores. Not SSE — one short tool call, so a plain JSON response.
app.post('/api/cast', async (req, res) => {
  const { entry, regulars } = req.body;
  if (!entry?.trim()) return res.status(400).json({ error: 'entry is required' });

  // No session exists yet to attach usage to (#225) — the casting call happens
  // before /api/convene creates one, if it ever does. Rather than holding
  // state server-side with nothing to key it on, the metrics ride along in
  // this response; the client hands them back on /api/convene (see
  // public/casting.js's consumeMetrics + app.js's castMetrics) so they land
  // in session.generationMetrics same as every other phase. A proposal the
  // user never accepts just never sends its metrics anywhere — no session
  // means no persisted metrics either way, which is the same "cost of a
  // proposal nobody used" the rest of the app already accepts.
  const metrics = [];
  try {
    const result = await proposeCast({
      client, model: MODEL, lodgeContext,
      roster: castingRoster(),
      regularIds: Array.isArray(regulars) ? regulars : [],
      documentText: entry,
      onMetric: m => {
        metrics.push(m);
        if (m.skipped) console.warn('[degraded]', m.phase, '—', m.error);
      },
    });
    res.json({ ...result, metrics });
  } catch (err) {
    console.error('Casting error:', err);
    res.status(500).json({ error: err.message || 'Could not read the room' });
  }
});

// POST /api/round — the continue path (#194 touchpoint 5: "One More Turn"
// renamed in-stream to "Continue"; this route's own behavior is unchanged —
// generate the next passage into the session). The old client drives its
// own loop with a preordained round count and calls this once per round; it
// never sees a `lull` endedBy, since it decides when to stop on its own.
app.post('/api/round', async (req, res) => {
  const { sessionId, playerTurn } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const session = loadSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const roundIndex = session.rounds.length;
  const meetingNote = lodgePrompts.deriveMeetingNote(session);
  const wordsSpent = wordsSpentSoFar(session.rounds);
  const passagePrompt = buildPassagePrompt({ entry: session.entry, meetingNote, isFirst: false, wordsSpent });

  session.generationMetrics = session.generationMetrics || [];

  const effectivePlayerName = resolvePlayerName(session.playerMode, session.playerMemberId, session.playerName);
  const precedingTurn = buildPrecedingTurn(effectivePlayerName, playerTurn);

  openSSE(res);
  try {
    const { fullRoundText: text, disposition, residueUpdates, beats, endedBy, lullNote } = await runRound({
      client, model: MODEL, lodgeContext, ROSTER, loadMemberFile, loadVoiceExemplar, loadResidue,
      presentMemberIds: playerDirectorPool(session.members, session.playerMode, session.playerMemberId),
      artifact: null, notes: {},
      roundPrompt: passagePrompt, conversationHistory: session.conversationHistory.slice(-6),
      speakerCount: lodgePrompts.DEFAULT_POOL_SIZE, round: roundIndex, precedingTurn,
      disposition: session.disposition || {},
      onChunk: chunk => res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`),
      onSpeakerStart: memberId => res.write(`data: ${JSON.stringify({ speaking: memberId })}\n\n`),
      onSpeakerEnd: (memberId, name, text) => res.write(`data: ${JSON.stringify({ speakerDone: { memberId, name, text } })}\n\n`),
      onMetric: m => {
        session.generationMetrics.push(m);
        if (m.skipped) console.warn('[degraded]', m.phase, m.memberId || '', '—', m.error);
      },
    });

    session.conversationHistory.push({ role: 'user', content: passagePrompt });
    session.conversationHistory.push({ role: 'assistant', content: text });
    session.rounds.push({ label: lullNote, text, historyLength: session.conversationHistory.length, beats, endedBy });
    session.transcriptText += `\n— ${lullNote} —\n\n${formatTranscriptText(text)}\n`;
    session.disposition = disposition || {};
    if (precedingTurn) {
      session.playerTurns = session.playerTurns || [];
      session.playerTurns.push({ round: roundIndex, speakerName: precedingTurn.speakerName, text: precedingTurn.text });
    }

    saveSession(session);
    saveResidueUpdates(residueUpdates);
    res.write(`data: ${JSON.stringify({ done: true, round: roundIndex + 1, label: lullNote, text })}\n\n`);
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

  const prompt = `A mysterious presence — an observer from outside time — has just spoken: "${text}"\n\nThe room reacts to what was said.`;
  session.generationMetrics = session.generationMetrics || [];

  openSSE(res);
  try {
    const { fullRoundText: response, disposition, residueUpdates } = await runRound({
      client, model: MODEL, lodgeContext, ROSTER, loadMemberFile, loadVoiceExemplar, loadResidue,
      presentMemberIds: playerDirectorPool(session.members, session.playerMode, session.playerMemberId),
      artifact: null, notes: {},
      roundPrompt: prompt, conversationHistory: session.conversationHistory.slice(-6),
      speakerCount: Math.min(lodgePrompts.INTERJECT_SPEAKER_COUNT, session.members.length), round: session.rounds.length,
      disposition: session.disposition || {},
      onChunk: chunk => res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`),
      onSpeakerStart: memberId => res.write(`data: ${JSON.stringify({ speaking: memberId })}\n\n`),
      onSpeakerEnd: (memberId, name, text) => res.write(`data: ${JSON.stringify({ speakerDone: { memberId, name, text } })}\n\n`),
      onMetric: m => {
        session.generationMetrics.push(m);
        if (m.skipped) console.warn('[degraded]', m.phase, m.memberId || '', '—', m.error);
      },
    });

    session.conversationHistory.push({ role: 'user', content: prompt });
    session.conversationHistory.push({ role: 'assistant', content: response });
    session.transcriptText += `\n— A Presence Passes Through —\n\n— a voice from elsewhere —\n${text}\n\n${formatTranscriptText(response)}\n`;
    session.disposition = disposition || {};

    saveSession(session);
    saveResidueUpdates(residueUpdates);
    res.write(`data: ${JSON.stringify({ done: true, label: 'A Presence Passes Through', text: response })}\n\n`);
  } catch (err) {
    console.error('Interject error:', err);
    res.write(`data: ${JSON.stringify({ error: 'Failed to interject' })}\n\n`);
  }
  res.end();
});

// POST /api/prototype/round — Stage 3 of #51: local-only test route for the
// new director + per-speaker pipeline. Never touches session storage (no
// saveSession call) — purely for validating the pipeline end-to-end against
// the existing, unmodified client rendering before any live route is cut
// over to it.
app.post('/api/prototype/round', async (req, res) => {
  if (!IS_LOCAL) return res.status(404).json({ error: 'Not available in deployed mode' });

  const { entry, members, speakerCount } = req.body;
  if (!entry?.trim()) return res.status(400).json({ error: 'entry is required' });
  if (!members?.length) return res.status(400).json({ error: 'at least one member is required' });

  const roundPrompt = buildPassagePrompt({ entry, isFirst: true, isTranscriptSource: false });
  const metrics = [];

  openSSE(res);
  try {
    const { fullRoundText, speakerOrder } = await runRound({
      client, model: MODEL, lodgeContext, ROSTER, loadMemberFile, loadVoiceExemplar,
      presentMemberIds: members, artifact: null, notes: {},
      roundPrompt, conversationHistory: [],
      speakerCount: speakerCount || Math.min(members.length, 5),
      round: 0,
      onChunk: chunk => res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`),
      onMetric: m => metrics.push(m),
    });
    res.write(`data: ${JSON.stringify({ done: true, fullRoundText, speakerOrder, metrics })}\n\n`);
  } catch (err) {
    console.error('[prototype] round error:', err);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
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
  const { transcriptText, sessionDate, title, group, groupId } = req.body;
  if (!transcriptText) return res.status(400).json({ error: 'transcriptText required' });

  const sheetTitle = `[Secret-Cabin-et] ${title || sessionDate || 'Meeting Notes'}`;
  const markdown = `# ${sheetTitle}\n\n${transcriptText}`;

  // Build URL using new-sheet scheme — no temp file, no shell quoting issues
  const params = new URLSearchParams({ text: markdown });
  // Ulysses' group= param resolves a bare name to whichever group matches first,
  // regardless of hierarchy — unreliable for subfolders. A callback identifier
  // (copied from Ulysses via Option+right-click → Copy Callback Identifier)
  // targets the exact group, so prefer it when supplied.
  const targetGroup = groupId?.trim() || group?.trim();
  if (targetGroup) params.set('group', targetGroup);
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
    const obsidianHeaders = buildSpeakerHeaderSet(ROSTER);
    const obsidianTranscript = transcriptText.split('\n').map(line => {
      const bare = line.replace(/ —$/, '').trim();
      return obsidianHeaders.has(normalizeSpeaker(bare)) ? `**${bare}**` : line;
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
          parentId: d.parentId || null,
          branchRound: d.branchRound ?? null,
          published: !!d.published,
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

// Citation verification (#153) lives in citations.js (#193); thin wrappers
// here supply the current client/model.
function groundAgainstLibraryText(citationsList, libraryLookup, onMetric) {
  return citations.groundAgainstLibraryText(client, MODEL, citationsList, libraryLookup, onMetric);
}

function escalateCitationsToWeb(citationsList) {
  return citations.escalateCitationsToWeb(citationsList);
}

// POST /api/sessions/:id/verify-citations — extract & judge citations across the whole session
app.post('/api/sessions/:id/verify-citations', async (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.generationMetrics = session.generationMetrics || [];

  try {
    const fullText = session.transcriptText || '';
    const dividerIndex = fullText.indexOf('\n— ');
    const roundsText = dividerIndex >= 0 ? fullText.slice(dividerIndex + 1) : fullText;

    const libraryLookup = loadLibraryCitationLookup();
    const libraryList = Object.entries(libraryLookup)
      .map(([id, e]) => `${id}: ${e.title} — ${e.source}`).join('\n');

    const system = `You are reviewing a transcript from a salon conversation among historical figures for citation accuracy. Members cite real texts, authors, and historical claims in free-form prose.

Extract every citation of a real (or purportedly real) text, author, or historical/scholarly claim from the transcript below. For each one, judge from your own knowledge whether it refers to a real work/claim and whether it's represented accurately:
- "verified": you're confident this is a real work/claim, accurately represented
- "unverified": this appears to be invented, or is represented inaccurately
- "uncertain": you can't confidently judge either way

Also check this list of archival library entries; if a citation clearly refers to one of them, set libraryMatch to that entry's id, else null:
${libraryList}

The "quote" field must be a verbatim excerpt (~10-25 words) copied exactly from the transcript text below, so it can be located in the original.`;

    const extractStart = Date.now();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system,
      messages: [{ role: 'user', content: roundsText }],
      tools: [{
        name: 'report_citations',
        description: 'Report every citation found in the transcript, with a verdict for each.',
        input_schema: {
          type: 'object',
          properties: {
            citations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  speaker: { type: 'string', description: 'As written in the transcript\'s "Name —" line.' },
                  quote: { type: 'string', description: 'Verbatim ~10-25 word excerpt from the transcript containing the citation.' },
                  work: { type: 'string', description: 'The cited work, author, or claim as named.' },
                  verdict: { type: 'string', enum: ['verified', 'unverified', 'uncertain'] },
                  note: { type: 'string', description: 'One-sentence reasoning for the verdict.' },
                  libraryMatch: { type: ['string', 'null'], description: 'Matching library entry id, or null.' },
                },
                required: ['speaker', 'quote', 'work', 'verdict', 'note'],
              },
            },
          },
          required: ['citations'],
        },
      }],
      tool_choice: { type: 'tool', name: 'report_citations' },
    });
    session.generationMetrics.push(makeMetric('citation-extraction', { usage: response.usage, latencyMs: Date.now() - extractStart }));

    const archiveImages = loadArchiveImageIndex();
    const block = response.content.find(b => b.type === 'tool_use');
    const rawCitations = block?.input?.citations || [];
    // #153 part 1 — re-check library-matched citations against the entry's
    // actual text, rather than trusting the extraction pass's title/source
    // match. Skipped (no extra call) when nothing matched this round.
    const grounded = await groundAgainstLibraryText(rawCitations, libraryLookup, m => session.generationMetrics.push(m));
    // #153 part 2 — for citations that didn't match a library entry, attempt
    // a real web lookup (capped, see MAX_WEB_ESCALATIONS) before trusting the
    // model's own memory-based verdict.
    const webEscalated = await escalateCitationsToWeb(rawCitations);
    const citations = rawCitations.map((c, index) => {
      const match = c.libraryMatch ? libraryLookup[c.libraryMatch] : null;
      const image = c.libraryMatch ? archiveImages[c.libraryMatch] : null;
      const refined = grounded.get(index);
      const web = webEscalated.get(index);
      return {
        ...c,
        ...(refined ? { verdict: refined.verdict, note: refined.note } : {}),
        ...(web ? { verdict: web.verdict, note: web.note } : {}),
        // #153 part 3 — reflects what was actually checked, not what merely
        // matched: a libraryMatch that didn't make it through grounding (e.g.
        // the entry was missing text) stays "model-knowledge", same failure
        // mode #157 found in treating "has a link" as "was verified".
        source: refined ? 'library' : (web ? web.source : 'model-knowledge'),
        libraryCitation: match?.citation || null,
        librarySourceUrl: match?.source_url || null,
        libraryImage: image?.image || null,
        webSourceUrl: web?.webSourceUrl || null,
        webSourceTitle: web?.webSourceTitle || null,
      };
    });

    session.citationFlags = citations;
    saveSession(session);
    res.json({ citations });
  } catch (err) {
    console.error('Citation verification error:', err);
    res.status(500).json({ error: 'Failed to verify citations' });
  }
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

// POST /api/sessions/:id/branch — fork a new session sharing history up to roundIndex
// #33: lets the user explore an alternative path from any round boundary without
// losing the original thread. No Claude call — a pure copy-and-truncate.
app.post('/api/sessions/:id/branch', (req, res) => {
  const { roundIndex } = req.body;
  const parent = loadSession(req.params.id);
  if (!parent) return res.status(404).json({ error: 'Session not found' });
  if (!Number.isInteger(roundIndex) || roundIndex < 0 || roundIndex >= (parent.rounds?.length || 0)) {
    return res.status(400).json({ error: 'roundIndex out of range' });
  }

  // Legacy sessions predate the historyLength field — best-guess assuming no
  // interjections happened before the branch point (2 history entries/round).
  const historyLength = parent.rounds[roundIndex].historyLength ?? (roundIndex + 1) * 2;
  const branchedRounds = parent.rounds.slice(0, roundIndex + 1).map(r => ({ ...r }));
  const branchedHistory = parent.conversationHistory.slice(0, historyLength).map(h => ({ ...h }));

  const date = new Date().toISOString().slice(0, 10);
  const id = makeBranchId(parent, roundIndex);

  let transcriptText = buildTranscriptHeader(parent.entry, parent.members, date);
  branchedRounds.forEach(r => {
    transcriptText += `\n— ${r.label} —\n\n${formatTranscriptText(r.text)}\n`;
  });

  const branch = {
    id, date,
    entry: parent.entry,
    members: [...parent.members],
    // #244: meetingNote is the current field; roundInstructions carries
    // forward untouched for a legacy parent that still only has that (see
    // lodgePrompts.deriveMeetingNote, which reads either).
    meetingNote: parent.meetingNote || null,
    roundInstructions: parent.roundInstructions || null,
    roundCount: parent.roundCount || 3,
    artifact: parent.artifact || null,
    notes: parent.notes || {},
    disposition: parent.disposition || {},
    sourceSessionId: parent.sourceSessionId || null,
    conversationHistory: branchedHistory,
    rounds: branchedRounds,
    transcriptText,
    generationMetrics: [],
    playerMode: parent.playerMode || 'none',
    playerMemberId: parent.playerMemberId || null,
    playerName: parent.playerName || null,
    playerTurns: (parent.playerTurns || []).filter(pt => pt.round <= roundIndex).map(pt => ({ ...pt })),
    parentId: parent.id,
    branchRound: roundIndex,
  };
  saveSession(branch);
  res.json({ sessionId: id });
});

// GET /api/sessions/:id/transcript — return annotated transcript text for reconvening
// Weaves stored annotations into the transcript text, same as the frontend export does.
app.get('/api/sessions/:id/transcript', (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  let transcript = session.transcriptText || '';

  // Weave in stored annotations if present
  const annotations = session.annotations || {};
  if (Object.keys(annotations).length) {
    const lines = transcript.split('\n');
    const result = [];
    let i = 0;
    while (i < lines.length) {
      result.push(lines[i]);
      const match = lines[i].match(/^(.+) —$/);
      if (match) {
        const speaker = match[1];
        // Find annotation by speaker name match
        const note = Object.values(annotations).find(a => a.speaker === speaker)?.note;
        if (note) {
          while (i + 1 < lines.length && lines[i + 1] !== '') { i++; result.push(lines[i]); }
          result.push(`  ↳ ${note}`);
        }
      }
      i++;
    }
    transcript = result.join('\n');
  }

  // Weave in a player-turn marker if present, keyed by round position (not
  // fuzzy speaker/quote matching — the round index is precisely known).
  const playerTurns = session.playerTurns || [];
  if (playerTurns.length) {
    const byRound = new Map(playerTurns.map(pt => [pt.round, pt]));
    const lines = transcript.split('\n');
    const result = [];
    let roundIdx = -1, markedThisRound = false, i = 0;
    while (i < lines.length) {
      result.push(lines[i]);
      // Round dividers ("— First Movement —") also match the looser
      // speaker-header pattern below, so they must be checked first.
      const isDivider = /^— (.+) —$/.test(lines[i]);
      if (isDivider) { roundIdx++; markedThisRound = false; }
      const speakerMatch = !isDivider && lines[i].match(/^(.+) —$/);
      if (speakerMatch && !markedThisRound && byRound.has(roundIdx)) {
        markedThisRound = true;
        while (i + 1 < lines.length && lines[i + 1] !== '') { i++; result.push(lines[i]); }
        result.push('  ⟡ played by a human participant, live');
      }
      i++;
    }
    transcript = result.join('\n');
  }

  const memberNames = (session.members || [])
    .map(id => ROSTER.find(m => m.id === id)?.name)
    .filter(Boolean);

  res.json({
    id: session.id,
    date: session.date,
    members: memberNames,
    entry: session.entry?.slice(0, 80),
    transcript,
  });
});

// PATCH /api/sessions/:id/publish — mark/unmark a session for the public reading room
app.patch('/api/sessions/:id/publish', (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.published = !!req.body.published;
  session.publishedAt = session.published ? new Date().toISOString() : null;
  saveSession(session);
  res.json({ published: session.published, publishedAt: session.publishedAt, url: `/reading-room/${session.id}` });
});

// GET /reading-room/:id — public, unauthenticated. 404s (rather than
// distinguishing "not found" from "not published") so an unpublished
// session's existence isn't revealed to an unauthenticated caller.
app.get('/reading-room/:id', (req, res) => {
  const session = loadSession(req.params.id);
  if (!session || !session.published) return res.status(404).send('Not found.');
  res.send(renderReadingRoomPage(session));
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

  res.json({
    id: member.id,
    name: member.name,
    bio: roster.extractSection(text, 'WHO YOU ARE'),
    voice: roster.extractSection(text, 'HOW YOU SPEAK'),
  });
});

// POST /api/members — draft + save a new character file, update roster
app.post('/api/members', async (req, res) => {
  const { name, bio, voiceRegister, cognitiveStyle, relationships } = req.body;
  if (!name?.trim() || !bio?.trim()) return res.status(400).json({ error: 'name and bio are required' });

  // Build a safe filename + id from the name
  const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const file = `${id}.md`;
  const filePath = path.join(MEMBERS_DIR, file);

  if (fs.existsSync(filePath)) {
    return res.status(409).json({ error: `A member file already exists for "${name}". Choose a different name or edit the file directly.` });
  }

  // Two canonical character files as format exemplars — deliberately stylistically
  // different (Crowley baroque/needling, Jung measured/clinical) so the generator
  // learns the *structure* and depth bar, not one character's specific voice.
  const exemplarCrowley = loadMemberFile('crowley.md');
  const exemplarJung = loadMemberFile('jung.md');

  const systemPrompt = `You are a researcher and writer helping build a character prompt for a historical salon simulation called The Secret-Cabin-et. The salon is atemporal — members from different centuries speak together as equals. You will write a character system prompt matching the structure and depth of the two exemplars below — not the specific voice of either one. Crowley is baroque, associative, and needling; Jung is measured and clinical. Neither is the template for tone — the person you're drafting sets their own tone. Read both for how much specificity and depth each section carries, then write to that bar for this character.

The character file must contain these sections, in order:
- # [NAME IN CAPS]
- ### Character System Prompt — the Secret-Cabin-et
- *Builds on: Lodge Context Document*
- ## WHO YOU ARE — 3–4 paragraphs: historical identity, expertise, self-understanding, and at least one honest complicating note — something this person would rather not examine, or (see historical accuracy rule below) a genuinely documented tension in their record
- **Optional bespoke section(s)** — 0–2 additional named sections unique to this person (in the spirit of Crowley's "THE PERSISTENT MINOR ELEMENT" or Jung's "THE SOCIETY, RENAMED" / "THE NEKYIA, IN GENERAL") for a real, specific, documented tension, controversy, or defining relationship the generic sections don't have room for. Only add one if the biography actually supports it — don't invent a section for its own sake, and don't force one if nothing warrants it.
- ## HOW YOU SPEAK — 3–5 paragraphs: register, rhythm, rhetorical moves, what they do with disagreement
- ## YOUR RELATIONSHIPS IN THIS ROOM — one substantive paragraph per relevant member present in the room (use only the members listed in the existing roster: ${ROSTER.map(m => m.name).join(', ')}). Ground each in something specific and real — a shared teacher, a documented meeting or correspondence, a textual influence, a real point of intellectual overlap or conflict — not generic sentiment. **Before writing this section, read INTERPRETIVE LENSES below.** If a relationship echoes a pattern already worked out there, apply the refined framing rather than reinventing it or reintroducing a version that was explicitly rejected.
- ## WHAT YOU DO WITH THE DOCUMENT — 2 paragraphs about how this member engages with a journal entry read aloud
- ## WHAT YOU DO NOT DO — bullet list of 4–6 hard constraints on this character's voice
- *Character prompt complete. Deploy on top of Lodge Context Document.*

Rules:
- Write in second person ("You are…", "You speak…")
- Be specific: cite real texts, real positions, real historical tensions
- Do not invent citations or relationships
- Keep the same section headers and formatting as the exemplars; match tone to the person, not to either exemplar
- Do not summarize or editorialize — write the prompt as if deploying it directly
- **Historical accuracy over authorial gloss (INTERPRETIVE LENSES, Axis 3):** if this person's documented life includes genuinely controversial material — prejudice, cruelty, complicity — represent it accurately and proportionately. Don't omit it for the room's comfort, and don't inflate it into caricature. If you're not confident of the shape or severity of something, don't guess at specifics — write around it rather than fabricate a claim.
- **Register:** per the Lodge Context Document's REGISTER PERMISSIONS (included below), humor and the erotic are available to every member in proportion to their own nature. Don't silently default this character to a flat or humorless register unless that flatness is itself true to who they were.

INTERPRETIVE LENSES — consult before drafting relationships (a writer's reference, not part of the runtime prompt):
${axesDoc}

LODGE CONTEXT — REGISTER PERMISSIONS (for calibrating voice, not to be echoed verbatim):
${lodgeContext.slice(lodgeContext.indexOf('## REGISTER PERMISSIONS'), lodgeContext.indexOf('## FORMAT — ACTIONS AND SPEECH'))}

EXEMPLAR ONE (Crowley — baroque, needling, high-theater):
${exemplarCrowley}

EXEMPLAR TWO (Jung — measured, clinical, a controversy held without a clean verdict):
${exemplarJung}`;

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
      model: MODEL,
      max_tokens: 7000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });
    const characterFile = response.content.filter(b => b.type === 'text').map(b => b.text).join('');

    fs.writeFileSync(filePath, characterFile, 'utf8');

    const newMember = { id, name: name.trim(), file, glyph: roster.assignGlyph(ROSTER) };
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

// ─── Knowledge graph ──────────────────────────────────────────────────────────
// See graph.js (#193) for the extracted implementation.

const GRAPH_FILE = path.join(PROMPTS_DIR, 'graph', 'graph.json');

// GET /api/graph — return full knowledge graph
app.get('/api/graph', (req, res) => {
  try {
    res.json(graph.buildGraph(ROSTER, GRAPH_FILE, LIBRARY_FILE, SESSIONS_DIR));
  } catch (err) {
    console.error('Graph error:', err);
    res.status(500).json({ error: 'Failed to build graph' });
  }
});

// ─── Library routes ───────────────────────────────────────────────────────────

const LIBRARY_DIR = path.join(PROMPTS_DIR, 'library');
const LIBRARY_FILE = path.join(LIBRARY_DIR, 'library.json');
const ARCHIVE_IMAGE_FILE = path.join(__dirname, 'public', 'archive', 'metadata.json');

function loadLibraryIndex() {
  return library.loadLibraryIndex(LIBRARY_FILE);
}

function loadArchiveImageIndex() {
  return library.loadArchiveImageIndex(ARCHIVE_IMAGE_FILE);
}

// GET /api/library — list all entries (index only, no full text)
// Optional query params: ?member=crowley, ?theme=schism, ?q=search+terms
app.get('/api/library', (req, res) => {
  try {
    let entries = loadLibraryIndex();
    const { member, theme, q } = req.query;
    if (member) entries = entries.filter(e => e.members?.includes(member));
    if (theme)  entries = entries.filter(e => e.themes?.includes(theme));
    if (q) {
      const terms = q.toLowerCase().split(/\s+/);
      entries = entries.filter(e =>
        terms.every(t =>
          e.title.toLowerCase().includes(t) ||
          e.source.toLowerCase().includes(t) ||
          e.themes?.some(th => th.includes(t)) ||
          e.members?.some(m => m.includes(t))
        )
      );
    }
    const images = loadArchiveImageIndex();
    entries = entries.map(e => ({ ...e, image: images[e.id]?.image || null }));
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load library' });
  }
});

// GET /api/library/:id — return full text of a single entry
app.get('/api/library/:id', (req, res) => {
  try {
    const index = loadLibraryIndex();
    const entry = index.find(e => e.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    const filePath = path.join(LIBRARY_DIR, entry.file);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    const raw = fs.readFileSync(filePath, 'utf8');
    // Strip YAML frontmatter, return plain text
    const text = raw.replace(/^---[\s\S]*?---\n/, '').trim();
    const image = loadArchiveImageIndex()[entry.id]?.image || null;
    const { citation, source_url } = parseLibraryFrontmatter(raw);
    res.json({ ...entry, text, image, citation, source_url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load entry' });
  }
});

function parseLibraryFrontmatter(raw) {
  return library.parseLibraryFrontmatter(raw);
}

function loadVoiceExemplar(memberId) {
  return library.loadVoiceExemplar(LIBRARY_DIR, LIBRARY_FILE, memberId);
}

// #166 — cross-session residue store, one small JSON file per member in
// RESIDUE_DIR. Read by runRound (pipeline.js) via the injected `loadResidue`
// function, same dependency-injection pattern as loadMemberFile and
// loadVoiceExemplar above — pipeline.js never touches the filesystem
// directly, so it stays testable as pure functions (see test/pipeline.test.js).
function residuePath(memberId) {
  return path.join(RESIDUE_DIR, `${memberId}.json`);
}

function loadResidue(memberId) {
  const p = residuePath(memberId);
  if (!fs.existsSync(p)) return '';
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')).text || '';
  } catch (err) {
    console.warn('[residue] failed to read', memberId, '—', err.message);
    return '';
  }
}

// Best-effort, one file per member who actually wrote a fresh fragment this
// round — most rounds this object is empty (see buildDispositionToolSchema's
// residueNote: "most turns, nothing belongs here"). A write failure must
// never fail a round that has already streamed successfully to the client.
function saveResidueUpdates(residueUpdates) {
  for (const [memberId, text] of Object.entries(residueUpdates || {})) {
    try {
      fs.writeFileSync(residuePath(memberId), JSON.stringify({ text, updatedAt: new Date().toISOString() }, null, 2));
    } catch (err) {
      console.warn('[residue] failed to save', memberId, '—', err.message);
    }
  }
}

function loadLibraryCitationLookup() {
  return library.loadLibraryCitationLookup(LIBRARY_DIR, LIBRARY_FILE);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildTranscriptHeader(entry, memberIds, date) {
  return transcriptFormat.buildTranscriptHeader(entry, memberIds, date, ROSTER);
}

// ─── Start ────────────────────────────────────────────────────────────────────

// Local dev only: concurrent worktree sessions default to the same PORT, so
// on collision we scan upward for a free one instead of crashing (#211). In
// production, Railway assigns PORT and expects the app to bind exactly that
// port for routing to work — fail fast there instead of silently drifting.
const MAX_PORT_ATTEMPTS = 10;

function startServer(port, attemptsLeft) {
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`The Secret-Cabin-et is open at http://localhost:${port}`);
  });
  server.on('error', (err) => {
    if (IS_LOCAL && err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`Port ${port} is already in use, trying ${port + 1}...`);
      startServer(port + 1, attemptsLeft - 1);
    } else {
      throw err;
    }
  });
}

startServer(PORT, MAX_PORT_ATTEMPTS);
