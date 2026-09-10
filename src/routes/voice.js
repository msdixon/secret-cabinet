'use strict';

// #29 (ElevenLabs pass) — server-side TTS proxy. voice.js (public/js) can't
// hold an ElevenLabs API key itself (it's client-side, script-tag-loaded, no
// build step to keep secrets out of what ships to the browser), so this
// route is the one place that key is ever read: it takes a member + already-
// stripped speech text, resolves the member's roster.json voiceId, and
// proxies the ElevenLabs TTS call, caching the resulting audio on disk so a
// replayed session's exact same line is never re-synthesized (and never
// re-billed) on a later viewing.
//
// GET /api/voice/config tells the client whether any of this is available at
// all — the browser has no other way to know an API key exists server-side,
// and voice.js needs that up front to decide whether to attempt the
// ElevenLabs path or fall back straight to the Web Speech API.
//
// #380: POST /api/voice/speak is public (src/auth.js's PUBLIC_API_ROUTES),
// but only ever serves a cache hit to an unauthenticated request — req.authed
// (set by createRequireAuth for every request, gated or not) is checked
// below, after the cache lookup, so an authenticated request always keeps
// today's behaviour and a cache hit is served to anyone regardless of
// req.authed. A cache miss for an unauthenticated request never reaches the
// ElevenLabs fetch; it gets the same 503 shape as "not configured", which
// public/js/voice.js already falls through to the Web Speech API on.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// #478: with no voice_settings.speed at all, ElevenLabs falls back to
// whatever its bare per-voice default happens to be, which read as
// uniformly too slow across every member. Live A/B testing against the
// real API (same voice/model/text, repeated trials to average out
// ElevenLabs' own generation-to-generation timing variance) showed 1.1
// consistently producing ~6-7% shorter audio than 1.0 with no audible
// artifacts -- comfortably inside the API's documented [0.7, 1.2] range,
// short of the top edge where docs warn quality degrades.
const DEFAULT_VOICE_SPEED = 1.1;

// A live ElevenLabs call failing (quota exhausted, bad key, an outage) used
// to be invisible: every beat just fell back to the Web Speech API with
// nothing logged anywhere a listener would see, so the only way to notice
// was hearing the wrong voice mid-session (see the quota-exhaustion incident
// this was added for, 2026-09-09). Tracked here as module-level state per
// server process -- there's one ElevenLabs account behind this whole
// service, so "is it currently working" is a global fact, not a per-request
// one. Only counts *live* calls (the `if (!cached)` branch below); a cache
// hit says nothing about whether the API would work right now if asked, so
// it neither sets nor clears this.
let consecutiveFailures = 0;
let lastFailureReason = null;
// A single failed request could be a one-off network blip; two in a row is
// enough to stop assuming that and start telling the client something is
// actually wrong.
const DEGRADED_THRESHOLD = 2;

function extractFailureReason(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    return parsed?.detail?.code || parsed?.detail?.status || null;
  } catch (_) {
    return null;
  }
}

function registerVoiceRoutes(app, { roster, voiceCacheDir, apiKey, modelId }) {
  const available = !!apiKey;

  app.get('/api/voice/config', (req, res) => {
    if (!available) return res.json({ available: false });
    const degraded = consecutiveFailures >= DEGRADED_THRESHOLD;
    res.json(degraded ? { available: true, degraded: true, reason: lastFailureReason } : { available: true, degraded: false });
  });

  app.post('/api/voice/speak', async (req, res) => {
    if (!available) return res.status(503).json({ error: 'ElevenLabs is not configured on this server' });

    const { memberId, text } = req.body || {};
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text is required' });

    const member = roster.find(m => m.id === memberId);
    const voiceId = member?.voiceId;
    if (!voiceId) return res.status(404).json({ error: 'No ElevenLabs voice assigned for this member' });

    // Cache key covers voice + exact text + speed: a replayed session speaks
    // the same line through the same member every time, so this is the
    // common case, not an edge case — worth the disk write. Speed is folded
    // in (#478) so a pace change actually reaches disk-cached lines instead
    // of silently continuing to serve pre-existing slow audio forever.
    const cacheKey = crypto.createHash('sha256').update(`${voiceId}::${DEFAULT_VOICE_SPEED}::${text}`).digest('hex');
    const cachePath = path.join(voiceCacheDir, `${cacheKey}.mp3`);
    const cached = fs.existsSync(cachePath);

    // #380: an unauthenticated visitor can only ever be served a clip that's
    // already on disk — never one that requires a billable ElevenLabs call.
    if (!cached && !req.authed) {
      return res.status(503).json({ error: 'ElevenLabs is not configured on this server' });
    }

    try {
      if (!cached) {
        const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
          },
          body: JSON.stringify({
            text,
            model_id: modelId,
            voice_settings: { speed: DEFAULT_VOICE_SPEED },
          }),
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          console.error('[voice] ElevenLabs TTS request failed:', response.status, detail.slice(0, 300));
          consecutiveFailures++;
          lastFailureReason = extractFailureReason(detail) || `http_${response.status}`;
          return res.status(502).json({ error: 'TTS request failed' });
        }
        const buf = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(cachePath, buf);
        consecutiveFailures = 0;
        lastFailureReason = null;
      }
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      fs.createReadStream(cachePath).pipe(res);
    } catch (err) {
      console.error('[voice] synthesis error:', err.message);
      consecutiveFailures++;
      lastFailureReason = 'synthesis_error';
      res.status(502).json({ error: 'TTS request failed' });
    }
  });
}

module.exports = { registerVoiceRoutes };
