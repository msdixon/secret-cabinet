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

const dayOne = require('./src/dayone');
const {
  buildMemberSection,
  runRound,
  stripInternalBlankLines,
  proposeCast,
  makeMetric,
  countWords,
  BREATH_BUDGET_WORDS,
} = require('./src/pipeline');
const roster = require('./src/roster');
const transcriptFormat = require('./src/transcript-format');
const readingRoom = require('./src/reading-room');
const lodgePrompts = require('./src/lodge-prompts');
const library = require('./src/library');
const citations = require('./src/citations');
const graph = require('./src/graph');
const sessionsStore = require('./src/sessions-store');
const citationManifest = require('./scripts/build-citation-manifest');
const bibliography = require('./src/bibliography');
const auth = require('./src/auth');
const { registerLibraryRoutes } = require('./src/routes/library');
const { registerGraphRoutes } = require('./src/routes/graph');
const { registerUploadRoutes } = require('./src/routes/upload');
const { registerMemberRoutes } = require('./src/routes/member');
const { registerExportRoutes } = require('./src/routes/export');
const { registerSessionRoutes } = require('./src/routes/session');
const { registerConveneRoutes } = require('./src/routes/convene');
const { registerVoiceRoutes } = require('./src/routes/voice');

// ─── Environment flags ────────────────────────────────────────────────────────
const IS_LOCAL = process.env.LOCAL === 'true' || process.env.NODE_ENV !== 'production';
const MODEL = process.env.MODEL || 'claude-sonnet-4-6';
// #29 (ElevenLabs pass) — unset by default, which is what keeps the feature
// entirely off (routes/voice.js's /api/voice/config reports `available:
// false` and voice.js falls back to the Web Speech API, same as before this
// pass). ELEVENLABS_VOICE_POOL lets a comma-separated list of voice IDs
// override roster.js's FALLBACK_VOICE_IDS pool without a code change, once
// you've checked which voices actually exist in the target account's Voice
// Library.
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || null;
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5';
const ELEVENLABS_VOICE_POOL = process.env.ELEVENLABS_VOICE_POOL
  ? process.env.ELEVENLABS_VOICE_POOL.split(',')
      .map(s => s.trim())
      .filter(Boolean)
  : null;

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
// #29 (ElevenLabs pass) — synthesized audio, keyed by voice+text (see
// routes/voice.js). A sibling of SESSIONS_DIR/RESIDUE_DIR for the same
// reason: on Railway this needs to survive redeploys or every restart
// re-spends ElevenLabs credits re-synthesizing lines already paid for.
const VOICE_CACHE_DIR = path.join(DATA_DIR, 'voice-cache');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(RESIDUE_DIR)) fs.mkdirSync(RESIDUE_DIR, { recursive: true });
if (!fs.existsSync(VOICE_CACHE_DIR)) fs.mkdirSync(VOICE_CACHE_DIR, { recursive: true });

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
  console.error(
    'SESSION_SECRET must be set when PASSPHRASE is set on a deployed instance. ' +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
  );
  process.exit(1);
}

app.use(
  session({
    store: new FileStore({ path: AUTH_SESSIONS_DIR }),
    secret: process.env.SESSION_SECRET || 'local-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      secure: !IS_LOCAL,
      sameSite: 'lax',
    },
  })
);

auth.registerAuthRoutes(app, PASSPHRASE);
app.use(auth.createRequireAuth(PASSPHRASE));

// #84 — member page + knowledge-graph visualization, a clean URL for the
// meta-level research view (not tucked in a drawer, per the issue).
app.get('/lodge', (req, res) => {
  res.sendFile('lodge.html', { root: path.join(__dirname, 'public') });
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
  // Only backfill voiceId when ElevenLabs is actually configured (#29) — an
  // install with no key set shouldn't get roster.json mutated with voice IDs
  // nothing will ever call.
  const voicePool = ELEVENLABS_API_KEY ? ELEVENLABS_VOICE_POOL || roster.FALLBACK_VOICE_IDS : null;
  ROSTER = roster.reloadRoster(ROSTER_FILE, MEMBERS_DIR, voicePool);
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
    Connection: 'keep-alive',
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

function composeSegmentText(segment) {
  return transcriptFormat.composeSegmentText(segment, ROSTER);
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

// Its who-has-spoken sibling, `turnsSoFar` (#352), lives in lodge-prompts.js
// and is passed straight through to the convene routes below the same way
// `deriveMeetingNote` is — see that function's own comment for why it isn't
// written out here alongside this one.

function buildPassagePrompt({
  entry,
  meetingNote,
  isFirst,
  artifact = null,
  isTranscriptSource = false,
  wordsSpent = 0,
}) {
  return lodgePrompts.buildPassagePrompt({
    entry,
    meetingNote,
    isFirst,
    artifact,
    isTranscriptSource,
    roster: ROSTER,
    wordsSpent,
    breathBudget: BREATH_BUDGET_WORDS,
  });
}

function playerDirectorPool(memberIds, playerMode, playerMemberId) {
  return lodgePrompts.playerDirectorPool(memberIds, playerMode, playerMemberId);
}

function resolvePlayerName(playerMode, playerMemberId, playerName) {
  return lodgePrompts.resolvePlayerName(playerMode, playerMemberId, playerName, ROSTER);
}

function buildPrecedingTurn(speakerName, playerTurn, memberId) {
  return lodgePrompts.buildPrecedingTurn(speakerName, playerTurn, stripInternalBlankLines, memberId);
}

// ─── Library / graph path constants ──────────────────────────────────────────

const LIBRARY_DIR = path.join(PROMPTS_DIR, 'library');
const LIBRARY_FILE = path.join(LIBRARY_DIR, 'library.json');
const ARCHIVE_IMAGE_FILE = path.join(__dirname, 'public', 'archive', 'metadata.json');
const GRAPH_FILE = path.join(PROMPTS_DIR, 'graph', 'graph.json');

function loadLibraryIndex() {
  return library.loadLibraryIndex(LIBRARY_FILE);
}

function loadArchiveImageIndex() {
  return library.loadArchiveImageIndex(ARCHIVE_IMAGE_FILE);
}

function loadVoiceExemplar(memberId) {
  return library.loadVoiceExemplar(LIBRARY_DIR, LIBRARY_FILE, memberId);
}

// #268 — relationship-as-data layer. Reads the same knowledge graph (#22/
// #84) the /api/graph route builds, at query time, same as that route —
// runRound (pipeline.js) caches the result for the life of one round via
// the injected loadRelationshipEdges function, same convention as
// loadVoiceExemplar/loadResidue above.
function loadRelationshipEdges() {
  return graph.buildGraph(ROSTER, GRAPH_FILE, LIBRARY_FILE, SESSIONS_DIR).edges;
}

function loadLibraryCitationLookup() {
  return library.loadLibraryCitationLookup(LIBRARY_DIR, LIBRARY_FILE);
}

// #356 — the bibliography's Library appendix needs each entry's
// publication-ready `citation` string, which only loadLibraryCitationLookup
// reads (off the .md frontmatter, not library.json's index) — merge the two
// the same way scripts/build-bibliography.js's CLI path does.
function loadBibliographyLibraryEntries() {
  const lookup = loadLibraryCitationLookup();
  return loadLibraryIndex().map(entry => ({ ...entry, ...lookup[entry.id] }));
}

// Citation verification (#153) lives in citations.js; thin wrappers here
// supply the current client/model, same convention as the rest of this file.
function groundAgainstLibraryText(citationsList, libraryLookup, onMetric) {
  return citations.groundAgainstLibraryText(client, MODEL, citationsList, libraryLookup, onMetric);
}

function escalateCitationsToWeb(citationsList) {
  return citations.escalateCitationsToWeb(citationsList);
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

function buildTranscriptHeader(entry, memberIds, date) {
  return transcriptFormat.buildTranscriptHeader(entry, memberIds, date, ROSTER);
}

// GET /api/config — surface environment flags to the frontend
app.get('/api/config', (req, res) => {
  res.json({ isLocal: IS_LOCAL });
});

// ─── Routes ──────────────────────────────────────────────────────────────────
// Route handlers extracted per #193's second pass — see src/routes/ for the
// implementations (library, graph, upload, member, export, session, convene;
// the `-routes` suffix became the directory name in #272). Every
// module takes its dependencies as an explicit parameter (no module-level
// singletons), same convention the nine pure-logic modules from #193's first
// pass established. Registered in dependency/risk order — lowest-risk
// (read-only library) first, highest-risk (SSE-streaming session generation)
// last — matching the order laid out in the seam-map comment on #193.

registerLibraryRoutes(app, {
  loadLibraryIndex,
  loadArchiveImageIndex,
  parseLibraryFrontmatter: library.parseLibraryFrontmatter,
  libraryDir: LIBRARY_DIR,
});

registerGraphRoutes(app, {
  graph,
  roster: ROSTER,
  graphFile: GRAPH_FILE,
  libraryFile: LIBRARY_FILE,
  sessionsDir: SESSIONS_DIR,
});

registerUploadRoutes(app);

registerMemberRoutes(app, {
  roster: ROSTER,
  rosterModule: roster,
  loadMemberFile,
  membersDir: MEMBERS_DIR,
  rosterFile: ROSTER_FILE,
  client,
  model: MODEL,
  lodgeContext,
  axesDoc,
});

registerExportRoutes(app, {
  dayOne,
  isLocal: IS_LOCAL,
  buildSpeakerHeaderSet,
  normalizeSpeaker,
  roster: ROSTER,
});

registerSessionRoutes(app, {
  sessionsDir: SESSIONS_DIR,
  loadSession,
  saveSession,
  roster: ROSTER,
  makeBranchId,
  buildTranscriptHeader,
  composeSegmentText,
  renderReadingRoomPage,
  loadLibraryCitationLookup,
  loadArchiveImageIndex,
  groundAgainstLibraryText,
  escalateCitationsToWeb,
  loadManifestSessions: citationManifest.loadSessions,
  buildCitationManifest: sessions => citationManifest.buildManifest(sessions, ROSTER),
  buildBibliography: sessions => bibliography.buildBibliography(sessions, ROSTER, loadBibliographyLibraryEntries()),
});

registerVoiceRoutes(app, {
  roster: ROSTER,
  voiceCacheDir: VOICE_CACHE_DIR,
  apiKey: ELEVENLABS_API_KEY,
  modelId: ELEVENLABS_MODEL_ID,
});

registerConveneRoutes(app, {
  client,
  model: MODEL,
  lodgeContext,
  roster: ROSTER,
  loadMemberFile,
  loadVoiceExemplar,
  loadResidue,
  loadRelationshipEdges,
  loadLibraryCitationLookup,
  castingRoster,
  buildPassagePrompt,
  wordsSpentSoFar,
  turnsSoFar: lodgePrompts.turnsSoFar,
  defaultPoolSize: lodgePrompts.DEFAULT_POOL_SIZE,
  deriveMeetingNote: lodgePrompts.deriveMeetingNote,
  playerDirectorPool,
  resolvePlayerName,
  buildPrecedingTurn,
  resolvePlayerSpeakerId: lodgePrompts.resolvePlayerSpeakerId,
  interjectSpeakerCount: lodgePrompts.INTERJECT_SPEAKER_COUNT,
  makeSessionId,
  saveSession,
  loadSession,
  saveResidueUpdates,
  composeSegmentText,
  buildTranscriptHeader,
  isLocal: IS_LOCAL,
  runRound,
  proposeCast,
});

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
  server.on('error', err => {
    if (IS_LOCAL && err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`Port ${port} is already in use, trying ${port + 1}...`);
      startServer(port + 1, attemptsLeft - 1);
    } else {
      throw err;
    }
  });
}

startServer(PORT, MAX_PORT_ATTEMPTS);
