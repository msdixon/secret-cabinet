'use strict';

// Aggregates generationMetrics (#191) across every session on disk into one
// cumulative cost/volume view — answers "what has this project spent total"
// and "how is cache-hit rate trending" without opening every sessions/*.json
// file by hand. Filed as #409 specifically to make MODEL-REVIEW.md's
// quarterly Step 1 ("pull generationMetrics from a few recent real
// sessions") faster, so the aggregation and pricing here deliberately track
// that file's own instructions and public/js/metrics.js's per-session panel
// (#191) rather than inventing a separate convention.
// No test framework/scripts runner exists in this repo — matches its
// existing ad hoc script style (see scripts/build-citation-manifest.js).
// Read-only, no new persistence. Run with:
//   node scripts/rollup-metrics.js
const fs = require('fs');
const path = require('path');
const { loadSessions } = require('./build-citation-manifest');

const ROOT = path.join(__dirname, '..');
const OUTPUT_FILE = path.join(ROOT, 'METRICS-ROLLUP.md');

// Same standard-tier rate public/js/metrics.js's PRICE_PER_MILLION uses —
// kept in sync by hand (no shared constants module exists for client/server
// code to both reach), not derived from server.js's MODEL, since no metric
// entry records which model generated it (see the caveat in the rendered
// output below).
const PRICE_PER_MILLION = { input: 3.0, output: 15.0, cacheRead: 0.3 };

// #191's own phase set, docs/MODEL-REVIEW.md restates it as the full call
// surface as of #225 (2026-08-08): director, speaker, casting, disposition,
// citation-extraction, citation-grounding.
const PHASE_LABELS = {
  director: 'Director (per-round casting)',
  speaker: 'Speaker turns',
  casting: 'Pre-convene casting',
  disposition: 'Disposition updates',
  'citation-extraction': 'Citation extraction',
  'citation-grounding': 'Citation grounding',
};

function estimateCost({ input, output, cacheRead }) {
  return (
    (input / 1e6) * PRICE_PER_MILLION.input +
    (output / 1e6) * PRICE_PER_MILLION.output +
    (cacheRead / 1e6) * PRICE_PER_MILLION.cacheRead
  );
}

function formatNum(n) {
  return Math.round(n).toLocaleString('en-US');
}

function formatCost(c) {
  return '$' + c.toFixed(c > 0 && c < 0.01 ? 4 : 2);
}

function emptyTotals() {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, skipped: 0, latencySum: 0, latencyCount: 0 };
}

function addMetric(totals, m) {
  const usage = m.usage || {};
  totals.calls++;
  totals.input += usage.input_tokens || 0;
  totals.output += usage.output_tokens || 0;
  totals.cacheRead += usage.cache_read_input_tokens || 0;
  if (m.skipped) totals.skipped++;
  if (typeof m.latencyMs === 'number') {
    totals.latencySum += m.latencyMs;
    totals.latencyCount++;
  }
}

// Aggregates across every session's generationMetrics, three ways: overall,
// by phase, and by date (for a cheap trend view — "cheap to add" per #409,
// so this stays a simple per-day sum rather than a real time-series).
function rollup(sessions) {
  const overall = emptyTotals();
  const byPhase = new Map(); // phase -> totals
  const byDate = new Map(); // date -> totals
  let sessionsWithMetrics = 0;
  let oldestPre225 = false; // any session predating #225's phase-coverage fix
  let oldestPre190 = false; // any session predating #190's cache_read field

  sessions.forEach(session => {
    const metrics = session.generationMetrics || [];
    if (!metrics.length) return;
    sessionsWithMetrics++;

    const phasesSeen = new Set(metrics.map(m => m.phase));
    // #225 shipped 2026-08-08 — a session that only ever produced
    // director/speaker/disposition phases (never casting or citation-*)
    // predates full call-surface coverage, same read MODEL-REVIEW.md's own
    // Step 1 caveat describes. Heuristic, not authoritative: a genuinely
    // short/uneventful post-#225 session could also lack those phases.
    if (!phasesSeen.has('casting') && !phasesSeen.has('citation-extraction') && !phasesSeen.has('citation-grounding')) {
      oldestPre225 = true;
    }
    if (metrics.every(m => !m.usage || m.usage.cache_read_input_tokens == null)) {
      oldestPre190 = true;
    }

    if (!byDate.has(session.date)) byDate.set(session.date, emptyTotals());
    const dateTotals = byDate.get(session.date);

    metrics.forEach(m => {
      addMetric(overall, m);
      addMetric(dateTotals, m);
      if (!byPhase.has(m.phase)) byPhase.set(m.phase, emptyTotals());
      addMetric(byPhase.get(m.phase), m);
    });
  });

  return {
    overall,
    byPhase: [...byPhase.entries()].map(([phase, totals]) => ({ phase, ...totals })),
    byDate: [...byDate.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([date, totals]) => ({
        date,
        ...totals,
      })),
    sessionsScanned: sessions.length,
    sessionsWithMetrics,
    oldestPre225,
    oldestPre190,
  };
}

function renderRow(label, totals) {
  const avgLatency = totals.latencyCount ? Math.round(totals.latencySum / totals.latencyCount) : null;
  return `| ${label} | ${totals.calls} | ${formatNum(totals.input)} | ${formatNum(totals.output)} | ${formatNum(totals.cacheRead)} | ${totals.skipped || '—'} | ${avgLatency != null ? avgLatency + 'ms' : '—'} | ${formatCost(estimateCost(totals))} |`;
}

function buildReport(data) {
  const lines = [
    '# Metrics Rollup',
    '',
    `Generated from ${data.sessionsScanned} session(s) on disk, ${data.sessionsWithMetrics} with recorded generationMetrics.`,
    '',
    `**Total estimated cost: ${formatCost(estimateCost(data.overall))}** across ${data.overall.calls} calls ` +
      `(${formatNum(data.overall.input)} input tokens, ${formatNum(data.overall.output)} output, ${formatNum(data.overall.cacheRead)} cache-read).`,
    '',
  ];

  if (data.oldestPre225 || data.oldestPre190) {
    lines.push(
      '> **Caveat, per docs/MODEL-REVIEW.md Step 1:** at least one scanned session appears to predate ' +
        (data.oldestPre225
          ? '[#225](https://github.com/msdixon/secret-cabinet/issues/225) (2026-08-08, full call-surface coverage)'
          : '') +
        (data.oldestPre225 && data.oldestPre190 ? ' and/or ' : '') +
        (data.oldestPre190
          ? '[#190](https://github.com/msdixon/secret-cabinet/issues/190) (2026-08-10, cache_read_input_tokens)'
          : '') +
        " — the totals above likely undercount older sessions' true cost and call volume rather than overcounting.",
      ''
    );
  }

  lines.push(
    '## By phase',
    '',
    '| Phase | Calls | Input | Output | Cache-read | Skipped | Avg latency | Est. cost |',
    '|---|---|---|---|---|---|---|---|',
    ...data.byPhase
      .sort((a, b) => estimateCost(b) - estimateCost(a))
      .map(p => renderRow(PHASE_LABELS[p.phase] || p.phase, p)),
    ''
  );

  lines.push(
    '## By date',
    '',
    '| Date | Calls | Input | Output | Cache-read | Skipped | Avg latency | Est. cost |',
    '|---|---|---|---|---|---|---|---|',
    ...data.byDate.map(d => renderRow(d.date, d)),
    ''
  );

  lines.push(
    '---',
    '',
    '_Pricing: $3/$15/$0.30 per 1M input/output/cache-read tokens — the current claude-sonnet-5 standard rate ' +
      "(public/js/metrics.js's PRICE_PER_MILLION). No generationMetrics entry records which model generated it, " +
      "so this rollup can't break totals out by model — every session is priced at today's rate regardless of " +
      'which MODEL default was live when it actually ran. Re-run after any MODEL-REVIEW.md switch to see the new baseline.',
    '_'
  );

  return lines.join('\n');
}

module.exports = { rollup, buildReport };

if (require.main === module) {
  const sessionsDir = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || ROOT, 'sessions');
  const sessions = loadSessions(sessionsDir);
  const data = rollup(sessions);
  const report = buildReport(data);
  fs.writeFileSync(OUTPUT_FILE, report, 'utf8');
  console.log(`Wrote ${OUTPUT_FILE} (${sessions.length} sessions scanned, from ${sessionsDir}).`);
}
