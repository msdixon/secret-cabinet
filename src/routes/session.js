'use strict';

// #193 route-extraction seam-map, module 6 of 7 — everything that operates
// on a stored session by id: list/search, threads, thread/annotations/tags/
// publish PATCH routes, delete, load, branch, annotated transcript, the
// public reading-room render, and citation verification (grouped here
// rather than a separate file — it's a session-scoped route reusing the
// same loadSession/saveSession pair as the rest, even though the citation
// logic itself already lives in citations.js). No SSE/streaming state —
// that's routes/convene.js's territory, extracted last for exactly that
// reason.

const fs = require('fs');
const path = require('path');

function registerSessionRoutes(app, {
  sessionsDir, loadSession, saveSession, roster,
  makeBranchId, buildTranscriptHeader, composeSegmentText, renderReadingRoomPage,
  client, model, makeMetric,
  loadLibraryCitationLookup, loadArchiveImageIndex,
  groundAgainstLibraryText, escalateCitationsToWeb,
}) {
  // GET /api/sessions — list recent sessions, with optional ?q=, ?tag=, ?thread= filters
  app.get('/api/sessions', (req, res) => {
    const q = (req.query.q || '').trim().toLowerCase();
    const tag = (req.query.tag || '').trim().toLowerCase();
    const thread = (req.query.thread || '').trim().toLowerCase();
    try {
      let sessions = fs.readdirSync(sessionsDir)
        .filter(f => f.endsWith('.json'))
        .map(f => ({ file: f, mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 200)
        .map(({ file }) => {
          const d = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
          const memberNames = (d.members || [])
            .map(id => roster.find(m => m.id === id)?.name)
            .filter(Boolean);
          return {
            id: d.id,
            date: d.date,
            entry: d.entry?.slice(0, 100),
            members: memberNames,
            rounds: d.rounds?.length || 0,
            tags: d.tags || [],
            threadId: d.threadId || null,
            threadName: d.threadName || null,
            parentId: d.parentId || null,
            branchRound: d.branchRound ?? null,
            published: !!d.published,
            _entry: (d.entry || '').toLowerCase(),
            _transcript: (d.transcriptText || '').toLowerCase(),
          };
        });

      if (thread) {
        sessions = sessions.filter(s => (s.threadId || '').toLowerCase() === thread);
        // For thread view, sort chronologically oldest-first
        sessions = sessions.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      }
      if (tag) {
        sessions = sessions.filter(s => s.tags.map(t => t.toLowerCase()).includes(tag));
      }
      if (q) {
        sessions = sessions.filter(s =>
          s._entry.includes(q) || s._transcript.includes(q) ||
          s.tags.some(t => t.toLowerCase().includes(q)) ||
          (s.threadName || '').toLowerCase().includes(q) ||
          (s.date || '').includes(q)
        );
      }

      res.json(sessions.slice(0, 40).map(({ _entry, _transcript, ...s }) => s));
    } catch (err) {
      res.status(500).json({ error: 'Failed to list sessions' });
    }
  });

  // GET /api/threads — list all named threads with session counts
  app.get('/api/threads', (req, res) => {
    try {
      const threads = {};
      fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json')).forEach(file => {
        const d = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
        if (d.threadId && d.threadName) {
          if (!threads[d.threadId]) threads[d.threadId] = { id: d.threadId, name: d.threadName, count: 0 };
          threads[d.threadId].count++;
        }
      });
      res.json(Object.values(threads).sort((a, b) => a.name.localeCompare(b.name)));
    } catch (err) {
      res.status(500).json({ error: 'Failed to list threads' });
    }
  });

  // PATCH /api/sessions/:id/thread — set or clear thread on a session
  app.patch('/api/sessions/:id/thread', (req, res) => {
    const { threadId, threadName } = req.body;
    const session = loadSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (threadId && threadName) {
      session.threadId = threadId.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/(^-|-$)/g, '');
      session.threadName = threadName.trim();
    } else {
      delete session.threadId;
      delete session.threadName;
    }
    saveSession(session);
    res.json({ threadId: session.threadId || null, threadName: session.threadName || null });
  });

  // PATCH /api/sessions/:id/annotations — save annotations array
  app.patch('/api/sessions/:id/annotations', (req, res) => {
    const { annotations } = req.body;
    if (!Array.isArray(annotations)) return res.status(400).json({ error: 'annotations must be an array' });
    const session = loadSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    session.annotations = annotations;
    saveSession(session);
    res.json({ count: annotations.length });
  });

  // POST /api/sessions/:id/verify-citations — extract & judge citations across the whole session
  app.post('/api/sessions/:id/verify-citations', async (req, res) => {
    const session = loadSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    session.generationMetrics = session.generationMetrics || [];

    try {
      const fullText = session.transcriptText || '';
      const dividerIndex = fullText.indexOf('\n— ');
      const roundsText = dividerIndex >= 0 ? fullText.slice(dividerIndex + 1) : fullText;

      const libraryLookup = loadLibraryCitationLookup();
      const libraryList = Object.entries(libraryLookup)
        .map(([id, e]) => `${id}: ${e.title} — ${e.source}`).join('\n');

      const system = `You are reviewing a transcript from a salon conversation among historical figures for citation accuracy. Members cite real texts, authors, and historical claims in free-form prose.

Extract every citation of a real (or purportedly real) text, author, or historical/scholarly claim from the transcript below. For each one, judge from your own knowledge whether it refers to a real work/claim and whether it's represented accurately:
- "verified": you're confident this is a real work/claim, accurately represented
- "unverified": this appears to be invented, or is represented inaccurately
- "uncertain": you can't confidently judge either way

Also check this list of archival library entries; if a citation clearly refers to one of them, set libraryMatch to that entry's id, else null:
${libraryList}

The "quote" field must be a verbatim excerpt (~10-25 words) copied exactly from the transcript text below, so it can be located in the original.`;

      const extractStart = Date.now();
      const response = await client.messages.create({
        model,
        max_tokens: 4000,
        system,
        messages: [{ role: 'user', content: roundsText }],
        tools: [{
          name: 'report_citations',
          description: 'Report every citation found in the transcript, with a verdict for each.',
          input_schema: {
            type: 'object',
            properties: {
              citations: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    speaker: { type: 'string', description: 'As written in the transcript\'s "Name —" line.' },
                    quote: { type: 'string', description: 'Verbatim ~10-25 word excerpt from the transcript containing the citation.' },
                    work: { type: 'string', description: 'The cited work, author, or claim as named.' },
                    verdict: { type: 'string', enum: ['verified', 'unverified', 'uncertain'] },
                    note: { type: 'string', description: 'One-sentence reasoning for the verdict.' },
                    libraryMatch: { type: ['string', 'null'], description: 'Matching library entry id, or null.' },
                  },
                  required: ['speaker', 'quote', 'work', 'verdict', 'note'],
                },
              },
            },
            required: ['citations'],
          },
        }],
        tool_choice: { type: 'tool', name: 'report_citations' },
      });
      session.generationMetrics.push(makeMetric('citation-extraction', { usage: response.usage, latencyMs: Date.now() - extractStart }));

      const archiveImages = loadArchiveImageIndex();
      const block = response.content.find(b => b.type === 'tool_use');
      const rawCitations = block?.input?.citations || [];
      // #153 part 1 — re-check library-matched citations against the entry's
      // actual text, rather than trusting the extraction pass's title/source
      // match. Skipped (no extra call) when nothing matched this round.
      const grounded = await groundAgainstLibraryText(rawCitations, libraryLookup, m => session.generationMetrics.push(m));
      // #153 part 2 — for citations that didn't match a library entry, attempt
      // a real web lookup (capped, see MAX_WEB_ESCALATIONS) before trusting the
      // model's own memory-based verdict.
      const webEscalated = await escalateCitationsToWeb(rawCitations);
      const citations = rawCitations.map((c, index) => {
        const match = c.libraryMatch ? libraryLookup[c.libraryMatch] : null;
        const image = c.libraryMatch ? archiveImages[c.libraryMatch] : null;
        const refined = grounded.get(index);
        const web = webEscalated.get(index);
        return {
          ...c,
          ...(refined ? { verdict: refined.verdict, note: refined.note } : {}),
          ...(web ? { verdict: web.verdict, note: web.note } : {}),
          // #153 part 3 — reflects what was actually checked, not what merely
          // matched: a libraryMatch that didn't make it through grounding (e.g.
          // the entry was missing text) stays "model-knowledge", same failure
          // mode #157 found in treating "has a link" as "was verified".
          source: refined ? 'library' : (web ? web.source : 'model-knowledge'),
          libraryCitation: match?.citation || null,
          librarySourceUrl: match?.source_url || null,
          libraryImage: image?.image || null,
          webSourceUrl: web?.webSourceUrl || null,
          webSourceTitle: web?.webSourceTitle || null,
        };
      });

      session.citationFlags = citations;
      saveSession(session);
      res.json({ citations });
    } catch (err) {
      console.error('Citation verification error:', err);
      res.status(500).json({ error: 'Failed to verify citations' });
    }
  });

  // PATCH /api/sessions/:id/tags — replace tags array on a session
  app.patch('/api/sessions/:id/tags', (req, res) => {
    const { tags } = req.body;
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be an array' });
    const session = loadSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    session.tags = tags.map(t => t.trim()).filter(Boolean);
    saveSession(session);
    res.json({ tags: session.tags });
  });

  // DELETE /api/sessions/:id — remove a session
  app.delete('/api/sessions/:id', (req, res) => {
    const p = path.join(sessionsDir, `${req.params.id}.json`);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'Session not found' });
    try {
      fs.unlinkSync(p);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete session' });
    }
  });

  // GET /api/sessions/:id — load full session
  app.get('/api/sessions/:id', (req, res) => {
    const session = loadSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  });

  // POST /api/sessions/:id/close — the user chose "Let it end" at a lull (#245)
  //
  // #244 defined `closed` as the third end-cause but left it unreachable, since
  // nothing server-side decides it: budget and lull are the room's own reasons
  // to pause, `closed` is the user's. This records it on the segment the meeting
  // actually stopped after, which is what makes #164's pacing review able to
  // tell "the room wound down and the user agreed" from "the user cut it off" —
  // the two look identical without it.
  app.post('/api/sessions/:id/close', (req, res) => {
    const session = loadSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const last = session.rounds?.[session.rounds.length - 1];
    if (!last) return res.status(400).json({ error: 'Session has no passages to close' });
    last.endedBy = 'closed';
    saveSession(session);
    res.json({ ok: true, closedAt: session.rounds.length - 1 });
  });

  // POST /api/sessions/:id/branch — fork a new session sharing history up to roundIndex
  // #33: lets the user explore an alternative path from any round boundary without
  // losing the original thread. No Claude call — a pure copy-and-truncate.
  app.post('/api/sessions/:id/branch', (req, res) => {
    const { roundIndex } = req.body;
    const parent = loadSession(req.params.id);
    if (!parent) return res.status(404).json({ error: 'Session not found' });
    if (!Number.isInteger(roundIndex) || roundIndex < 0 || roundIndex >= (parent.rounds?.length || 0)) {
      return res.status(400).json({ error: 'roundIndex out of range' });
    }

    // Legacy sessions predate the historyLength field — best-guess assuming no
    // interjections happened before the branch point (2 history entries/round).
    const historyLength = parent.rounds[roundIndex].historyLength ?? (roundIndex + 1) * 2;
    const branchedRounds = parent.rounds.slice(0, roundIndex + 1).map(r => ({ ...r }));
    const branchedHistory = parent.conversationHistory.slice(0, historyLength).map(h => ({ ...h }));

    const date = new Date().toISOString().slice(0, 10);
    const id = makeBranchId(parent, roundIndex);

    let transcriptText = buildTranscriptHeader(parent.entry, parent.members, date);
    branchedRounds.forEach(r => { transcriptText += composeSegmentText(r); });

    const branch = {
      id, date,
      entry: parent.entry,
      members: [...parent.members],
      // #244: meetingNote is the current field; roundInstructions carries
      // forward untouched for a legacy parent that still only has that (see
      // lodgePrompts.deriveMeetingNote, which reads either).
      meetingNote: parent.meetingNote || null,
      roundInstructions: parent.roundInstructions || null,
      roundCount: parent.roundCount || 3,
      artifact: parent.artifact || null,
      notes: parent.notes || {},
      disposition: parent.disposition || {},
      sourceSessionId: parent.sourceSessionId || null,
      conversationHistory: branchedHistory,
      rounds: branchedRounds,
      transcriptText,
      generationMetrics: [],
      playerMode: parent.playerMode || 'none',
      playerMemberId: parent.playerMemberId || null,
      playerName: parent.playerName || null,
      playerTurns: (parent.playerTurns || []).filter(pt => pt.round <= roundIndex).map(pt => ({ ...pt })),
      parentId: parent.id,
      branchRound: roundIndex,
    };
    saveSession(branch);
    res.json({ sessionId: id });
  });

  // GET /api/sessions/:id/transcript — return annotated transcript text for reconvening
  // Weaves stored annotations into the transcript text, same as the frontend export does.
  app.get('/api/sessions/:id/transcript', (req, res) => {
    const session = loadSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    let transcript = session.transcriptText || '';

    // Weave in stored annotations if present
    const annotations = session.annotations || {};
    if (Object.keys(annotations).length) {
      const lines = transcript.split('\n');
      const result = [];
      let i = 0;
      while (i < lines.length) {
        result.push(lines[i]);
        const match = lines[i].match(/^(.+) —$/);
        if (match) {
          const speaker = match[1];
          // Find annotation by speaker name match
          const note = Object.values(annotations).find(a => a.speaker === speaker)?.note;
          if (note) {
            while (i + 1 < lines.length && lines[i + 1] !== '') { i++; result.push(lines[i]); }
            result.push(`  ↳ ${note}`);
          }
        }
        i++;
      }
      transcript = result.join('\n');
    }

    // Weave in a player-turn marker if present, keyed by round position (not
    // fuzzy speaker/quote matching — the round index is precisely known).
    const playerTurns = session.playerTurns || [];
    if (playerTurns.length) {
      const byRound = new Map(playerTurns.map(pt => [pt.round, pt]));
      const lines = transcript.split('\n');
      const result = [];
      let roundIdx = -1, markedThisRound = false, i = 0;
      while (i < lines.length) {
        result.push(lines[i]);
        // Round dividers ("— First Movement —") also match the looser
        // speaker-header pattern below, so they must be checked first.
        const isDivider = /^— (.+) —$/.test(lines[i]);
        if (isDivider) { roundIdx++; markedThisRound = false; }
        const speakerMatch = !isDivider && lines[i].match(/^(.+) —$/);
        if (speakerMatch && !markedThisRound && byRound.has(roundIdx)) {
          markedThisRound = true;
          while (i + 1 < lines.length && lines[i + 1] !== '') { i++; result.push(lines[i]); }
          result.push('  ⟡ played by a human participant, live');
        }
        i++;
      }
      transcript = result.join('\n');
    }

    const memberNames = (session.members || [])
      .map(id => roster.find(m => m.id === id)?.name)
      .filter(Boolean);

    res.json({
      id: session.id,
      date: session.date,
      members: memberNames,
      entry: session.entry?.slice(0, 80),
      transcript,
    });
  });

  // PATCH /api/sessions/:id/publish — mark/unmark a session for the public reading room
  app.patch('/api/sessions/:id/publish', (req, res) => {
    const session = loadSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    session.published = !!req.body.published;
    session.publishedAt = session.published ? new Date().toISOString() : null;
    saveSession(session);
    res.json({ published: session.published, publishedAt: session.publishedAt, url: `/reading-room/${session.id}` });
  });

  // GET /reading-room/:id — public, unauthenticated. 404s (rather than
  // distinguishing "not found" from "not published") so an unpublished
  // session's existence isn't revealed to an unauthenticated caller.
  app.get('/reading-room/:id', (req, res) => {
    const session = loadSession(req.params.id);
    if (!session || !session.published) return res.status(404).send('Not found.');
    res.send(renderReadingRoomPage(session));
  });
}

module.exports = { registerSessionRoutes };
