'use strict';

// #29 -- browser/server TTS for Witness playback (replay + live mirroring).
// First pass (PR #319) was Web Speech API only: a deterministic hash of
// memberId into whatever voices the browser actually has, plus a small
// per-member pitch/rate offset, since SpeechSynthesis's voice list is
// OS/browser-dependent and there was no backend that could honor a
// hand-authored profile anyway. This pass adds that backend -- an
// ElevenLabs proxy (routes/voice.js) with a per-member voiceId hashed into
// roster.json the same deterministic way, now server-authored so it's the
// same voice for every listener instead of whatever their browser happens
// to ship. ElevenLabs is entirely optional: GET /api/voice/config reports
// whether the server has a key configured, and every call site here falls
// straight back to the untouched Web Speech path when it doesn't (no key
// set) or when a request fails (network hiccup, bad voice id, quota) --
// this module never assumes ElevenLabs is there. Still-named follow-up:
// speech actually synced to the beat-by-beat reveal rather than fired once
// per rendered beat and left to run its own course.
//
// Same script-tag/IIFE + configure-free convention as witness.js's siblings
// (#142) -- window.Voice, one global. Unlike witness.js this module needs no
// deps from app.js: everything it touches (memberId strings, the browser's
// own speechSynthesis/fetch/Audio) is either passed in as an argument or
// read directly off the platform. witness.js is its only caller, from the
// single seam that already covers every rendering path -- see
// renderWitnessBlock's speech branch. witness.js's call signature
// (speak(text, memberId, speedMultiplier)) is unchanged by this pass --
// which backend actually spoke is an internal decision, not something the
// caller needs to know.
window.Voice = (function () {
  const ENABLED_KEY = 'sc-witness-voice-enabled';
  const MIN_RATE = 0.5;
  const MAX_RATE = 3; // SpeechSynthesis itself allows ~[0.1, 10]; keep it intelligible

  // ── ElevenLabs availability ─────────────────────────────────────────────
  // Whether the server has an API key configured -- the browser has no other
  // way to know. Checked once at load; a test environment with no `fetch`
  // (jsdom here has none) simply never flips this, which is what keeps every
  // pre-existing Web Speech test exercising the exact path it always has.
  // Deliberately doesn't retry or poll: a config change means a server
  // restart, at which point a page reload picks it up same as any other
  // server-side setting.
  let elevenLabsAvailable = false;
  if (typeof fetch === 'function') {
    fetch('/api/voice/config')
      .then(r => (r.ok ? r.json() : null))
      .then(cfg => {
        if (cfg) elevenLabsAvailable = !!cfg.available;
      })
      .catch(() => {}); // no server, offline, etc. -- stay on the Web Speech fallback
  }

  // The one ElevenLabs <audio> currently playing, if any -- tracked so a new
  // speak() call (next beat) or stop() can interrupt it, the same
  // cut-to-the-newest-beat behavior speak()'s synth().cancel() already gives
  // the Web Speech path (see its own comment below for why: witness.js paces
  // by reading time already, not by waiting for audio to finish).
  let currentAudio = null;

  function stopCurrentAudio() {
    if (!currentAudio) return;
    currentAudio.pause();
    currentAudio.src = '';
    currentAudio = null;
  }

  function synth() {
    return typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  }

  function isSupported() {
    return typeof SpeechSynthesisUtterance !== 'undefined' && !!synth();
  }

  function loadEnabled() {
    if (!isSupported()) return false;
    try {
      return localStorage.getItem(ENABLED_KEY) === '1';
    } catch (_) {
      return false;
    }
  }

  let enabled = loadEnabled();

  function updateButton() {
    const btn = document.getElementById('witness-voice-btn');
    if (!btn) return;
    if (!isSupported()) {
      btn.style.display = 'none';
      return;
    }
    btn.textContent = enabled ? '🔊 Voice' : '🔈 Voice';
    btn.classList.toggle('voice-on', enabled);
  }
  updateButton();

  function setEnabled(v) {
    enabled = !!v;
    try {
      localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0');
    } catch (_) {} // #288 precedent: blocked/full localStorage costs persistence, not the setting
    if (!enabled) {
      stopCurrentAudio();
      synth()?.cancel();
    }
    updateButton();
  }

  function toggle() {
    setEnabled(!enabled);
  }

  // ── Deterministic per-member voice/pitch/rate ───────────────────────────
  // A tiny string hash (FNV-1a), stable across a session and across reloads
  // for the same memberId -- so "Crowley always sounds like this" even
  // though what "this" is depends on the browser's own voice list, not a
  // curated choice.
  function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function fraction(seed) {
    return (hashString(seed) % 1000) / 1000; // deterministic value in [0, 1)
  }

  // getVoices() can return [] until the browser's async 'voiceschanged'
  // fires (Chrome does this on first load) -- cache is invalidated on that
  // event rather than assumed stable for the page's whole life.
  let cachedVoices = null;
  if (isSupported()) {
    synth().addEventListener?.('voiceschanged', () => {
      cachedVoices = null;
    });
  }

  function englishVoices() {
    const all = synth()?.getVoices() || [];
    if (!all.length) return [];
    const en = all.filter(v => /^en/i.test(v.lang));
    return en.length ? en : all;
  }

  function voiceForMember(memberId) {
    if (cachedVoices === null) cachedVoices = englishVoices();
    if (!cachedVoices.length) return null;
    return cachedVoices[hashString(memberId || '—') % cachedVoices.length];
  }

  function pitchForMember(memberId) {
    return 0.8 + fraction(`${memberId || '—'}:pitch`) * 0.4; // [0.8, 1.2)
  }

  function baseRateForMember(memberId) {
    return 0.92 + fraction(`${memberId || '—'}:rate`) * 0.16; // [0.92, 1.08)
  }

  function clampRate(r) {
    return Math.min(MAX_RATE, Math.max(MIN_RATE, r));
  }

  // Strip action asides (*stands and paces*) before speaking -- a listener
  // hearing the words "stands and paces" spoken as if they were dialogue is
  // worse than the asterisks-left-in bug this was meant to fix in the first
  // place: this member isn't a narrator describing their own stage
  // directions. The whole matched span is removed, not just the asterisks
  // (an earlier version of this replaced `*text*` with `text`, keeping the
  // action's words in the spoken output) -- then whitespace is collapsed
  // back to single spaces, since removing "*waves warmly* " mid-sentence
  // otherwise leaves a double space or an awkward gap around it.
  function stripForSpeech(text) {
    return text
      .replace(/\*([^*]+)\*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Unchanged from the first pass -- see module comment up top. Cancels any
  // utterance in flight rather than queueing: witness.js paces reveal by
  // reading time already, so a queue would just mean voice trailing further
  // and further behind text on a fast read-through or a burst of live beats.
  // Cutting to the newest beat keeps audio roughly tracking what's on screen
  // instead of an ever-growing backlog.
  function speakViaWebSpeech(spoken, memberId, speedMultiplier) {
    const s = synth();
    s.cancel();
    const utterance = new SpeechSynthesisUtterance(spoken);
    const voice = voiceForMember(memberId);
    if (voice) utterance.voice = voice;
    utterance.pitch = pitchForMember(memberId);
    utterance.rate = clampRate(baseRateForMember(memberId) * (speedMultiplier || 1));
    s.speak(utterance);
  }

  // #29 (ElevenLabs pass) -- proxied through routes/voice.js, which resolves
  // memberId to a roster voiceId and caches the result, so this is a plain
  // POST + play. Any failure (network, a member with no voiceId, a bad
  // ElevenLabs response) falls back to the Web Speech path for this one
  // beat rather than going silent -- and doesn't flip elevenLabsAvailable
  // off, since a single failed request shouldn't downgrade every later beat
  // in the session too.
  function speakViaElevenLabs(spoken, memberId, speedMultiplier) {
    const audio = new Audio();
    currentAudio = audio;
    fetch('/api/voice/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId, text: spoken }),
    })
      .then(r => {
        if (!r.ok) throw new Error(`voice request failed: ${r.status}`);
        return r.blob();
      })
      .then(blob => {
        if (currentAudio !== audio) return; // superseded by a newer speak()/stop() before this resolved
        const url = URL.createObjectURL(blob);
        audio.src = url;
        audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
        audio.play().catch(() => {}); // e.g. an autoplay-policy rejection -- fail silently, same as a TTS hiccup
      })
      .catch(() => {
        if (currentAudio === audio) {
          currentAudio = null;
          speakViaWebSpeech(spoken, memberId, speedMultiplier);
        }
      });
  }

  // One utterance/audio clip per rendered speech beat, called from
  // witness.js's single speech-rendering seam -- covers stage/room and
  // live/replay alike, the same seam #279's reading-time pacing already
  // hooks into. Which backend actually speaks is decided here, not by the
  // caller -- witness.js's call site is unchanged from the first pass.
  function speak(text, memberId, speedMultiplier) {
    if (!enabled || !isSupported() || !text) return;
    const spoken = stripForSpeech(text);
    if (!spoken) return;
    stopCurrentAudio(); // interrupt the previous beat's ElevenLabs audio, if any
    if (elevenLabsAvailable) {
      speakViaElevenLabs(spoken, memberId, speedMultiplier);
      return;
    }
    speakViaWebSpeech(spoken, memberId, speedMultiplier);
  }

  function stop() {
    stopCurrentAudio();
    synth()?.cancel();
  }

  return {
    isSupported,
    toggle,
    setEnabled,
    isEnabled: () => enabled,
    speak,
    stop,
  };
})();
