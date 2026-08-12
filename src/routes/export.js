'use strict';

// #193 route-extraction seam-map, module 5 of 7 — export routes: Day One
// (via dayone.js), Ulysses (local-only URL scheme), and Obsidian (local-only
// file write). No session mutation — each is a one-shot side effect against
// an external target, keyed on data the client already sends.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

function registerExportRoutes(app, { dayOne, isLocal, buildSpeakerHeaderSet, normalizeSpeaker, roster }) {
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
    if (!isLocal) return res.status(404).json({ error: 'Not available in deployed mode' });
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
    if (!isLocal) return res.status(404).json({ error: 'Not available in deployed mode' });
    const { vaultPath, transcriptText, sessionDate, members, tags, sourceExcerpt, sessionId } = req.body;
    if (!vaultPath?.trim()) return res.status(400).json({ error: 'vaultPath required' });
    if (!transcriptText) return res.status(400).json({ error: 'transcriptText required' });

    const resolvedVault = vaultPath.trim().replace(/^~/, os.homedir());
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
      const obsidianHeaders = buildSpeakerHeaderSet(roster);
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
}

module.exports = { registerExportRoutes };
