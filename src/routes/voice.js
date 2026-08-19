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

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function registerVoiceRoutes(app, { roster, voiceCacheDir, apiKey, modelId }) {
  const available = !!apiKey;

  app.get('/api/voice/config', (req, res) => {
    res.json({ available });
  });

  app.post('/api/voice/speak', async (req, res) => {
    if (!available) return res.status(503).json({ error: 'ElevenLabs is not configured on this server' });

    const { memberId, text } = req.body || {};
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text is required' });

    const member = roster.find(m => m.id === memberId);
    const voiceId = member?.voiceId;
    if (!voiceId) return res.status(404).json({ error: 'No ElevenLabs voice assigned for this member' });

    // Cache key covers voice + exact text: a replayed session speaks the
    // same line through the same member every time, so this is the common
    // case, not an edge case — worth the disk write.
    const cacheKey = crypto.createHash('sha256').update(`${voiceId}::${text}`).digest('hex');
    const cachePath = path.join(voiceCacheDir, `${cacheKey}.mp3`);

    try {
      if (!fs.existsSync(cachePath)) {
        const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
          },
          body: JSON.stringify({ text, model_id: modelId }),
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          console.error('[voice] ElevenLabs TTS request failed:', response.status, detail.slice(0, 300));
          return res.status(502).json({ error: 'TTS request failed' });
        }
        const buf = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(cachePath, buf);
      }
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      fs.createReadStream(cachePath).pipe(res);
    } catch (err) {
      console.error('[voice] synthesis error:', err.message);
      res.status(502).json({ error: 'TTS request failed' });
    }
  });
}

module.exports = { registerVoiceRoutes };
