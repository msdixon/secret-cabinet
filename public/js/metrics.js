'use strict';

// #191 — surfaces the per-session generation metrics `makeMetric` already
// persists (pipeline.js) but nothing in the UI reads: tokens, latency,
// retries, skips, and the director/casting reasoning behind tonight's cast.
// Reuses the dossier-drawer chrome (#186 precedent)
// rather than inventing new UI — same script-tag/IIFE + configure(deps)
// convention as export.js/sessions.js/casting.js (#142).
window.Metrics = (function () {
  let deps = null; // set by configure(); see app.js's metricsDeps()

  function configure(injectedDeps) {
    deps = injectedDeps;
  }

  // Per-1M-token rates for the app's default model (MODEL in server.js,
  // 'claude-sonnet-5' as of #406 — same $3/$15 standard rate as the prior
  // 'claude-sonnet-4-6' default, so these numbers didn't need to change).
  // A deployment overriding MODEL via env var will see a slightly-off
  // estimate — acceptable for a labeled "estimated cost", and cheaper than
  // threading the actual model name through every stored metric.
  const PRICE_PER_MILLION = { input: 3.0, output: 15.0, cacheRead: 0.3 };

  const PHASE_LABELS = {
    director: 'Director (per-round casting)',
    casting: 'Pre-convene casting',
    'citation-extraction': 'Citation extraction',
    'citation-grounding': 'Citation grounding',
    'grounding-verify': 'Source verification (your uploads)',
  };

  function formatNum(n) {
    return n.toLocaleString('en-US');
  }

  function formatCost(c) {
    return '$' + c.toFixed(c > 0 && c < 0.01 ? 4 : 2);
  }

  function estimateCost({ input, output, cacheRead }) {
    return (
      (input / 1e6) * PRICE_PER_MILLION.input +
      (output / 1e6) * PRICE_PER_MILLION.output +
      (cacheRead / 1e6) * PRICE_PER_MILLION.cacheRead
    );
  }

  function reasonLabel(r) {
    if (r.phase === 'casting') return 'Pre-convene casting';
    if (r.phase === 'director') return r.round != null ? `Round ${r.round + 1} casting` : 'Director';
    return PHASE_LABELS[r.phase] || r.phase;
  }

  // Groups every stored metric into per-speaker rows (phase 'speaker' /
  // 'disposition', keyed by memberId) and per-phase rows for everything else
  // (director/casting/citation-*, memberId null) — the same split the panel
  // renders as two tables, so aggregation and rendering agree on the split.
  // presentMemberIds (session.members) seeds a zero row for every seated
  // member up front — #361: a member who was never picked emits no metric
  // at all, so without this the panel silently omits them instead of
  // showing the zero that's the actual signal.
  function aggregate(metrics, members, presentMemberIds) {
    const totals = { calls: metrics.length, input: 0, output: 0, cacheRead: 0, skipped: 0 };
    const bySpeaker = new Map();
    const byPhase = new Map();
    const reasonings = [];

    (presentMemberIds || []).forEach(id => {
      const member = members.find(mm => mm.id === id);
      bySpeaker.set(id, {
        name: member?.name || id,
        calls: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        skipped: 0,
      });
    });

    metrics.forEach(m => {
      const usage = m.usage || {};
      const input = usage.input_tokens || 0;
      const output = usage.output_tokens || 0;
      const cacheRead = usage.cache_read_input_tokens || 0;
      totals.input += input;
      totals.output += output;
      totals.cacheRead += cacheRead;
      if (m.skipped) totals.skipped++;

      if (m.memberId) {
        if (!bySpeaker.has(m.memberId)) {
          const member = members.find(mm => mm.id === m.memberId);
          bySpeaker.set(m.memberId, {
            name: member?.name || m.memberId,
            calls: 0,
            input: 0,
            output: 0,
            cacheRead: 0,
            skipped: 0,
          });
        }
        const s = bySpeaker.get(m.memberId);
        s.calls++;
        s.input += input;
        s.output += output;
        s.cacheRead += cacheRead;
        if (m.skipped) s.skipped++;
      } else {
        if (!byPhase.has(m.phase)) {
          byPhase.set(m.phase, { phase: m.phase, calls: 0, input: 0, output: 0, cacheRead: 0 });
        }
        const p = byPhase.get(m.phase);
        p.calls++;
        p.input += input;
        p.output += output;
        p.cacheRead += cacheRead;
      }

      if (m.reasoning) reasonings.push({ phase: m.phase, round: m.round, reasoning: m.reasoning });
    });

    return {
      totals,
      bySpeaker: [...bySpeaker.values()].sort((a, b) => b.input + b.output - (a.input + a.output)),
      byPhase: [...byPhase.values()],
      reasonings,
    };
  }

  function render(session) {
    const body = document.getElementById('metrics-body');
    const metrics = session.generationMetrics || [];
    if (!metrics.length) {
      body.innerHTML = '<div class="sessions-empty">No generation metrics recorded for this session.</div>';
      return;
    }

    const members = deps.getCore().MEMBERS || [];
    const { totals, bySpeaker, byPhase, reasonings } = aggregate(metrics, members, session.members);
    const cost = estimateCost(totals);
    // #190 verification: the whole point of surfacing this distinctly rather
    // than folding it into total input — a non-zero share here is the signal
    // that repeat director/speaker calls are actually hitting the cache.
    const cacheShare =
      totals.input + totals.cacheRead > 0
        ? Math.round((totals.cacheRead / (totals.input + totals.cacheRead)) * 100)
        : 0;

    const summaryHtml = `
      <div class="metrics-summary">
        <div class="metrics-stat"><span class="metrics-stat-value">${totals.calls}</span><span class="metrics-stat-label">API calls</span></div>
        <div class="metrics-stat"><span class="metrics-stat-value">${formatNum(totals.input)}</span><span class="metrics-stat-label">Input tokens</span></div>
        <div class="metrics-stat"><span class="metrics-stat-value">${formatNum(totals.output)}</span><span class="metrics-stat-label">Output tokens</span></div>
        <div class="metrics-stat"><span class="metrics-stat-value">${formatNum(totals.cacheRead)}</span><span class="metrics-stat-label">Cache-read tokens${totals.cacheRead ? ` (${cacheShare}%)` : ''}</span></div>
        <div class="metrics-stat"><span class="metrics-stat-value">${formatCost(cost)}</span><span class="metrics-stat-label">Estimated cost</span></div>
      </div>
      ${totals.skipped ? `<div class="metrics-note">⚠ ${totals.skipped} call${totals.skipped !== 1 ? 's' : ''} degraded or skipped this session.</div>` : ''}
    `;

    const speakerHtml = bySpeaker.length
      ? `
      <div class="dossier-section-label">Per-speaker breakdown</div>
      <table class="metrics-table">
        <thead><tr><th>Speaker</th><th>Calls</th><th>In</th><th>Out</th><th>Cache</th><th>Skip</th></tr></thead>
        <tbody>${bySpeaker
          .map(
            s => `
          <tr${s.calls === 0 ? ' class="metrics-row-silent"' : ''}>
            <td>${deps.escapeHTML(s.name)}${s.calls === 0 ? ' <span class="metrics-silent-tag">sat silent</span>' : ''}</td>
            <td>${s.calls}</td>
            <td>${formatNum(s.input)}</td>
            <td>${formatNum(s.output)}</td>
            <td>${formatNum(s.cacheRead)}</td>
            <td>${s.skipped ? `⚠${s.skipped}` : '—'}</td>
          </tr>`
          )
          .join('')}</tbody>
      </table>`
      : '';

    const phaseHtml = byPhase.length
      ? `
      <div class="dossier-section-label">Other calls</div>
      <table class="metrics-table">
        <thead><tr><th>Phase</th><th>Calls</th><th>In</th><th>Out</th><th>Cache</th></tr></thead>
        <tbody>${byPhase
          .map(
            p => `
          <tr>
            <td>${deps.escapeHTML(PHASE_LABELS[p.phase] || p.phase)}</td>
            <td>${p.calls}</td>
            <td>${formatNum(p.input)}</td>
            <td>${formatNum(p.output)}</td>
            <td>${formatNum(p.cacheRead)}</td>
          </tr>`
          )
          .join('')}</tbody>
      </table>`
      : '';

    const rationaleHtml = reasonings.length
      ? `
      <div class="dossier-section-label">Why the room chose these voices tonight</div>
      ${reasonings
        .map(
          r => `
        <div class="metrics-reasoning">
          <div class="metrics-reasoning-tag">${deps.escapeHTML(reasonLabel(r))}</div>
          <div class="dossier-text">${deps.escapeHTML(r.reasoning)}</div>
        </div>`
        )
        .join('')}
    `
      : '';

    body.innerHTML = summaryHtml + speakerHtml + phaseHtml + rationaleHtml;
  }

  let isOpen = false;
  let loadedSessionId = null;

  function closeMetrics() {
    isOpen = false;
    document.getElementById('metrics-overlay').classList.remove('open');
    document.getElementById('metrics-drawer').classList.remove('open');
  }

  async function load(sessionId) {
    const body = document.getElementById('metrics-body');
    body.innerHTML = '<div class="sessions-empty">Loading…</div>';
    loadedSessionId = sessionId;
    try {
      const session = await fetch(`/api/sessions/${sessionId}`).then(r => r.json());
      if (loadedSessionId !== sessionId) return; // superseded by a later toggle()
      if (session.error) {
        body.innerHTML = '<div class="sessions-empty">Could not load metrics.</div>';
        return;
      }
      render(session);
    } catch (e) {
      if (loadedSessionId === sessionId) body.innerHTML = '<div class="sessions-empty">Could not load metrics.</div>';
    }
  }

  // sessionId is optional — omit it to show the currently loaded/live session
  // (the after-panel's footer button), or pass one explicitly (a Past
  // Meetings list item). Toggling the same session closes the drawer.
  function toggle(sessionId) {
    const id = sessionId || deps.getCore().currentSessionId;
    if (!id) return;
    if (isOpen && loadedSessionId === id) {
      closeMetrics();
      return;
    }
    isOpen = true;
    document.getElementById('metrics-overlay').classList.add('open');
    document.getElementById('metrics-drawer').classList.add('open');
    load(id);
  }

  return { configure, toggle, close: closeMetrics };
})();
