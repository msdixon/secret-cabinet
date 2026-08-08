'use strict';

// #193 seam-map, module 7 of 8 — the knowledge graph (#22/#84).
//
// Self-contained given the roster and a few directory paths as input; one
// route (GET /api/graph) calls it. File paths are passed in explicitly
// rather than read from module-level constants, following the convention
// set by roster.js/library.js.

const fs = require('fs');
const path = require('path');

/**
 * Build the full graph at query time from three sources:
 *   1. Historical seed edges (graph.json)
 *   2. Library-derived edges (member↔text, text↔theme) from library.json
 *   3. Session-derived edges (co-convened members, discussed text, theme tags) from sessions/
 *
 * Returns { nodes: [...], edges: [...] }
 */
function buildGraph(roster, graphFile, libraryFile, sessionsDir) {
  const edges = [];
  const nodeMap = new Map(); // id → node

  function ensureNode(id, type, label) {
    if (!nodeMap.has(id)) nodeMap.set(id, { id, type, label });
  }

  // ── 1. Roster nodes ────────────────────────────────────────────────────────
  roster.forEach(m => ensureNode(m.id, 'member', m.name));

  // ── 2. Historical seed edges ───────────────────────────────────────────────
  if (fs.existsSync(graphFile)) {
    const seed = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
    (seed.edges || []).forEach(e => {
      ensureNode(e.source, 'member', e.source);
      ensureNode(e.target, 'member', e.target);
      edges.push({ ...e, weight: 1 });
    });
  }

  // ── 3. Library-derived edges ───────────────────────────────────────────────
  if (fs.existsSync(libraryFile)) {
    const library = JSON.parse(fs.readFileSync(libraryFile, 'utf8'));
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

  if (fs.existsSync(sessionsDir)) {
    fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith('.json') && f !== '.gitkeep')
      .forEach(f => {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8'));
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

module.exports = { buildGraph };
