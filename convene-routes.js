'use strict';

// #193 route-extraction seam-map, module 7 of 7 (done last) — session
// generation: convene, cast, round, interject, and the local-only prototype
// route. This is the highest-risk extraction in this pass — not auth this
// time (that was #193's first pass), but exactly what that pass's own
// scoping comment flagged as the reason route splitting was deferred at
// all: SSE streaming state (openSSE, chunked res.write mid-generation) and
// session create/mutate-in-flight. Sequenced last, after the lower-risk
// groups were proven, and verified live against a running server — a
// convene started, the stream confirmed to still deliver
// speaking/speakerDone/done events, and the session confirmed to persist —
// rather than trusting unit tests alone.

function openSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
}

function registerConveneRoutes(app, {
  client, model, lodgeContext, roster,
  loadMemberFile, loadVoiceExemplar, loadResidue,
  castingRoster,
  buildPassagePrompt, wordsSpentSoFar, defaultPoolSize, deriveMeetingNote,
  playerDirectorPool, resolvePlayerName, buildPrecedingTurn,
  interjectSpeakerCount,
  makeSessionId, saveSession, loadSession, saveResidueUpdates,
  formatTranscriptText, composeSegmentText, buildTranscriptHeader,
  isLocal, runRound, proposeCast,
}) {
  // POST /api/convene — start a session and stream its first passage
  app.post('/api/convene', async (req, res) => {
    const { entry, members } = req.body;
    if (!entry?.trim()) return res.status(400).json({ error: 'entry is required' });
    if (!members?.length) return res.status(400).json({ error: 'at least one member is required' });

    const { roundInstructions, meetingNote, roundCount, artifact, notes, sourceSessionId,
      playerMode, playerMemberId, playerName, playerTurn, castMetrics } = req.body;
    const isTranscriptSource = !!sourceSessionId;
    const id = makeSessionId(entry);
    const date = new Date().toISOString().slice(0, 10);
    // #194 touchpoint 2: roundInstructions (array) collapses to meetingNote
    // (single free-text field). deriveMeetingNote handles both since nothing
    // stops a caller from still sending the old shape.
    const effectiveMeetingNote = deriveMeetingNote({ meetingNote, roundInstructions });
    const passagePrompt = buildPassagePrompt({ entry, meetingNote: effectiveMeetingNote, isFirst: true, artifact: artifact || null, isTranscriptSource, wordsSpent: 0 });
    // #225 — the pre-convene casting call's usage rides in on the request body
    // (see /api/cast) rather than being held server-side; validate the shape
    // rather than trusting it wholesale since it's client-supplied.
    const generationMetrics = Array.isArray(castMetrics)
      ? castMetrics.filter(m => m && typeof m === 'object' && typeof m.phase === 'string')
      : [];

    const effectivePlayerMode = playerMode || 'none';
    const effectivePlayerMemberId = effectivePlayerMode === 'member' ? (playerMemberId || null) : null;
    const effectivePlayerName = resolvePlayerName(effectivePlayerMode, effectivePlayerMemberId, playerName);
    const precedingTurn = buildPrecedingTurn(effectivePlayerName, playerTurn);

    openSSE(res);
    try {
      const { fullRoundText: text, disposition, residueUpdates, beats, endedBy, lullNote } = await runRound({
        client, model, lodgeContext, ROSTER: roster, loadMemberFile, loadVoiceExemplar, loadResidue,
        presentMemberIds: playerDirectorPool(members, effectivePlayerMode, effectivePlayerMemberId),
        artifact: artifact || null, notes: notes || {},
        roundPrompt: passagePrompt, conversationHistory: [],
        speakerCount: defaultPoolSize, round: 0, precedingTurn,
        disposition: {},
        onChunk: chunk => res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`),
        onSpeakerStart: memberId => res.write(`data: ${JSON.stringify({ speaking: memberId })}\n\n`),
        onSpeakerEnd: (memberId, name, text) => res.write(`data: ${JSON.stringify({ speakerDone: { memberId, name, text } })}\n\n`),
        onMetric: m => {
          generationMetrics.push(m);
          if (m.skipped) console.warn('[degraded]', m.phase, m.memberId || '', '—', m.error);
        },
      });
      const history = [
        { role: 'user', content: passagePrompt },
        { role: 'assistant', content: text },
      ];
      // #244: label is the passage's own lull note (director-authored or stock
      // fallback) rather than a fixed "First Movement" — see #194 touchpoint 4.
      // #245: that note *ends* the passage rather than opening it, so the
      // transcript marker follows the text; composeSegmentText owns that
      // placement for every writer of transcriptText.
      const firstSegment = { label: lullNote, text, historyLength: history.length, beats, endedBy };
      const session = {
        id, date, entry, members,
        meetingNote: effectiveMeetingNote || null,
        roundCount: roundCount || 3,
        artifact: artifact || null,
        notes: notes || {},
        sourceSessionId: sourceSessionId || null,
        conversationHistory: history,
        rounds: [firstSegment],
        transcriptText: buildTranscriptHeader(entry, members, date) + composeSegmentText(firstSegment),
        generationMetrics,
        playerMode: effectivePlayerMode,
        playerMemberId: effectivePlayerMemberId,
        playerName: effectivePlayerMode === 'custom' ? effectivePlayerName : null,
        playerTurns: precedingTurn ? [{ round: 0, speakerName: precedingTurn.speakerName, text: precedingTurn.text }] : [],
        disposition: disposition || {},
      };
      saveSession(session);
      saveResidueUpdates(residueUpdates);
      res.write(`data: ${JSON.stringify({ done: true, sessionId: id, round: 1, label: lullNote, text })}\n\n`);
    } catch (err) {
      console.error('Convene error:', err);
      res.write(`data: ${JSON.stringify({ error: err.message || 'Failed to convene lodge' })}\n\n`);
    }
    res.end();
  });

  // POST /api/cast — propose tonight's cast from the document (#185)
  //
  // Pre-convene and deliberately outside the session lifecycle: nothing is
  // saved, nothing is started, and the answer is a suggestion the user accepts
  // or ignores. Not SSE — one short tool call, so a plain JSON response.
  app.post('/api/cast', async (req, res) => {
    const { entry, regulars } = req.body;
    if (!entry?.trim()) return res.status(400).json({ error: 'entry is required' });

    // No session exists yet to attach usage to (#225) — the casting call happens
    // before /api/convene creates one, if it ever does. Rather than holding
    // state server-side with nothing to key it on, the metrics ride along in
    // this response; the client hands them back on /api/convene (see
    // public/casting.js's consumeMetrics + app.js's castMetrics) so they land
    // in session.generationMetrics same as every other phase. A proposal the
    // user never accepts just never sends its metrics anywhere — no session
    // means no persisted metrics either way, which is the same "cost of a
    // proposal nobody used" the rest of the app already accepts.
    const metrics = [];
    try {
      const result = await proposeCast({
        client, model, lodgeContext,
        roster: castingRoster(),
        regularIds: Array.isArray(regulars) ? regulars : [],
        documentText: entry,
        onMetric: m => {
          metrics.push(m);
          if (m.skipped) console.warn('[degraded]', m.phase, '—', m.error);
        },
      });
      res.json({ ...result, metrics });
    } catch (err) {
      console.error('Casting error:', err);
      res.status(500).json({ error: err.message || 'Could not read the room' });
    }
  });

  // POST /api/round — the continue path (#194 touchpoint 5: "One More Turn"
  // renamed in-stream to "Continue"; this route's own behavior is unchanged —
  // generate the next passage into the session). The old client drives its
  // own loop with a preordained round count and calls this once per round; it
  // never sees a `lull` endedBy, since it decides when to stop on its own.
  app.post('/api/round', async (req, res) => {
    const { sessionId, playerTurn } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    const session = loadSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const roundIndex = session.rounds.length;
    const meetingNote = deriveMeetingNote(session);
    const wordsSpent = wordsSpentSoFar(session.rounds);
    const passagePrompt = buildPassagePrompt({ entry: session.entry, meetingNote, isFirst: false, wordsSpent });

    session.generationMetrics = session.generationMetrics || [];

    const effectivePlayerName = resolvePlayerName(session.playerMode, session.playerMemberId, session.playerName);
    const precedingTurn = buildPrecedingTurn(effectivePlayerName, playerTurn);

    openSSE(res);
    try {
      const { fullRoundText: text, disposition, residueUpdates, beats, endedBy, lullNote } = await runRound({
        client, model, lodgeContext, ROSTER: roster, loadMemberFile, loadVoiceExemplar, loadResidue,
        presentMemberIds: playerDirectorPool(session.members, session.playerMode, session.playerMemberId),
        artifact: null, notes: {},
        roundPrompt: passagePrompt, conversationHistory: session.conversationHistory.slice(-6),
        speakerCount: defaultPoolSize, round: roundIndex, precedingTurn,
        disposition: session.disposition || {},
        previousLullNote: session.rounds[session.rounds.length - 1]?.label || null,
        onChunk: chunk => res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`),
        onSpeakerStart: memberId => res.write(`data: ${JSON.stringify({ speaking: memberId })}\n\n`),
        onSpeakerEnd: (memberId, name, text) => res.write(`data: ${JSON.stringify({ speakerDone: { memberId, name, text } })}\n\n`),
        onMetric: m => {
          session.generationMetrics.push(m);
          if (m.skipped) console.warn('[degraded]', m.phase, m.memberId || '', '—', m.error);
        },
      });

      session.conversationHistory.push({ role: 'user', content: passagePrompt });
      session.conversationHistory.push({ role: 'assistant', content: text });
      const segment = { label: lullNote, text, historyLength: session.conversationHistory.length, beats, endedBy };
      session.rounds.push(segment);
      session.transcriptText += composeSegmentText(segment);
      session.disposition = disposition || {};
      if (precedingTurn) {
        session.playerTurns = session.playerTurns || [];
        session.playerTurns.push({ round: roundIndex, speakerName: precedingTurn.speakerName, text: precedingTurn.text });
      }

      saveSession(session);
      saveResidueUpdates(residueUpdates);
      res.write(`data: ${JSON.stringify({ done: true, round: roundIndex + 1, label: lullNote, text })}\n\n`);
    } catch (err) {
      console.error('Round error:', err);
      res.write(`data: ${JSON.stringify({ error: 'Failed to generate round' })}\n\n`);
    }
    res.end();
  });

  // POST /api/interject — user speaks; room streams a response
  app.post('/api/interject', async (req, res) => {
    const { sessionId, text } = req.body;
    if (!sessionId || !text?.trim()) return res.status(400).json({ error: 'sessionId and text required' });

    const session = loadSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const prompt = `A mysterious presence — an observer from outside time — has just spoken: "${text}"\n\nThe room reacts to what was said.`;
    session.generationMetrics = session.generationMetrics || [];

    openSSE(res);
    try {
      const { fullRoundText: response, disposition, residueUpdates } = await runRound({
        client, model, lodgeContext, ROSTER: roster, loadMemberFile, loadVoiceExemplar, loadResidue,
        presentMemberIds: playerDirectorPool(session.members, session.playerMode, session.playerMemberId),
        artifact: null, notes: {},
        roundPrompt: prompt, conversationHistory: session.conversationHistory.slice(-6),
        speakerCount: Math.min(interjectSpeakerCount, session.members.length), round: session.rounds.length,
        disposition: session.disposition || {},
        onChunk: chunk => res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`),
        onSpeakerStart: memberId => res.write(`data: ${JSON.stringify({ speaking: memberId })}\n\n`),
        onSpeakerEnd: (memberId, name, text) => res.write(`data: ${JSON.stringify({ speakerDone: { memberId, name, text } })}\n\n`),
        onMetric: m => {
          session.generationMetrics.push(m);
          if (m.skipped) console.warn('[degraded]', m.phase, m.memberId || '', '—', m.error);
        },
      });

      session.conversationHistory.push({ role: 'user', content: prompt });
      session.conversationHistory.push({ role: 'assistant', content: response });
      session.transcriptText += `\n— A Presence Passes Through —\n\n— a voice from elsewhere —\n${text}\n\n${formatTranscriptText(response)}\n`;
      session.disposition = disposition || {};

      saveSession(session);
      saveResidueUpdates(residueUpdates);
      res.write(`data: ${JSON.stringify({ done: true, label: 'A Presence Passes Through', text: response })}\n\n`);
    } catch (err) {
      console.error('Interject error:', err);
      res.write(`data: ${JSON.stringify({ error: 'Failed to interject' })}\n\n`);
    }
    res.end();
  });

  // POST /api/prototype/round — Stage 3 of #51: local-only test route for the
  // new director + per-speaker pipeline. Never touches session storage (no
  // saveSession call) — purely for validating the pipeline end-to-end before
  // any live route is cut over to it.
  app.post('/api/prototype/round', async (req, res) => {
    if (!isLocal) return res.status(404).json({ error: 'Not available in deployed mode' });

    const { entry, members, speakerCount } = req.body;
    if (!entry?.trim()) return res.status(400).json({ error: 'entry is required' });
    if (!members?.length) return res.status(400).json({ error: 'at least one member is required' });

    const roundPrompt = buildPassagePrompt({ entry, isFirst: true, isTranscriptSource: false });
    const metrics = [];

    openSSE(res);
    try {
      const { fullRoundText, speakerOrder } = await runRound({
        client, model, lodgeContext, ROSTER: roster, loadMemberFile, loadVoiceExemplar,
        presentMemberIds: members, artifact: null, notes: {},
        roundPrompt, conversationHistory: [],
        speakerCount: speakerCount || Math.min(members.length, 5),
        round: 0,
        onChunk: chunk => res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`),
        onMetric: m => metrics.push(m),
      });
      res.write(`data: ${JSON.stringify({ done: true, fullRoundText, speakerOrder, metrics })}\n\n`);
    } catch (err) {
      console.error('[prototype] round error:', err);
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }
    res.end();
  });
}

module.exports = { registerConveneRoutes };
