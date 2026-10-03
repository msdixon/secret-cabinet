'use strict';

// #193 route-extraction seam-map, module 2 of 7 — the knowledge graph route.
// One route, self-contained given the paths graph.buildGraph already takes
// as explicit parameters.

const { canRead } = require('../sessions-store');

function registerGraphRoutes(app, { graph, roster, graphFile, libraryFile, sessionsDir }) {
  // GET /api/graph — return full knowledge graph
  app.get('/api/graph', (req, res) => {
    try {
      res.json(
        graph.buildGraph(roster, graphFile, libraryFile, sessionsDir, {
          // #595: the graph includes entry text, so it only draws on sessions
          // this caller could open.
          canSee: s => canRead(s, req.user),
        })
      );
    } catch (err) {
      console.error('Graph error:', err);
      res.status(500).json({ error: 'Failed to build graph' });
    }
  });
}

module.exports = { registerGraphRoutes };
