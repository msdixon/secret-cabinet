'use strict';

// #193 route-extraction seam-map, module 2 of 7 — the knowledge graph route.
// One route, self-contained given the paths graph.buildGraph already takes
// as explicit parameters.

function registerGraphRoutes(app, { graph, roster, graphFile, libraryFile, sessionsDir }) {
  // GET /api/graph — return full knowledge graph
  app.get('/api/graph', (req, res) => {
    try {
      res.json(graph.buildGraph(roster, graphFile, libraryFile, sessionsDir));
    } catch (err) {
      console.error('Graph error:', err);
      res.status(500).json({ error: 'Failed to build graph' });
    }
  });
}

module.exports = { registerGraphRoutes };
