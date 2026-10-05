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
// #354: the record's shared segment vocabulary — see record.js's own header.
const record = require('../../public/js/record.js');
// #355: flattenBeatCitations reads the always-on per-beat extraction back
// out of a session — see citations.js's own header for the rest of the
// module, which this route still uses for the deliberate grounding pass.
const { flattenBeatCitations } = require('../citations');
// #514: a deleted session's uploaded grounding material has nowhere left to
// live — see grounding.js's header for why it's never persisted to disk in
// the first place, so this is the one place it needs an explicit cleanup.
const { clearGrounding } = require('../grounding');
// #595: who may read or change a stored session — see sessions-store.js.
const { canRead, canWrite, filterReadable } = require('../sessions-store');

// #178: validates a requested publishedRounds selection down to the
// in-bounds integer indices it actually contains, deduped and sorted so
// reading-room.js's filter doesn't need to. null/non-array input (including
// the "clear the selection" case) maps to null, meaning "every passage" —
// the same as the field being absent altogether.
function normalizePublishedRounds(input, roundCount) {
  if (!Array.isArray(input)) return null;
  const kept = new Set();
  input.forEach(v => {
    const i = Number(v);
    if (Number.isInteger(i) && i >= 0 && i < roundCount) kept.add(i);
  });
  return Array.from(kept).sort((a, b) => a - b);
}

function registerSessionRoutes(
  app,
  {
    sessionsDir,
    loadSession,
    saveSession,
    roster,
    makeBranchId,
    buildTranscriptHeader,
    composeSegmentText,
    renderReadingRoomPage,
    loadLibraryCitationLookup,
    loadArchiveImageIndex,
    groundAgainstLibraryText,
    escalateCitationsToWeb,
    loadManifestSessions,
    buildCitationManifest,
    buildBibliography,
    renderBibliographyPage,
    users,
  }
) {
  // #595: load a session for a route that changes it (or spends money on it)
  // and answer 404 — not 403, matching #378's convention that a session you
  // can't touch doesn't reveal that it exists — unless the caller owns it.
  // Returns the session, or null after having already responded.
  function loadWritable(req, res) {
    const session = loadSession(req.params.id);
    if (!session || !canWrite(session, req.user)) {
      res.status(404).json({ error: 'Session not found' });
      return null;
    }
    return session;
  }

  // GET /api/sessions — list recent sessions, with optional ?q=, ?tag=, ?thread= filters
  app.get('/api/sessions', (req, res) => {
    const q = (req.query.q || '').trim().toLowerCase();
    const tag = (req.query.tag || '').trim().toLowerCase();
    const thread = (req.query.thread || '').trim().toLowerCase();
    try {
      let sessions = fs
        .readdirSync(sessionsDir)
        .filter(f => f.endsWith('.json'))
        .map(f => ({ file: f, mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 200)
        .map(({ file }) => {
          const d = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
          // #344: id/name kept aligned pairwise (both filtered together) so
          // the avatar-stack can look up a portrait by memberIds[i] for the
          // name at members[i] — a stale/removed roster id drops from both.
          const memberEntries = (d.members || [])
            .map(id => ({ id, name: roster.find(m => m.id === id)?.name }))
            .filter(e => e.name);
          return {
            id: d.id,
            date: d.date,
            entry: d.entry?.slice(0, 100),
            members: memberEntries.map(e => e.name),
            memberIds: memberEntries.map(e => e.id),
            rounds: d.rounds?.length || 0,
            tags: d.tags || [],
            threadId: d.threadId || null,
            threadName: d.threadName || null,
            parentId: d.parentId || null,
            branchRound: d.branchRound ?? null,
            published: !!d.published,
            _owned: canWrite(d, req.user),
            _entry: (d.entry || '').toLowerCase(),
            _transcript: (d.transcriptText || '').toLowerCase(),
          };
        });

      // #378: unauthenticated callers only ever see published sessions —
      // applied before thread/tag/q so none of those can surface an
      // unpublished session's data (entry excerpt, tags, transcript match).
      // Currently unreachable in practice (requireAuth already blocks an
      // unauthenticated /api/ request before it gets here whenever a
      // passphrase is set) — this is groundwork for #379, a no-op today.
      // #595 widens that: a signed-in user's shelf is their own sessions
      // only. (Others' published sessions stay reachable by link, via
      // /reading-room/:id and GET /api/sessions/:id, but aren't mixed into
      // someone's own history.) Open-mode local user owns everything.
      sessions = req.authed ? sessions.filter(s => s._owned) : sessions.filter(s => s.published);

      if (thread) {
        sessions = sessions.filter(s => (s.threadId || '').toLowerCase() === thread);
        // For thread view, sort chronologically oldest-first
        sessions = sessions.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      }
      if (tag) {
        sessions = sessions.filter(s => s.tags.map(t => t.toLowerCase()).includes(tag));
      }
      if (q) {
        sessions = sessions.filter(
          s =>
            s._entry.includes(q) ||
            s._transcript.includes(q) ||
            s.tags.some(t => t.toLowerCase().includes(q)) ||
            (s.threadName || '').toLowerCase().includes(q) ||
            (s.date || '').includes(q)
        );
      }

      res.json(sessions.slice(0, 40).map(({ _entry, _transcript, _owned, _readable, ...s }) => s));
    } catch (err) {
      res.status(500).json({ error: 'Failed to list sessions' });
    }
  });

  // GET /api/threads — list all named threads with session counts
  app.get('/api/threads', (req, res) => {
    try {
      const threads = {};
      fs.readdirSync(sessionsDir)
        .filter(f => f.endsWith('.json'))
        .forEach(file => {
          const d = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
          // #378: same published gate as GET /api/sessions — an unauthenticated
          // caller shouldn't learn a thread exists solely from unpublished
          // sessions. #595: and a signed-in one sees only their own threads.
          if (req.authed ? !canWrite(d, req.user) : !d.published) return;
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

  // GET /api/admin/citation-manifest — #153's manual-promotion check-in,
  // run against whatever sessionsDir this process was actually started with
  // (RAILWAY_VOLUME_MOUNT_PATH-based on a deployed instance with a volume
  // attached, same as every other route in this file). Sits behind the same
  // requireAuth gate as the rest of /api/* — no separate admin auth layer.
  // Returns the aggregate manifest only, never raw session/transcript data.
  app.get('/api/admin/citation-manifest', (req, res) => {
    try {
      const sessions = filterReadable(loadManifestSessions(sessionsDir), req.user);
      res.type('text/markdown').send(buildCitationManifest(sessions));
    } catch (err) {
      res.status(500).json({ error: 'Failed to build citation manifest' });
    }
  });

  // GET /api/admin/bibliography — #356's project-wide bibliography, the
  // appendix-form works-cited counterpart to the citation manifest above
  // (see src/bibliography.js for how the two differ). Same sessions,
  // same auth gate, same "aggregate document only" shape.
  app.get('/api/admin/bibliography', (req, res) => {
    try {
      const sessions = filterReadable(loadManifestSessions(sessionsDir), req.user);
      res.type('text/markdown').send(buildBibliography(sessions));
    } catch (err) {
      res.status(500).json({ error: 'Failed to build bibliography' });
    }
  });

  // GET /api/admin/sessions — #595's metadata-only admin view: every
  // session's owner, timestamps and error state, never its content.
  //
  // Decided 2026-09-21/30: an admin can see that a session exists and whose
  // it is, but not what was said unless the owner published it. So the
  // `entry` excerpt (the owner's own draft text) is included only for a
  // published session, and nothing here touches transcriptText, rounds,
  // notes or annotations. Gated by ADMIN_ROUTES' /api/admin/ prefix.
  //
  // Cost is deliberately absent: it isn't stored on the session today (only
  // the `[cost]` log lines from #594), and persisting a running total is its
  // own change. `errorCount` is the generation phases that degraded
  // (generationMetrics entries with `skipped`) — the same signal the server
  // logs as `[degraded]`.
  app.get('/api/admin/sessions', (req, res) => {
    try {
      const rows = fs
        .readdirSync(sessionsDir)
        .filter(f => f.endsWith('.json'))
        .map(file => {
          try {
            const p = path.join(sessionsDir, file);
            const d = JSON.parse(fs.readFileSync(p, 'utf8'));
            const owner = users?.findById(d.ownerId);
            return {
              id: d.id,
              ownerId: d.ownerId || null,
              ownerName: owner?.name || null,
              ownerEmail: owner?.email || null,
              date: d.date || null,
              updatedAt: new Date(fs.statSync(p).mtimeMs).toISOString(),
              rounds: d.rounds?.length || 0,
              members: d.members?.length || 0,
              published: !!d.published,
              publishedAt: d.publishedAt || null,
              errorCount: (d.generationMetrics || []).filter(m => m && m.skipped).length,
              ...(d.published ? { entry: d.entry?.slice(0, 100) } : {}),
            };
          } catch (err) {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      res.json({ sessions: rows });
    } catch (err) {
      res.status(500).json({ error: 'Failed to list sessions' });
    }
  });

  // GET /bibliography — #461: a browsable, styled counterpart to the raw
  // markdown dump above. Same data, same "aggregate document only" shape —
  // no session/transcript content beyond what a citation quote already
  // carries — but a page a collaborator or grant reviewer could actually be
  // handed a link to, rather than an API response. Not in server.js's
  // requireAuth bypass list (unlike /reading-room/*), so it stays gated the
  // same way /lodge is: visible in the mantel nav to everyone, but an
  // unauthenticated click lands on the passphrase gate — see #379's
  // route-inventory precedent for that pattern.
  app.get('/bibliography', (req, res) => {
    try {
      const sessions = filterReadable(loadManifestSessions(sessionsDir), req.user);
      res.send(renderBibliographyPage(sessions));
    } catch (err) {
      res.status(500).send('Failed to build bibliography.');
    }
  });

  // PATCH /api/sessions/:id/thread — set or clear thread on a session
  app.patch('/api/sessions/:id/thread', (req, res) => {
    const { threadId, threadName } = req.body;
    const session = loadWritable(req, res);
    if (!session) return;
    if (threadId && threadName) {
      session.threadId = threadId
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/(^-|-$)/g, '');
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
    const session = loadWritable(req, res);
    if (!session) return;
    session.annotations = annotations;
    saveSession(session);
    res.json({ count: annotations.length });
  });

  // POST /api/sessions/:id/verify-citations — ground & judge the citations
  // already captured on this session's beats.
  //
  // #355: extraction used to happen here, in one whole-transcript call —
  // this route now does no extraction of its own at all. Every AI speaker
  // turn already carries its own citations (if any), captured always-on at
  // write time by pipeline-disposition.js's piggyback on the per-beat
  // disposition call, with memberId already known from the beat rather than
  // string-matched out of formatted prose. What's left here is the
  // deliberate, heavier pass (#153): re-check library-matched citations
  // against the entry's actual excerpt text, and attempt a real web lookup
  // for whatever didn't match — both of which hit rate-limited resources
  // and so stay an explicit, re-runnable action rather than something that
  // happens on every beat.
  app.post('/api/sessions/:id/verify-citations', async (req, res) => {
    const session = loadWritable(req, res);
    if (!session) return;
    session.generationMetrics = session.generationMetrics || [];

    try {
      const libraryLookup = loadLibraryCitationLookup();
      const archiveImages = loadArchiveImageIndex();
      const rawCitations = flattenBeatCitations(session, roster);
      // #153 part 1 — re-check library-matched citations against the entry's
      // actual text, rather than trusting the extraction pass's title/source
      // match. Skipped (no extra call) when nothing matched this round.
      const grounded = await groundAgainstLibraryText(rawCitations, libraryLookup, m =>
        session.generationMetrics.push(m)
      );
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
          source: refined ? 'library' : web ? web.source : 'model-knowledge',
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
    const session = loadWritable(req, res);
    if (!session) return;
    session.tags = tags.map(t => t.trim()).filter(Boolean);
    saveSession(session);
    res.json({ tags: session.tags });
  });

  // DELETE /api/sessions/:id — remove a session
  app.delete('/api/sessions/:id', (req, res) => {
    const session = loadWritable(req, res);
    if (!session) return;
    const p = path.join(sessionsDir, `${req.params.id}.json`);
    try {
      fs.unlinkSync(p);
      clearGrounding(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete session' });
    }
  });

  // GET /api/sessions/:id — load full session
  app.get('/api/sessions/:id', (req, res) => {
    const session = loadSession(req.params.id);
    // #378: 404 (not 403) for an unpublished session to an unauthenticated
    // caller, matching /reading-room/:id's existing convention — an
    // unpublished session's existence isn't revealed either.
    if (!canRead(session, req.user)) return res.status(404).json({ error: 'Session not found' });
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
    const session = loadWritable(req, res);
    if (!session) return;
    // #354: interjections are segments now, so the last segment is no longer
    // necessarily a passage. "Let it end" is an answer to a lull, and only a
    // passage ends in one — marking an interjection `closed` would record the
    // user cutting off a turn they never chose to take.
    const closedAt = (session.rounds || []).findLastIndex(r => !record.isInterjectionSegment(r));
    if (closedAt < 0) return res.status(400).json({ error: 'Session has no passages to close' });
    session.rounds[closedAt].endedBy = 'closed';
    saveSession(session);
    res.json({ ok: true, closedAt });
  });

  // POST /api/sessions/:id/branch — fork a new session sharing history up to roundIndex
  // #33: lets the user explore an alternative path from any round boundary without
  // losing the original thread. No Claude call — a pure copy-and-truncate.
  app.post('/api/sessions/:id/branch', (req, res) => {
    const { roundIndex } = req.body;
    const parent = loadSession(req.params.id);
    // #595: anyone who can read a session (the owner, or anyone for a
    // published one) can branch their own copy of it; the branch belongs to
    // whoever made it, not to the parent's owner.
    if (!canRead(parent, req.user)) return res.status(404).json({ error: 'Session not found' });
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
    branchedRounds.forEach(r => {
      transcriptText += composeSegmentText(r);
    });

    const branch = {
      id,
      date,
      entry: parent.entry,
      members: [...parent.members],
      // #244: meetingNote is the current field; roundInstructions carries
      // forward untouched for a legacy parent that still only has that (see
      // lodgePrompts.deriveMeetingNote, which reads either). #363: roundCount
      // is deliberately *not* carried forward — #244 left it inert, nothing
      // has read it since, and a branch is a new session, not a preserved
      // record. Old sessions keep whatever they stored; nothing reads that
      // either.
      meetingNote: parent.meetingNote || null,
      roundInstructions: parent.roundInstructions || null,
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
      ownerId: req.user?.id || null,
    };
    saveSession(branch);
    res.json({ sessionId: id });
  });

  // GET /api/sessions/:id/transcript — return annotated transcript text for reconvening
  // Weaves stored annotations into the transcript text, same as the frontend export does.
  app.get('/api/sessions/:id/transcript', (req, res) => {
    const session = loadSession(req.params.id);
    // #378: same 404-not-403 gate as GET /api/sessions/:id.
    if (!canRead(session, req.user)) return res.status(404).json({ error: 'Session not found' });

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
            while (i + 1 < lines.length && lines[i + 1] !== '') {
              i++;
              result.push(lines[i]);
            }
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
      let roundIdx = -1,
        markedThisRound = false,
        i = 0;
      while (i < lines.length) {
        result.push(lines[i]);
        // Round dividers ("— First Movement —") also match the looser
        // speaker-header pattern below, so they must be checked first.
        const isDivider = /^— (.+) —$/.test(lines[i]);
        if (isDivider) {
          roundIdx++;
          markedThisRound = false;
        }
        const speakerMatch = !isDivider && lines[i].match(/^(.+) —$/);
        if (speakerMatch && !markedThisRound && byRound.has(roundIdx)) {
          markedThisRound = true;
          while (i + 1 < lines.length && lines[i + 1] !== '') {
            i++;
            result.push(lines[i]);
          }
          result.push('  ⟡ played by a human participant, live');
        }
        i++;
      }
      transcript = result.join('\n');
    }

    const memberNames = (session.members || []).map(id => roster.find(m => m.id === id)?.name).filter(Boolean);

    res.json({
      id: session.id,
      date: session.date,
      members: memberNames,
      entry: session.entry?.slice(0, 80),
      transcript,
    });
  });

  // PATCH /api/sessions/:id/publish — mark/unmark a session for the public
  // reading room, and (#178) optionally curate which passages it shows.
  //
  // publishedRounds is a list of session.rounds indices — the same ordinal
  // branching already keys off (roundIndex/segmentIndex elsewhere in this
  // file and in public/js/sessions.js). Omitting it from the request body
  // leaves any existing selection untouched; sending null clears it back to
  // "every passage", which is also the default for a session that's never
  // been curated — see reading-room.js's own filtering.
  app.patch('/api/sessions/:id/publish', (req, res) => {
    const session = loadWritable(req, res);
    if (!session) return;
    const wasPublished = session.published;
    session.published = !!req.body.published;
    if (session.published) {
      // Editing curation on an already-published session (the "Curate"
      // action) re-sends published:true; don't let that bump publishedAt.
      if (!wasPublished || !session.publishedAt) session.publishedAt = new Date().toISOString();
    } else {
      session.publishedAt = null;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'publishedRounds')) {
      session.publishedRounds = normalizePublishedRounds(req.body.publishedRounds, session.rounds?.length || 0);
    }
    saveSession(session);
    res.json({
      published: session.published,
      publishedAt: session.publishedAt,
      publishedRounds: session.publishedRounds ?? null,
      url: `/reading-room/${session.id}`,
    });
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
