'use strict';

// #193 route-extraction seam-map, module 1 of 7 — the archival library
// routes. Read-only, no session state: lowest risk, first proof for the
// `register<X>Routes(app, deps)` convention this pass uses (same shape as
// auth.js's registerAuthRoutes — see that module's comment for why deps are
// passed in explicitly rather than reached for as module-level singletons).
//
// Deps are the same thin wrapper functions server.js already defines around
// library.js (loadLibraryIndex, loadArchiveImageIndex) plus
// library.js's own parseLibraryFrontmatter directly, since that one takes no
// server.js-specific state.

const fs = require('fs');
const path = require('path');

function registerLibraryRoutes(app, { loadLibraryIndex, loadArchiveImageIndex, parseLibraryFrontmatter, libraryDir }) {
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
      const filePath = path.join(libraryDir, entry.file);
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
}

module.exports = { registerLibraryRoutes };
