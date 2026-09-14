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
//
// #583 extends the same lightweight approach to the other side of that same
// gate: convene/cast/round/interject calls made once a session has
// authenticated past the client's applyConveneGate() (public/js/app.js).
// #422 explicitly left this out of scope (no per-user identity, no auth
// changes) — but "gated" and "invisible" aren't the same thing, and a
// colleague demo run through shared credentials is exactly the kind of real
// usage that narrow scope couldn't see. Same restraint as #422: count/log
// only, no alerting, no auth changes, surfaced in the same buildReport
// output rather than a second admin route.

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

// The gated-side counterpart to API_ROUTE_LABELS — the convene/casting/
// provocation controls applyConveneGate() hides from an unauthenticated
// visitor (public/js/app.js). POST /api/prototype/round is deliberately
// excluded: it 404s outside local dev (isLocal check in
// src/routes/convene.js), so it can never carry real deployed signal and
// would only add local-dev noise if it were counted.
const GATED_ROUTE_LABELS = [
  ['POST', /^\/api\/convene$/, 'POST /api/convene'],
  ['POST', /^\/api\/cast$/, 'POST /api/cast'],
  ['POST', /^\/api\/round$/, 'POST /api/round'],
  ['POST', /^\/api\/interject$/, 'POST /api/interject'],
];

// The three page-view labels classifyVisit ever returns for a non-`/api/`
// path — everything else in store.byRoute is one of API_ROUTE_LABELS. Used
// at report-build time (#437) to split the blended byRoute/total into
// "traffic" (a person loading a page) vs "calls" (the API requests that one
// page load fans out into on boot, e.g. /api/members, /api/voice/config —
// counting those toward "visits" massively overcounts actual visitors).
const PAGE_ROUTE_LABELS = new Set(['GET /', 'GET /lodge', 'GET /reading-room/:id']);

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

// Returns the gated-side route label for a countable convene/cast/round/
// interject call, or null for anything else. Server.js only ever calls this
// on requests where req.authed is already true (see its mounting site), so
// this doesn't re-check auth itself — same division of responsibility as
// classifyVisit, which likewise trusts its caller on the req.authed split.
function classifyGatedVisit(req) {
  const match = GATED_ROUTE_LABELS.find(([method, pattern]) => method === req.method && pattern.test(req.path));
  return match ? match[2] : null;
}

function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function emptyStore() {
  return { total: 0, byDate: {}, byRoute: {}, gatedTotal: 0, gatedByDate: {}, gatedByRoute: {} };
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

// #583 — same shape as recordVisit above, for the gated side: convene/cast/
// round/interject calls from an authenticated session. A separate function
// (rather than a `kind` flag on recordVisit) since the two write into
// distinct fields on `store` and are driven by opposite req.authed branches
// at the call site in server.js — keeping them separate keeps each one a
// direct read of "what gets counted here."
function recordGatedVisit(filePath, store, req, now = new Date()) {
  const label = classifyGatedVisit(req);
  if (!label) return null;
  const date = todayKey(now);
  store.gatedTotal = (store.gatedTotal || 0) + 1;
  store.gatedByDate[date] = (store.gatedByDate[date] || 0) + 1;
  store.gatedByRoute[label] = (store.gatedByRoute[label] || 0) + 1;
  saveStore(filePath, store);
  return label;
}

// Markdown summary, same "aggregate document, nothing raw" shape as the two
// existing /api/admin/* routes (citation-manifest, bibliography) in
// routes/session.js — legible in a browser with no JSON viewer needed.
//
// #437: store.byRoute already distinguishes page routes from API routes
// (PAGE_ROUTE_LABELS above), so the traffic/calls split is derived here at
// render time rather than tracked as a new counting mechanism — what gets
// counted, and how recordVisit/emptyStore work, is unchanged.
function buildReport(store) {
  const dates = Object.keys(store.byDate).sort();
  const last7 = dates.slice(-7);
  const routes = Object.entries(store.byRoute).sort((a, b) => b[1] - a[1]);
  const pageRoutes = routes.filter(([route]) => PAGE_ROUTE_LABELS.has(route));
  const apiRoutes = routes.filter(([route]) => !PAGE_ROUTE_LABELS.has(route));
  const traffic = pageRoutes.reduce((sum, [, count]) => sum + count, 0);
  const calls = apiRoutes.reduce((sum, [, count]) => sum + count, 0);

  const gatedDates = Object.keys(store.gatedByDate || {}).sort();
  const gatedLast7 = gatedDates.slice(-7);
  const gatedRoutes = Object.entries(store.gatedByRoute || {}).sort((a, b) => b[1] - a[1]);
  const gatedTotal = store.gatedTotal || 0;

  const lines = [
    '# Visitation — public read tier',
    '',
    `**${traffic} page view(s) recorded** since tracking began — loads of /, /lodge, or ` +
      'a reading room by browsers that never signed in. This is the number that answers ' +
      '"is the invite-only pool staying small."',
    '',
    '## Traffic by page',
    '',
    '| Page | Views |',
    '|---|---|',
    ...(pageRoutes.length ? pageRoutes.map(([route, count]) => `| ${route} | ${count} |`) : ['| — | 0 |']),
    '',
    '## Last 7 days (all tracked events)',
    '',
    'Page views and API calls combined — a single page load fans out into several of the ' +
      'latter, so day-to-day totals here run higher than the traffic figure above.',
    '',
    '| Date | Events |',
    '|---|---|',
    ...(last7.length ? last7.map(d => `| ${d} | ${store.byDate[d]} |`) : ['| — | 0 |']),
    '',
    '## API calls (secondary — not visits)',
    '',
    `${calls} call(s) recorded. Each page load fans out into several of these on its own ` +
      "(e.g. loading / alone triggers /api/members and /api/voice/config too), so they'd " +
      'overcount visits if blended into the traffic figure above — kept here as supporting ' +
      'detail instead (e.g. to spot scraper-like API hammering unaccompanied by page loads).',
    '',
    '| Route | Calls |',
    '|---|---|',
    ...(apiRoutes.length ? apiRoutes.map(([route, count]) => `| ${route} | ${count} |`) : ['| — | 0 |']),
    '',
    '## Gated interactions (authenticated, deployed only)',
    '',
    `**${gatedTotal} interaction(s) recorded** — convene/cast/round/interject calls made by a ` +
      "session that authenticated past the app's convene gate (#583, extending #422 to the " +
      'other side of that same gate). Local dev is excluded, since every local request is ' +
      "authenticated by default and would otherwise swamp this with the app's own developer " +
      'use rather than real gated-side usage — for example, a colleague demo run through ' +
      'shared credentials on a deployed instance.',
    '',
    '| Route | Calls |',
    '|---|---|',
    ...(gatedRoutes.length ? gatedRoutes.map(([route, count]) => `| ${route} | ${count} |`) : ['| — | 0 |']),
    '',
    '### Last 7 days',
    '',
    '| Date | Interactions |',
    '|---|---|',
    ...(gatedLast7.length ? gatedLast7.map(d => `| ${d} | ${store.gatedByDate[d]} |`) : ['| — | 0 |']),
    '',
  ];
  return lines.join('\n');
}

module.exports = {
  classifyVisit,
  classifyGatedVisit,
  recordVisit,
  recordGatedVisit,
  loadStore,
  saveStore,
  emptyStore,
  todayKey,
  buildReport,
};
