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
// renderWitnessBlock's speech branch. Which backend actually spoke is an
// internal decision, not something the caller needs to know.
//
// #333 added a fourth, optional `memberGender` argument to speak() -- the
// one piece of roster data this module needs but, per the isolation above,
// won't reach into app.js's MEMBERS to fetch itself. witness.js already has
// the roster (deps.members) and resolves it at the call site instead.
//
// #338 added a fifth, optional `memberDemeanor` argument the same way. It
// only ever biases the Web Speech path's pitch/rate, not voice selection --
// unlike gender, there's no per-voice demeanor signal in a browser's own
// voice list to filter against (no KNOWN_VOICE_NAME_GENDERS equivalent
// exists for demeanor), so ElevenLabs' voiceId, already assigned demeanor-
// appropriately server-side (roster.js's assignVoiceId), is the only place
// demeanor actually picks a voice; see pitchForMember/baseRateForMember below.
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

  // #333 — SpeechSynthesisVoice carries no structured gender field, only a
  // browser/OS-assigned `name`. Chrome's own voices spell it out ("Google UK
  // English Female"); everything else falls back to a lookup of the common
  // default names macOS, Windows, and Android/Chrome OS actually ship,
  // covering the voice lists real users hit without pretending to
  // recognize every voice pack in existence. Unrecognized names return
  // null, same as no gender info at all -- voiceForMember below treats that
  // exactly like `gender` being omitted.
  const KNOWN_VOICE_NAME_GENDERS = {
    samantha: 'female',
    karen: 'female',
    moira: 'female',
    tessa: 'female',
    victoria: 'female',
    fiona: 'female',
    kate: 'female',
    serena: 'female',
    susan: 'female',
    allison: 'female',
    ava: 'female',
    zoe: 'female',
    nicky: 'female',
    'microsoft zira': 'female',
    'microsoft hazel': 'female',
    'microsoft susan': 'female',
    alex: 'male',
    daniel: 'male',
    fred: 'male',
    aaron: 'male',
    arthur: 'male',
    bruce: 'male',
    gordon: 'male',
    lee: 'male',
    oliver: 'male',
    rocko: 'male',
    'microsoft david': 'male',
    'microsoft mark': 'male',
    'microsoft james': 'male',
  };

  function voiceGenderGuess(voice) {
    const name = (voice.name || '').toLowerCase();
    if (name.includes('female')) return 'female';
    if (name.includes('male')) return 'male';
    for (const known in KNOWN_VOICE_NAME_GENDERS) {
      if (name.includes(known)) return KNOWN_VOICE_NAME_GENDERS[known];
    }
    return null;
  }

  // `gender`, when given, narrows the browser's own voice list to ones
  // voiceGenderGuess reads as matching before hashing -- same
  // filter-then-hash shape as roster.js's server-side assignVoiceId, kept
  // deterministic per member. Falls back to the full list when `gender` is
  // omitted or nothing in the list is recognized as matching it, so a
  // browser whose voices this heuristic can't read stays exactly as
  // behaved before #333.
  function voiceForMember(memberId, gender) {
    if (cachedVoices === null) cachedVoices = englishVoices();
    if (!cachedVoices.length) return null;
    let candidates = cachedVoices;
    if (gender) {
      const matching = cachedVoices.filter(v => voiceGenderGuess(v) === gender);
      if (matching.length) candidates = matching;
    }
    return candidates[hashString(memberId || '—') % candidates.length];
  }

  // #338 -- small per-demeanor nudges layered on the deterministic per-member
  // base above: 'intense' reads a touch higher and faster, 'stately' a touch
  // lower and slower, 'grounded' stays at the pre-#338 baseline. Omitted or
  // unrecognized demeanor (undefined lookup -> `|| 0`) leaves both functions
  // producing exactly their pre-#338 output, so every existing caller and
  // test that doesn't pass a demeanor is unaffected.
  const DEMEANOR_PITCH_BIAS = { intense: 0.06, stately: -0.08, grounded: 0 };
  const DEMEANOR_RATE_BIAS = { intense: 0.06, stately: -0.05, grounded: 0 };

  function pitchForMember(memberId, demeanor) {
    const bias = DEMEANOR_PITCH_BIAS[demeanor] || 0;
    return 0.8 + fraction(`${memberId || '—'}:pitch`) * 0.4 + bias; // [0.8, 1.2) + demeanor bias
  }

  function baseRateForMember(memberId, demeanor) {
    const bias = DEMEANOR_RATE_BIAS[demeanor] || 0;
    return 0.92 + fraction(`${memberId || '—'}:rate`) * 0.16 + bias; // [0.92, 1.08) + demeanor bias
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
  function speakViaWebSpeech(spoken, memberId, speedMultiplier, memberGender, memberDemeanor) {
    const s = synth();
    s.cancel();
    const utterance = new SpeechSynthesisUtterance(spoken);
    const voice = voiceForMember(memberId, memberGender);
    if (voice) utterance.voice = voice;
    utterance.pitch = pitchForMember(memberId, memberDemeanor);
    utterance.rate = clampRate(baseRateForMember(memberId, memberDemeanor) * (speedMultiplier || 1));
    s.speak(utterance);
  }

  // #29 (ElevenLabs pass) -- proxied through routes/voice.js, which resolves
  // memberId to a roster voiceId and caches the result, so this is a plain
  // POST + play. Any failure (network, a member with no voiceId, a bad
  // ElevenLabs response) falls back to the Web Speech path for this one
  // beat rather than going silent -- and doesn't flip elevenLabsAvailable
  // off, since a single failed request shouldn't downgrade every later beat
  // in the session too.
  function speakViaElevenLabs(spoken, memberId, speedMultiplier, memberGender, memberDemeanor) {
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
          speakViaWebSpeech(spoken, memberId, speedMultiplier, memberGender, memberDemeanor);
        }
      });
  }

  // One utterance/audio clip per rendered speech beat, called from
  // witness.js's single speech-rendering seam -- covers stage/room and
  // live/replay alike, the same seam #279's reading-time pacing already
  // hooks into. Which backend actually speaks is decided here, not by the
  // caller. `memberGender` (#333) and `memberDemeanor` (#338) are resolved
  // by witness.js from the roster (the only place that data lives) and
  // passed through; both are only ever consulted by the Web Speech path,
  // since the ElevenLabs path's voiceId is already assigned gender- and
  // demeanor-appropriately server-side (see roster.js's assignVoiceId).
  function speak(text, memberId, speedMultiplier, memberGender, memberDemeanor) {
    if (!enabled || !isSupported() || !text) return;
    const spoken = stripForSpeech(text);
    if (!spoken) return;
    stopCurrentAudio(); // interrupt the previous beat's ElevenLabs audio, if any
    if (elevenLabsAvailable) {
      speakViaElevenLabs(spoken, memberId, speedMultiplier, memberGender, memberDemeanor);
      return;
    }
    speakViaWebSpeech(spoken, memberId, speedMultiplier, memberGender, memberDemeanor);
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
