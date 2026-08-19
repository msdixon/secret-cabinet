'use strict';

// #29 -- first-pass browser TTS for Witness playback (replay + live
// mirroring). Deliberately scoped small against the issue's "large" label:
// the Web Speech API only, no ElevenLabs/paid-TTS integration, and no
// hand-authored per-member voice profile -- there's no character-file field
// for one, and SpeechSynthesis's voice list is OS/browser-dependent (Chrome
// vs. Safari vs. whatever's installed differ), so hand-picking "Crowley gets
// this exact accent" wouldn't reproduce across machines anyway. What ships
// instead: a deterministic hash of memberId into whatever voices the browser
// actually has, plus a small per-member pitch/rate offset, so the room reads
// as several distinct-sounding speakers without pretending to a curated
// cast. Named follow-ups this leaves, if #29 gets picked up again: a real
// per-member voice/accent field once there's a paid TTS backend that can
// honor it, and speech actually synced to the beat-by-beat reveal rather
// than fired once per rendered beat and left to run its own course.
//
// Same script-tag/IIFE + configure-free convention as witness.js's siblings
// (#142) -- window.Voice, one global. Unlike witness.js this module needs no
// deps from app.js: everything it touches (memberId strings, the browser's
// own speechSynthesis) is either passed in as an argument or read directly
// off the platform. witness.js is its only caller, from the single seam
// that already covers every rendering path -- see renderWitnessBlock's
// speech branch.
window.Voice = (function () {
  const ENABLED_KEY = 'sc-witness-voice-enabled';
  const MIN_RATE = 0.5;
  const MAX_RATE = 3; // SpeechSynthesis itself allows ~[0.1, 10]; keep it intelligible

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
    if (!enabled) synth()?.cancel();
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

  // Strip action markup (*stands and paces*) before speaking -- a listener
  // shouldn't hear asterisks read aloud.
  function stripForSpeech(text) {
    return text.replace(/\*([^*]+)\*/g, '$1').trim();
  }

  // One utterance per rendered speech beat, called from witness.js's single
  // speech-rendering seam -- covers stage/room and live/replay alike, the
  // same seam #279's reading-time pacing already hooks into. Cancels any
  // utterance in flight rather than queueing: witness.js paces reveal by
  // reading time already, so a queue would just mean voice trailing further
  // and further behind text on a fast read-through or a burst of live beats.
  // Cutting to the newest beat keeps audio roughly tracking what's on screen
  // instead of an ever-growing backlog.
  function speak(text, memberId, speedMultiplier) {
    if (!enabled || !isSupported() || !text) return;
    const spoken = stripForSpeech(text);
    if (!spoken) return;
    const s = synth();
    s.cancel();
    const utterance = new SpeechSynthesisUtterance(spoken);
    const voice = voiceForMember(memberId);
    if (voice) utterance.voice = voice;
    utterance.pitch = pitchForMember(memberId);
    utterance.rate = clampRate(baseRateForMember(memberId) * (speedMultiplier || 1));
    s.speak(utterance);
  }

  function stop() {
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
