'use strict';

// #142: extracted from app.js's inline "Witness mode" block, following the
// script-tag/IIFE convention public/scene/scene.js already established in
// production (window.LodgeScene). window.Witness exposes a small API; app.js
// calls into it and never touches these internals directly.
//
// The reverse also holds: this module never reaches into app.js's core
// globals (MEMBERS, currentSessionId, etc.) directly. Where playback needs
// core data or logic -- member records, speaker-name resolution, markup
// escaping, restoring a session on exit -- app.js passes it in as an
// argument to start(), the same way app.js hands scene.js activeMembers via
// updateSeats([...activeMembers]).
window.Witness = (function () {
  // ── Live mode (#87) ────────────────────────────────────────────────────────
  // Live rounds render into #witness-stage using the exact same markup/CSS as
  // replay (renderWitnessBlock below) instead of a parallel implementation --
  // getLiveStageEl() is called from app.js's core render path
  // (addRoundHeader, startStreamEntry, interject) once per round/entry. This
  // is independent of the replay state machine further down, which the two
  // never run at once: forceLiveOff() and start() both force live mode off,
  // since restoring or replaying a stored session is never "the room
  // speaking right now."
  let witnessLiveActive = false;

  function getLiveStageEl() {
    return witnessLiveActive
      ? document.getElementById('witness-stage')
      : document.getElementById('transcript-content');
  }

  // Swaps which panel is visible, *moving* (not cloning) each rendered entry
  // across -- annotation state and click handlers are read via
  // querySelectorAll on .transcript-entry globally (app.js's saveAnnotation,
  // buildAnnotatedTranscript), so a clone would leave two nodes sharing one
  // entryId and double up on save. Moving keeps exactly one DOM copy of each
  // entry, just reparented, so toggling back and forth any number of times
  // never loses or duplicates anything either side rendered. Disabled (by
  // app.js, on #witness-live-toggle) while a round is streaming, so a round
  // never gets split mid-turn across containers.
  function toggleLive() {
    witnessLiveActive = !witnessLiveActive;
    const stage = document.getElementById('witness-stage');
    const reading = document.getElementById('transcript-content');
    const panel = document.getElementById('witness-panel');
    const readingPanel = document.getElementById('transcript-panel');
    const btn = document.getElementById('witness-live-toggle');
    const from = witnessLiveActive ? reading : stage;
    const to = witnessLiveActive ? stage : reading;
    while (from.firstChild) to.appendChild(from.firstChild);

    if (witnessLiveActive) {
      readingPanel.style.display = 'none';
      panel.style.display = 'block';
      document.getElementById('witness-hint').textContent = '◉ Live — watching the room';
      document.getElementById('witness-progress').style.display = 'none';
      stage.scrollTop = stage.scrollHeight;
      if (btn) { btn.textContent = '✕ Reading view'; btn.title = 'Return to the annotated reading view'; }
    } else {
      panel.style.display = 'none';
      readingPanel.style.display = '';
      document.getElementById('witness-progress').style.display = '';
      reading.scrollTop = reading.scrollHeight;
      if (btn) { btn.textContent = '◎ Witness'; btn.title = "Watch the room live, in Witness's theatrical presentation"; }
    }
  }

  // Forces live mode off regardless of the toggle's prior state, without the
  // move-nodes-between-panels choreography toggleLive() does -- used by
  // app.js's restoreSession(), where a restored session is static, read-only
  // history that must never render into the live stage even if the toggle
  // happened to be left on.
  function forceLiveOff() {
    witnessLiveActive = false;
    document.getElementById('witness-panel').style.display = 'none';
    document.getElementById('witness-stage').innerHTML = '';
    document.getElementById('transcript-panel').style.display = '';
    const btn = document.getElementById('witness-live-toggle');
    if (btn) { btn.textContent = '◎ Witness'; btn.title = "Watch the room live, in Witness's theatrical presentation"; }
  }

  // The shared panel's Exit button serves both modes -- dispatch to whichever
  // state machine is actually active.
  function exitClicked() {
    if (witnessLiveActive) toggleLive();
    else exit();
  }

  // ── Replay mode ────────────────────────────────────────────────────────────
  let witnessBlocks = [];      // parsed sequence of blocks to play
  let witnessIndex = 0;        // current block position
  let witnessTimer = null;     // auto-advance timer
  let witnessActive = false;
  let witnessSourceSessionId = null; // session being witnessed (for restore on exit)
  let deps = null;              // core helpers/data handed in by start() -- see below
  let onExitRestore = null;     // app.js's restoreSession, captured from deps at start()

  const WITNESS_WPM = 180;     // reading speed for auto-advance pacing
  const WITNESS_PAUSE_AFTER_HEADER = 1800;   // ms pause after round headers
  const WITNESS_MIN_PAUSE = 1200;            // minimum ms between blocks
  const WITNESS_MAX_PAUSE = 12000;           // cap on auto-advance delay

  // Own speaker-side tracking, independent of app.js's live-transcript side
  // state (lastSpeakerId/currentSpeakerSide there) -- replay and live
  // rendering never run concurrently, but keeping a separate copy here means
  // this module never has to reach into app.js's globals to reset it.
  let lastSpeakerId = null;
  let currentSpeakerSide = 'right';

  function getSpeakerSide(speakerId) {
    if (speakerId === '—') return currentSpeakerSide;
    if (speakerId !== lastSpeakerId) {
      currentSpeakerSide = currentSpeakerSide === 'left' ? 'right' : 'left';
      lastSpeakerId = speakerId;
    }
    return currentSpeakerSide;
  }

  function memberGlyph(memberId) {
    const m = memberId && deps.members.find(mm => mm.id === memberId);
    return m?.glyph || '';
  }

  /**
   * Parse a session's rounds + annotations into a flat sequence of playback blocks.
   * Block types: { type: 'header', label }
   *              { type: 'speech', speaker, text, memberId, annotation }
   *              { type: 'action', text }
   */
  function parseWitnessBlocks(session) {
    const blocks = [];
    const annotations = session.annotations || {};

    (session.rounds || []).forEach(round => {
      blocks.push({ type: 'header', label: round.label });

      const lines = (round.text || '').split('\n');
      let speaker = null, textLines = [];

      const flush = (keepSpeaker = false) => {
        if (!speaker || !textLines.length) return;
        const m = deps.resolveMember(speaker, deps.members);
        const annotation = Object.values(annotations).find(a => a.speaker === speaker)?.note || null;
        blocks.push({
          type: 'speech',
          speaker,
          text: textLines.join('\n').trim(),
          memberId: m?.id || null,
          annotation,
        });
        // Keep speaker across blank lines so multi-paragraph speeches aren't dropped
        if (!keepSpeaker) speaker = null;
        textLines = [];
      };

      lines.forEach(line => {
        const t = line.trim();
        if (!t) { flush(true); return; } // keepSpeaker=true: blank line is paragraph break, not speaker change
        if (t === '---' || t === '—' || t === '--') return;
        const isActionLine = /^\*[^*\n]+\*$/.test(t);
        if (isActionLine && !speaker) {
          flush();
          blocks.push({ type: 'action', text: t.slice(1, -1) });
          return;
        }
        const isKnownName = deps.isKnownSpeakerHeader(t, deps.members);
        const looksLikeName = !t.includes(' ') && t.endsWith(':') && t.length < 30;
        if (isKnownName || looksLikeName) { flush(); speaker = t.replace(/:$/, ''); textLines = []; }
        else if (speaker) textLines.push(t);
      });
      flush();
    });

    return blocks;
  }

  function witnessReadingTime(text) {
    const words = text.trim().split(/\s+/).length;
    const ms = (words / WITNESS_WPM) * 60 * 1000;
    return Math.min(Math.max(ms, WITNESS_MIN_PAUSE), WITNESS_MAX_PAUSE);
  }

  function renderWitnessBlock(block) {
    const stage = document.getElementById('witness-stage');

    if (block.type === 'header') {
      const el = document.createElement('div');
      el.className = 'witness-round-header';
      el.innerHTML = `<div class="witness-rule"></div><span class="witness-round-label">${deps.escapeHTML(block.label)}</span><div class="witness-rule"></div>`;
      stage.appendChild(el);
      stage.scrollTop = stage.scrollHeight;
      return WITNESS_PAUSE_AFTER_HEADER;
    }

    if (block.type === 'action') {
      const el = document.createElement('div');
      el.className = 'action-line';
      el.textContent = block.text;
      stage.appendChild(el);
      stage.scrollTop = stage.scrollHeight;
      return witnessReadingTime(block.text);
    }

    if (block.type === 'speech') {
      const nonEmptyLines = block.text.trim().split('\n').map(l => l.trim()).filter(Boolean);
      const allAction = nonEmptyLines.length > 0 && nonEmptyLines.every(l => /^\*[^*]+\*$/.test(l));
      if (allAction) {
        nonEmptyLines.forEach(l => {
          const el = document.createElement('div');
          el.className = 'action-line';
          el.textContent = l.slice(1, -1);
          stage.appendChild(el);
        });
        stage.scrollTop = stage.scrollHeight;
        return witnessReadingTime(block.text);
      }
      const nc = block.memberId ? `voice-${block.memberId}` : '';
      const glyph = memberGlyph(block.memberId)
        ? `<span class="speaker-glyph">${memberGlyph(block.memberId)}</span>` : '';
      const side = getSpeakerSide(block.memberId || block.speaker);

      const e = document.createElement('div');
      e.className = `transcript-entry bubble-${side}`;
      const nameHtml = `<div class="speaker-name ${nc}">${glyph}${deps.escapeHTML(block.speaker)}</div>`;
      let bodyHtml = `<div class="bubble-body"><div class="speech-text">${deps.renderActions(block.text)}</div>`;
      if (block.annotation) bodyHtml += `<div class="witness-annotation">↳ ${deps.escapeHTML(block.annotation)}</div>`;
      bodyHtml += '</div>';
      e.innerHTML = nameHtml + bodyHtml;
      stage.appendChild(e);
      stage.scrollTop = stage.scrollHeight;
      return witnessReadingTime(block.text);
    }

    return WITNESS_MIN_PAUSE;
  }

  function advance() {
    if (!witnessActive) return;
    clearTimeout(witnessTimer);

    if (witnessIndex >= witnessBlocks.length) {
      const stage = document.getElementById('witness-stage');
      const endEl = document.createElement('div');
      endEl.className = 'witness-end';
      endEl.textContent = 'The room falls silent.';
      stage.appendChild(endEl);
      stage.scrollTop = stage.scrollHeight;
      document.getElementById('witness-hint').textContent = 'Click Exit to return';
      document.getElementById('witness-progress').style.width = '100%';
      return;
    }

    const block = witnessBlocks[witnessIndex];
    const delay = renderWitnessBlock(block);
    witnessIndex++;

    // Update progress bar
    const pct = (witnessIndex / witnessBlocks.length) * 100;
    document.getElementById('witness-progress').style.width = `${pct}%`;
    document.getElementById('witness-hint').textContent =
      `${witnessIndex} / ${witnessBlocks.length} — space or click to advance`;

    // Schedule auto-advance
    witnessTimer = setTimeout(advance, delay);
  }

  // Begins replay of a fully-resolved session. `session` is { rounds,
  // annotations, id } -- app.js is responsible for fetching/assembling it
  // (including merging in any live, not-yet-saved annotations) before
  // calling in, same as scene.js's updateSeats([...activeMembers]) receives
  // a ready-made snapshot rather than reaching for activeMembers itself.
  //
  // `injectedDeps` is { members, resolveMember, isKnownSpeakerHeader,
  // escapeHTML, renderActions, restoreSession } -- the handful of core
  // app.js helpers playback needs. restoreSession is called (if provided)
  // when exit() determines the session on screen before Witness opened
  // should be restored.
  function start(session, injectedDeps) {
    if (!session || !session.rounds) return;
    deps = injectedDeps;
    onExitRestore = injectedDeps?.restoreSession || null;

    // Replay always wins over live mode -- watching a stored session is never
    // "the room speaking right now."
    witnessLiveActive = false;
    document.getElementById('transcript-panel').style.display = '';

    witnessBlocks = parseWitnessBlocks(session);
    witnessIndex = 0;
    witnessActive = true;
    witnessSourceSessionId = session.id || null;

    // Reset side map for a clean Witness run
    lastSpeakerId = null; currentSpeakerSide = 'right';
    document.getElementById('witness-stage').innerHTML = '';
    document.getElementById('witness-progress').style.display = '';

    // Show witness panel
    document.getElementById('witness-panel').style.display = 'block';
    document.getElementById('witness-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('witness-progress').style.width = '0%';
    document.getElementById('witness-hint').textContent = 'Space or click to advance';

    // Keyboard handler
    document.addEventListener('keydown', witnessKeyHandler);

    advance();
  }

  function witnessKeyHandler(e) {
    if (e.code === 'Space' && witnessActive) {
      e.preventDefault();
      advance();
    }
    if (e.code === 'Escape' && witnessActive) {
      exit();
    }
  }

  function exit() {
    const sessionToRestore = witnessSourceSessionId;
    witnessActive = false;
    witnessSourceSessionId = null;
    clearTimeout(witnessTimer);
    document.removeEventListener('keydown', witnessKeyHandler);
    document.getElementById('witness-panel').style.display = 'none';
    document.getElementById('witness-stage').innerHTML = '';
    // Hand back to app.js to restore the session transcript so the user
    // lands back in the full view -- this module never calls app.js
    // functions other than the one it was explicitly given for this.
    if (sessionToRestore && onExitRestore) onExitRestore(sessionToRestore);
  }

  return {
    getLiveStageEl,
    toggleLive,
    forceLiveOff,
    exitClicked,
    advance,
    start,
  };
})();
