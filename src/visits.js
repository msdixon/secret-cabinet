'use strict';

// #422 — visitation/traffic metrics for the public read tier (#379/#380).
// Deliberately narrow first cut: count and surface unauthenticated traffic,
// nothing else. No rate limiting, no per-user identity, no alerting — see
// PROJECT.md's public-regime decision (2026-08-25) for why this exists: the
// invite-only pool is meant to stay small, and a name like Crowley can draw
// an unplanned crowd, so Rachel needs a way to notice that's happening
// instead of assuming the pool stayed small.
//
// Deliberately counts only `!req.authed` requests (see server.js's mounting
// site) — Rachel's own signed-in browsing shouldn't inflate a number meant
// to answer "how much outside traffic is this getting."

const fs = require('fs');

// Static assets (css/js/images/fonts, the Babylon vendor bundle) ride along
// with every page load and would dwarf the page-level counts without telling
// Rachel anything about actual visits — not counted at all.
const ASSET_EXTENSION = /\.[a-zA-Z0-9]+$/;

// Mirrors auth.js's PUBLIC_API_ROUTES table (method + pattern) but maps to a
// human label instead of a boolean, so e.g. /api/sessions/:id and
// /api/sessions/:id/transcript don't collide in the by-route breakdown. Kept
// as a separate table rather than importing auth.js's, since that one is
// optimized for "is this public" (order/overlap don't matter) while this one
// needs a specific label per route and is allowed to diverge if either ever
// does.
const API_ROUTE_LABELS = [
  ['GET', /^\/api\/config$/, 'GET /api/config'],
  ['GET', /^\/api\/sessions$/, 'GET /api/sessions'],
  ['GET', /^\/api\/sessions\/[^/]+\/transcript$/, 'GET /api/sessions/:id/transcript'],
  ['GET', /^\/api\/sessions\/[^/]+$/, 'GET /api/sessions/:id'],
  ['GET', /^\/api\/threads$/, 'GET /api/threads'],
  ['GET', /^\/api\/members$/, 'GET /api/members'],
  ['GET', /^\/api\/members\/[^/]+\/dossier$/, 'GET /api/members/:id/dossier'],
  ['GET', /^\/api\/library$/, 'GET /api/library'],
  ['GET', /^\/api\/library\/[^/]+$/, 'GET /api/library/:id'],
  ['GET', /^\/api\/graph$/, 'GET /api/graph'],
  ['GET', /^\/api\/voice\/config$/, 'GET /api/voice/config'],
  ['POST', /^\/api\/voice\/speak$/, 'POST /api/voice/speak'],
];

// Returns a human-readable route label for a countable visit, or null for
// anything that shouldn't be counted (a static asset, or any path that isn't
// actually part of the public read tier — reachable in practice too, since
// this runs on every request regardless of req.authed).
function classifyVisit(req) {
  if (req.path.startsWith('/api/')) {
    const match = API_ROUTE_LABELS.find(([method, pattern]) => method === req.method && pattern.test(req.path));
    return match ? match[2] : null;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  if (req.path === '/') return 'GET /';
  if (req.path === '/lodge') return 'GET /lodge';
  if (/^\/reading-room\/[^/]+$/.test(req.path)) return 'GET /reading-room/:id';
  if (ASSET_EXTENSION.test(req.path)) return null;
  return null;
}

function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function emptyStore() {
  return { total: 0, byDate: {}, byRoute: {} };
}

function loadStore(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { ...emptyStore(), ...parsed };
  } catch (err) {
    return emptyStore();
  }
}

function saveStore(filePath, store) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
  } catch (err) {
    console.warn('[visits] failed to persist', err.message);
  }
}

// Records one visit into `store` in place and persists it — best-effort,
// same convention as server.js's saveResidueUpdates: a write failure here
// must never break the request it's counting. Returns the route label that
// was counted, or null if this request wasn't countable (an asset, a
// mutating/gated call, etc.) — server.js uses that to decide whether to log.
function recordVisit(filePath, store, req, now = new Date()) {
  const label = classifyVisit(req);
  if (!label) return null;
  const date = todayKey(now);
  store.total++;
  store.byDate[date] = (store.byDate[date] || 0) + 1;
  store.byRoute[label] = (store.byRoute[label] || 0) + 1;
  saveStore(filePath, store);
  return label;
}

// Markdown summary, same "aggregate document, nothing raw" shape as the two
// existing /api/admin/* routes (citation-manifest, bibliography) in
// routes/session.js — legible in a browser with no JSON viewer needed.
function buildReport(store) {
  const dates = Object.keys(store.byDate).sort();
  const last7 = dates.slice(-7);
  const routes = Object.entries(store.byRoute).sort((a, b) => b[1] - a[1]);

  const lines = [
    '# Visitation — public read tier',
    '',
    `**${store.total} unauthenticated request(s) recorded** since tracking began. ` +
      'Counts only requests from browsers that never signed in — your own visits while ' +
      "logged in don't add to this.",
    '',
    '## Last 7 days with traffic',
    '',
    '| Date | Visits |',
    '|---|---|',
    ...(last7.length ? last7.map(d => `| ${d} | ${store.byDate[d]} |`) : ['| — | 0 |']),
    '',
    '## By route',
    '',
    '| Route | Visits |',
    '|---|---|',
    ...(routes.length ? routes.map(([route, count]) => `| ${route} | ${count} |`) : ['| — | 0 |']),
    '',
  ];
  return lines.join('\n');
}

module.exports = { classifyVisit, recordVisit, loadStore, saveStore, emptyStore, todayKey, buildReport };
