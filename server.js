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
const crypto = require('crypto');

const session = require('express-session');
const FileStore = require('session-file-store')(session);

const dayOne = require('./dayone');
const multer = require('multer');
const PDFParser = require('pdf2json');
const { buildMemberSection, runRound, stripInternalBlankLines, proposeCast } = require('./pipeline');

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
const PROMPTS_DIR = path.join(__dirname, 'prompts');
const MEMBERS_DIR = path.join(PROMPTS_DIR, 'members');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: false }));

// ─── Auth (passphrase, deployed only) ────────────────────────────────────────

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

// Auth guard — applied to all routes except login/logout
// Must run before express.static: static previously short-circuited the gate,
// serving index.html to anyone while only the API calls it makes 401'd.
function requireAuth(req, res, next) {
  if (!PASSPHRASE) return next(); // no passphrase set = open
  if (req.path === '/api/config') return next(); // health check — always public
  // #38: the reading room is the one intentionally public surface — gated by
  // session.published inside the route handler itself, not by passphrase.
  // Authoring/publishing stays behind the passphrase; only the rendered
  // output is reachable here. Portraits must also bypass: the reading room
  // page embeds them directly, and on a deployed (PASSPHRASE-set) instance
  // an unauthenticated visitor's <img> requests would otherwise 401. Static
  // character art, not sensitive on its own — safe to open regardless of
  // whether any session happens to be published.
  if (req.path.startsWith('/reading-room/')) return next();
  if (req.path.startsWith('/portraits/')) return next();
  if (req.session.authed) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

app.use(requireAuth);

// #84 — member page + knowledge-graph visualization, a clean URL for the
// meta-level research view (not tucked in a drawer, per the issue).
app.get('/lodge', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'lodge.html'));
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/babylonjs', express.static(path.join(__dirname, 'node_modules/babylonjs')));

// ─── Lodge roster ────────────────────────────────────────────────────────────
// Loaded from roster.json; reloadRoster() refreshes in-memory copy after writes.

const ROSTER_FILE = path.join(MEMBERS_DIR, 'roster.json');
let ROSTER = [];

// One-line sketch per member, for #185's casting call — the model needs to
// know who these people *are* to say which of them a document would draw, and
// roster.json carries only names and glyphs. Shorter than the dossier's
// version on purpose: this one is paid for 30-odd times in a single prompt.
// Cached because it re-reads and re-parses every character file; cleared by
// reloadRoster(), which is the only point at which those files can change.
// Declared here rather than beside memberBrief() below so reloadRoster()'s
// call at module load doesn't hit the temporal dead zone.
const briefCache = new Map();

// Small pool of neutral symbols for members without a hand-picked glyph (the
// original 12 carry meaningful ones set by hand in roster.json). Cycles once
// exhausted — see #80.
const FALLBACK_GLYPHS = [
  '☉', '♀', '♂', '♄', '♅', '♆', '♇', '☄',
  '★', '☆', '✪', '✴', '✷', '✹', '✵', '❋',
  '◆', '◇', '▲', '▽', '⬟', '⬢', '⌖', '✻',
];

// Deterministic-ish: picks the first pool symbol not already in use by the
// roster, so glyphs stay distinct as long as the pool has room; cycles by
// roster size once it doesn't.
function assignGlyph(roster) {
  const used = new Set(roster.map(m => m.glyph).filter(Boolean));
  const free = FALLBACK_GLYPHS.find(g => !used.has(g));
  return free || FALLBACK_GLYPHS[roster.length % FALLBACK_GLYPHS.length];
}

function reloadRoster() {
  const all = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));
  // Filter out any entry whose character file no longer exists on disk
  ROSTER = all.filter(m => !m.file || fs.existsSync(path.join(MEMBERS_DIR, m.file)));
  // Backfill glyphs for any member who doesn't have one yet (e.g. members
  // added to roster.json before glyphs existed, or by hand without one)
  let backfilled = false;
  for (const m of ROSTER) {
    if (!m.glyph) {
      m.glyph = assignGlyph(ROSTER);
      backfilled = true;
    }
  }
  briefCache.clear();
  // Rewrite roster.json if entries were removed or glyphs were backfilled
  if (ROSTER.length < all.length || backfilled) {
    fs.writeFileSync(ROSTER_FILE, JSON.stringify(ROSTER, null, 2) + '\n', 'utf8');
  }
}
reloadRoster();

const lodgeContext = fs.readFileSync(path.join(PROMPTS_DIR, 'lodge-context.md'), 'utf8');
const axesDoc = fs.readFileSync(path.join(__dirname, 'AXES.md'), 'utf8');

function loadMemberFile(filename) {
  if (!filename) return '';
  const p = path.join(MEMBERS_DIR, filename);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function memberBrief(member) {
  if (briefCache.has(member.id)) return briefCache.get(member.id);
  const text = loadMemberFile(member.file);
  const brief = text ? extractSection(text, 'WHO YOU ARE', 200) : null;
  briefCache.set(member.id, brief);
  return brief;
}

function castingRoster() {
  return ROSTER.map(m => ({ id: m.id, name: m.name, brief: memberBrief(m) }));
}

// ─── Session persistence ──────────────────────────────────────────────────────

function makeSessionId(entry) {
  const date = new Date().toISOString().slice(0, 10);
  const slug = entry.trim().slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const hash = crypto.createHash('md5').update(entry).digest('hex').slice(0, 6);
  return `${date}-${slug}-${hash}`;
}

// Branch IDs can't reuse makeSessionId's hash-of-entry-text — the entry is
// identical to the parent's, so same-day branches would collide. Mix in the
// parent id, branch point, and wall-clock time for uniqueness.
function makeBranchId(parent, roundIndex) {
  const date = new Date().toISOString().slice(0, 10);
  const slug = parent.entry.trim().slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const hash = crypto.createHash('md5').update(`${parent.id}:${roundIndex}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 6);
  return `${date}-${slug}-branch-${hash}`;
}

function saveSession(session) {
  fs.writeFileSync(path.join(SESSIONS_DIR, `${session.id}.json`), JSON.stringify(session, null, 2));
}

function loadSession(id) {
  const p = path.join(SESSIONS_DIR, `${id}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

// ─── Anthropic call helpers ───────────────────────────────────────────────────

function openSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
}

// ── Speaker header recognition (mirrors public/app.js's alias index) ──────
// Members sign with a short form (surname, first name, or nickname), not
// their full roster name — see roster.json's `aliases` field and the
// comment above buildAliasIndex in public/app.js for the full rationale.
// Kept in sync with that client-side logic; if one changes, change both.
const ALIAS_STOPWORDS = new Set(['of', 'the', 'van', 'der', 'de', 'la', 'lady', 'sir', 'dr', 'st']);

function normalizeSpeaker(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '').toLowerCase().replace(/[\s-]+/g, ' ').trim();
}

function buildSpeakerHeaderSet(roster) {
  const owner = new Map(); // normalized key -> member id, or null if ambiguous
  const register = (key, id) => {
    const k = normalizeSpeaker(key);
    if (!k) return;
    if (owner.has(k) && owner.get(k) !== id) owner.set(k, null);
    else if (!owner.has(k)) owner.set(k, id);
  };
  roster.forEach(m => {
    register(m.name, m.id);
    m.name.split(/[\s-]+/)
      .filter(tok => tok.length > 2 && !ALIAS_STOPWORDS.has(tok.toLowerCase()))
      .forEach(tok => register(tok, m.id));
    (m.aliases || []).forEach(a => register(a, m.id));
  });
  const set = new Set();
  owner.forEach((id, k) => { if (id != null) set.add(k); });
  return set;
}

// ─── Reading room (public, read-only) — #38 ───────────────────────────────────
// A session explicitly marked published renders at /reading-room/:id with no
// login and no client JS: just the source document and the transcript, typeset.
// Whole-session only for this MVP — no per-round curation, no portraits, no
// annotations (matches the issue's "no generation controls, no member grid").

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Mirrors public/app.js's renderTranscriptInto parsing (same speaker-header
// heuristics, via the same buildSpeakerHeaderSet/normalizeSpeaker used above)
// but emits static server-rendered HTML — this page ships with no client JS.
function renderRoundHtml(text) {
  const headers = buildSpeakerHeaderSet(ROSTER);
  const lines = (text || '').split('\n');
  let speaker = null, textLines = [];
  let html = '';

  const renderSpeechHtml = body => escapeHtml(body)
    .split('\n')
    .map(line => {
      const t = line.trim();
      const m = t.match(/^\*(.+)\*$/);
      if (m && !m[1].includes('*')) return `<p class="rr-action">${m[1]}</p>`;
      return line.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
    })
    .join('<br>');

  const flush = () => {
    if (!speaker || !textLines.length) return;
    const body = textLines.join('\n').trim();
    html += `<div class="rr-turn"><div class="rr-speaker">${escapeHtml(speaker)}</div><div class="rr-speech">${renderSpeechHtml(body)}</div></div>\n`;
    speaker = null; textLines = [];
  };

  lines.forEach(line => {
    const t = line.trim();
    if (!t) { flush(); return; }
    if (t === '---' || t === '—' || t === '--') return;
    const isAction = /^\*[^*\n]+\*$/.test(t);
    if (isAction && !speaker) {
      html += `<p class="rr-stage-action">${escapeHtml(t.slice(1, -1))}</p>\n`;
      return;
    }
    const bare = t.replace(/:$/, '');
    const isKnownName = headers.has(normalizeSpeaker(bare));
    const looksLikeName = !t.includes(' ') && t.length < 30 && /^[A-Z]/.test(t) && !t.includes('*');
    if (isKnownName || looksLikeName) { flush(); speaker = bare; textLines = []; }
    else if (speaker) textLines.push(t);
  });
  flush();
  return html;
}

function renderReadingRoomPage(session) {
  const members = (session.members || [])
    .map(id => ROSTER.find(m => m.id === id))
    .filter(Boolean);
  const title = (session.entry || 'A meeting').trim().slice(0, 80);
  const roundsHtml = (session.rounds || []).map(r =>
    `<section class="rr-round"><h2 class="rr-round-label">${escapeHtml(r.label)}</h2>${renderRoundHtml(r.text)}</section>`
  ).join('\n');
  // Portraits are AI-generated placeholders, disclosed in MANIFEST.md; not
  // every roster entry has one yet (see #80), so a broken image just hides
  // itself rather than showing a placeholder icon — same convention as the
  // dossier drawer's portrait (public/app.js).
  const membersHtml = members.map(m => `<span class="rr-member">
      <img class="rr-portrait" src="/portraits/${escapeHtml(m.id)}.png" alt="" loading="lazy" onerror="this.style.display='none'">
      <span class="rr-member-name">${escapeHtml(m.name)}</span>
    </span>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — The Secret-Cabin-et</title>
<meta name="description" content="A published salon transcript from The Secret-Cabin-et.">
<meta name="robots" content="noindex, follow">
<style>
  @import url('https://fonts.googleapis.com/css2?family=UnifrakturMaguntia&family=IM+Fell+English:ital@0;1&family=Crimson+Pro:ital,wght@0,300;0,400;0,600;1,300;1,400&display=swap');
  :root {
    --bg:#0e0b08; --panel:#17120d; --border:#3a2e1e; --amber:#c8922a; --amber-dim:#7a5418;
    --cream:#e8dfc8; --muted:#c0a882; --ash:#9a8a74; --footer:#5a4a3a;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg:#f2e8d0; --panel:#e8dcc0; --border:#cbb98f; --amber:#8a5f14; --amber-dim:#a07a2a;
      --cream:#2a2015; --muted:#4a3d28; --ash:#6a5a42; --footer:#a0906e;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--cream); font-family: 'Crimson Pro', Georgia, serif; font-size: 18px; line-height: 1.75; }
  .rr-wrap { max-width: 680px; margin: 0 auto; padding: 64px 24px 96px; }
  .rr-masthead { text-align: center; margin-bottom: 8px; }
  .rr-masthead-name { font-family: 'UnifrakturMaguntia', serif; font-size: 26px; color: var(--amber); letter-spacing: 2px; }
  .rr-masthead-tag { font-family: 'IM Fell English', serif; font-style: italic; font-size: 12px; color: var(--ash); letter-spacing: 3px; text-transform: uppercase; margin-top: 6px; }
  .rr-meta { text-align: center; font-family: 'IM Fell English', serif; font-size: 13px; color: var(--ash); margin: 28px 0 4px; }
  .rr-members { display: flex; flex-wrap: wrap; justify-content: center; gap: 18px 22px; margin-bottom: 40px; }
  .rr-member { display: flex; flex-direction: column; align-items: center; gap: 6px; width: 68px; }
  .rr-portrait { width: 56px; height: 56px; border-radius: 50%; object-fit: cover; border: 1px solid var(--amber-dim); }
  .rr-member-name { font-family: 'IM Fell English', serif; font-style: italic; font-size: 12px; color: var(--muted); text-align: center; line-height: 1.3; }
  .rr-source { border-left: 3px solid var(--amber-dim); background: var(--panel); padding: 18px 22px; margin-bottom: 48px; font-style: italic; color: var(--muted); white-space: pre-wrap; }
  .rr-round { margin-bottom: 48px; }
  .rr-round-label { font-family: 'IM Fell English', serif; font-size: 13px; letter-spacing: 3px; text-transform: uppercase; color: var(--ash); text-align: center; margin-bottom: 28px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
  .rr-turn { margin-bottom: 28px; }
  .rr-speaker { font-family: 'IM Fell English', serif; font-size: 14px; letter-spacing: 1px; color: var(--amber); margin-bottom: 4px; }
  .rr-speech { color: var(--cream); }
  .rr-speech .rr-action { font-style: italic; color: var(--ash); margin: 4px 0; }
  .rr-stage-action { font-style: italic; color: var(--ash); text-align: center; margin: 20px 0; }
  .rr-footer { text-align: center; margin-top: 72px; font-family: 'IM Fell English', serif; font-size: 11px; letter-spacing: 1px; color: var(--footer); line-height: 1.8; }
</style>
</head>
<body>
  <div class="rr-wrap">
    <header class="rr-masthead">
      <div class="rr-masthead-name">The Secret-Cabin-et</div>
      <div class="rr-masthead-tag">Reading Room</div>
    </header>
    <div class="rr-meta">${escapeHtml(session.date || '')}</div>
    <div class="rr-members">${membersHtml}</div>
    <div class="rr-source">${escapeHtml(session.entry || '')}</div>
    ${roundsHtml}
    <footer class="rr-footer">Published from a private session of The Secret-Cabin-et.<br>An imaginative exercise, not a historical record.</footer>
  </div>
</body>
</html>`;
}

// Post-process raw Claude transcript text: append ' —' after speaker name lines
// so plain-text exports clearly distinguish speakers from speech.
function formatTranscriptText(text) {
  const headers = buildSpeakerHeaderSet(ROSTER);
  return text.split('\n').map(line => {
    const t = line.trim();
    const bare = t.endsWith(':') ? t.slice(0, -1) : t;
    return headers.has(normalizeSpeaker(bare)) ? `${bare} —` : line;
  }).join('\n');
}

// ─── Round prompts ────────────────────────────────────────────────────────────

const DEFAULT_ROUND_INSTRUCTIONS = [
  'The room stirs. Write the first movement — initial reactions to whatever the material woke up. Not every member must engage with the document directly; some may respond to the room\'s reaction to it before responding to it themselves. 3-5 members speak. There is no author to address.',
  'The document recedes. The conversation follows what it raised. Members are now talking to each other about the actual question that has surfaced — disagreements crystallize, alliances form, citations come out, someone is irritated, someone is more interested than they wanted to be. References to the document are welcome but not required; the room is no longer obliged to it. 3-5 members speak. Receipts may be deployed. Actions in asterisks.',
  'The conversation has gone where it has gone. It may have left the document entirely. Final movement: the room arrives somewhere, or it doesn\'t. Someone may say the thing that persists as an ember. Someone may push back hard at a point that has been allowed to stand too long. Someone may simply observe the fire. 2-4 members. Let it end as it ends.',
];
const EXTRA_ROUND_INSTRUCTION = 'A thread unresolved, a silence wanting breaking, a late arrival to the argument, a member who passed earlier returning with something they have just thought of. 2-4 members speak.';

// The exact speaker count for a round is now a hard number handed to the
// director, not a range for it to interpret — these mirror the upper end of
// the prose guidance above (the prose itself is left as-is; it's now soft
// framing for the director's judgment about *who*, not an enforced count).
// #73 exposed round *count* to the user (session.roundCount, below); per-round
// speaker count remains this fixed default — still no user-facing control,
// deferred as a separate follow-up.
const SPEAKER_COUNTS = [5, 5, 4]; // rounds 1-3
const EXTRA_ROUND_SPEAKER_COUNT = 4;
const INTERJECT_SPEAKER_COUNT = 3; // today's prose only ever suggested "2-3", never enforced — a new explicit assumption

function speakerCountForRound(index) {
  return SPEAKER_COUNTS[index] || EXTRA_ROUND_SPEAKER_COUNT;
}

function buildRoundPrompt(index, entry, instructions, artifact = null, isTranscriptSource = false) {
  const instr = instructions?.[index] || DEFAULT_ROUND_INSTRUCTIONS[index] || EXTRA_ROUND_INSTRUCTION;
  if (index === 0) {
    const artifactMember = artifact?.memberId ? ROSTER.find(m => m.id === artifact.memberId) : null;
    const artifactHint = artifactMember
      ? `\n\n${artifactMember.name} has private context from before the meeting. They should speak in this round.`
      : '';
    const preamble = isTranscriptSource
      ? `A record has been passed around the table — minutes of a previous gathering, authorship uncertain, date unclear. The room considers it.\n\n"${entry}"`
      : `The document has just been read aloud:\n\n"${entry}"`;
    return `${preamble}\n\n${instr}${artifactHint}`;
  }
  return instr;
}

// ─── Player-as-member ─────────────────────────────────────────────────────────
// A human can write turns as one voice in the room instead of only observing.
// Mode 'member': the human stands in for an existing roster seat — that
// member is excluded from the AI director's selectable pool everywhere for
// the session (convene/round/interject), so the AI never also generates
// lines for the seat the human is voicing. Mode 'custom': a free-text
// identity, added as an *extra* voice — nothing is excluded, since it isn't
// standing in for a roster seat.

function playerDirectorPool(memberIds, playerMode, playerMemberId) {
  return (playerMode === 'member' && playerMemberId)
    ? memberIds.filter(id => id !== playerMemberId)
    : memberIds;
}

function resolvePlayerName(playerMode, playerMemberId, playerName) {
  if (playerMode === 'member') return ROSTER.find(m => m.id === playerMemberId)?.name || null;
  if (playerMode === 'custom') return playerName?.trim() || null;
  return null;
}

// Builds the { speakerName, text } object runRound expects, or null if no
// turn was submitted this round (the player passed, or isn't active).
function buildPrecedingTurn(speakerName, playerTurn) {
  const text = playerTurn?.text?.trim();
  if (!speakerName || !text) return null;
  return { speakerName, text: stripInternalBlankLines(text) };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /api/convene — start a session and stream round 1
app.post('/api/convene', async (req, res) => {
  const { entry, members } = req.body;
  if (!entry?.trim()) return res.status(400).json({ error: 'entry is required' });
  if (!members?.length) return res.status(400).json({ error: 'at least one member is required' });

  const { roundInstructions, roundCount, artifact, notes, sourceSessionId,
    playerMode, playerMemberId, playerName, playerTurn } = req.body;
  const isTranscriptSource = !!sourceSessionId;
  const id = makeSessionId(entry);
  const date = new Date().toISOString().slice(0, 10);
  const roundPrompt = buildRoundPrompt(0, entry, roundInstructions, artifact || null, isTranscriptSource);
  const generationMetrics = [];

  const effectivePlayerMode = playerMode || 'none';
  const effectivePlayerMemberId = effectivePlayerMode === 'member' ? (playerMemberId || null) : null;
  const effectivePlayerName = resolvePlayerName(effectivePlayerMode, effectivePlayerMemberId, playerName);
  const precedingTurn = buildPrecedingTurn(effectivePlayerName, playerTurn);

  openSSE(res);
  try {
    const { fullRoundText: text, disposition } = await runRound({
      client, model: MODEL, lodgeContext, ROSTER, loadMemberFile, loadVoiceExemplar,
      presentMemberIds: playerDirectorPool(members, effectivePlayerMode, effectivePlayerMemberId),
      artifact: artifact || null, notes: notes || {},
      roundPrompt, conversationHistory: [],
      speakerCount: speakerCountForRound(0), round: 0, precedingTurn,
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
      { role: 'user', content: roundPrompt },
      { role: 'assistant', content: text },
    ];
    const session = {
      id, date, entry, members,
      roundInstructions: roundInstructions || null,
      roundCount: roundCount || 3,
      artifact: artifact || null,
      notes: notes || {},
      sourceSessionId: sourceSessionId || null,
      conversationHistory: history,
      rounds: [{ label: 'First Movement', text, historyLength: history.length }],
      transcriptText: buildTranscriptHeader(entry, members, date) + `\n— First Movement —\n\n${formatTranscriptText(text)}\n`,
      generationMetrics,
      playerMode: effectivePlayerMode,
      playerMemberId: effectivePlayerMemberId,
      playerName: effectivePlayerMode === 'custom' ? effectivePlayerName : null,
      playerTurns: precedingTurn ? [{ round: 0, speakerName: precedingTurn.speakerName, text: precedingTurn.text }] : [],
      disposition: disposition || {},
    };
    saveSession(session);
    res.write(`data: ${JSON.stringify({ done: true, sessionId: id, round: 1, label: 'First Movement', text })}\n\n`);
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

  try {
    const result = await proposeCast({
      client, model: MODEL, lodgeContext,
      roster: castingRoster(),
      regularIds: Array.isArray(regulars) ? regulars : [],
      documentText: entry,
      onMetric: m => {
        if (m.skipped) console.warn('[degraded]', m.phase, '—', m.error);
      },
    });
    res.json(result);
  } catch (err) {
    console.error('Casting error:', err);
    res.status(500).json({ error: err.message || 'Could not read the room' });
  }
});

// POST /api/round — stream the next round into an existing session
app.post('/api/round', async (req, res) => {
  const { sessionId, playerTurn } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const session = loadSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const roundIndex = session.rounds.length;
  const roundPrompt = buildRoundPrompt(roundIndex, session.entry, session.roundInstructions);

  const labels = ['First Movement', 'The Room Responds', 'Final Embers', 'One More Turn'];
  const label = labels[Math.min(roundIndex, labels.length - 1)];

  session.generationMetrics = session.generationMetrics || [];

  const effectivePlayerName = resolvePlayerName(session.playerMode, session.playerMemberId, session.playerName);
  const precedingTurn = buildPrecedingTurn(effectivePlayerName, playerTurn);

  openSSE(res);
  try {
    const { fullRoundText: text, disposition } = await runRound({
      client, model: MODEL, lodgeContext, ROSTER, loadMemberFile, loadVoiceExemplar,
      presentMemberIds: playerDirectorPool(session.members, session.playerMode, session.playerMemberId),
      artifact: null, notes: {},
      roundPrompt, conversationHistory: session.conversationHistory.slice(-6),
      speakerCount: speakerCountForRound(roundIndex), round: roundIndex, precedingTurn,
      disposition: session.disposition || {},
      onChunk: chunk => res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`),
      onSpeakerStart: memberId => res.write(`data: ${JSON.stringify({ speaking: memberId })}\n\n`),
      onSpeakerEnd: (memberId, name, text) => res.write(`data: ${JSON.stringify({ speakerDone: { memberId, name, text } })}\n\n`),
      onMetric: m => {
        session.generationMetrics.push(m);
        if (m.skipped) console.warn('[degraded]', m.phase, m.memberId || '', '—', m.error);
      },
    });

    session.conversationHistory.push({ role: 'user', content: roundPrompt });
    session.conversationHistory.push({ role: 'assistant', content: text });
    session.rounds.push({ label, text, historyLength: session.conversationHistory.length });
    session.transcriptText += `\n— ${label} —\n\n${formatTranscriptText(text)}\n`;
    session.disposition = disposition || {};
    if (precedingTurn) {
      session.playerTurns = session.playerTurns || [];
      session.playerTurns.push({ round: roundIndex, speakerName: precedingTurn.speakerName, text: precedingTurn.text });
    }

    saveSession(session);
    res.write(`data: ${JSON.stringify({ done: true, round: roundIndex + 1, label, text })}\n\n`);
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
    const { fullRoundText: response, disposition } = await runRound({
      client, model: MODEL, lodgeContext, ROSTER, loadMemberFile, loadVoiceExemplar,
      presentMemberIds: playerDirectorPool(session.members, session.playerMode, session.playerMemberId),
      artifact: null, notes: {},
      roundPrompt: prompt, conversationHistory: session.conversationHistory.slice(-6),
      speakerCount: Math.min(INTERJECT_SPEAKER_COUNT, session.members.length), round: session.rounds.length,
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

  const roundPrompt = buildRoundPrompt(0, entry, null, null, false);
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

// #153 part 1 — for citations the extraction pass matched to a library entry,
// re-judge the verdict against that entry's actual excerpt text instead of
// trusting a title/source-only match against the model's memory. Memory can
// be wrong even when the title matches (see #157: fabricated source_urls
// slipped past exactly this kind of surface-level check). One batched call
// covering every matched citation in the round, not one call each; skipped
// entirely (no extra call) if nothing matched.
async function groundAgainstLibraryText(citations, libraryLookup) {
  const matched = citations
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => c.libraryMatch && libraryLookup[c.libraryMatch]?.text);
  if (!matched.length) return new Map();

  const system = `You are checking whether citations from a transcript are actually supported by the real source text they were matched to. This is a stricter check than general knowledge — treat each "Excerpt" below as ground truth, not your training data.

For each numbered item, judge whether its "Transcript quote" is genuinely consistent with its "Excerpt":
- "verified": the excerpt clearly supports the quote/claim as attributed
- "unverified": the excerpt contradicts it, or doesn't contain/support what's being attributed to it
- "uncertain": the excerpt doesn't clearly settle it either way (e.g. adjacent material, but not this specific claim)`;

  const itemsText = matched.map(({ c, index }) => {
    const entry = libraryLookup[c.libraryMatch];
    return `### Item ${index}\nWork cited: ${c.work}\nTranscript quote: "${c.quote}"\n\nExcerpt from "${entry.title}" (${entry.source}):\n${entry.text}`;
  }).join('\n\n---\n\n');

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system,
    messages: [{ role: 'user', content: itemsText }],
    tools: [{
      name: 'report_grounded_verdicts',
      description: 'Report a text-grounded verdict for each numbered item.',
      input_schema: {
        type: 'object',
        properties: {
          verdicts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer', description: 'The item number from the prompt.' },
                verdict: { type: 'string', enum: ['verified', 'unverified', 'uncertain'] },
                note: { type: 'string', description: 'One-sentence reasoning, referencing the excerpt directly.' },
              },
              required: ['index', 'verdict', 'note'],
            },
          },
        },
        required: ['verdicts'],
      },
    }],
    tool_choice: { type: 'tool', name: 'report_grounded_verdicts' },
  });

  const block = response.content.find(b => b.type === 'tool_use');
  const verdicts = block?.input?.verdicts || [];
  return new Map(verdicts.map(v => [v.index, v]));
}

// #153 part 2 — for citations the extraction pass could NOT match to a
// library entry, attempt a real lookup against open-data sources before
// falling back to the model's own unconfirmed judgment. Hand-rolled fetches
// (decided 2026-08-05) rather than Anthropic's hosted web-search tool — that
// route is #111's proposal, kept open as a fallback tier, not this one.
// Tiered by closeness to primary text: archive.org full-text "search inside"
// scanned books, then Wikisource's proofread transcriptions, then Wikipedia
// (existence only, not quote-level), then Wikidata (biographical/factual
// claims). Bounded to MAX_WEB_ESCALATIONS lookups per run — these are free
// public APIs shared with everyone else using them, not something to hammer
// on a long transcript. Session-scoped only for now (v1 decision): results
// aren't written back into prompts/library/ — that stays a human-curated
// promotion step via scripts/build-citation-manifest.js, gated by
// verify-library-sources.js (#157).
const MAX_WEB_ESCALATIONS = 6;
const WEB_FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const normalizeForWebMatch = s => (s || '').replace(/[*"'“”‘’]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

const STOPWORDS = new Set(['the', 'and', 'of', 'a', 'an', 'to', 'in', 'on', 'by', 'or', 'from', 'with', 'his', 'her']);
const tokenizeForWebMatch = s => normalizeForWebMatch(s).split(/[^a-z0-9]+/).filter(Boolean);
// A famous phrase can turn up verbatim inside a completely unrelated book
// that merely quotes it (found in testing: a Dickens opening line matched a
// stand-up comedy memoir that happened to quote it). Requiring at least one
// significant word from the cited work to appear in the matched doc's title
// or creator keeps a real phrase-hit from being credited to the wrong book.
// Word-set comparison, not substring — a naive .includes() lets "tale"
// false-match inside "tales" (also caught in testing).
function worksOverlap(work, doc) {
  const haystackWords = new Set(tokenizeForWebMatch(`${doc.title || ''} ${doc.creator || ''}`));
  const words = tokenizeForWebMatch(work).filter(w => w.length > 3 && !STOPWORDS.has(w));
  return words.some(w => haystackWords.has(w));
}

// Tier 1: archive.org full-text search across scanned books — the closest
// available thing to genuine quote-grounding for public-domain works. Same
// fetch pattern as scripts/verify-library-sources.js's archive.org check.
async function tryArchiveOrgFullText(work, quote) {
  if (!quote) return { status: 'not-found' };
  const q = `"${quote.replace(/"/g, '')}" AND mediatype:texts`;
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=creator&output=json&rows=5`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return { status: 'error', reason: `HTTP ${res.status}` };
    const data = await res.json();
    const docs = data?.response?.docs || [];
    const doc = docs.find(d => worksOverlap(work, d));
    if (!doc) return { status: 'not-found' };
    return {
      status: 'confirmed',
      webSourceUrl: `https://archive.org/details/${doc.identifier}`,
      webSourceTitle: doc.title || doc.identifier,
      note: `Confirmed: this phrase was found via archive.org full-text search inside "${doc.title || doc.identifier}".`,
    };
  } catch (err) {
    return { status: 'error', reason: err.message };
  }
}

// Tier 2: Wikisource — human-transcribed, proofread primary texts (already
// used for the Julian of Norwich entry via #155). Only counts as a hit if
// the quote actually appears in the page's extract, not just a title match.
async function tryWikisource(work, quote) {
  const searchUrl = `https://en.wikisource.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(work)}&srlimit=1&format=json&origin=*`;
  try {
    const searchRes = await fetchWithTimeout(searchUrl);
    if (!searchRes.ok) return { status: 'error', reason: `HTTP ${searchRes.status}` };
    const searchData = await searchRes.json();
    const title = searchData?.query?.search?.[0]?.title;
    if (!title) return { status: 'not-found' };

    const extractUrl = `https://en.wikisource.org/w/api.php?action=query&prop=extracts&explaintext=1&titles=${encodeURIComponent(title)}&format=json&origin=*`;
    const extractRes = await fetchWithTimeout(extractUrl);
    if (!extractRes.ok) return { status: 'error', reason: `HTTP ${extractRes.status}` };
    const extractData = await extractRes.json();
    const extract = Object.values(extractData?.query?.pages || {})[0]?.extract || '';
    const snippet = normalizeForWebMatch(quote).split(' ').slice(0, 8).join(' ');
    if (!snippet || !normalizeForWebMatch(extract).includes(snippet)) return { status: 'not-found' };
    return {
      status: 'confirmed',
      webSourceUrl: `https://en.wikisource.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      webSourceTitle: title,
      note: `Confirmed against Wikisource's transcription of "${title}".`,
    };
  } catch (err) {
    return { status: 'error', reason: err.message };
  }
}

// Tier 3: Wikipedia summary — confirms the work/author exists and roughly
// what it's about, not that this specific quote is accurate. A hit here
// stays "uncertain (unconfirmed)", never "verified".
async function tryWikipediaSummary(work) {
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(work)}&limit=1&format=json&origin=*`;
  try {
    const searchRes = await fetchWithTimeout(searchUrl);
    if (!searchRes.ok) return { status: 'error', reason: `HTTP ${searchRes.status}` };
    const [, titles] = await searchRes.json();
    const title = titles?.[0];
    if (!title) return { status: 'not-found' };

    const summaryRes = await fetchWithTimeout(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);
    if (summaryRes.status === 404) return { status: 'not-found' };
    if (!summaryRes.ok) return { status: 'error', reason: `HTTP ${summaryRes.status}` };
    const data = await summaryRes.json();
    if (data.type === 'disambiguation') return { status: 'not-found' };
    return {
      status: 'existence-only',
      webSourceUrl: data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      webSourceTitle: data.title || title,
      note: `"${work}" exists per Wikipedia, but this specific quote/claim wasn't independently confirmed — uncertain (unconfirmed).`,
    };
  } catch (err) {
    return { status: 'error', reason: err.message };
  }
}

// Tier 4: Wikidata — narrow use for factual/biographical claims (dates,
// authorship) rather than quoted text. Same existence-only ceiling as tier 3.
async function tryWikidata(work) {
  const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(work)}&language=en&format=json&origin=*`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return { status: 'error', reason: `HTTP ${res.status}` };
    const data = await res.json();
    const hit = data?.search?.[0];
    if (!hit) return { status: 'not-found' };
    return {
      status: 'existence-only',
      webSourceUrl: `https://www.wikidata.org/wiki/${hit.id}`,
      webSourceTitle: hit.label || work,
      note: `"${work}" exists as a Wikidata entity${hit.description ? ` (${hit.description})` : ''}, but this specific quote/claim wasn't independently confirmed — uncertain (unconfirmed).`,
    };
  } catch (err) {
    return { status: 'error', reason: err.message };
  }
}

// Runs the tiers in order for one citation. A "confirmed" or "existence-only"
// hit becomes real web-grounded evidence, overriding the model's own guess.
// A clean miss across every tier (no matches, no errors) means the work
// genuinely isn't found in these open sources — falls back to the model's
// original memory-based verdict, unchanged, rather than punishing citations
// of real but un-archived modern scholarship. Only an actual technical
// failure (network error, timeout, rate-limit) on every tier degrades the
// verdict to "uncertain (unconfirmed)" — we attempted a check and couldn't
// complete it, so trusting bare memory alone would be worse than saying so.
async function escalateCitationToWeb(citation) {
  const tiers = [
    () => tryArchiveOrgFullText(citation.work, citation.quote),
    () => tryWikisource(citation.work, citation.quote),
    () => tryWikipediaSummary(citation.work),
    () => tryWikidata(citation.work),
  ];
  let sawError = false;
  for (const tier of tiers) {
    const result = await tier();
    if (result.status === 'confirmed') {
      return { verdict: 'verified', note: result.note, source: 'web', webSourceUrl: result.webSourceUrl, webSourceTitle: result.webSourceTitle };
    }
    if (result.status === 'existence-only') {
      return { verdict: 'uncertain', note: result.note, source: 'web', webSourceUrl: result.webSourceUrl, webSourceTitle: result.webSourceTitle };
    }
    if (result.status === 'error') sawError = true;
  }
  if (sawError) {
    return {
      verdict: 'uncertain',
      note: `${citation.note} — uncertain (unconfirmed): web verification was attempted but unavailable.`,
      source: 'model-knowledge',
    };
  }
  return null;
}

async function escalateCitationsToWeb(citations) {
  const unmatched = citations
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => !c.libraryMatch)
    .slice(0, MAX_WEB_ESCALATIONS);

  const results = new Map();
  for (const { c, index } of unmatched) {
    try {
      const outcome = await escalateCitationToWeb(c);
      if (outcome) results.set(index, outcome);
    } catch (err) {
      console.error('Web escalation error for citation', index, err);
    }
  }
  return results;
}

// POST /api/sessions/:id/verify-citations — extract & judge citations across the whole session
app.post('/api/sessions/:id/verify-citations', async (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

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

    const archiveImages = loadArchiveImageIndex();
    const block = response.content.find(b => b.type === 'tool_use');
    const rawCitations = block?.input?.citations || [];
    // #153 part 1 — re-check library-matched citations against the entry's
    // actual text, rather than trusting the extraction pass's title/source
    // match. Skipped (no extra call) when nothing matched this round.
    const grounded = await groundAgainstLibraryText(rawCitations, libraryLookup);
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

// Extract the first substantive paragraph after a character file's section
// header. Shared by the dossier route (long form, for reading) and casting's
// member briefs (short form, for the model's judgment).
function extractSection(text, sectionName, limit = 320) {
  const re = new RegExp(`## ${sectionName}[\\s\\S]*?\\n\\n([^#\\n][\\s\\S]*?)(?:\\n\\n---|\n\n##|$)`);
  const m = text.match(re);
  if (!m) return null;
  const para = m[1].split(/\n\n/)[0].trim()
    .replace(/\*([^*]+)\*/g, '$1') // strip asterisk emphasis
    .replace(/\n/g, ' ')
    .slice(0, limit);
  return para || null;
}

// GET /api/members/:id/dossier — parse and return brief + voice from character file
app.get('/api/members/:id/dossier', (req, res) => {
  const member = ROSTER.find(m => m.id === req.params.id);
  if (!member) return res.status(404).json({ error: 'Member not found' });
  const text = loadMemberFile(member.file);
  if (!text) return res.json({ id: member.id, name: member.name, bio: null, voice: null });

  res.json({
    id: member.id,
    name: member.name,
    bio: extractSection(text, 'WHO YOU ARE'),
    voice: extractSection(text, 'HOW YOU SPEAK'),
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

    const newMember = { id, name: name.trim(), file, glyph: assignGlyph(ROSTER) };
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

const GRAPH_FILE = path.join(PROMPTS_DIR, 'graph', 'graph.json');

/**
 * Build the full graph at query time from three sources:
 *   1. Historical seed edges (graph.json)
 *   2. Library-derived edges (member↔text, text↔theme) from library.json
 *   3. Session-derived edges (co-convened members, discussed text, theme tags) from sessions/
 *
 * Returns { nodes: [...], edges: [...] }
 */
function buildGraph() {
  const edges = [];
  const nodeMap = new Map(); // id → node

  function ensureNode(id, type, label) {
    if (!nodeMap.has(id)) nodeMap.set(id, { id, type, label });
  }

  // ── 1. Roster nodes ────────────────────────────────────────────────────────
  ROSTER.forEach(m => ensureNode(m.id, 'member', m.name));

  // ── 2. Historical seed edges ───────────────────────────────────────────────
  if (fs.existsSync(GRAPH_FILE)) {
    const seed = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8'));
    (seed.edges || []).forEach(e => {
      ensureNode(e.source, 'member', e.source);
      ensureNode(e.target, 'member', e.target);
      edges.push({ ...e, weight: 1 });
    });
  }

  // ── 3. Library-derived edges ───────────────────────────────────────────────
  const LIBRARY_FILE_PATH = path.join(PROMPTS_DIR, 'library', 'library.json');
  if (fs.existsSync(LIBRARY_FILE_PATH)) {
    const library = JSON.parse(fs.readFileSync(LIBRARY_FILE_PATH, 'utf8'));
    library.forEach(entry => {
      ensureNode(entry.id, 'text', entry.title);
      // member → text
      (entry.members || []).forEach(memberId => {
        ensureNode(memberId, 'member', memberId);
        edges.push({ source: memberId, target: entry.id, type: 'appears-in', origin: 'library', weight: 1 });
      });
      // text → theme
      (entry.themes || []).forEach(theme => {
        ensureNode(theme, 'theme', theme);
        edges.push({ source: entry.id, target: theme, type: 'touches', origin: 'library', weight: 1 });
      });
      // member → theme (direct, for easier querying)
      (entry.members || []).forEach(memberId => {
        (entry.themes || []).forEach(theme => {
          edges.push({ source: memberId, target: theme, type: 'associated-with', origin: 'library', weight: 1 });
        });
      });
    });
  }

  // ── 4. Session-derived edges ───────────────────────────────────────────────
  const sessionEdges = new Map(); // key → edge with accumulated weight

  function accumulateEdge(source, target, type, origin, sessionId) {
    const key = `${source}|${target}|${type}`;
    if (sessionEdges.has(key)) {
      sessionEdges.get(key).weight++;
      if (sessionId) sessionEdges.get(key).sessions.push(sessionId);
    } else {
      sessionEdges.set(key, { source, target, type, origin, weight: 1, sessions: sessionId ? [sessionId] : [] });
    }
  }

  if (fs.existsSync(SESSIONS_DIR)) {
    fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.json') && f !== '.gitkeep')
      .forEach(f => {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
          const members = s.members || [];
          const tags = s.tags || [];
          const sid = s.id;

          // Ensure session node
          ensureNode(sid, 'session', s.entry?.slice(0, 60) || sid);

          // session → member (co-convened)
          members.forEach(mid => {
            ensureNode(mid, 'member', mid);
            accumulateEdge(sid, mid, 'convened', 'session', null);
            // member co-occurrence with other members
            members.forEach(mid2 => {
              if (mid < mid2) accumulateEdge(mid, mid2, 'co-convened', 'session', sid);
            });
          });

          // session → tags as themes
          tags.forEach(tag => {
            ensureNode(tag, 'theme', tag);
            accumulateEdge(sid, tag, 'tagged', 'session', null);
            // member → theme via session tag
            members.forEach(mid => {
              accumulateEdge(mid, tag, 'associated-with', 'session', sid);
            });
          });
        } catch (_) {}
      });
  }

  sessionEdges.forEach(e => edges.push(e));

  return {
    nodes: Array.from(nodeMap.values()),
    edges,
    generated: new Date().toISOString(),
  };
}

// GET /api/graph — return full knowledge graph
app.get('/api/graph', (req, res) => {
  try {
    res.json(buildGraph());
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
  if (!fs.existsSync(LIBRARY_FILE)) return [];
  return JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
}

// Archival images (#30) keyed by library entry id — see public/archive/metadata.json.
// Kept separate from library.json/frontmatter since not every entry has an image yet.
function loadArchiveImageIndex() {
  if (!fs.existsSync(ARCHIVE_IMAGE_FILE)) return {};
  return JSON.parse(fs.readFileSync(ARCHIVE_IMAGE_FILE, 'utf8')).entries || {};
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

// `citation`/`source_url` live only in each entry's .md frontmatter, not in
// library.json's index — this reads them out. Shared by the internal
// citation-grounding lookup below and GET /api/library/:id (#84).
function parseLibraryFrontmatter(raw) {
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
  const citation = frontmatter.match(/^citation:\s*"?(.*?)"?$/m)?.[1] || null;
  const source_url = frontmatter.match(/^source_url:\s*"?(.*?)"?$/m)?.[1] || null;
  return { citation, source_url };
}

// #187 — the library entry a member actually *wrote*, for injection into
// their speaker prompt as a voice-register exemplar. Internal-only; not
// exposed as a route.
//
// Keyed on `author`, deliberately not on `members`. `members` is an
// association list — it includes everyone an entry concerns, so Waite's 1911
// preface lists Pamela Colman Smith and Jung's 1916 text lists Corbin.
// Matching on it would hand a member someone else's prose under the heading
// "how you actually write", which is a fabrication of voice; `author` is the
// one member whose hand the text is in. A member with no authored entry
// returns null and their prompt is built exactly as it was before #187.
//
// One entry per author today. If an author ever gains a second, the first in
// library.json order wins — deterministic, and a curator wanting a specific
// one as the exemplar should order the file accordingly.
function loadVoiceExemplar(memberId) {
  if (!memberId) return null;
  const entry = loadLibraryIndex().find(e => e.author === memberId);
  if (!entry) return null;
  const filePath = path.join(LIBRARY_DIR, entry.file);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  const text = raw.replace(/^---[\s\S]*?---\n/, '').trim();
  if (!text) return null;
  return {
    id: entry.id,
    title: entry.title,
    source: entry.source,
    date: entry.date,
    translated: !!entry.translated,
    text,
  };
}

// Internal-only: read the `citation`/`source_url` frontmatter fields (plus
// the full excerpt body, for #153 part 1's text-grounded re-check) that
// loadLibraryIndex()/library.json don't carry, for cross-referencing a
// verified citation to its grounding source. Not exposed via a public route.
function loadLibraryCitationLookup() {
  const lookup = {};
  for (const entry of loadLibraryIndex()) {
    const filePath = path.join(LIBRARY_DIR, entry.file);
    if (!fs.existsSync(filePath)) continue;
    const raw = fs.readFileSync(filePath, 'utf8');
    const { citation, source_url } = parseLibraryFrontmatter(raw);
    const text = raw.replace(/^---[\s\S]*?---\n/, '').trim();
    lookup[entry.id] = { title: entry.title, source: entry.source, citation, source_url, text };
  }
  return lookup;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildTranscriptHeader(entry, memberIds, date) {
  const names = memberIds.map(id => ROSTER.find(m => m.id === id)?.name).filter(Boolean).join(', ');
  return `THE SECRET-CABIN-ET\nMeeting Notes — ${date}\nAssembled: ${names}\n\nSource material:\n${entry}\n`;
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
