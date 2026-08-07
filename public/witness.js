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
// argument, the same way app.js hands scene.js activeMembers via
// updateSeats([...activeMembers]).
//
// #184 (defaults inversion, see DESIGN-184-STAGE-DEFAULT.md): the stage
// (#witness-stage) and the record (app.js's #transcript-content) are now two
// permanent panes rendering the same conversation, never one swapped for the
// other -- the old toggleLive()/getLiveStageEl() DOM re-parenting is gone.
// A live convene mirrors each completed beat into the stage via
// liveRoundHeader/liveSpeech/liveTyping* below, called from app.js's
// existing render call sites (addRoundHeader, startStreamEntry) right after
// they write the same beat into the record. This is a second, lighter
// render -- not a DOM move -- so it deliberately does NOT carry entryId or
// dataset.speaker the way record entries do: annotation stays exclusively in
// the record (#184's decision), and the stage's .transcript-entry elements
// are presentation-only, built by renderWitnessBlock exactly like replay.
window.Witness = (function () {
  let deps = null; // core helpers/data -- see configure() below

  // configure() is called once at app.js's init (same pattern as
  // window.Export/window.Sessions) so deps exists before the first live
  // convene, not just once replay starts. start() also re-sets deps from its
  // own argument, in case a caller passes a fresher snapshot.
  function configure(injectedDeps) {
    deps = injectedDeps;
  }

  // ── Shared speaker-side tracking ─────────────────────────────────────────────
  // Used by both live mirroring and replay. Never runs concurrently with
  // either (a session is either being watched live or replayed, never both),
  // so one set of module vars is safe -- each entry point below resets it.
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

  // ── Stage chrome: hint text, exit button, collapse/reopen ──────────────────
  let hasStageContent = false;

  function setHint(text) {
    const hint = document.getElementById('witness-hint');
    if (hint) hint.textContent = text;
  }

  function markStageActive() {
    if (hasStageContent) return;
    hasStageContent = true;
    const btn = document.getElementById('witness-exit-btn');
    if (btn) btn.style.display = '';
  }

  // Clears the stage back to idle. `reopen` distinguishes the two real
  // callers: a brand-new live convene should default to showing the
  // performance (reopen=true), while restoring a past session into the
  // record should leave the stage collapsed if the user had it that way
  // (reopen=false) -- restoring is a read-only record operation, not an
  // invitation back into the stage.
  function clearStage(reopen) {
    const stage = document.getElementById('witness-stage');
    if (stage) stage.innerHTML = '';
    const prog = document.getElementById('witness-progress');
    if (prog) prog.style.display = 'none';
    const btn = document.getElementById('witness-exit-btn');
    if (btn) btn.style.display = 'none';
    lastSpeakerId = null;
    currentSpeakerSide = 'right';
    hasStageContent = false;
    setHint('');
    if (reopen) reopenStage();
  }

  function liveReset() { clearStage(true); }
  function resetLiveStage() { clearStage(false); }

  function collapseStage() {
    document.getElementById('stage-record')?.classList.add('collapsed');
  }

  function reopenStage() {
    document.getElementById('stage-record')?.classList.remove('collapsed');
    const stage = document.getElementById('witness-stage');
    if (stage) stage.scrollTop = stage.scrollHeight;
  }

  // ── Live mirroring (#184) ────────────────────────────────────────────────────
  // Each call renders one already-settled beat into the stage via the same
  // renderWitnessBlock() replay uses below -- ignoring its returned pacing
  // delay, since live beats appear as fast as the room actually speaks, not
  // on a reading-time schedule.
  //
  // liveRoundHeader returns its element (unlike liveSpeech/liveTyping*)
  // because app.js's addRoundHeader() does the same for the record, and its
  // callers pair the two: on a failed round, they call both h.remove() (the
  // record) and this return value's .remove() (the stage), so a round that
  // never actually happened doesn't linger as a performed beat on replay.
  function liveRoundHeader(label) {
    markStageActive();
    setHint('◉ Live — the room is speaking');
    const stage = document.getElementById('witness-stage');
    const el = document.createElement('div');
    el.className = 'witness-round-header';
    el.innerHTML = `<div class="witness-rule"></div><span class="witness-round-label">${deps.escapeHTML(label)}</span><div class="witness-rule"></div>`;
    stage.appendChild(el);
    stage.scrollTop = stage.scrollHeight;
    return el;
  }

  function liveSpeech({ speaker, text, memberId, annotation }) {
    markStageActive();
    setHint('◉ Live — the room is speaking');
    renderWitnessBlock({ type: 'speech', speaker, text, memberId: memberId || null, annotation: annotation || null });
  }

  // Mirrors the record's "typing" placeholder (#115) so the stage keeps its
  // theatrical, someone-is-speaking-right-now feel rather than going dark
  // between beats. Growing raw text, not a real block -- swapped for the
  // settled bubble by the next liveSpeech() call, same lifecycle as the
  // record's own typing element in app.js's startStreamEntry().
  let liveTypingEl = null;

  function liveTypingStart(name) {
    markStageActive();
    setHint('◉ Live — the room is speaking');
    const stage = document.getElementById('witness-stage');
    if (!stage) return;
    liveTypingEl = document.createElement('div');
    liveTypingEl.className = 'transcript-typing';
    liveTypingEl.innerHTML = `<div class="speaker-name">${deps.escapeHTML(name)}</div><div class="typing-text transcript-stream-live"></div>`;
    stage.appendChild(liveTypingEl);
    stage.scrollTop = stage.scrollHeight;
  }

  function liveTypingAppend(chunk) {
    if (!liveTypingEl) return;
    liveTypingEl.querySelector('.typing-text').textContent += chunk;
    const stage = document.getElementById('witness-stage');
    if (stage) stage.scrollTop = stage.scrollHeight;
  }

  function liveClearTyping() {
    if (liveTypingEl) { liveTypingEl.remove(); liveTypingEl = null; }
  }

  // The shared panel's Exit button serves both live and replay -- dispatch to
  // whichever is actually active. Live: collapse only, the convene (and the
  // record) keep going underneath. Replay: stop the paced playback, then
  // collapse -- #184's "exit the stage" is how the record gets full height
  // back for a real reading/annotation pass, reusing this one control rather
  // than adding a new one.
  function exitClicked() {
    if (witnessActive) exit();
    else collapseStage();
  }

  // ── Replay mode ────────────────────────────────────────────────────────────
  let witnessBlocks = [];      // parsed sequence of blocks to play
  let witnessIndex = 0;        // current block position (next block to render)
  let witnessTimer = null;     // auto-advance timer
  let witnessActive = false;
  let witnessSourceSessionId = null; // session being witnessed (for restore on exit)
  let onExitRestore = null;     // app.js's restoreSession, captured from deps at start()

  // Go-back support (#90): parallel arrays over witnessIndex so we can
  // undo any rendered block without a full re-render.
  //   witnessRenderedNodes[i]   — DOM nodes appended to the stage by block i
  //   witnessSideSnapshots[i]   — { lastSpeakerId, currentSpeakerSide } captured
  //                               *before* block i was rendered, so restoring it
  //                               makes getSpeakerSide() behave identically on a
  //                               re-render of the same block.
  // Both are reset in start() and maintained in advance() / goBack().
  let witnessRenderedNodes = [];
  let witnessSideSnapshots = [];
  // End-of-session state: tracked separately so clicking/arrowing at the end
  // doesn't stack up multiple "The room falls silent." markers.
  let witnessEnded = false;
  let witnessEndEl = null;
  // Touch-swipe tracking (mobile go-back, #90).
  let _touchStartX = null;
  let _touchStartY = null;

  const WITNESS_WPM = 180;     // reading speed for auto-advance pacing
  const WITNESS_PAUSE_AFTER_HEADER = 1800;   // ms pause after round headers
  const WITNESS_MIN_PAUSE = 1200;            // minimum ms between blocks
  const WITNESS_MAX_PAUSE = 12000;           // cap on auto-advance delay

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

  // Renders one block into the stage. Used by both replay's advance() (which
  // uses the returned pacing delay) and live mirroring above (which ignores
  // it). Always appends fresh elements -- never reads from or moves nodes
  // belonging to the record.
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

  // Shared helper: update hint and progress bar to reflect the current state.
  function _updateControls() {
    const hint = document.getElementById('witness-hint');
    const prog = document.getElementById('witness-progress');
    if (witnessEnded) {
      if (hint) hint.textContent = '← back · Exit to leave';
      if (prog) prog.style.width = '100%';
    } else if (witnessIndex === 0) {
      if (hint) hint.textContent = 'Space or click to advance';
      if (prog) prog.style.width = '0%';
    } else {
      const pct = (witnessIndex / witnessBlocks.length) * 100;
      if (hint) hint.textContent =
        `${witnessIndex} / ${witnessBlocks.length} — ← back · space or click`;
      if (prog) prog.style.width = `${pct}%`;
    }
  }

  function advance() {
    if (!witnessActive) return;
    clearTimeout(witnessTimer);

    // At the end: add the closing marker exactly once, then stop.
    if (witnessIndex >= witnessBlocks.length) {
      if (!witnessEnded) {
        const stage = document.getElementById('witness-stage');
        witnessEndEl = document.createElement('div');
        witnessEndEl.className = 'witness-end';
        witnessEndEl.textContent = 'The room falls silent.';
        stage.appendChild(witnessEndEl);
        stage.scrollTop = stage.scrollHeight;
        witnessEnded = true;
      }
      _updateControls();
      return;
    }

    // Snapshot speaker-side state so goBack() can restore it for this block.
    witnessSideSnapshots[witnessIndex] = { lastSpeakerId, currentSpeakerSide };

    // Render the block, collecting every newly appended child node.
    const stage = document.getElementById('witness-stage');
    const childCountBefore = stage.childElementCount;
    const delay = renderWitnessBlock(witnessBlocks[witnessIndex]);
    const newNodes = [];
    for (let i = childCountBefore; i < stage.childElementCount; i++) {
      newNodes.push(stage.children[i]);
    }
    witnessRenderedNodes[witnessIndex] = newNodes;

    witnessIndex++;
    _updateControls();

    // Schedule auto-advance
    witnessTimer = setTimeout(advance, delay);
  }

  // Step back one block (#90). Removes the last rendered block's DOM nodes
  // and restores the speaker-side state that was in effect before it rendered,
  // so re-advancing reproduces the exact same output.
  function goBack() {
    if (!witnessActive) return;
    clearTimeout(witnessTimer);

    // Remove the end-of-session marker and its flag first, so the state
    // machine is in sync with the DOM regardless of whether we go further back.
    if (witnessEnded) {
      if (witnessEndEl) { witnessEndEl.remove(); witnessEndEl = null; }
      witnessEnded = false;
    }

    // Nothing left to undo.
    if (witnessIndex <= 0) {
      _updateControls();
      return;
    }

    witnessIndex--;

    // Remove the nodes this block appended.
    const nodes = witnessRenderedNodes[witnessIndex] || [];
    nodes.forEach(n => { if (n.parentNode) n.parentNode.removeChild(n); });
    witnessRenderedNodes[witnessIndex] = [];

    // Restore speaker-side state to what it was before the block rendered.
    const snap = witnessSideSnapshots[witnessIndex];
    if (snap) { lastSpeakerId = snap.lastSpeakerId; currentSpeakerSide = snap.currentSpeakerSide; }

    const stage = document.getElementById('witness-stage');
    stage.scrollTop = stage.scrollHeight;
    _updateControls();

    // Resume auto-advance from the stepped-back position after a short pause
    // so the user has time to read what they returned to.
    witnessTimer = setTimeout(advance, WITNESS_MIN_PAUSE * 2);
  }

  // ── Touch / swipe support (#90) ────────────────────────────────────────────
  // Swipe left = advance (next), swipe right = go back. Registered on the
  // stage element only (start() / exit()) -- scoped so a swipe inside the
  // record (#184) scrolls the record instead of driving the stage.
  function _onTouchStart(e) {
    _touchStartX = e.touches[0].clientX;
    _touchStartY = e.touches[0].clientY;
  }

  function _onTouchEnd(e) {
    if (_touchStartX === null) return;
    const dx = e.changedTouches[0].clientX - _touchStartX;
    const dy = e.changedTouches[0].clientY - _touchStartY;
    _touchStartX = null;
    _touchStartY = null;
    // Require a clear horizontal intent: |dx| > 40px and horizontal dominates.
    if (Math.abs(dx) < 40 || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
    // Suppress the synthetic click that would otherwise fire advance() via onclick.
    e.preventDefault();
    if (dx < 0) advance(); else goBack();
  }

  // Begins replay of a fully-resolved session. `session` is { rounds,
  // annotations, id } -- app.js is responsible for fetching/assembling it
  // (including merging in any live, not-yet-saved annotations) before
  // calling in, same as scene.js's updateSeats([...activeMembers]) receives
  // a ready-made snapshot rather than reaching for activeMembers itself.
  //
  // `injectedDeps` is { members, resolveMember, isKnownSpeakerHeader,
  // escapeHTML, renderActions, restoreSession } -- the handful of core
  // app.js helpers playback needs. Before rendering, this awaits
  // deps.restoreSession(session.id) so the record shows the same session the
  // stage is about to play (a no-op if it already does) -- #184: both panes
  // are the same conversation, not stage-then-record-on-exit like before.
  async function start(session, injectedDeps) {
    if (!session || !session.rounds) return;
    if (injectedDeps) deps = injectedDeps;
    onExitRestore = deps?.restoreSession || null;
    witnessSourceSessionId = session.id || null;

    // Sync the record BEFORE touching the stage -- restoreSession() (via
    // resetLiveStage()) also clears the stage, so awaiting first avoids a
    // race where that clear would wipe out this replay's own render. Only
    // when the session has an id: an ephemeral/unsaved session (no id) has
    // nothing in the record to sync to.
    if (onExitRestore && witnessSourceSessionId) await onExitRestore(witnessSourceSessionId);

    witnessBlocks = parseWitnessBlocks(session);
    witnessIndex = 0;
    witnessActive = true;

    // Reset side map and go-back state for a clean Witness run.
    lastSpeakerId = null; currentSpeakerSide = 'right';
    witnessRenderedNodes = [];
    witnessSideSnapshots = [];
    witnessEnded = false;
    witnessEndEl = null;

    const stage = document.getElementById('witness-stage');
    stage.innerHTML = '';
    hasStageContent = true;
    document.getElementById('witness-progress').style.display = '';
    document.getElementById('witness-exit-btn').style.display = '';

    reopenStage();
    document.getElementById('stage-pane').scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('witness-progress').style.width = '0%';
    document.getElementById('witness-hint').textContent = 'Space or click to advance';

    // Keyboard handler (arrow keys + space for go-back / advance, Esc to exit)
    document.addEventListener('keydown', witnessKeyHandler);

    // Touch-swipe handler for mobile go-back (#90). passive:false on touchend
    // so e.preventDefault() can suppress the synthetic click.
    stage.addEventListener('touchstart', _onTouchStart, { passive: true });
    stage.addEventListener('touchend', _onTouchEnd, { passive: false });

    advance();
  }

  function witnessKeyHandler(e) {
    if (!witnessActive) return;
    if (e.code === 'Space' || e.code === 'ArrowRight' || e.code === 'ArrowDown') {
      e.preventDefault();
      advance();
    } else if (e.code === 'ArrowLeft' || e.code === 'ArrowUp') {
      e.preventDefault();
      goBack();
    } else if (e.code === 'Escape') {
      exit();
    }
  }

  // Stops replay entirely (no "resume where you left off" -- a fresh ◎ Watch
  // click always restarts from block 0, unchanged from before #184). Unlike
  // the pre-#184 version, this no longer needs to restore the record: start()
  // already synced it, and it was never replaced during playback.
  function exit() {
    witnessActive = false;
    witnessSourceSessionId = null;
    witnessEnded = false;
    witnessEndEl = null;
    clearTimeout(witnessTimer);
    document.removeEventListener('keydown', witnessKeyHandler);
    const stage = document.getElementById('witness-stage');
    stage.removeEventListener('touchstart', _onTouchStart);
    stage.removeEventListener('touchend', _onTouchEnd);
    stage.innerHTML = '';
    document.getElementById('witness-progress').style.display = 'none';
    document.getElementById('witness-exit-btn').style.display = 'none';
    hasStageContent = false;
    collapseStage();
  }

  return {
    configure,
    liveReset,
    resetLiveStage,
    liveRoundHeader,
    liveSpeech,
    liveTypingStart,
    liveTypingAppend,
    liveClearTyping,
    collapseStage,
    reopenStage,
    exitClicked,
    advance,
    start,
  };
})();
