'use strict';

// #514 route-extraction, sibling to routes/session.js's verify-citations —
// user-supplied grounding material (Zotero-style bibliography upload) and
// the guardrail-verification pass that checks a session's already-captured
// citations against it. See src/grounding.js's header for the design this
// implements (guardrail-by-default, session-scoped, ephemeral).
//
// No PDF/multipart handling here: the frontend extracts text via the
// existing POST /api/upload (routes/upload.js, already tested) first, then
// posts the resulting {filename, text} JSON here — one extraction path,
// reused, rather than a second multer/pdf2json wiring in this file too.

const { flattenBeatCitations } = require('../citations');
const {
  addGroundingSource,
  getGroundingSummary,
  hasGrounding,
  clearGrounding,
  verifyClaimsAgainstGrounding,
} = require('../grounding');

function registerGroundingRoutes(app, { client, model, loadSession, saveSession, roster }) {
  // POST /api/sessions/:id/grounding — add one source's already-extracted
  // text to this session's ephemeral corpus.
  app.post('/api/sessions/:id/grounding', (req, res) => {
    const session = loadSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const { filename, text } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'No text provided' });
    }
    const result = addGroundingSource(req.params.id, filename, text);
    if (!result.added) return res.status(422).json({ error: result.error });
    res.json({ truncated: result.truncated, summary: result.summary });
  });

  // GET /api/sessions/:id/grounding — this session's uploaded-source summary
  app.get('/api/sessions/:id/grounding', (req, res) => {
    const session = loadSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(getGroundingSummary(req.params.id));
  });

  // DELETE /api/sessions/:id/grounding — clear this session's uploaded
  // sources (an explicit user action; also happens implicitly when the
  // session itself is deleted, see routes/session.js).
  app.delete('/api/sessions/:id/grounding', (req, res) => {
    clearGrounding(req.params.id);
    res.json({ ok: true, summary: getGroundingSummary(req.params.id) });
  });

  // POST /api/sessions/:id/verify-grounding — check this session's
  // already-captured citations against the researcher's own uploaded
  // material. A fourth, on-demand tier alongside verify-citations' library
  // re-grounding and web escalation — additive to whatever those already
  // found, never overriding a prior verdict with a merely-adjacent
  // retrieval hit (see grounding.js's "not-addressed" handling).
  app.post('/api/sessions/:id/verify-grounding', async (req, res) => {
    const session = loadSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!hasGrounding(req.params.id)) {
      return res.status(400).json({ error: 'No sources uploaded for this session yet' });
    }
    session.generationMetrics = session.generationMetrics || [];

    try {
      const rawCitations = flattenBeatCitations(session, roster);
      const existing = session.citationFlags || [];
      const verified = await verifyClaimsAgainstGrounding({
        client,
        model,
        sessionId: req.params.id,
        citations: rawCitations,
        onMetric: m => session.generationMetrics.push(m),
      });
      const citations = rawCitations.map((c, index) => {
        const prior = existing[index];
        const grounded = verified.get(index);
        return {
          ...c,
          ...(prior
            ? {
                verdict: prior.verdict,
                note: prior.note,
                source: prior.source,
                libraryCitation: prior.libraryCitation,
                librarySourceUrl: prior.librarySourceUrl,
                libraryImage: prior.libraryImage,
                webSourceUrl: prior.webSourceUrl,
                webSourceTitle: prior.webSourceTitle,
              }
            : {}),
          ...(grounded
            ? {
                verdict: grounded.verdict,
                note: grounded.note,
                source: grounded.source,
                groundingSourceTitle: grounded.groundingSourceTitle,
              }
            : {}),
        };
      });

      session.citationFlags = citations;
      saveSession(session);
      res.json({ citations, groundingSummary: getGroundingSummary(req.params.id) });
    } catch (err) {
      console.error('Grounding verification error:', err);
      res.status(500).json({ error: 'Failed to verify against your sources' });
    }
  });
}

module.exports = { registerGroundingRoutes };
