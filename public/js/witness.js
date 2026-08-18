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
// #184 (defaults inversion, see docs/archive/DESIGN-184-STAGE-DEFAULT.md): the stage
// (#witness-stage) and the record (app.js's #transcript-content) are two
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
//
// Revision, post-#206 review: both panes still render live, but only one is
// ever VISIBLE -- the same streaming text showing twice at once turned out
// to be unreadable, not "linked." collapseStage()/reopenStage() toggle
// mutually exclusive classes on #stage-record: .stage-only (stage showing,
// record hidden -- the default the instant a convene starts) and .collapsed
// (record showing, stage hidden -- entered automatically once a convene
// reaches its natural pause, or any time via Exit, which still never stops
// a still-running convene). The record keeps accumulating while hidden;
// live annotation during an active convene is deferred rather than
// designed for, since a hidden pane isn't a workable annotation surface.
// See docs/archive/DESIGN-184-STAGE-DEFAULT.md's Revision section.
//
// #257 retired #202's wordless Text/Room toggle: the stage described above
// (#witness-stage's scrolling bubble column) is now the fallback for when
// the 3D scene never initializes. When it does, "the room" (#257) below
// takes over as the one stage there is, and it renders these same beats as
// DOM cards composited over the WebGL canvas -- see that section's own
// comment for the mechanism.
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

  // ── The room (#257) ──────────────────────────────────────────────────────
  // #202 shipped a wordless Text/Room toggle -- a user choice between two
  // renderings, one of them mute. #257 retires that choice: there is one
  // stage now. Whenever the 3D scene actually initializes (app.js's
  // initSceneLayer calls enableRoom() on success), the room becomes the
  // stage and every live-mirrored or replayed beat composites into it as a
  // DOM speech card anchored to the speaking member's seat -- Vector3.Project
  // via window.LodgeScene.getSeatScreenPosition, a card positioned at that
  // screen point, layered over the WebGL canvas. #witness-stage's bubble
  // rendering survives only as the fallback for when the scene never
  // initializes (no WebGL, ?noscene, sc-scene-disabled) -- sceneAvailable
  // stays false and every render below falls through to it unchanged.
  let sceneAvailable = false;

  function enableRoom() {
    sceneAvailable = true;
    document.getElementById('stage-pane')?.classList.add('room-active');
  }

  // Round headers, lulls, and unattributed action lines aren't anchored to
  // any one member's seat -- they read into a small fixed strip at the top
  // of the room instead. In stage mode this is just #witness-stage itself,
  // same as before #257.
  function eventContainer() {
    return sceneAvailable ? document.getElementById('room-events') : document.getElementById('witness-stage');
  }

  function roomLayer() {
    return document.getElementById('room-speech-layer');
  }

  // memberId -> card element currently shown, keyed so a member's typing
  // placeholder and settled bubble are the same DOM node (swapped in place,
  // not removed and recreated -- avoids a flicker between the two states).
  const roomCards = new Map();
  const roomCardFadeTimers = new Map();
  let roomRepositionHandle = null;
  let liveTypingMemberId = null;

  // Settled cards linger long enough to read, then fade -- unlike the
  // scrolling stage, the room has no history to scroll through, so a card
  // that never left would just accumulate. Cancelled if the same member
  // speaks (or starts typing) again first.
  const ROOM_CARD_FADE_GRACE_MS = 1500;
  const ROOM_CARD_FADE_TRANSITION_MS = 550;

  function cancelCardFade(memberId) {
    const timer = roomCardFadeTimers.get(memberId);
    if (timer) {
      clearTimeout(timer);
      roomCardFadeTimers.delete(memberId);
    }
  }

  function scheduleCardFade(memberId, text) {
    cancelCardFade(memberId);
    const delay = witnessReadingTime(text) + ROOM_CARD_FADE_GRACE_MS;
    const timer = setTimeout(() => {
      const card = roomCards.get(memberId);
      if (!card) return;
      card.classList.add('room-card-fading');
      setTimeout(() => {
        if (roomCards.get(memberId) === card) {
          card.remove();
          roomCards.delete(memberId);
        }
      }, ROOM_CARD_FADE_TRANSITION_MS);
    }, delay);
    roomCardFadeTimers.set(memberId, timer);
  }

  // #257's other named rough edge: nudge a card down when its horizontal
  // band overlaps the previous one's, sorted left-to-right -- a simple
  // stacking heuristic, not real collision resolution, but enough for the
  // handful of seats that can plausibly be showing a card at once.
  const CARD_COLLISION_WIDTH = 280; // #291: tracks .room-speech-card's max-width (style.css)
  const CARD_STACK_OFFSET = 92;
  // A card grows upward from its seat point (CSS translateY(-100%), so it
  // reads as "hovering above the portrait"), and portraits themselves sit in
  // the upper half of the room's resting shot -- a longer turn can then grow
  // tall enough to poke above the canvas into the toolbar above it. Not a
  // real collision system, just a floor on how high the anchor point itself
  // is allowed to sit, so the card has room to grow into.
  const CARD_MIN_TOP = 150;

  function repositionRoomCards() {
    const placed = [];
    roomCards.forEach((card, memberId) => {
      const pos = window.LodgeScene?.getSeatScreenPosition?.(memberId);
      if (!pos || !pos.visible) {
        card.style.display = 'none';
        return;
      }
      card.style.display = '';
      placed.push({ card, x: pos.x, y: Math.max(pos.y, CARD_MIN_TOP) });
    });
    placed.sort((a, b) => a.x - b.x);
    let prev = null;
    placed.forEach(p => {
      const y = prev && Math.abs(p.x - prev.x) < CARD_COLLISION_WIDTH ? prev.y + CARD_STACK_OFFSET : p.y;
      p.card.style.left = `${p.x}px`;
      p.card.style.top = `${y}px`;
      prev = { x: p.x, y };
    });
    // CARD_MIN_TOP is a floor on the anchor point, not on the card's own
    // rendered top edge -- a long turn can still grow tall enough to poke
    // above the room. Measuring the actual laid-out box and nudging it back
    // in catches that regardless of how tall the content turned out to be.
    // jsdom (module-convention/witness.test.js) lays out nothing, so every
    // rect here is zero-height and this is a no-op there -- CARD_MIN_TOP
    // above is what those tests actually exercise.
    const room = document.getElementById('witness-room');
    const roomRect = room?.getBoundingClientRect();
    if (roomRect && roomRect.height) {
      placed.forEach(p => {
        const cardRect = p.card.getBoundingClientRect();
        const overflowTop = roomRect.top - cardRect.top;
        if (overflowTop > 0) {
          p.card.style.top = `${parseFloat(p.card.style.top) + overflowTop}px`;
        }
      });
    }
  }

  // The camera keeps easing toward whoever's speaking (#232) even between a
  // card's own content updates, so cards need to track it continuously, not
  // just reposition once per beat. Runs only while at least one card is
  // shown; each render call also positions immediately so a card never waits
  // a frame to appear in the right place.
  function roomRepositionTick() {
    repositionRoomCards();
    roomRepositionHandle =
      roomCards.size && typeof requestAnimationFrame === 'function' ? requestAnimationFrame(roomRepositionTick) : null;
  }

  function touchRoomLoop() {
    repositionRoomCards();
    if (roomRepositionHandle == null && roomCards.size && typeof requestAnimationFrame === 'function') {
      roomRepositionHandle = requestAnimationFrame(roomRepositionTick);
    }
  }

  function stopRoomLoop() {
    if (roomRepositionHandle != null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(roomRepositionHandle);
    }
    roomRepositionHandle = null;
  }

  function clearRoom() {
    roomCardFadeTimers.forEach((_, memberId) => cancelCardFade(memberId));
    clearRoomHolds();
    roomCards.clear();
    const layer = roomLayer();
    if (layer) layer.innerHTML = '';
    const events = document.getElementById('room-events');
    if (events) events.innerHTML = '';
    liveTypingMemberId = null;
    stopRoomLoop();
  }

  // Gets or creates the persistent card for a member -- typing and settled
  // states are the same element so swapping between them (renderRoomCard
  // replacing a typing card's content) never flickers a remove/re-add.
  function getOrCreateCard(memberId) {
    let card = roomCards.get(memberId);
    if (card) return { card, existed: true, prevHtml: card.innerHTML };
    card = document.createElement('div');
    card.className = 'room-speech-card';
    roomLayer()?.appendChild(card);
    roomCards.set(memberId, card);
    return { card, existed: false, prevHtml: null };
  }

  function speechHtml({ speaker, text, memberId, annotation }) {
    const nc = memberId ? `voice-${memberId}` : '';
    const glyph = memberGlyph(memberId) ? `<span class="speaker-glyph">${memberGlyph(memberId)}</span>` : '';
    const nameHtml = `<div class="speaker-name ${nc}">${glyph}${deps.escapeHTML(speaker)}</div>`;
    let bodyHtml = `<div class="bubble-body"><div class="speech-text">${deps.renderActions(text)}</div>`;
    if (annotation) bodyHtml += `<div class="witness-annotation">↳ ${deps.escapeHTML(annotation)}</div>`;
    bodyHtml += '</div>';
    return nameHtml + bodyHtml;
  }

  // Renders one settled speech beat into a member's card, anchored to their
  // seat. A member with no seat to anchor to (interject's "a voice from
  // elsewhere", memberId null) reads into the event strip instead, same
  // markup, same as it would in stage mode. Returns { undo } so replay's
  // go-back can reverse exactly this render.
  function renderRoomCard(block) {
    const { text, memberId } = block;
    if (!memberId) {
      const el = document.createElement('div');
      el.className = 'transcript-entry room-event-entry';
      el.innerHTML = speechHtml(block);
      eventContainer()?.appendChild(el);
      return { undo: () => el.remove() };
    }
    cancelCardFade(memberId);
    const { card, existed, prevHtml } = getOrCreateCard(memberId);
    card.classList.remove('room-card-typing');
    card.innerHTML = speechHtml(block);
    // #291: a settled beat is the full text -- start a reader at its top,
    // not wherever the typing scroll (below) last left the card sitting.
    card.scrollTop = 0;
    touchRoomLoop();
    scheduleCardFade(memberId, text);
    return {
      undo: () => {
        cancelCardFade(memberId);
        if (existed) {
          card.innerHTML = prevHtml;
          touchRoomLoop();
        } else {
          card.remove();
          roomCards.delete(memberId);
        }
      },
    };
  }

  function renderRoomTyping(name, memberId) {
    if (!memberId) return; // nothing to anchor a typing indicator to
    cancelCardFade(memberId);
    const { card } = getOrCreateCard(memberId);
    card.classList.add('room-card-typing');
    const nc = `voice-${memberId}`;
    const glyph = memberGlyph(memberId) ? `<span class="speaker-glyph">${memberGlyph(memberId)}</span>` : '';
    card.innerHTML =
      `<div class="speaker-name ${nc}">${glyph}${deps.escapeHTML(name)}</div>` +
      '<div class="bubble-body"><div class="speech-text typing-text transcript-stream-live"></div></div>';
    touchRoomLoop();
  }

  function setRoomTypingText(text) {
    const card = liveTypingMemberId && roomCards.get(liveTypingMemberId);
    const el = card?.querySelector('.typing-text');
    if (el) el.textContent = text;
    // #291: the card now caps its own height and scrolls internally rather
    // than growing without bound, so a beat that outgrows it needs to be
    // kept scrolled to the tail as it's typed -- the stage's plain-text
    // fallback already does the equivalent (liveTypingSet's stage.scrollTop
    // = stage.scrollHeight below).
    if (card) card.scrollTop = card.scrollHeight;
  }

  // ── Room-mode live pacing (#279) ─────────────────────────────────────────
  // Live delivery is deliberately unpaced overall -- see the comment above
  // liveSpeech -- but that left a single member's card with no minimum time
  // on screen: app.js's startStreamEntry opens a fresh typing placeholder in
  // the very same synchronous call that just closed a beat, immediately
  // overwriting the settled card a reader hadn't had time to read yet, and a
  // burst of beats closing in one chunk could do the same beat-to-beat.
  // scheduleCardFade above doesn't touch this -- it only governs how long a
  // *settled* card lingers once nothing is updating it, not the instant,
  // synchronous overwrite on arrival.
  //
  // Gate the two room mutations that can clobber a card mid-read -- a
  // settled render and the typing-start that follows one -- behind a
  // per-member hold, keyed to the same witnessReadingTime() replay already
  // paces full playback on. This only wraps the live entry points below,
  // never renderRoomCard/renderRoomTyping themselves, so replay (which
  // already paces itself, one block at a time, via renderWitnessBlock's own
  // returned delay) is untouched. liveTypingSet -- the typing text growing
  // character by character within an already-open typing card -- is exempt:
  // it isn't replacing anything a reader hasn't seen yet, just filling in
  // what's already visibly "being typed."
  //
  // Only the latest deferred mutation per member is kept, not a full queue:
  // a fresher settled card always supersedes a stale queued typing
  // placeholder (there's no reason to flash a placeholder for content
  // that's already fully known), and a second settled card arriving before
  // the first was ever shown supersedes it too -- an intermediate beat can
  // go unseen on the rare burst where several close in one chunk, same
  // trade-off the record (which always has everything) already makes for
  // stage mode's own scroll-and-miss-one case.
  const roomHoldUntil = new Map(); // memberId -> epoch ms the card may next change
  const roomHoldTimers = new Map(); // memberId -> pending flush timeout
  const roomHoldPending = new Map(); // memberId -> deferred { type: 'card', block } | { type: 'typingStart', name, text }

  function roomHoldActive(memberId) {
    const until = roomHoldUntil.get(memberId);
    return !!until && until > Date.now();
  }

  function setRoomHold(memberId, text) {
    const ms = witnessReadingTime(text);
    roomHoldUntil.set(memberId, Date.now() + ms);
    clearTimeout(roomHoldTimers.get(memberId));
    roomHoldTimers.set(
      memberId,
      setTimeout(() => flushRoomHold(memberId), ms)
    );
  }

  function flushRoomHold(memberId) {
    roomHoldTimers.delete(memberId);
    roomHoldUntil.delete(memberId);
    const pending = roomHoldPending.get(memberId);
    roomHoldPending.delete(memberId);
    if (!pending) return;
    if (pending.type === 'card') {
      renderWitnessBlock(pending.block);
      setRoomHold(memberId, pending.block.text);
    } else {
      renderRoomTyping(pending.name, memberId);
      if (pending.text) setRoomTypingText(pending.text);
    }
  }

  function clearRoomHolds() {
    roomHoldTimers.forEach(timer => clearTimeout(timer));
    roomHoldTimers.clear();
    roomHoldUntil.clear();
    roomHoldPending.clear();
  }

  // A speech block reading as pure action lines (e.g. "*stands and paces*")
  // renders into the room event strip, not the speaker's own card -- see
  // renderWitnessBlock's speech branch below, which this mirrors so the live
  // gating above can tell upfront whether a given block will actually touch
  // a per-member card before deciding to hold it.
  function isAllActionText(text) {
    const nonEmptyLines = text
      .trim()
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    return nonEmptyLines.length > 0 && nonEmptyLines.every(l => /^\*[^*]+\*$/.test(l));
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
    clearRoom();
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

  function liveReset() {
    clearStage(true);
  }
  function resetLiveStage() {
    clearStage(false);
  }

  // Enters "the record" view: stage hidden, record showing full height.
  // Called on Exit (live or replay) and automatically once the user lets a
  // meeting end at a lull -- see app.js's closeMeeting().
  function collapseStage() {
    const el = document.getElementById('stage-record');
    el?.classList.remove('stage-only');
    el?.classList.add('collapsed');
    // The record may have been hidden (display:none) this whole time, which
    // zeroes scrollHeight -- app.js's recordFollow() calls during that
    // window were inert. Catch up now that layout is real, so revealing it
    // lands on the latest speech, not wherever scrollTop last landed (0).
    const recordScroll = document.getElementById('record-scroll');
    if (recordScroll) recordScroll.scrollTop = recordScroll.scrollHeight;
  }

  // Enters "the stage" view: record hidden, stage showing full height --
  // the default the instant a live convene starts (via liveReset()) and
  // whenever replay begins (via start()). Mutually exclusive with
  // collapseStage() above: the two panes never render live at once.
  function reopenStage() {
    const el = document.getElementById('stage-record');
    el?.classList.remove('collapsed');
    el?.classList.add('stage-only');
    const stage = document.getElementById('witness-stage');
    if (stage) stage.scrollTop = stage.scrollHeight;
  }

  // ── Live mirroring (#184, #257) ──────────────────────────────────────────────
  // Each call renders one already-settled beat wherever the active surface is
  // (the room's cards/event strip, or #witness-stage as a fallback) via the
  // same createHeaderEl/createLullEl/renderRoomCard helpers replay's
  // renderWitnessBlock() uses below -- ignoring any returned pacing delay,
  // since live beats appear as fast as the room actually speaks, not on a
  // reading-time schedule.
  //
  // liveRoundHeader returns its element (unlike liveSpeech/liveTyping*)
  // because app.js's addRoundHeader() does the same for the record, and its
  // callers pair the two: on a failed round, they call both h.remove() (the
  // record) and this return value's .remove() (the stage/room), so a round
  // that never actually happened doesn't linger as a performed beat.
  function liveRoundHeader(label) {
    markStageActive();
    setHint('◉ Live — the room is speaking');
    return createHeaderEl(label);
  }

  // #245's live counterpart to the replayed 'lull' block above — mirrors the
  // record's divider onto the active surface when a passage reaches its pause.
  //
  // Returns its element, and app.js needs it for more than error recovery this
  // time: only one pane is ever visible (see the .stage-only/.collapsed note
  // atop this file), and during a live meeting that pane is the stage. The
  // Continue / Let it end controls have to hang off this copy, or the user
  // would be asked to decide on a divider they cannot see.
  function liveLull(note) {
    markStageActive();
    setHint('◉ Live — the room has paused');
    return createLullEl(note);
  }

  function liveSpeech({ speaker, text, memberId, annotation }) {
    markStageActive();
    setHint('◉ Live — the room is speaking');
    const block = { type: 'speech', speaker, text, memberId: memberId || null, annotation: annotation || null };
    const holdsACard = sceneAvailable && block.memberId && !isAllActionText(text);
    if (holdsACard && roomHoldActive(block.memberId)) {
      roomHoldPending.set(block.memberId, { type: 'card', block });
      return;
    }
    renderWitnessBlock(block);
    if (holdsACard) setRoomHold(block.memberId, text);
  }

  // Mirrors the record's "typing" placeholder (#115) so the active surface
  // keeps its theatrical, someone-is-speaking-right-now feel rather than
  // going dark between beats. Growing raw text, not a real block -- swapped
  // for the settled bubble by the next liveSpeech() call, same lifecycle as
  // the record's own typing element in app.js's startStreamEntry(). In room
  // mode this reuses (and is later overwritten by) the speaking member's own
  // card, per renderRoomTyping/renderRoomCard's shared getOrCreateCard.
  let liveTypingEl = null;

  function liveTypingStart(name, memberId) {
    markStageActive();
    setHint('◉ Live — the room is speaking');
    liveTypingMemberId = memberId || null;
    if (sceneAvailable) {
      if (liveTypingMemberId && roomHoldActive(liveTypingMemberId)) {
        roomHoldPending.set(liveTypingMemberId, { type: 'typingStart', name, text: '' });
        return;
      }
      renderRoomTyping(name, liveTypingMemberId);
      return;
    }
    const stage = document.getElementById('witness-stage');
    if (!stage) return;
    liveTypingEl = document.createElement('div');
    liveTypingEl.className = 'transcript-typing';
    liveTypingEl.innerHTML = `<div class="speaker-name">${deps.escapeHTML(name)}</div><div class="typing-text transcript-stream-live"></div>`;
    stage.appendChild(liveTypingEl);
    stage.scrollTop = stage.scrollHeight;
  }

  // #219: replaces (not appends) the typing text with the current beat's
  // full text so far. app.js recomputes the whole open beat via
  // splitIntoBeats on every chunk rather than tracking a raw delta, and
  // hands that over here -- see startStreamEntry's append().
  function liveTypingSet(text) {
    if (sceneAvailable) {
      const pending = liveTypingMemberId && roomHoldPending.get(liveTypingMemberId);
      if (pending && pending.type === 'typingStart') {
        pending.text = text;
        return;
      }
      setRoomTypingText(text);
      return;
    }
    if (!liveTypingEl) return;
    liveTypingEl.querySelector('.typing-text').textContent = text;
    const stage = document.getElementById('witness-stage');
    if (stage) stage.scrollTop = stage.scrollHeight;
  }

  function liveClearTyping() {
    // Room mode: nothing to remove -- the next liveSpeech()/renderRoomCard
    // overwrites the same card in place (see getOrCreateCard). Clearing the
    // tracked member here would just make setRoomTypingText a no-op between
    // clear and the settled render, so it's left for renderRoomCard to reset.
    if (sceneAvailable) return;
    if (liveTypingEl) {
      liveTypingEl.remove();
      liveTypingEl = null;
    }
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
  let witnessBlocks = []; // parsed sequence of blocks to play
  let witnessIndex = 0; // current block position (next block to render)
  let witnessTimer = null; // auto-advance timer
  let witnessActive = false;
  let witnessSourceSessionId = null; // session being witnessed (for restore on exit)
  let onExitRestore = null; // app.js's restoreSession, captured from deps at start()

  // Go-back support (#90): parallel arrays over witnessIndex so we can
  // undo any rendered block without a full re-render.
  //   witnessUndos[i]           — the undo callback renderWitnessBlock returned
  //                               for block i (#257: a room card mutated in
  //                               place needs a content-restoring undo, not a
  //                               node-removal one, so this stores whatever
  //                               callback the render actually produced rather
  //                               than assuming appended nodes).
  //   witnessSideSnapshots[i]   — { lastSpeakerId, currentSpeakerSide } captured
  //                               *before* block i was rendered, so restoring it
  //                               makes getSpeakerSide() behave identically on a
  //                               re-render of the same block.
  // Both are reset in start() and maintained in advance() / goBack().
  let witnessUndos = [];
  let witnessSideSnapshots = [];
  // End-of-session state: tracked separately so clicking/arrowing at the end
  // doesn't stack up multiple "The room falls silent." markers.
  let witnessEnded = false;
  let witnessEndEl = null;
  // Touch-swipe tracking (mobile go-back, #90).
  let _touchStartX = null;
  let _touchStartY = null;

  const WITNESS_WPM = 180; // reading speed for auto-advance pacing
  const WITNESS_PAUSE_AFTER_HEADER = 1800; // ms pause after round headers
  const WITNESS_MIN_PAUSE = 1200; // minimum ms between blocks
  const WITNESS_MAX_PAUSE = 12000; // cap on auto-advance delay

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
      // #245: `endedBy` (written only since #244) separates a segment whose
      // label opens it -- an old round header -- from one whose label is the
      // lull that ended it, which plays after the passage, where the room
      // actually drew breath. Same discriminator sessions.js's restore uses.
      const endsInLull = !!round.endedBy;
      if (!endsInLull) blocks.push({ type: 'header', label: round.label });

      const lines = (round.text || '').split('\n');
      let speaker = null,
        textLines = [];

      const flush = (keepSpeaker = false) => {
        if (!speaker || !textLines.length) return;
        const m = deps.resolveMember(speaker, deps.members);
        const annotation = Object.values(annotations).find(a => a.speaker === speaker)?.note || null;
        // #219: one turn, several bubbles -- same split app.js's live
        // streaming uses, so a replayed turn paces the same way it did the
        // night it was generated. The annotation (already only a loose
        // speaker-name match, not turn-specific -- see the lookup above)
        // goes on the last beat, the natural "end of turn" position,
        // rather than repeating across every fragment.
        const beats = deps.splitIntoBeats(textLines.join('\n').trim());
        beats.forEach((beatText, i) => {
          blocks.push({
            type: 'speech',
            speaker,
            text: beatText,
            memberId: m?.id || null,
            annotation: i === beats.length - 1 ? annotation : null,
          });
        });
        // Keep speaker across blank lines so multi-paragraph speeches aren't dropped
        if (!keepSpeaker) speaker = null;
        textLines = [];
      };

      lines.forEach(line => {
        const t = line.trim();
        if (!t) {
          flush(true);
          return;
        } // keepSpeaker=true: blank line is paragraph break, not speaker change
        if (t === '---' || t === '—' || t === '--') return;
        const isActionLine = /^\*[^*\n]+\*$/.test(t);
        if (isActionLine && !speaker) {
          flush();
          blocks.push({ type: 'action', text: t.slice(1, -1) });
          return;
        }
        const isKnownName = deps.isKnownSpeakerHeader(t, deps.members);
        const looksLikeName = !t.includes(' ') && t.endsWith(':') && t.length < 30;
        if (isKnownName || looksLikeName) {
          flush();
          speaker = t.replace(/:$/, '');
          textLines = [];
        } else if (speaker) textLines.push(t);
      });
      flush();
      if (endsInLull) blocks.push({ type: 'lull', label: round.label });
    });

    return blocks;
  }

  // ── Playback speed (#288) ─────────────────────────────────────────────────
  // #279 (PR #283) introduced a fixed per-member reading hold with no
  // user-facing control; the decision on #288 was to make one speed control
  // cover it plus replay and the old stage's pacing, rather than three
  // separate knobs. Since all three already funnel through
  // witnessReadingTime() (room-mode's setRoomHold above calls it directly;
  // replay's renderWitnessBlock below calls it for both the room's cards and
  // the old #witness-stage bubbles, which share that one function), a single
  // multiplier applied at the end of witnessReadingTime -- plus the same
  // divisor on the fixed header/lull pause below -- reaches every surface
  // from one place.
  //
  // A cycling button, not a slider: #257's and #279's own notes already flag
  // the room's chrome as tight on space, and a handful of preset speeds is
  // both simpler to hit precisely and cheaper to fit than a drag control.
  const WITNESS_SPEED_KEY = 'sc-witness-speed';
  const WITNESS_SPEEDS = [0.75, 1, 1.5, 2];

  function loadSpeed() {
    const v = parseFloat(localStorage.getItem(WITNESS_SPEED_KEY));
    return WITNESS_SPEEDS.includes(v) ? v : 1;
  }

  let witnessSpeed = loadSpeed();

  function updateSpeedButton() {
    const btn = document.getElementById('witness-speed-btn');
    if (btn) btn.textContent = `${witnessSpeed}×`;
  }
  updateSpeedButton();

  function setSpeed(v) {
    if (!WITNESS_SPEEDS.includes(v)) return;
    witnessSpeed = v;
    try {
      localStorage.setItem(WITNESS_SPEED_KEY, String(v));
    } catch (_) {} // a blocked/full localStorage should cost persistence, not the setting itself
    updateSpeedButton();
  }

  function cycleSpeed() {
    const i = WITNESS_SPEEDS.indexOf(witnessSpeed);
    setSpeed(WITNESS_SPEEDS[(i + 1) % WITNESS_SPEEDS.length]);
  }

  function witnessReadingTime(text) {
    const words = text.trim().split(/\s+/).length;
    const ms = (words / WITNESS_WPM) * 60 * 1000;
    return Math.min(Math.max(ms, WITNESS_MIN_PAUSE), WITNESS_MAX_PAUSE) / witnessSpeed;
  }

  // Shared by liveRoundHeader/liveLull above and renderWitnessBlock's replay
  // branches below, so both surfaces (room event strip or #witness-stage
  // fallback) render headers/lulls identically whichever one is live.
  function createHeaderEl(label) {
    const el = document.createElement('div');
    el.className = 'witness-round-header';
    el.innerHTML = `<div class="witness-rule"></div><span class="witness-round-label">${deps.escapeHTML(label)}</span><div class="witness-rule"></div>`;
    const c = eventContainer();
    c?.appendChild(el);
    if (!sceneAvailable && c) c.scrollTop = c.scrollHeight;
    return el;
  }

  function createLullEl(note) {
    const el = document.createElement('div');
    el.className = 'transcript-lull';
    el.innerHTML = `<div class="lull-rule"></div><span class="lull-note">${deps.escapeHTML(note)}</span><div class="lull-rule"></div>`;
    const c = eventContainer();
    c?.appendChild(el);
    if (!sceneAvailable && c) c.scrollTop = c.scrollHeight;
    return el;
  }

  // `lines` are already-stripped action text (asterisks removed). Returns
  // every element created, since an all-action speech turn can produce more
  // than one.
  function createActionLines(lines) {
    const c = eventContainer();
    const els = lines.map(text => {
      const el = document.createElement('div');
      el.className = 'action-line';
      el.textContent = text;
      c?.appendChild(el);
      return el;
    });
    if (!sceneAvailable && c) c.scrollTop = c.scrollHeight;
    return els;
  }

  // Renders one settled speech beat wherever the active surface is: the
  // room's per-member card (renderRoomCard) when the scene is available, or
  // a #witness-stage bubble otherwise -- the pre-#257 rendering, unchanged.
  function renderSpeechBeat(block) {
    if (sceneAvailable) return renderRoomCard(block);
    const side = getSpeakerSide(block.memberId || block.speaker);
    const e = document.createElement('div');
    e.className = `transcript-entry bubble-${side}`;
    e.innerHTML = speechHtml(block);
    const stage = document.getElementById('witness-stage');
    stage.appendChild(e);
    stage.scrollTop = stage.scrollHeight;
    return { undo: () => e.remove() };
  }

  // Renders one block onto the active surface. Used by both replay's
  // advance() (which uses the returned pacing delay) and live mirroring
  // above (which ignores it). Returns { delay, undo } -- undo reverses
  // exactly this call's effect, which goBack() uses to step replay backward
  // without assuming every render appended a fresh, independently-removable
  // node (a room card is mutated in place across renders, not recreated).
  function renderWitnessBlock(block) {
    if (block.type === 'header') {
      const el = createHeaderEl(block.label);
      return { delay: WITNESS_PAUSE_AFTER_HEADER / witnessSpeed, undo: () => el.remove() };
    }

    if (block.type === 'lull') {
      const el = createLullEl(block.label);
      return { delay: WITNESS_PAUSE_AFTER_HEADER / witnessSpeed, undo: () => el.remove() };
    }

    if (block.type === 'action') {
      const els = createActionLines([block.text]);
      return { delay: witnessReadingTime(block.text), undo: () => els.forEach(el => el.remove()) };
    }

    if (block.type === 'speech') {
      if (isAllActionText(block.text)) {
        const nonEmptyLines = block.text
          .trim()
          .split('\n')
          .map(l => l.trim())
          .filter(Boolean);
        const els = createActionLines(nonEmptyLines.map(l => l.slice(1, -1)));
        return { delay: witnessReadingTime(block.text), undo: () => els.forEach(el => el.remove()) };
      }
      const { undo } = renderSpeechBeat(block);
      return { delay: witnessReadingTime(block.text), undo };
    }

    return { delay: WITNESS_MIN_PAUSE, undo: () => {} };
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
      if (hint) hint.textContent = `${witnessIndex} / ${witnessBlocks.length} — ← back · space or click`;
      if (prog) prog.style.width = `${pct}%`;
    }
  }

  function advance() {
    if (!witnessActive) return;
    clearTimeout(witnessTimer);

    // At the end: add the closing marker exactly once, then stop.
    if (witnessIndex >= witnessBlocks.length) {
      if (!witnessEnded) {
        const el = document.createElement('div');
        el.className = 'witness-end';
        el.textContent = 'The room falls silent.';
        const c = eventContainer();
        c?.appendChild(el);
        if (!sceneAvailable && c) c.scrollTop = c.scrollHeight;
        witnessEndEl = el;
        witnessEnded = true;
      }
      _updateControls();
      return;
    }

    // Snapshot speaker-side state so goBack() can restore it for this block.
    witnessSideSnapshots[witnessIndex] = { lastSpeakerId, currentSpeakerSide };

    const { delay, undo } = renderWitnessBlock(witnessBlocks[witnessIndex]);
    witnessUndos[witnessIndex] = undo;

    witnessIndex++;
    _updateControls();

    // Schedule auto-advance
    witnessTimer = setTimeout(advance, delay);
  }

  // Step back one block (#90). Reverses the last rendered block's effect via
  // the undo it returned (a fresh node removal in stage mode; a room card's
  // content reverting to its pre-block snapshot, or being removed outright if
  // the block created it -- see renderRoomCard) and restores the speaker-side
  // state that was in effect before it rendered, so re-advancing reproduces
  // the exact same output.
  function goBack() {
    if (!witnessActive) return;
    clearTimeout(witnessTimer);

    // Remove the end-of-session marker and its flag first, so the state
    // machine is in sync with the DOM regardless of whether we go further back.
    if (witnessEnded) {
      if (witnessEndEl) {
        witnessEndEl.remove();
        witnessEndEl = null;
      }
      witnessEnded = false;
    }

    // Nothing left to undo.
    if (witnessIndex <= 0) {
      _updateControls();
      return;
    }

    witnessIndex--;

    witnessUndos[witnessIndex]?.();
    witnessUndos[witnessIndex] = null;

    // Restore speaker-side state to what it was before the block rendered.
    const snap = witnessSideSnapshots[witnessIndex];
    if (snap) {
      lastSpeakerId = snap.lastSpeakerId;
      currentSpeakerSide = snap.currentSpeakerSide;
    }

    if (!sceneAvailable) {
      const stage = document.getElementById('witness-stage');
      stage.scrollTop = stage.scrollHeight;
    }
    _updateControls();

    // Resume auto-advance from the stepped-back position after a short pause
    // so the user has time to read what they returned to.
    witnessTimer = setTimeout(advance, (WITNESS_MIN_PAUSE * 2) / witnessSpeed);
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
    if (dx < 0) advance();
    else goBack();
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
    lastSpeakerId = null;
    currentSpeakerSide = 'right';
    witnessUndos = [];
    witnessSideSnapshots = [];
    witnessEnded = false;
    witnessEndEl = null;

    const stage = document.getElementById('witness-stage');
    stage.innerHTML = '';
    clearRoom();
    hasStageContent = true;
    document.getElementById('witness-progress').style.display = '';
    document.getElementById('witness-exit-btn').style.display = '';

    reopenStage();
    document.getElementById('stage-pane').scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('witness-progress').style.width = '0%';
    document.getElementById('witness-hint').textContent = 'Space or click to advance';

    // Keyboard handler (arrow keys + space for go-back / advance, Esc to exit)
    document.addEventListener('keydown', witnessKeyHandler);

    // Touch-swipe handler for mobile go-back (#90), bound to both surfaces --
    // whichever one is actually visible, only one ever is (see #257's
    // room-active note atop this file). passive:false on touchend so
    // e.preventDefault() can suppress the synthetic click.
    const room = document.getElementById('witness-room');
    [stage, room].forEach(el => {
      el?.addEventListener('touchstart', _onTouchStart, { passive: true });
      el?.addEventListener('touchend', _onTouchEnd, { passive: false });
    });

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
    const room = document.getElementById('witness-room');
    [stage, room].forEach(el => {
      el?.removeEventListener('touchstart', _onTouchStart);
      el?.removeEventListener('touchend', _onTouchEnd);
    });
    stage.innerHTML = '';
    clearRoom();
    document.getElementById('witness-progress').style.display = 'none';
    document.getElementById('witness-exit-btn').style.display = 'none';
    hasStageContent = false;
    collapseStage();
  }

  return {
    configure,
    enableRoom,
    liveReset,
    resetLiveStage,
    liveRoundHeader,
    liveLull,
    liveSpeech,
    liveTypingStart,
    liveTypingSet,
    liveClearTyping,
    collapseStage,
    reopenStage,
    exitClicked,
    advance,
    start,
    cycleSpeed,
  };
})();
