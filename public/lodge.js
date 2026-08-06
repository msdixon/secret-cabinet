'use strict';

// #84 — Member page + visual graph UI. Standalone page (doesn't load app.js),
// so it owns its own small amount of state rather than reusing app.js's
// globals — same reasoning that keeps witness.js/scene.js from reaching into
// app.js directly, just with no shared script tag to coordinate with at all.

const SVG_NS = 'http://www.w3.org/2000/svg';

function escapeHTML(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── State ──────────────────────────────────────────────────────────────────

let ROSTER = [];
let ROSTER_BY_ID = new Map();
let LIBRARY = [];
let LIBRARY_BY_ID = new Map();
let RAW_GRAPH = { nodes: [], edges: [] };

// Visual graph: only member/text/theme nodes (session nodes + their edges
// are structural plumbing, not part of the "meta-level research view" the
// issue describes) but per-member session stats are still computed from the
// full unfiltered graph, below.
let graphNodes = [];   // { id, type, label, x, y, vx, vy, r, fixed }
let graphNodeById = new Map();
let graphLinks = [];   // grouped by unordered pair: { a, b, weight, parts: [{type,label,origin,weight}] }

let selectedId = null;
let hoveredId = null;
let visibleTypes = new Set(['member', 'text', 'theme']);
let searchTerm = '';

// Pan/zoom
let viewX = 0, viewY = 0, viewScale = 1;
let svgW = 900, svgH = 520;

let simRunning = false;
let simAlpha = 0;

// ── Boot ───────────────────────────────────────────────────────────────────

async function boot() {
  const [roster, library, graph] = await Promise.all([
    fetch('/api/members').then(r => r.json()),
    fetch('/api/library').then(r => r.json()),
    fetch('/api/graph').then(r => r.json()),
  ]);

  ROSTER = roster;
  ROSTER.forEach(m => ROSTER_BY_ID.set(m.id, m));
  LIBRARY = library;
  LIBRARY.forEach(e => LIBRARY_BY_ID.set(e.id, e));
  RAW_GRAPH = graph;

  document.getElementById('lodge-page-stats').textContent =
    `${ROSTER.length} members · ${LIBRARY.length} texts · ${graph.nodes.length} nodes · ${graph.edges.length} edges`;

  buildRosterGrid();
  buildGraphData();
  initGraphSvg();
  startSim();

  document.getElementById('roster-filter').addEventListener('input', onRosterFilter);
  document.getElementById('graph-search').addEventListener('input', onGraphSearch);
  document.getElementById('graph-reset-btn').addEventListener('click', () => { resetView(); reheat(); });
  document.querySelectorAll('[data-node-type]').forEach(cb => {
    cb.addEventListener('change', onTypeToggle);
  });
  window.addEventListener('resize', onResize);
}

// ── Roster grid ────────────────────────────────────────────────────────────

function buildRosterGrid(filter) {
  const grid = document.getElementById('lodge-roster-grid');
  const term = (filter || '').trim().toLowerCase();
  const members = ROSTER.filter(m => !term || m.name.toLowerCase().includes(term));
  grid.innerHTML = members.map(m => `
    <div class="lodge-roster-card ${selectedId === m.id ? 'selected' : ''}" data-select="${m.id}" role="button" tabindex="0" aria-label="${escapeHTML(m.name)}">
      <img class="lodge-roster-portrait" src="/portraits/${m.id}.png" alt="" loading="lazy" onerror="this.style.display='none'">
      <div class="lodge-roster-glyph">${escapeHTML(m.glyph || '')}</div>
      <div class="lodge-roster-name">${escapeHTML(m.name)}</div>
    </div>
  `).join('') || '<div class="members-empty-hint">No members match.</div>';

  grid.querySelectorAll('[data-select]').forEach(el => {
    el.addEventListener('click', () => selectNode(el.dataset.select));
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectNode(el.dataset.select); }
    });
  });
}

function onRosterFilter(e) {
  buildRosterGrid(e.target.value);
}

// ── Graph data prep ────────────────────────────────────────────────────────

function buildGraphData() {
  const memberSet = new Set(ROSTER.map(m => m.id));
  const textSet = new Set(LIBRARY.map(e => e.id));

  graphNodes = RAW_GRAPH.nodes
    .filter(n => n.type === 'member' || n.type === 'text' || n.type === 'theme')
    .map(n => ({
      id: n.id,
      type: n.type,
      label: n.type === 'member' ? (ROSTER_BY_ID.get(n.id)?.name || n.label) : n.label,
      x: 0, y: 0, vx: 0, vy: 0,
      fixed: false,
    }));
  graphNodeById = new Map(graphNodes.map(n => [n.id, n]));

  // Degree (for radius scaling) + grouped undirected links.
  const linkMap = new Map();
  RAW_GRAPH.edges.forEach(e => {
    if (!graphNodeById.has(e.source) || !graphNodeById.has(e.target)) return; // touches a session node
    const [a, b] = [e.source, e.target].sort();
    const key = `${a}|${b}`;
    if (!linkMap.has(key)) linkMap.set(key, { a, b, weight: 0, parts: [] });
    const link = linkMap.get(key);
    link.weight += e.weight || 1;
    link.parts.push({ type: e.type, label: e.label || null, origin: e.origin, weight: e.weight || 1 });
  });
  graphLinks = Array.from(linkMap.values());

  const degree = new Map();
  graphLinks.forEach(l => {
    degree.set(l.a, (degree.get(l.a) || 0) + 1);
    degree.set(l.b, (degree.get(l.b) || 0) + 1);
  });
  const baseR = { member: 9, text: 6, theme: 5 };
  graphNodes.forEach(n => {
    n.r = baseR[n.type] + Math.min(6, Math.sqrt(degree.get(n.id) || 0) * 1.6);
  });

  layoutInitialPositions();
}

function layoutInitialPositions() {
  const cx = svgW / 2, cy = svgH / 2;
  const rings = { member: Math.min(svgW, svgH) * 0.22, text: Math.min(svgW, svgH) * 0.36, theme: Math.min(svgW, svgH) * 0.46 };
  const byType = { member: [], text: [], theme: [] };
  graphNodes.forEach(n => byType[n.type].push(n));
  Object.keys(byType).forEach(type => {
    const list = byType[type];
    const radius = rings[type];
    list.forEach((n, i) => {
      const angle = (i / Math.max(1, list.length)) * Math.PI * 2 + (type === 'text' ? 0.3 : type === 'theme' ? 0.6 : 0);
      const jitter = (Math.random() - 0.5) * 20;
      n.x = cx + Math.cos(angle) * radius + jitter;
      n.y = cy + Math.sin(angle) * radius + jitter;
    });
  });
}

// ── Force simulation (hand-rolled — no D3 dependency for ~150 nodes) ───────

function simTick() {
  const cx = svgW / 2, cy = svgH / 2;
  const nodes = graphNodes;
  const REPEL = 900;
  const SPRING = 0.02;
  const CENTER = 0.008;
  const DAMPING = 0.82;

  // Repulsion (O(n^2) — fine at this node count).
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let distSq = dx * dx + dy * dy;
      if (distSq < 1) distSq = 1;
      const dist = Math.sqrt(distSq);
      const force = REPEL / distSq;
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      if (!a.fixed) { a.vx += fx; a.vy += fy; }
      if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
    }
  }

  // Springs along links — higher weight pulls slightly tighter.
  graphLinks.forEach(l => {
    const a = graphNodeById.get(l.a), b = graphNodeById.get(l.b);
    if (!a || !b) return;
    const ideal = Math.max(40, 110 - Math.min(60, l.weight * 8));
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const force = (dist - ideal) * SPRING;
    const fx = (dx / dist) * force, fy = (dy / dist) * force;
    if (!a.fixed) { a.vx += fx; a.vy += fy; }
    if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
  });

  // Centering + damping + integrate.
  let kinetic = 0;
  nodes.forEach(n => {
    if (n.fixed) return;
    n.vx += (cx - n.x) * CENTER;
    n.vy += (cy - n.y) * CENTER;
    n.vx *= DAMPING;
    n.vy *= DAMPING;
    n.x += n.vx;
    n.y += n.vy;
    n.x = Math.max(n.r, Math.min(svgW - n.r, n.x));
    n.y = Math.max(n.r, Math.min(svgH - n.r, n.y));
    kinetic += n.vx * n.vx + n.vy * n.vy;
  });
  return kinetic;
}

function startSim() {
  simAlpha = 1;
  if (!simRunning) {
    simRunning = true;
    requestAnimationFrame(simLoop);
  }
}

function reheat() {
  layoutInitialPositions();
  startSim();
}

function simLoop() {
  const kinetic = simTick();
  renderGraph();
  simAlpha *= 0.996;
  if (kinetic > 0.02 && simAlpha > 0.02) {
    requestAnimationFrame(simLoop);
  } else {
    simRunning = false;
  }
}

// ── SVG rendering ───────────────────────────────────────────────────────────

let svgEl, linksLayer, nodesLayer, viewportG;

function initGraphSvg() {
  svgEl = document.getElementById('graph-svg');
  const container = document.getElementById('graph-svg-container');
  svgW = container.clientWidth || 900;
  svgH = 520;
  svgEl.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);
  svgEl.innerHTML = '';

  viewportG = document.createElementNS(SVG_NS, 'g');
  linksLayer = document.createElementNS(SVG_NS, 'g');
  nodesLayer = document.createElementNS(SVG_NS, 'g');
  viewportG.appendChild(linksLayer);
  viewportG.appendChild(nodesLayer);
  svgEl.appendChild(viewportG);

  layoutInitialPositions();
  attachPanZoom();
}

function nodeVisible(n) {
  if (!visibleTypes.has(n.type)) return false;
  if (searchTerm && !n.label.toLowerCase().includes(searchTerm)) return false;
  return true;
}

function connectedIds(id) {
  const set = new Set([id]);
  graphLinks.forEach(l => {
    if (l.a === id) set.add(l.b);
    if (l.b === id) set.add(l.a);
  });
  return set;
}

function renderGraph() {
  if (!svgEl) return;
  const anyFilterActive = searchTerm || visibleTypes.size < 3;
  const focusId = selectedId || hoveredId;
  const highlight = focusId ? connectedIds(focusId) : null;

  linksLayer.innerHTML = '';
  graphLinks.forEach(l => {
    const a = graphNodeById.get(l.a), b = graphNodeById.get(l.b);
    if (!a || !b || !nodeVisible(a) || !nodeVisible(b)) return;
    const dim = highlight && !(highlight.has(l.a) && highlight.has(l.b));
    const dominant = dominantOrigin(l.parts);
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
    line.setAttribute('class', `graph-edge graph-edge-${dominant}${dim ? ' dim' : ''}`);
    line.setAttribute('stroke-width', Math.min(6, 1 + l.weight * 0.5));
    line.addEventListener('mouseenter', (ev) => showEdgeTooltip(ev, l));
    line.addEventListener('mousemove', positionTooltip);
    line.addEventListener('mouseleave', hideTooltip);
    linksLayer.appendChild(line);
  });

  nodesLayer.innerHTML = '';
  let anyVisible = false;
  graphNodes.forEach(n => {
    if (!nodeVisible(n)) return;
    anyVisible = true;
    const dim = highlight && !highlight.has(n.id);
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', `graph-node graph-node-${n.type}${n.id === selectedId ? ' selected' : ''}${dim ? ' dim' : ''}`);
    g.setAttribute('transform', `translate(${n.x},${n.y})`);
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', `${n.type}: ${n.label}`);

    let shape;
    if (n.type === 'member') {
      shape = document.createElementNS(SVG_NS, 'circle');
      shape.setAttribute('r', n.r);
    } else if (n.type === 'text') {
      shape = document.createElementNS(SVG_NS, 'rect');
      shape.setAttribute('x', -n.r); shape.setAttribute('y', -n.r);
      shape.setAttribute('width', n.r * 2); shape.setAttribute('height', n.r * 2);
      shape.setAttribute('transform', 'rotate(45)');
    } else {
      shape = document.createElementNS(SVG_NS, 'polygon');
      const r = n.r * 1.15;
      shape.setAttribute('points', `0,${-r} ${r * 0.87},${r * 0.5} ${-r * 0.87},${r * 0.5}`);
    }
    shape.setAttribute('class', 'graph-node-shape');
    g.appendChild(shape);

    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('class', 'graph-node-label');
    label.setAttribute('y', n.r + 12);
    label.setAttribute('text-anchor', 'middle');
    label.textContent = n.label;
    g.appendChild(label);

    g.addEventListener('click', (ev) => { ev.stopPropagation(); selectNode(n.id); });
    g.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectNode(n.id); }
    });
    g.addEventListener('mouseenter', () => { hoveredId = n.id; renderGraph(); });
    g.addEventListener('mouseleave', () => { hoveredId = null; renderGraph(); });
    attachDrag(g, n);

    nodesLayer.appendChild(g);
  });

  document.getElementById('graph-empty-hint').style.display = anyVisible ? 'none' : 'block';
}

function dominantOrigin(parts) {
  if (parts.some(p => p.origin === 'historical')) return 'historical';
  if (parts.some(p => p.origin === 'session')) return 'session';
  return 'library';
}

// ── Tooltip ─────────────────────────────────────────────────────────────────

function showEdgeTooltip(ev, link) {
  const a = graphNodeById.get(link.a), b = graphNodeById.get(link.b);
  const lines = link.parts.map(p => `${p.type}${p.label ? ` — ${p.label}` : ''}${p.weight > 1 ? ` (×${p.weight})` : ''}`);
  const tip = document.getElementById('graph-tooltip');
  tip.innerHTML = `<strong>${escapeHTML(a.label)} ↔ ${escapeHTML(b.label)}</strong><br>${lines.map(l => escapeHTML(l)).join('<br>')}`;
  tip.style.display = 'block';
  positionTooltip(ev);
}

function positionTooltip(ev) {
  const tip = document.getElementById('graph-tooltip');
  const container = document.getElementById('graph-svg-container');
  const rect = container.getBoundingClientRect();
  tip.style.left = `${ev.clientX - rect.left + 14}px`;
  tip.style.top = `${ev.clientY - rect.top + 10}px`;
}

function hideTooltip() {
  document.getElementById('graph-tooltip').style.display = 'none';
}

// ── Pan / zoom / drag ────────────────────────────────────────────────────────

function applyViewTransform() {
  viewportG.setAttribute('transform', `translate(${viewX},${viewY}) scale(${viewScale})`);
}

function resetView() {
  viewX = 0; viewY = 0; viewScale = 1;
  applyViewTransform();
}

function attachPanZoom() {
  let panning = false, startX = 0, startY = 0, startViewX = 0, startViewY = 0;

  svgEl.addEventListener('mousedown', (ev) => {
    if (ev.target !== svgEl && !ev.target.closest) return;
    panning = true;
    startX = ev.clientX; startY = ev.clientY;
    startViewX = viewX; startViewY = viewY;
  });
  window.addEventListener('mousemove', (ev) => {
    if (!panning) return;
    viewX = startViewX + (ev.clientX - startX);
    viewY = startViewY + (ev.clientY - startY);
    applyViewTransform();
  });
  window.addEventListener('mouseup', () => { panning = false; });

  svgEl.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const delta = ev.deltaY > 0 ? 0.9 : 1.1;
    viewScale = Math.max(0.3, Math.min(3, viewScale * delta));
    applyViewTransform();
  }, { passive: false });

  svgEl.addEventListener('click', (ev) => {
    if (ev.target === svgEl) { selectedId = null; renderDetail(); renderGraph(); }
  });
}

function attachDrag(g, n) {
  let dragging = false;

  g.addEventListener('mousedown', (ev) => {
    ev.stopPropagation();
    dragging = true;
    n.fixed = true;
    startSim();
  });
  window.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const rect = svgEl.getBoundingClientRect();
    const scaleX = svgW / rect.width, scaleY = svgH / rect.height;
    n.x = (ev.clientX - rect.left) * scaleX / viewScale - viewX / viewScale;
    n.y = (ev.clientY - rect.top) * scaleY / viewScale - viewY / viewScale;
    n.vx = 0; n.vy = 0;
    renderGraph();
  });
  window.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; n.fixed = false; startSim(); }
  });
}

function onResize() {
  const container = document.getElementById('graph-svg-container');
  svgW = container.clientWidth || 900;
  svgEl.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);
}

// ── Search / filter ─────────────────────────────────────────────────────────

function onGraphSearch(e) {
  searchTerm = e.target.value.trim().toLowerCase();
  renderGraph();
}

function onTypeToggle() {
  visibleTypes = new Set(
    Array.from(document.querySelectorAll('[data-node-type]:checked')).map(cb => cb.dataset.nodeType)
  );
  renderGraph();
}

// ── Selection + detail panel ────────────────────────────────────────────────

function selectNode(id) {
  selectedId = id;
  renderGraph();
  buildRosterGrid(document.getElementById('roster-filter').value);
  renderDetail();
}

async function renderDetail() {
  const empty = document.getElementById('lodge-detail-empty');
  const content = document.getElementById('lodge-detail-content');
  if (!selectedId) {
    empty.style.display = 'block';
    content.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  content.style.display = 'block';
  content.innerHTML = '<div class="members-empty-hint">Loading…</div>';

  const node = graphNodeById.get(selectedId) || RAW_GRAPH.nodes.find(n => n.id === selectedId);
  if (!node) { content.innerHTML = '<div class="members-empty-hint">Not found.</div>'; return; }

  if (node.type === 'member') content.innerHTML = await renderMemberDetail(selectedId);
  else if (node.type === 'text') content.innerHTML = await renderTextDetail(selectedId);
  else content.innerHTML = renderThemeDetail(selectedId);

  content.querySelectorAll('[data-goto]').forEach(el => {
    el.addEventListener('click', () => selectNode(el.dataset.goto));
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectNode(el.dataset.goto); }
    });
  });
  const voiceToggle = content.querySelector('.dossier-toggle');
  if (voiceToggle) voiceToggle.addEventListener('click', () => {
    const box = voiceToggle.nextElementSibling;
    box.classList.toggle('open');
    voiceToggle.textContent = box.classList.contains('open') ? '▲ Voice' : '▼ Voice';
  });
}

// Relationship/stat helpers, computed from the FULL unfiltered graph (session
// nodes included) since "times convened" etc. needs the session-derived
// edges the visual graph deliberately hides.
function edgesTouching(id) {
  return RAW_GRAPH.edges.filter(e => e.source === id || e.target === id);
}

async function renderMemberDetail(id) {
  const member = ROSTER_BY_ID.get(id);
  const dossier = await fetch(`/api/members/${id}/dossier`).then(r => r.ok ? r.json() : null).catch(() => null);

  const edges = edgesTouching(id);
  const texts = edges.filter(e => e.type === 'appears-in' && e.source === id)
    .map(e => LIBRARY_BY_ID.get(e.target)).filter(Boolean);
  const themeIds = new Set(edges.filter(e => e.type === 'associated-with' && e.source === id).map(e => e.target));
  const coConvened = edges.filter(e => e.type === 'co-convened')
    .map(e => ({ other: e.source === id ? e.target : e.source, weight: e.weight || 1 }))
    .sort((a, b) => b.weight - a.weight);
  const historical = edges.filter(e => e.origin === 'historical');
  const timesConvened = edges.filter(e => e.type === 'convened' && e.target === id).length;

  return `
    <div class="lodge-detail-header">
      <img class="lodge-detail-portrait" src="/portraits/${id}.png" alt="" loading="lazy" onerror="this.remove()">
      <div>
        <div class="lodge-detail-name">${escapeHTML(member?.glyph || '')} ${escapeHTML(member?.name || id)}</div>
        <div class="lodge-detail-kind">Member</div>
      </div>
    </div>
    ${dossier?.bio ? `<div class="panel-label">Who they are</div><div class="dossier-text">${escapeHTML(dossier.bio)}</div>` : ''}
    ${dossier?.voice ? `<button class="dossier-toggle">▼ Voice</button><div class="dossier-voice"><div class="dossier-text">${escapeHTML(dossier.voice)}</div></div>` : ''}

    <div class="panel-label lodge-detail-section">Session history</div>
    <div class="dossier-text">Convened <strong>${timesConvened}</strong> time${timesConvened === 1 ? '' : 's'} so far.</div>
    ${coConvened.length ? `
      <div class="lodge-chip-row">
        ${coConvened.slice(0, 12).map(c => `<span class="lodge-chip lodge-chip-member" data-goto="${c.other}" role="button" tabindex="0">${escapeHTML(ROSTER_BY_ID.get(c.other)?.name || c.other)}${c.weight > 1 ? ` ×${c.weight}` : ''}</span>`).join('')}
      </div>` : '<div class="dossier-text">No recorded co-conveners yet.</div>'}

    ${historical.length ? `
      <div class="panel-label lodge-detail-section">Historical relationships</div>
      <div class="lodge-relationship-list">
        ${historical.map(e => `<div class="lodge-relationship"><strong>${escapeHTML(ROSTER_BY_ID.get(e.source)?.name || e.source)} → ${escapeHTML(ROSTER_BY_ID.get(e.target)?.name || e.target)}</strong> <span class="lodge-relationship-type">${escapeHTML(e.type)}</span><div class="dossier-text">${escapeHTML(e.label || '')}</div></div>`).join('')}
      </div>` : ''}

    <div class="panel-label lodge-detail-section">Library texts</div>
    ${texts.length ? `<div class="lodge-text-list">
      ${texts.map(t => `<div class="lodge-text-item" data-goto="${t.id}" role="button" tabindex="0"><div class="lodge-text-item-title">${escapeHTML(t.title)}</div><div class="lodge-text-item-meta">${escapeHTML(t.source)}${t.date ? `, ${escapeHTML(t.date)}` : ''}</div></div>`).join('')}
    </div>` : '<div class="dossier-text">None in the library yet.</div>'}

    <div class="panel-label lodge-detail-section">Themes</div>
    ${themeIds.size ? `<div class="lodge-chip-row">
      ${Array.from(themeIds).map(t => `<span class="lodge-chip lodge-chip-theme" data-goto="${t}" role="button" tabindex="0">${escapeHTML(t)}</span>`).join('')}
    </div>` : '<div class="dossier-text">None recorded yet.</div>'}
  `;
}

async function renderTextDetail(id) {
  const summary = LIBRARY_BY_ID.get(id);
  const full = await fetch(`/api/library/${id}`).then(r => r.ok ? r.json() : null).catch(() => null);
  const entry = full || summary;
  if (!entry) return '<div class="members-empty-hint">Not found.</div>';

  return `
    <div class="lodge-detail-header">
      ${entry.image ? `<img class="lodge-detail-portrait lodge-detail-archive-image" src="${escapeHTML(entry.image)}" alt="">` : ''}
      <div>
        <div class="lodge-detail-name">${escapeHTML(entry.title)}</div>
        <div class="lodge-detail-kind">Text — ${escapeHTML(entry.source)}${entry.date ? `, ${escapeHTML(entry.date)}` : ''}</div>
      </div>
    </div>

    ${entry.citation ? `<div class="panel-label lodge-detail-section">Citation</div><div class="dossier-text lodge-citation">${escapeHTML(entry.citation)}</div>` : ''}
    ${entry.source_url ? `<a class="lodge-source-link" href="${escapeHTML(entry.source_url)}" target="_blank" rel="noopener">View source ↗</a>` : ''}

    ${entry.text ? `<div class="panel-label lodge-detail-section">Excerpt</div><div class="journal-entry-display lodge-excerpt">${escapeHTML(entry.text)}</div>` : ''}

    <div class="panel-label lodge-detail-section">Members</div>
    <div class="lodge-chip-row">
      ${(entry.members || []).map(m => `<span class="lodge-chip lodge-chip-member" data-goto="${m}" role="button" tabindex="0">${escapeHTML(ROSTER_BY_ID.get(m)?.name || m)}</span>`).join('') || '<div class="dossier-text">None recorded.</div>'}
    </div>

    <div class="panel-label lodge-detail-section">Themes</div>
    <div class="lodge-chip-row">
      ${(entry.themes || []).map(t => `<span class="lodge-chip lodge-chip-theme" data-goto="${t}" role="button" tabindex="0">${escapeHTML(t)}</span>`).join('') || '<div class="dossier-text">None recorded.</div>'}
    </div>
  `;
}

function renderThemeDetail(id) {
  const edges = edgesTouching(id);
  const members = new Set(edges.filter(e => e.type === 'associated-with' && e.target === id).map(e => e.source));
  const texts = edges.filter(e => e.type === 'touches' && e.target === id).map(e => LIBRARY_BY_ID.get(e.source)).filter(Boolean);

  return `
    <div class="lodge-detail-header">
      <div>
        <div class="lodge-detail-name">${escapeHTML(id)}</div>
        <div class="lodge-detail-kind">Theme</div>
      </div>
    </div>

    <div class="panel-label lodge-detail-section">Members</div>
    <div class="lodge-chip-row">
      ${Array.from(members).map(m => `<span class="lodge-chip lodge-chip-member" data-goto="${m}" role="button" tabindex="0">${escapeHTML(ROSTER_BY_ID.get(m)?.name || m)}</span>`).join('') || '<div class="dossier-text">None recorded.</div>'}
    </div>

    <div class="panel-label lodge-detail-section">Texts</div>
    <div class="lodge-text-list">
      ${texts.map(t => `<div class="lodge-text-item" data-goto="${t.id}" role="button" tabindex="0"><div class="lodge-text-item-title">${escapeHTML(t.title)}</div><div class="lodge-text-item-meta">${escapeHTML(t.source)}</div></div>`).join('') || '<div class="dossier-text">None recorded.</div>'}
    </div>
  `;
}

boot();
