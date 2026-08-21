'use strict';

let currentJournal = JSON.parse(localStorage.getItem('sc-journal') || 'null') || { id: null, name: null };

// Roster is fetched from the server so newly added members appear without reload.
let MEMBERS = [];

async function fetchMembers() {
  try {
    const data = await fetch('/api/members').then(r => r.json());
    if (Array.isArray(data)) MEMBERS = data;
  } catch (e) {
    console.error('Could not load roster', e);
  }
}

// Seeded at startup from the user's pinned regulars (#185, window.Casting);
// empty until someone pins their first, and hand-castable from the grid
// either way.
let activeMembers = new Set();
// #245: how many passages the meeting has so far, not a position in a
// preordained count of three. Nothing reads it to decide whether to keep
// going — the user does that at each lull.
let segmentCount = 0;
let currentSessionId = null;
let currentSourceSessionId = null; // set when reconvening on a prior transcript
let transcriptText = '';
let sessionDate = '';
let journalList = [];
let currentEntry = '';
let pendingRetry = null;
let lastInterjectText = '';

// ── Player-as-member ─────────────────────────────────────────────────────────
let playerMode = 'none'; // 'none' | 'member' | 'custom' — snapshotted at convene() start
let playerMemberId = null;
let playerName = null;
let currentPlayerSpeakerName = null; // resolved display name; drives parser recognition of custom identities
let sessionPlayerTurns = []; // [{round, speakerName, text}] — `round` is the segment index (#245)
let playerTurnsRevealed = false;

// ── Render member tokens ──────────────────────────────────────────────────────

function renderMembers() {
  document.getElementById('members-grid').innerHTML = '';

  // No core/guest distinction — one sorted, filterable roster. An already-active
  // member stays visible even when the filter no longer matches them, so casting
  // someone doesn't make them disappear.
  //
  // Regulars sort to the front (#185): the people who are always here should
  // read as the room's standing shape, not as three names scattered through an
  // alphabet.
  const filter = (document.getElementById('member-filter')?.value || '').trim().toLowerCase();
  const roster = [...MEMBERS].sort((a, b) => {
    const ra = window.Casting.isRegular(a.id),
      rb = window.Casting.isRegular(b.id);
    if (ra !== rb) return ra ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const grid = document.getElementById('members-grid');
  let visibleCount = 0;

  roster.forEach(m => {
    const isActive = activeMembers.has(m.id);
    const isRegular = window.Casting.isRegular(m.id);
    if (filter && !isActive && !m.name.toLowerCase().includes(filter)) return;
    visibleCount++;
    const el = document.createElement('div');
    el.className = 'member-token' + (isActive ? ' active' : '') + (isRegular ? ' regular' : '');
    // Roster names are user-authored (+ Invite to the Lodge), and the pin puts
    // one inside two attributes — escape rather than trust it there.
    const safeName = escapeHTML(m.name);
    el.innerHTML =
      `<img class="member-portrait" src="/portraits/${m.id}.png" alt="" loading="lazy" onerror="portraitFallback(this,'dot')"><span class="member-name">${m.name}</span>` +
      `<button type="button" class="member-pin${isRegular ? ' pinned' : ''}" aria-pressed="${isRegular}"` +
      ` title="${isRegular ? `${safeName} is a regular — always drawn to the room. Click to release.` : `Keep ${safeName} as a regular — always drawn to the room.`}"` +
      ` aria-label="${isRegular ? 'Release' : 'Keep'} ${safeName} as a regular">✦</button>`;
    el.onclick = () => {
      if (isActive) activeMembers.delete(m.id);
      else activeMembers.add(m.id);
      window.Casting.noteHandCast();
      renderMembers();
    };
    // The pin sits inside the token but answers a different question — who is
    // always here, not who is here tonight — so it must not also toggle presence.
    el.querySelector('.member-pin').onclick = e => {
      e.stopPropagation();
      window.Casting.toggleRegular(m.id);
    };
    grid.appendChild(el);
  });

  const emptyHint = document.getElementById('members-empty-hint');
  emptyHint.style.display = filter && visibleCount === 0 ? 'block' : 'none';
  if (filter) document.getElementById('members-empty-hint-term').textContent = filter;

  updateMemberCount();
  window.Casting.render();
  populateArtifactSelect();
  populatePlayAsMemberSelect();
  if (activeMembers.size > 0) window.Sessions.buildDossier([...activeMembers]);
  window.LodgeScene?.updateSeats([...activeMembers]);
}

function populateArtifactSelect() {
  const sel = document.getElementById('artifact-member');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">— select a member —</option>';
  MEMBERS.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    sel.appendChild(opt);
  });
  if (current) sel.value = current;
}

// ── Play as ───────────────────────────────────────────────────────────────────

function populatePlayAsMemberSelect() {
  const sel = document.getElementById('play-as-member-select');
  if (!sel) return;
  const current = sel.value;
  const active = [...activeMembers];
  sel.innerHTML = '<option value="">— select a present member —</option>';
  active
    .map(id => MEMBERS.find(m => m.id === id))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      sel.appendChild(opt);
    });
  if (current && active.includes(current)) {
    sel.value = current;
    return;
  }
  // The previously "played" member is no longer present — reset defensively
  // rather than silently keeping a stale selection.
  const modeSel = document.getElementById('play-as-mode-select');
  if (modeSel?.value === 'member') {
    modeSel.value = 'none';
    handlePlayAsModeChange();
  }
}

function handlePlayAsModeChange() {
  const mode = document.getElementById('play-as-mode-select').value;
  document.getElementById('play-as-member-field').style.display = mode === 'member' ? 'block' : 'none';
  document.getElementById('play-as-custom-field').style.display = mode === 'custom' ? 'block' : 'none';
}

function isPlayerActive() {
  return !!currentPlayerSpeakerName;
}

// Reflects a restored (finished) session's "Play as" choice, read-only —
// no live turn-writing can happen for a session that already completed.
function restorePlayAsControlDisplay() {
  const modeSel = document.getElementById('play-as-mode-select');
  if (!modeSel) return;
  modeSel.value = playerMode;
  modeSel.disabled = true;
  handlePlayAsModeChange();
  const memberSel = document.getElementById('play-as-member-select');
  const customInput = document.getElementById('play-as-custom-name');
  if (playerMode === 'member' && memberSel) {
    if (![...memberSel.options].some(o => o.value === playerMemberId)) {
      const opt = document.createElement('option');
      opt.value = playerMemberId;
      opt.textContent = currentPlayerSpeakerName || playerMemberId;
      memberSel.appendChild(opt);
    }
    memberSel.value = playerMemberId;
    memberSel.disabled = true;
  } else if (memberSel) {
    memberSel.disabled = false;
  }
  if (playerMode === 'custom' && customInput) {
    customInput.value = playerName || '';
    customInput.disabled = true;
  } else if (customInput) {
    customInput.disabled = false;
  }
}

function awaitPlayerTurn(roundLabel) {
  return new Promise(resolve => {
    const overlay = document.getElementById('player-turn-overlay');
    const modal = document.getElementById('player-turn-modal');
    const textarea = document.getElementById('player-turn-text');
    document.getElementById('player-turn-round-label').textContent = roundLabel;
    document.getElementById('player-turn-name-label').textContent = currentPlayerSpeakerName;
    textarea.value = '';
    overlay.classList.add('open');
    modal.classList.add('open');
    textarea.focus();
    const speakBtn = document.getElementById('player-turn-speak-btn');
    const passBtn = document.getElementById('player-turn-pass-btn');
    const cleanup = () => {
      overlay.classList.remove('open');
      modal.classList.remove('open');
      speakBtn.onclick = null;
      passBtn.onclick = null;
    };
    speakBtn.onclick = () => {
      const text = textarea.value.trim();
      cleanup();
      resolve(text ? { text } : null);
    };
    passBtn.onclick = () => {
      cleanup();
      resolve(null);
    };
  });
}

function updateMemberCount() {
  const n = activeMembers.size;
  const badge = document.getElementById('member-count-badge');
  if (!badge) return;
  badge.textContent = `${n} present`;
  badge.className = 'member-count-badge' + (n >= 8 ? ' over' : n >= 6 ? ' warn' : '');
  badge.title =
    n >= 6
      ? `${n} members active — larger casts reduce individual voice distinction and increase generation time. 4–6 recommended.`
      : '';
}

// ── Ember animation ───────────────────────────────────────────────────────────

function setEmber(active) {
  document.getElementById('ember-bar').className = 'ember-bar' + (active ? ' active' : '');
  ['s1', 's2', 's3', 's4', 's5'].forEach(id => {
    document.getElementById(id).className = 'spark' + (active ? ' active' : '');
  });
}

// ── Status ────────────────────────────────────────────────────────────────────

function setStatus(msg, thinking) {
  const el = document.getElementById('status-bar');
  el.textContent = msg;
  el.className = 'status-bar' + (thinking ? ' thinking' : '');
  setEmber(thinking);
}

// ── Transcript rendering ──────────────────────────────────────────────────────

// roundIndex is the session-relative round index (0-based) this header opens,
// or null for headers that never enter session.rounds (interjections) — used
// to tag the round's entries so player-turn markers can find them later.
let currentRenderRound = null;

// Passages no longer open with a header, so the segment index that tags each
// entry (data-round, which player-turn markers match on) is set directly
// rather than as a side effect of rendering one.
function setRenderSegment(segmentIndex) {
  currentRenderRound = segmentIndex;
}

function addRoundHeader(label, roundIndex = null) {
  currentRenderRound = roundIndex;
  const c = document.getElementById('transcript-content');
  const h = document.createElement('div');
  h.className = 'transcript-round-header';
  h.innerHTML = `<div class="round-rule"></div><span class="round-rule-label">${escapeHTML(label)}</span><div class="round-rule"></div>`;
  c.appendChild(h);
  transcriptText += `\n\n— ${label} —\n\n`;
  return h;
}

// #245: the lull — the pause the room takes when a passage runs out of breath.
// It renders *after* the passage it ended (unlike the round headers it
// replaces, which announced the passage about to happen), and reads as an
// action line rather than a section heading, because that's what it is: the
// fire settling, someone refilling a glass.
//
// The note is director-authored (or a stock line the server picked), so unlike
// the fixed round labels it replaces it's model output — escape it.
//
// #357: also the single choke point every lull note passes through --live
// convene (runLullLoop), stirRoom, and sessions.js's restoreSession replay
// all call this -- so it's where the 3D fire reacts to the meeting's own
// state instead of app.js reaching into LodgeScene from three places.
// segmentIndex is already the established per-round ordinal (branch points
// key off it too), so segmentIndex + 1 is "how many passages have happened
// so far" with no separate counter to keep in sync; the stock lull note is
// literally "Someone stirs the fire" (src/pipeline-lull.js), and a
// director-written note can say the same thing in its own words, so this
// matches on content rather than hard-coding that one string.
function addLullDivider(note, segmentIndex = null) {
  const c = document.getElementById('transcript-content');
  const el = document.createElement('div');
  el.className = 'transcript-lull';
  el.innerHTML = `<div class="lull-rule"></div><span class="lull-note">${escapeHTML(note)}</span><div class="lull-rule"></div>`;
  c.appendChild(el);
  transcriptText += `\n\n— ${note} —\n\n`;
  if (segmentIndex !== null) el.dataset.segment = segmentIndex;
  window.LodgeScene?.setPassageCount(segmentIndex !== null ? segmentIndex + 1 : segmentCount);
  if (/\bstir\w*\b/i.test(note) && /\bfire\b/i.test(note)) window.LodgeScene?.stirFire();
  return el;
}

// The primary loop (#245): every passage ends at a lull, and the meeting only
// goes on because the user says so here. There is no round count deciding it
// in advance — that was the whole point of #194's first decision.
//
// A pending lull is the one place the app now waits indefinitely on the user
// mid-meeting, so it needs an escape hatch: anything that wipes the transcript
// out from under it (restoring another meeting, reconvening, starting a fresh
// one) removes these buttons from the DOM, and without abandonLull() the
// promise would never settle — leaving convene() suspended in its try block
// and the Convene button disabled for good.
let abandonLull = null;

// The controls go on every copy of the lull it's given — the record's divider
// and the stage's mirror of it — because only one of those panes is ever
// visible at a time (see style.css's .stage-only/.collapsed pair), and during
// a live meeting it's the stage. Attaching to just one would mean asking the
// user to decide on a divider that's currently display:none.
function awaitLull(els) {
  return new Promise(resolve => {
    const rows = els.filter(Boolean).map(el => {
      const actions = document.createElement('div');
      actions.className = 'lull-actions';
      const cont = document.createElement('button');
      cont.className = 'lull-btn continue';
      cont.textContent = 'Continue';
      const end = document.createElement('button');
      end.className = 'lull-btn';
      end.textContent = 'Let it end';
      actions.append(cont, end);
      el.appendChild(actions);
      return { actions, cont, end };
    });
    recordFollow();
    const choose = choice => {
      abandonLull = null;
      rows.forEach(r => r.actions.remove());
      resolve(choice);
    };
    rows.forEach(r => {
      r.cont.onclick = () => choose('continue');
      r.end.onclick = () => choose('end');
    });
    abandonLull = () => choose('abandoned');
  });
}

// Settles a lull nobody is going to answer, because its meeting is no longer
// the one on screen. Deliberately not 'end': the meeting wasn't closed, it was
// walked away from, and marking it closed server-side would be a lie in the
// one field #164's pacing review reads.
function releasePendingLull() {
  if (abandonLull) abandonLull();
}

// #33: lets the user fork a new meeting sharing everything up to this round,
// without disturbing the one they're viewing. Only offered on restored/saved
// meetings (currentSessionId is set) — branching mid-generation isn't a case
// the UI supports.
function addBranchControl(headerEl, roundIndex) {
  const btn = document.createElement('button');
  btn.className = 'branch-from-here-btn';
  btn.title = 'Branch from here — explore an alternate path from this point';
  btn.textContent = '⑂ Branch';
  btn.onclick = () => branchFromRound(roundIndex);
  headerEl.appendChild(btn);
}

async function branchFromRound(roundIndex) {
  if (!currentSessionId) return;
  if (
    !confirm(
      'Branch from this lull? A new meeting is created sharing everything up to here, and you continue from there — the original stays untouched.'
    )
  )
    return;
  setStatus('Branching...', true);
  try {
    const res = await fetch(`/api/sessions/${currentSessionId}/branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roundIndex }),
    });
    if (!res.ok) throw new Error('Branch failed');
    const { sessionId } = await res.json();
    await window.Sessions.restoreSession(sessionId);
    if (document.getElementById('sessions-drawer')?.classList.contains('open')) window.Sessions.loadSessionsList();
    setStatus('New branch created. The room continues from here.', false);
  } catch (e) {
    setStatus('Could not create the branch.', false);
  }
}

// Escape HTML to avoid injecting from model output, then transform asterisk-actions.
function escapeHTML(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Swaps a broken <img class="...-portrait"> for its pre-portrait placeholder
// (dot or glyph) in place, so a member missing a portrait still reads fine.
function portraitFallback(img, kind, glyph) {
  const el = document.createElement(kind === 'dot' ? 'div' : 'span');
  el.className = kind === 'dot' ? 'member-dot' : 'speaker-glyph';
  if (glyph) el.textContent = glyph;
  img.replaceWith(el);
}

// Two passes:
//   1. A whole line wrapped in *...* becomes a block-level action (own paragraph).
//   2. Inline *...* becomes an inline keyword/emphasis span -- #373: this is
//      NOT action text (voice.js speaks it, unlike a whole-line action --
//      see its stripForSpeech), so it gets its own class/style rather than
//      reusing action-line's look, which reads as the same silently-skipped
//      stage business.
// Empty actions (** or * *) are left alone.
function renderActions(text) {
  const safe = escapeHTML(text);
  return safe
    .split('\n')
    .map(line => {
      const trimmed = line.trim();
      const m = trimmed.match(/^\*(.+)\*$/);
      if (m && !m[1].includes('*')) {
        return `<div class="action-line">${m[1]}</div>`;
      }
      return line.replace(/\*([^*\n]+?)\*/g, '<span class="keyword-inline">$1</span>');
    })
    .join('<br>');
}

// ── Speaker glyphs ────────────────────────────────────────────────────────────
// Symbols rendered beside each speaker's name. Sourced from roster.json (via
// MEMBERS, fetched from /api/members) so every member has one, including
// those added through the character workflow — see #80.

function memberGlyph(memberId) {
  const m = memberId && MEMBERS.find(mm => mm.id === memberId);
  return m?.glyph || '';
}

let _entryCounter = 0;
let lastSpeakerId = null;
let currentSpeakerSide = 'right'; // first real speaker flips to 'left'

// Flip side when the speaker changes; same speaker keeps the same side.
// "—" is the parser's fallback for unattributed text — treat it as transparent
// so it inherits the current side without triggering a flip or updating tracking.
function getSpeakerSide(speakerId) {
  if (speakerId === '—') return currentSpeakerSide;
  if (speakerId !== lastSpeakerId) {
    currentSpeakerSide = currentSpeakerSide === 'left' ? 'right' : 'left';
    lastSpeakerId = speakerId;
  }
  return currentSpeakerSide;
}

// ── Record scroll (#184) ──────────────────────────────────────────────────────
// The record is now a bounded, internally-scrolling pane rather than an
// unbounded growing column. Stick to bottom while the user hasn't scrolled
// away; the moment they do, stop auto-scrolling and surface a "↓ live" pill
// rather than yanking them back mid-read. recordAttached is the single
// source of truth both the scroll listener and every append call site read.
let recordAttached = true;

function recordScrollEl() {
  return document.getElementById('record-scroll');
}

function initRecordScroll() {
  const el = recordScrollEl();
  const pill = document.getElementById('record-live-pill');
  if (!el || !pill) return;
  el.addEventListener('scroll', () => {
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom && !recordAttached) {
      recordAttached = true;
      pill.classList.remove('visible');
    } else if (!atBottom && recordAttached) {
      recordAttached = false;
      pill.classList.add('visible');
    }
  });
  pill.addEventListener('click', jumpToLive);
}

// Called after every record append in place of the old unconditional
// `c.scrollTop = c.scrollHeight`. A fresh/empty record has recordAttached
// still true by default, so restoring a past session naturally scrolls
// through to its end as it renders, same as today's incidental behavior.
function recordFollow() {
  const el = recordScrollEl();
  if (el && recordAttached) el.scrollTop = el.scrollHeight;
}

function jumpToLive() {
  recordAttached = true;
  const el = recordScrollEl();
  if (el) el.scrollTop = el.scrollHeight;
  document.getElementById('record-live-pill')?.classList.remove('visible');
}

function addSpeech(speaker, text, isObserver, memberId, existingAnnotation) {
  const c = document.getElementById('transcript-content');
  // If every non-empty line is wrapped in *...*, render as centered action line(s) with
  // no bubble and no speaker-side update. Handles both single and multi-line action blocks.
  const nonEmptyLines = text
    .trim()
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  const allAction = nonEmptyLines.length > 0 && nonEmptyLines.every(l => /^\*[^*]+\*$/.test(l));
  if (allAction) {
    nonEmptyLines.forEach(l => {
      const d = document.createElement('div');
      d.className = 'action-line';
      d.textContent = l.slice(1, -1);
      c.appendChild(d);
    });
    recordFollow();
    transcriptText += nonEmptyLines.join('\n') + '\n\n';
    return;
  }
  const e = document.createElement('div');
  const entryId = `entry-${++_entryCounter}`;
  const side = getSpeakerSide(memberId || speaker);
  e.className = `transcript-entry bubble-${side}`;
  e.dataset.entryId = entryId;
  e.dataset.speaker = speaker;
  if (currentRenderRound != null) e.dataset.round = currentRenderRound;
  let nc;
  if (isObserver) nc = 'observer-voice';
  else if (memberId) nc = `voice-${memberId}`;
  else nc = '';
  const glyph = memberId
    ? `<img class="speaker-avatar" src="/portraits/${memberId}.png" alt="" loading="lazy" onerror="portraitFallback(this,'glyph','${memberGlyph(memberId)}')">`
    : '';
  const nameEl = `<div class="speaker-name ${nc}" ${memberId ? `onclick="window.Sessions.highlightDossierEntry('${memberId}')" style="cursor:pointer"` : ''}>${glyph}${escapeHTML(speaker)}</div>`;
  e.innerHTML = `${nameEl}<div class="bubble-body"><div class="speech-text" onclick="toggleAnnotation(this.closest('.transcript-entry'))" title="Click to add a scholarly note">${renderActions(text)}</div><div class="annotation-area" style="display:none"><textarea class="annotation-input" placeholder="Note…" onblur="saveAnnotation(this)" onkeydown="if(event.key==='Escape')closeAnnotation(this.closest('.transcript-entry'))"></textarea></div></div>`;
  if (existingAnnotation) {
    e.classList.add('annotated');
    e.querySelector('.annotation-input').value = existingAnnotation;
  }
  c.appendChild(e);
  recordFollow();
  // Skip "—" fallback speaker — it's a parser artefact, not real speech
  if (speaker !== '—') transcriptText += `${speaker} —\n${text}\n\n`;
}

function toggleAnnotation(entry) {
  const area = entry.querySelector('.annotation-area');
  const isOpen = area.style.display !== 'none';
  if (isOpen) {
    closeAnnotation(entry);
  } else {
    area.style.display = 'block';
    area.querySelector('textarea').focus();
    entry.classList.add('annotating');
  }
}

function closeAnnotation(entry) {
  entry.querySelector('.annotation-area').style.display = 'none';
  entry.classList.remove('annotating');
}

async function saveAnnotation(textarea) {
  const entry = textarea.closest('.transcript-entry');
  const note = textarea.value.trim();
  entry.classList.toggle('annotated', !!note);
  if (!currentSessionId) return;
  // Collect all annotations across all entries
  const all = [...document.querySelectorAll('.transcript-entry')]
    .map(e => ({
      entryId: e.dataset.entryId,
      speaker: e.dataset.speaker,
      note: e.querySelector('.annotation-input')?.value.trim() || '',
    }))
    .filter(a => a.note);
  await fetch(`/api/sessions/${currentSessionId}/annotations`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ annotations: all }),
  }).catch(() => {});
  window.Export.updateScholarlyExportButton();
}

// ── Speaker attribution ────────────────────────────────────────────────────
// normalizeSpeaker/buildAliasIndex/resolveMember/isKnownSpeakerHeader moved to
// public/js/speaker.js (#285) -- window.Speaker. Pure text matching with no
// UI-feature seam of its own, unlike the #142 extractions; its one read of
// core state (currentPlayerSpeakerName, for custom player identities) goes
// through speakerDeps() below rather than a closure, same as everywhere else.

// #219: deliberately not beat-split, unlike startStreamEntry's live path and
// witness.js's stage replay. This is the record pane's parser -- used both
// as the streaming safety net (finalize() below) and, via sessions.js's
// restoreSession, to rebuild the record for EVERY saved session on load.
// Saved annotations are keyed by entryId, a plain sequential counter
// (`entry-${++_entryCounter}` in addSpeech) with no meaning beyond "the Nth
// bubble this parse produced" -- restoring an old, annotated session has to
// reproduce the exact same bubble count and order it had when the
// annotation was saved, or the note lands on the wrong bubble. Splitting
// turns into beats here would change that count for every existing
// annotated session the moment this ships. The stage has no such
// constraint (#184: stage entries carry no entryId, annotation stays
// exclusively in the record), and a freshly-streamed turn's beats get their
// entryId for the first time, so both of those split safely; this doesn't.
function parseAndRenderTranscript(response) {
  const c0 = document.getElementById('transcript-content');
  const lines = response.split('\n');
  let speaker = null,
    textLines = [];

  const flush = () => {
    if (speaker && textLines.length) {
      const text = textLines.join('\n').trim();
      const m = window.Speaker.resolveMember(speaker, MEMBERS);
      addSpeech(speaker, text, false, m?.id, null);
      // If the block was pure action, preserve speaker so the next speech
      // (without a repeated header) still gets attributed correctly.
      const nonEmpty = text
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
      const wasPureAction = nonEmpty.length > 0 && nonEmpty.every(l => /^\*[^*]+\*$/.test(l));
      if (!wasPureAction) speaker = null;
      textLines = [];
    }
  };

  lines.forEach(line => {
    const t = line.trim();
    if (!t) {
      flush();
      return;
    }
    // Skip model-generated dividers and bare em-dashes
    if (t === '---' || t === '—' || t === '--') return;
    // Unattributed action line between speakers — render directly, no speaker needed
    const isActionLine = /^\*[^*\n]+\*$/.test(t);
    if (isActionLine && !speaker) {
      const d = document.createElement('div');
      d.className = 'action-line';
      d.textContent = t.slice(1, -1);
      c0.appendChild(d);
      recordFollow();
      transcriptText += `${t}\n\n`;
      return;
    }
    const isKnownName = window.Speaker.isKnownSpeakerHeader(t, MEMBERS);
    const looksLikeName = !t.includes(' ') && t.endsWith(':') && t.length < 30;
    if (isKnownName || looksLikeName) {
      flush();
      speaker = t.replace(/:$/, '');
      textLines = [];
    } else if (speaker) {
      textLines.push(t);
    } else {
      speaker = '—';
      textLines.push(t);
    }
  });
  flush();
}

// ── Streaming ─────────────────────────────────────────────────────────────────

// Opens a streaming POST, yields chunks to onChunk, returns the done payload.
// onSpeaking/onSpeakerDone are optional (#115) -- the transcript panel's
// per-speaker live rendering; the 3D scene's own reaction to `speaking` is
// unconditional below, independent of whether a caller passes onSpeaking.
async function streamPost(url, body, onChunk, onSpeaking, onSpeakerDone) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Server error ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let donePayload = null;

  // finally, not just the data.done branch -- a thrown mid-stream error
  // (data.error, or the reader itself failing) must not leave a seat stuck
  // glowing as "speaking" with no generation actually in flight.
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (!raw.startsWith('data: ')) continue;
        const data = JSON.parse(raw.slice(6));
        if (data.error) throw new Error(data.error);
        if (data.done) {
          donePayload = data;
        } else if (data.text) {
          onChunk(data.text);
        } else if (data.speaking) {
          window.LodgeScene?.setSpeaking(data.speaking);
          onSpeaking?.(data.speaking);
        } else if (data.speakerDone) {
          onSpeakerDone?.(data.speakerDone);
        } else if (data.pool) {
          // #360: the director's candidate pool, so the scene can tell a
          // present member who might speak next ("thinking") apart from one
          // who's present but not in contention ("listening").
          window.LodgeScene?.setPool(data.pool);
        } else if (data.disposition) {
          // #360: waitingOnMemberId from the just-finished beat's disposition
          // update (#203's own signal) — a member wanting back in reads as
          // "waiting" until their disposition next changes.
          window.LodgeScene?.setDisposition(data.disposition.memberId, data.disposition.waitingOnMemberId);
        }
      }
    }
  } finally {
    window.LodgeScene?.setSpeaking(null);
  }
  return donePayload;
}

// #115: each speaker's turn renders as a proper attributed bubble the
// instant it settles (onSpeakerDone), not just after the whole round
// finishes. A lightweight "typing" placeholder shows raw text growing for
// whoever's currently generating (onSpeaking creates it, named via the
// roster; append grows it) -- then gets swapped for the real addSpeech
// bubble the moment that speaker's settled text arrives, since only then do
// we know whether the block is a normal turn or a pure-action line (addSpeech
// decides that from the complete text, which isn't knowable mid-stream).
//
// #219: a turn is no longer one bubble -- window.Beats.splitIntoBeats runs
// on the growing buffer after every chunk, and every beat but the last is
// stable the moment it appears (see that function's own comment), so it's
// swapped from "typing" to a real bubble immediately, same speaker, fresh
// typing placeholder opened for whatever comes next. onSpeakerDone's
// settled text is the authority for whichever beats hadn't closed yet by
// the time the turn actually finished (closedBeats tracks how many were
// already flushed live, so it never re-renders one twice).
//
// #184: every stage change here has a matching window.Witness.live*() call
// right after it, mirroring the same beat into the stage a moment after the
// record gets it -- the stage renders its own lightweight copy (see
// witness.js's top-of-file comment), it never reads these DOM nodes.
//
// finalize() only falls back to the old whole-text reparse if nothing
// rendered live this round -- a safety net, not the normal path, so a
// missed or malformed speakerDone event can't silently drop content. In that
// rare case the record still gets the round correctly (as single bubbles
// per turn, not beat-split -- see parseAndRenderTranscript's own note on
// why it stays that way); only the stage misses mirroring it, self-healing
// on the next round's beats.
function startStreamEntry() {
  const c = document.getElementById('transcript-content');
  let typingEl = null;
  let renderedLive = false;
  let buffer = '';
  let closedBeats = 0;
  let speakerName = '';
  let speakerMemberId = null;

  function removeTyping() {
    if (typingEl) {
      typingEl.remove();
      typingEl = null;
    }
    window.Witness.liveClearTyping();
  }

  function openTyping() {
    typingEl = document.createElement('div');
    typingEl.className = 'transcript-typing';
    typingEl.innerHTML = `<div class="speaker-name">${escapeHTML(speakerName)}</div><div class="typing-text transcript-stream-live"></div>`;
    c.appendChild(typingEl);
    recordFollow();
    window.Witness.liveTypingStart(speakerName, speakerMemberId || null);
  }

  return {
    append(chunk) {
      if (!typingEl) return; // nothing streaming yet worth showing raw (e.g. the name-header chunk before onSpeaking fires)
      buffer += chunk;
      const beats = window.Beats.splitIntoBeats(buffer);
      if (!beats.length) return;

      // Every beat but the last is stable -- close it as a real bubble now
      // instead of waiting for the whole turn, and open a fresh typing
      // placeholder for the same speaker.
      while (closedBeats < beats.length - 1) {
        const settled = beats[closedBeats];
        removeTyping();
        addSpeech(speakerName, settled, false, speakerMemberId || undefined, null);
        window.Witness.liveSpeech({ speaker: speakerName, text: settled, memberId: speakerMemberId || null });
        closedBeats++;
        openTyping();
      }

      typingEl.querySelector('.typing-text').textContent = beats[beats.length - 1];
      recordFollow();
      window.Witness.liveTypingSet(beats[beats.length - 1]);
    },
    onSpeaking(memberId) {
      removeTyping();
      buffer = '';
      closedBeats = 0;
      const m = MEMBERS.find(mm => mm.id === memberId);
      speakerName = m?.name || '…';
      speakerMemberId = memberId;
      openTyping();
    },
    onSpeakerDone({ memberId, name, text }) {
      removeTyping();
      // The remaining beats -- whatever hadn't already closed live -- come
      // from the settled text, which is authoritative (post-trim, post-
      // stripInternalBlankLines) rather than the raw streamed buffer.
      const beats = window.Beats.splitIntoBeats(text);
      beats.slice(closedBeats).forEach(beatText => {
        addSpeech(name, beatText, false, memberId || undefined, null);
        window.Witness.liveSpeech({ speaker: name, text: beatText, memberId: memberId || null });
      });
      renderedLive = true;
      buffer = '';
      closedBeats = 0;
    },
    finalize(fullText) {
      removeTyping();
      if (!renderedLive) parseAndRenderTranscript(fullText);
    },
    abort() {
      removeTyping();
    },
  };
}

// ── Error recovery ────────────────────────────────────────────────────────────

function setError(msg, retryFn) {
  pendingRetry = retryFn;
  const el = document.getElementById('status-bar');
  el.innerHTML = `<span>${msg}</span><button class="lodge-btn status-retry-btn" onclick="retryFromError()">Try again</button>`;
  el.className = 'status-bar error';
  setEmber(false);
}

async function retryFromError() {
  if (!pendingRetry) return;
  const fn = pendingRetry;
  pendingRetry = null;
  document.getElementById('status-bar').className = 'status-bar';
  await fn();
}

// ── Day One / File import / Export ───────────────────────────────────────────
// Extracted to public/export.js (#142) -- window.Export. getEntry() is called
// from convene() below via window.Export.getEntry().

// ── Convene ───────────────────────────────────────────────────────────────────

async function convene() {
  const entry = window.Export.getEntry();
  if (!entry) {
    setStatus('The room requires a provocation.', false);
    return;
  }
  if (activeMembers.size < 2) {
    setStatus('At least two must be present.', false);
    return;
  }

  releasePendingLull();
  document.getElementById('transcript-empty').style.display = 'none';
  document.getElementById('transcript-content').innerHTML = '';
  window.Witness.liveReset();
  _entryCounter = 0;
  recordAttached = true;
  document.getElementById('record-live-pill')?.classList.remove('visible');

  lastSpeakerId = null;
  currentSpeakerSide = 'right';
  document.getElementById('convene-btn').disabled = true;
  document.getElementById('after-panel').className = 'after-panel';
  document.getElementById('interject-form').style.display = 'none';
  closeAllAfterMenus();

  currentSessionId = null;
  segmentCount = 0;
  sessionDate = new Date().toISOString().split('T')[0];
  window.LodgeScene?.setPassageCount(0);
  // #356: a fresh room starts with nothing to cite -- clear the signal a
  // previously-restored session may have set.
  window.Export.setSessionHasCitations(false);

  // Re-enable the "Play as" controls in case the last thing shown was a
  // restored (read-only) session — restorePlayAsControlDisplay() disables them.
  ['play-as-mode-select', 'play-as-member-select', 'play-as-custom-name'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = false;
  });

  // Snapshot "Play as" state — a mid-session change to the (now-hidden) controls
  // should never affect an in-flight session.
  playerMode = document.getElementById('play-as-mode-select')?.value || 'none';
  playerMemberId = playerMode === 'member' ? document.getElementById('play-as-member-select')?.value || null : null;
  playerName = playerMode === 'custom' ? document.getElementById('play-as-custom-name')?.value.trim() || null : null;
  currentPlayerSpeakerName =
    playerMode === 'member'
      ? MEMBERS.find(m => m.id === playerMemberId)?.name || null
      : playerMode === 'custom'
        ? playerName
        : null;
  sessionPlayerTurns = [];
  playerTurnsRevealed = false;
  document.getElementById('transcript-panel')?.classList.remove('reveal-player-turns');

  const members = [...activeMembers];
  const memberNames = members
    .map(id => MEMBERS.find(m => m.id === id)?.name)
    .filter(Boolean)
    .join(', ');
  const entryForHeader = window.Export.getEntry();
  transcriptText = `THE SECRET-CABIN-ET\nMeeting Notes — ${sessionDate}\nAssembled: ${memberNames}\n\nSource material:\n${entryForHeader}\n`;

  const artifactText = document.getElementById('artifact-text')?.value.trim();
  const artifactMemberId = document.getElementById('artifact-member')?.value;
  const artifact = artifactText && artifactMemberId ? { text: artifactText, memberId: artifactMemberId } : null;
  const notes = window.Sessions.collectSessionNotes();

  try {
    // The opening passage. Nothing decides how many follow it — see runLullLoop.
    const playerTurn1 = isPlayerActive() ? await awaitPlayerTurn('The room gathers') : null;
    setStatus('The room is speaking.', true);
    const txtBefore1 = transcriptText;
    setRenderSegment(0);
    const s1 = startStreamEntry();
    let d1;
    try {
      d1 = await streamPost(
        '/api/convene',
        {
          entry,
          members,
          artifact,
          notes,
          sourceSessionId: currentSourceSessionId || undefined,
          playerMode,
          playerMemberId,
          playerName,
          playerTurn: playerTurn1 || undefined,
          castMetrics: window.Casting.consumeMetrics(),
        },
        chunk => s1.append(chunk),
        s1.onSpeaking,
        s1.onSpeakerDone
      );
      s1.finalize(d1.text);
      currentSessionId = d1.sessionId;
      segmentCount = 1;
      window.Sessions.buildDossier(members);
      if (playerTurn1) {
        sessionPlayerTurns.push({ round: 0, speakerName: currentPlayerSpeakerName, text: playerTurn1.text });
        applyPlayerTurnMarkers(sessionPlayerTurns);
      }
    } catch (err) {
      s1.abort();
      transcriptText = txtBefore1;
      const msg =
        err.message && !err.message.startsWith('Server error')
          ? err.message
          : 'The room could not begin. The fire may be low.';
      setError(msg, convene);
      return;
    }

    await runLullLoop(d1.label);
  } finally {
    document.getElementById('convene-btn').disabled = false;
  }
}

// #245: the meeting, as it now is — passage, lull, and whatever the user
// decides at the lull. The old shape (a `for` loop bounded by a number picked
// before anyone spoke) is gone entirely; this loop has no exit condition of
// its own, only the two the user chooses between.
async function runLullLoop(lullNote) {
  let note = lullNote;
  while (true) {
    const lull = addLullDivider(note, segmentCount - 1);
    const stageLull = window.Witness.liveLull(note);
    setStatus(note, false);
    const choice = await awaitLull([lull, stageLull]);
    if (choice === 'abandoned') return;
    if (choice === 'end') {
      await closeMeeting();
      return;
    }
    const next = await runPassage(note);
    if (next === null) return; // the error is on screen with its own retry
    note = next;
  }
}

// One passage into an open session. Returns the lull note that ended it, or
// null if it failed (the caller stops; the retry link resumes the loop).
async function runPassage(lullNote) {
  const idx = segmentCount;
  const playerTurn = isPlayerActive() ? await awaitPlayerTurn(lullNote) : null;
  setStatus('The room takes it up again.', true);
  await new Promise(r => setTimeout(r, 300));
  const txtBefore = transcriptText;
  setRenderSegment(idx);
  const s = startStreamEntry();
  try {
    const d = await streamPost(
      '/api/round',
      { sessionId: currentSessionId, playerTurn: playerTurn || undefined },
      chunk => s.append(chunk),
      s.onSpeaking,
      s.onSpeakerDone
    );
    s.finalize(d.text);
    segmentCount = idx + 1;
    if (playerTurn) {
      sessionPlayerTurns.push({ round: idx, speakerName: currentPlayerSpeakerName, text: playerTurn.text });
      applyPlayerTurnMarkers(sessionPlayerTurns);
    }
    return d.label;
  } catch (err) {
    s.abort();
    transcriptText = txtBefore;
    showSessionControls();
    setError('The room could not go on.', () => resumeMeeting(lullNote));
    return null;
  }
}

// Retry path for a passage that failed mid-meeting: run it again from the lull
// it stalled at, then hand back to the loop as if nothing had happened.
async function resumeMeeting(lullNote) {
  if (!currentSessionId) return;
  document.getElementById('convene-btn').disabled = true;
  try {
    const next = await runPassage(lullNote);
    if (next !== null) await runLullLoop(next);
  } finally {
    document.getElementById('convene-btn').disabled = false;
  }
}

// "Let it end" — the user's own end-cause. #244 defined `closed` as the third
// one but left it unreachable server-side, because it isn't the room's
// decision to make; this is the action that reaches it. Best-effort: a meeting
// that ended is ended whether or not the marker saved.
async function closeMeeting() {
  showSessionControls();
  window.Witness.collapseStage();
  setStatus('The meeting has found its natural pause. The embers hold.', false);
  try {
    await fetch(`/api/sessions/${currentSessionId}/close`, { method: 'POST' });
  } catch (e) {
    console.warn('Could not record the meeting close', e);
  }
}

function showSessionControls() {
  document.getElementById('after-panel').className = 'after-panel visible';
  document.getElementById('verify-citations-btn').className = 'lodge-btn visible';
  document.getElementById('reveal-player-turns-btn').className =
    'lodge-btn' + (sessionPlayerTurns.length ? ' visible' : '');
  window.Export.updateScholarlyExportButton();
}

// ── Citation verification ────────────────────────────────────────────────────

// A speech turn can contain more than one citation — worst verdict wins the
// border color (so a hallucination is never masked by a verified one in the
// same turn), and all notes are concatenated rather than the last one clobbering
// the rest.
const CITATION_VERDICT_SEVERITY = { unverified: 2, uncertain: 1, verified: 0 };

// #153 part 3 — how a verdict was actually reached, not just what it landed
// on. Missing on pre-#153 sessions (citationFlags saved before this field
// existed) — default to 'model-knowledge' there, since that was the only
// method available at the time, not 'library' (which would overstate it).
const CITATION_SOURCE_LABEL = {
  library: 'checked against curated text',
  web: 'checked via live lookup',
  'model-knowledge': "Claude's own knowledge",
};

function applyCitationFlags(citations) {
  // Strip markdown emphasis asterisks (renderActions() strips them from the
  // rendered DOM, but the model quotes verbatim from the raw *marked-up*
  // transcript) and collapse whitespace, on both sides of the comparison.
  const norm = s => s.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
  const byEntry = new Map();
  citations.forEach(flag => {
    // The verification call is fed session.transcriptText, where the server's
    // formatTranscriptText() appends " —" to speaker header lines; the
    // client's dataset.speaker never has that suffix — strip it before matching.
    const speaker = flag.speaker.replace(/\s*—\s*$/, '').trim();
    const candidates = [...document.querySelectorAll('.transcript-entry')]
      .filter(e => e.dataset.speaker === speaker)
      .filter(e => norm(e.querySelector('.speech-text')?.textContent || '').includes(norm(flag.quote)));
    if (candidates.length !== 1) {
      console.warn('Citation flag did not match exactly one entry:', flag, candidates.length);
      return;
    }
    const entry = candidates[0];
    if (!byEntry.has(entry)) byEntry.set(entry, []);
    byEntry.get(entry).push(flag);
  });
  byEntry.forEach((flags, entry) => {
    const worst = flags.reduce((a, b) =>
      CITATION_VERDICT_SEVERITY[b.verdict] > CITATION_VERDICT_SEVERITY[a.verdict] ? b : a
    );
    entry.classList.add('flagged-citation', `citation-${worst.verdict}`);
    const speechEl = entry.querySelector('.speech-text');
    speechEl.title = flags
      .map(f => {
        const sourceLabel = CITATION_SOURCE_LABEL[f.source || 'model-knowledge'];
        const groundedIn = f.libraryCitation || f.webSourceTitle;
        return `[${sourceLabel}] ${f.note}` + (groundedIn ? `\nGrounded in: ${groundedIn}` : '');
      })
      .join('\n\n');
    // #30 — archival image synced to whichever cited work has one, alongside the speech block.
    const withImage = flags.find(f => f.libraryImage);
    if (withImage) attachArchivalImage(entry, withImage);
  });
}

// Appends a thumbnail of the cited work's archival image, linked out to its
// archive.org source. One per speech block — if several citations in the same
// turn have images, the first (see byEntry ordering above) wins rather than
// stacking a gallery.
function attachArchivalImage(entry, flag) {
  const body = entry.querySelector('.bubble-body');
  if (!body || body.querySelector('.archival-image')) return;
  const caption = escapeHTML(flag.libraryCitation || flag.work || 'Archival source');
  const href = flag.librarySourceUrl
    ? ` href="${escapeHTML(flag.librarySourceUrl)}" target="_blank" rel="noopener"`
    : '';
  const tag = flag.librarySourceUrl ? 'a' : 'span';
  const fig = document.createElement('div');
  fig.className = 'archival-image';
  fig.innerHTML = `<${tag} class="archival-image-link"${href} title="${caption}">
      <img src="/${escapeHTML(flag.libraryImage)}" alt="${caption}" loading="lazy">
    </${tag}>`;
  body.appendChild(fig);
}

async function verifyCitations() {
  if (!currentSessionId) return;
  const btn = document.getElementById('verify-citations-btn');
  btn.disabled = true;
  setStatus('Cross-referencing citations...', true);
  try {
    const res = await fetch(`/api/sessions/${currentSessionId}/verify-citations`, { method: 'POST' });
    if (!res.ok) throw new Error('Verification failed');
    const { citations } = await res.json();
    applyCitationFlags(citations);
    window.Export.updateScholarlyExportButton();
    setStatus(`${citations.length} citation${citations.length === 1 ? '' : 's'} reviewed.`, false);
  } catch (err) {
    setError('Citation verification failed.', verifyCitations);
  } finally {
    btn.disabled = false;
  }
}

// ── Player turn markers ──────────────────────────────────────────────────────
// Invisible during live play (full immersion — a player turn renders exactly
// like an AI turn); tracked precisely by round index so it can be revealed
// on demand and always included in exports. No fuzzy matching needed here,
// unlike citation flags — the round index is exact, not inferred.

function applyPlayerTurnMarkers(playerTurns) {
  (playerTurns || []).forEach(pt => {
    const entry = document.querySelector(`.transcript-entry[data-round="${pt.round}"]`);
    if (entry) entry.classList.add('player-turn');
  });
}

function togglePlayerTurnReveal() {
  playerTurnsRevealed = !playerTurnsRevealed;
  document.getElementById('transcript-panel').classList.toggle('reveal-player-turns', playerTurnsRevealed);
  document.getElementById('reveal-player-turns-btn').textContent = playerTurnsRevealed
    ? 'Hide Player Turns ◆'
    : 'Reveal Player Turns ◆';
}

// ── Stir the room again ──────────────────────────────────────────────────────
// #245: "One More Turn" was round vocabulary and retires with the rounds. What
// it *did* survives, under a name for what it actually is — re-stirring a
// meeting that already closed, which is a different act from continuing one
// that's merely paused (that's the lull's Continue). One passage, then the
// room settles back into its after-state rather than reopening the lull loop.
//
// Player turns stay AI-only here, as they were before (v1 scope limit); the
// segment index is still tagged so its entries remain addressable.

async function stirRoom() {
  if (!currentSessionId) return;
  const btn = document.getElementById('stir-room-btn');
  btn.disabled = true;
  const idx = segmentCount;
  setStatus('The room is stirred, and takes it up again.', true);
  const txtBefore = transcriptText;
  setRenderSegment(idx);
  const s = startStreamEntry();

  try {
    const d = await streamPost(
      '/api/round',
      { sessionId: currentSessionId },
      chunk => s.append(chunk),
      s.onSpeaking,
      s.onSpeakerDone
    );
    s.finalize(d.text);
    segmentCount = idx + 1;
    addLullDivider(d.label, idx);
    window.Witness.liveLull(d.label);
    await closeMeeting();
    setStatus('The embers hold a while longer.', false);
  } catch (err) {
    s.abort();
    transcriptText = txtBefore;
    setError('The room could not be stirred.', stirRoom);
  } finally {
    btn.disabled = false;
  }
}

// ── Interject ─────────────────────────────────────────────────────────────────

function toggleInterjectForm() {
  const form = document.getElementById('interject-form');
  const showing = form.style.display !== 'none';
  form.style.display = showing ? 'none' : 'flex';
  if (!showing) document.getElementById('interject-input').focus();
}

async function interject() {
  if (!currentSessionId) return;
  const input = document.getElementById('interject-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  document.getElementById('interject-form').style.display = 'none';
  lastInterjectText = text;

  addRoundHeader('A Presence Passes Through');
  window.Witness.liveRoundHeader('A Presence Passes Through');
  addSpeech('— a voice from elsewhere —', text, true, undefined, undefined);
  window.Witness.liveSpeech({ speaker: '— a voice from elsewhere —', text, memberId: null });
  setStatus('The room notices...', true);
  await sendInterject(text);
}

async function sendInterject(text) {
  const s = startStreamEntry();
  try {
    const d = await streamPost(
      '/api/interject',
      { sessionId: currentSessionId, text },
      chunk => s.append(chunk),
      s.onSpeaking,
      s.onSpeakerDone
    );
    s.finalize(d.text);
    lastInterjectText = '';
    setStatus('The presence withdraws. The room continues.', false);
  } catch (err) {
    s.abort();
    setError('The interjection went unheard.', () => sendInterject(lastInterjectText));
  }
}

// ── Export ────────────────────────────────────────────────────────────────────
// buildAnnotatedTranscript/getAnnotatedPassages/updateScholarlyExportButton/
// renderBibliography/exportScholarly moved to public/export.js (#142) --
// window.Export. reconveneOnCurrentSession below stays here (core convene-flow
// state) and calls window.Export.buildAnnotatedTranscript().

function reconveneOnCurrentSession() {
  if (!currentSessionId || !transcriptText) return;
  const FILE_TEXT_LIMIT = 4000;
  const full = window.Export.buildAnnotatedTranscript();
  const truncated =
    full.length > FILE_TEXT_LIMIT ? full.slice(0, FILE_TEXT_LIMIT) + '\n\n[transcript truncated]' : full;

  currentEntry = truncated;
  currentSourceSessionId = currentSessionId;

  // Scroll to top and show document panel with transcript loaded
  document.getElementById('paste-area-container').style.display = 'none';
  document.getElementById('fetched-display').style.display = 'block';
  const display = document.getElementById('entry-display');
  display.textContent = truncated;
  display.classList.remove('placeholder');
  document.getElementById('entry-date-tag').textContent = sessionDate || '';
  document.getElementById('entry-journal-tag').textContent = '↩ Prior transcript';

  const sel = document.getElementById('source-select');
  const opt = document.createElement('option');
  opt.value = `transcript:${currentSessionId}`;
  opt.textContent = `Transcript — ${sessionDate}`;
  opt.selected = true;
  sel.prepend(opt);
  sel.value = `transcript:${currentSessionId}`;

  // Clear transcript view so user starts fresh
  releasePendingLull();
  document.getElementById('transcript-content').innerHTML = '';
  document.getElementById('after-panel').className = 'after-panel';
  document.getElementById('interject-form').style.display = 'none';
  closeAllAfterMenus();
  segmentCount = 0;
  currentSessionId = null;
  transcriptText = '';
  // #356: the transcript now on the table hasn't been re-parsed into beats
  // yet, so any citation signal from before belongs to the session just left.
  window.Export.setSessionHasCitations(false);

  window.scrollTo({ top: 0, behavior: 'smooth' });
  setStatus('The transcript has been placed on the table. Assemble a new room and reconvene.', false);
}

// ── Continue / Preserve menus ───────────────────────────────────────────────
// #74 folded a sprawling after-meeting panel into fewer controls once already;
// #186 does it again by naming the two verbs directly. Continue's four items
// (one more turn, interject, reconvene, branch) and Preserve's exports were
// all top-level buttons before this -- now they live behind one menu each,
// opened/closed the same way as the sessions/dossier drawers elsewhere in
// this file, just anchored to their button instead of sliding from the edge.

function closeAllAfterMenus() {
  document.querySelectorAll('.lodge-menu.open').forEach(m => m.classList.remove('open'));
}

function toggleAfterMenu(menuId) {
  const menu = document.getElementById(menuId);
  const wasOpen = menu.classList.contains('open');
  closeAllAfterMenus();
  if (!wasOpen) menu.classList.add('open');
}

// A click anywhere outside a menu-wrap closes whatever's open; a click on an
// item inside a menu (an export, "One More Turn", etc.) closes it too, since
// every item here is a one-shot action rather than a toggle worth leaving open.
document.addEventListener('click', e => {
  if (e.target.closest('.lodge-menu')) {
    closeAllAfterMenus();
    return;
  }
  if (!e.target.closest('.menu-wrap')) closeAllAfterMenus();
});

// Continue's "Branch" item branches from the meeting's last lull, reusing the
// #33 branch machinery (normally only offered inline on a restored session's
// lulls) with the final segment index. #245 moved branch points from round
// boundaries to lulls, but a lull is checkpoint-consistent in exactly the way
// a round boundary was, so branchRound keeps its meaning and nothing stored
// needed migrating.
function branchFromLatestLull() {
  if (!currentSessionId || segmentCount < 1) return;
  branchFromRound(segmentCount - 1);
}

// ── Export settings drawer ──────────────────────────────────────────────────
// #186: Ulysses group/identifier, Obsidian vault, and the Day One journal
// label used to sit as standing fields in the after-panel; they're config,
// consulted rarely, not something the ritual space needs to show by default.

function openExportSettings() {
  closeAllAfterMenus();
  document.getElementById('export-settings-overlay').classList.add('open');
  document.getElementById('export-settings-drawer').classList.add('open');
}

function closeExportSettings() {
  document.getElementById('export-settings-overlay').classList.remove('open');
  document.getElementById('export-settings-drawer').classList.remove('open');
}

// ── Witness mode ──────────────────────────────────────────────────────────────
// The Witness UI/state machine lives in public/witness.js (#142), following
// the scene.js script-tag/IIFE convention -- window.Witness. What's left here
// is the bridge: resolving session data + live annotations (core
// transcript/session concerns app.js still owns) before handing off, and the
// handful of core helpers (member resolution, markup escaping, session
// restore) the module needs but doesn't own, passed in as arguments the same
// way updateSeats([...activeMembers]) hands scene.js a ready-made snapshot.

function collectLiveAnnotations() {
  const result = {};
  document.querySelectorAll('.transcript-entry.annotated').forEach(e => {
    const note = e.querySelector('.annotation-input')?.value.trim();
    const speaker = e.dataset.speaker;
    if (note && speaker) result[e.dataset.entryId] = { speaker, note };
  });
  return result;
}

// A no-op if the session being restored is already the one loaded -- avoids
// a redundant fetch/rerender when Witness starts back into the same session
// it was launched from. Returns the underlying promise (or a resolved one
// for the no-op case) so witness.js's start() can await it -- #184: the
// record must be synced *before* the stage begins rendering, since restoring
// clears the stage too (window.Witness.resetLiveStage()) and a race would
// wipe out the stage's own render.
function restoreSessionIfDifferent(id) {
  if (id !== currentSessionId) return window.Sessions.restoreSession(id);
  return Promise.resolve();
}

function witnessDeps() {
  return {
    members: MEMBERS,
    resolveMember: window.Speaker.resolveMember,
    isKnownSpeakerHeader: window.Speaker.isKnownSpeakerHeader,
    escapeHTML,
    renderActions,
    restoreSession: restoreSessionIfDifferent,
    // #219: witness.js splits each turn into beat bubbles on replay too,
    // via the same pure function app.js's live streaming uses -- injected
    // rather than read directly off window.Beats, per this module's own
    // "everything comes in as deps" convention.
    splitIntoBeats: window.Beats.splitIntoBeats,
    // #354: same convention, for the shared label-placement rule -- see
    // sessionsDeps' identical injection.
    labelOpensSegment: window.Record.labelOpensSegment,
  };
}

// "◎ Watch" button in the after-panel -- replays the session currently on
// screen. sessionData is only ever passed when called internally (never from
// the button, which always calls this with no arguments).
async function startWitness(sessionData) {
  let session = sessionData;
  if (!session) {
    if (!currentSessionId) return;
    session = await fetch(`/api/sessions/${currentSessionId}`).then(r => r.json());
    session.annotations = { ...(session.annotations || {}), ...collectLiveAnnotations() };
  }
  await window.Witness.start(session, witnessDeps());
}

// Entry point from Past Meetings drawer
async function startWitnessFromSession(id) {
  try {
    const session = await fetch(`/api/sessions/${id}`).then(r => r.json());
    window.Sessions.closeSessionsDrawer();
    await window.Witness.start(session, witnessDeps());
  } catch (e) {
    alert('Could not load session for playback.');
  }
}

// exportTxt/exportDayOne/exportObsidian/exportUlysses moved to
// public/export.js (#142) -- window.Export.

// Sessions drawer / Comparative mode / Dossier drawer moved to
// public/sessions.js (#142) -- window.Sessions.

// ── Add member modal ──────────────────────────────────────────────────────────

function openAddMemberModal() {
  document.getElementById('add-member-overlay').classList.add('open');
  document.getElementById('add-member-modal').classList.add('open');
  document.getElementById('add-member-name').focus();
}

function closeAddMemberModal() {
  document.getElementById('add-member-overlay').classList.remove('open');
  document.getElementById('add-member-modal').classList.remove('open');
}

async function submitNewMember() {
  const name = document.getElementById('new-member-name').value.trim();
  const bio = document.getElementById('new-member-bio').value.trim();
  const voiceRegister = document.getElementById('new-member-voice').value.trim();
  const cognitiveStyle = document.getElementById('new-member-cognitive').value.trim();
  const relationships = document.getElementById('new-member-relationships').value.trim();
  const statusEl = document.getElementById('add-member-status');
  const btn = document.getElementById('add-member-submit-btn');

  if (!name) {
    statusEl.textContent = 'A name is required.';
    return;
  }
  if (!bio) {
    statusEl.textContent = 'A biography is required.';
    return;
  }

  btn.disabled = true;
  statusEl.style.color = 'var(--lodge-amber)';
  statusEl.textContent = 'Drafting the character… the room makes room.';

  try {
    const res = await fetch('/api/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, bio, voiceRegister, cognitiveStyle, relationships }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unknown error');

    MEMBERS.push(data.member);
    renderMembers();

    // Clear form
    [
      'new-member-name',
      'new-member-bio',
      'new-member-voice',
      'new-member-cognitive',
      'new-member-relationships',
    ].forEach(id => {
      document.getElementById(id).value = '';
    });

    statusEl.style.color = 'var(--lodge-muted)';
    statusEl.textContent = `${data.member.name} has joined the lodge.`;
    setTimeout(closeAddMemberModal, 1400);
  } catch (e) {
    statusEl.style.color = '#a06060';
    statusEl.textContent = e.message || 'The invitation could not be sent.';
    btn.disabled = false;
  }
}

// applyEnvConfig/exportMd moved to public/export.js (#142) -- window.Export.

// ── Scene (3D) ──────────────────────────────────────────────────────────────
// Phase 0 (#26): pure atmosphere, no member sync yet — see public/scene/scene.js.

// #257: the room is the stage now, whenever it can be -- no more switcher to
// fall back from (that was #202, retired). "Scene unavailable" simply means
// never calling enableRoom(), which leaves witness.js's #witness-stage
// bubble rendering as the only thing that ever draws.
function initSceneLayer() {
  try {
    if (new URLSearchParams(location.search).get('noscene')) return;
    if (localStorage.getItem('sc-scene-disabled')) return;
    if (typeof BABYLON === 'undefined' || !window.LodgeScene) return;
    const canvas = document.getElementById('scene-canvas');
    if (!canvas) return;
    if (LodgeScene.init(canvas)) window.Witness?.enableRoom();
  } catch (e) {
    console.error('[scene] failed to initialize, continuing without it', e);
  }
}

// ── Casting triggers (#185) ───────────────────────────────────────────────────

// "On document paste" taken literally, rather than debouncing every keystroke:
// the proposal fires on the paste event itself, on a committed edit (change =
// blur, for the typed case), and on the hook export.js calls when a Day One /
// library / file document finishes loading. window.Casting does the rest of
// the gating — it won't repeat for the same document, and won't fire at all
// once the user has hand-cast.
function autoProposeCast() {
  // Clicking Convene blurs the textarea, which fires `change`. Casting a room
  // that is already assembling is pure waste — and the one call this feature
  // is allowed per session shouldn't be spent on it.
  if (document.getElementById('convene-btn')?.disabled) return;
  window.Casting.requestProposal({ auto: true });
}

function initCastingTriggers() {
  const area = document.getElementById('paste-area');
  if (!area) return;
  // Paste fires before the textarea's value updates; defer a tick.
  area.addEventListener('paste', () => setTimeout(autoProposeCast, 0));
  area.addEventListener('change', autoProposeCast);
}

// ── Init ──────────────────────────────────────────────────────────────────────

// Live core-state accessors handed to window.Export (#142) -- getCore()
// returns a fresh snapshot on every call, so the module always reads current
// values; the setters are the only way it writes back to app.js's own
// currentEntry/currentJournal/currentSourceSessionId.
function exportDeps() {
  return {
    getCore: () => ({
      currentEntry,
      currentJournal,
      currentSessionId,
      sessionDate,
      transcriptText,
      activeMembers,
      MEMBERS,
    }),
    setCurrentEntry: text => {
      currentEntry = text;
    },
    setCurrentJournal: journal => {
      currentJournal = journal;
      localStorage.setItem('sc-journal', JSON.stringify(currentJournal));
    },
    setCurrentSourceSessionId: id => {
      currentSourceSessionId = id;
    },
    setStatus,
    // #185 — the non-paste document paths (Day One, library, file import) land
    // asynchronously inside export.js, so there is no DOM event app.js could
    // listen for. This is the notification that a document is now readable.
    onDocumentReady: autoProposeCast,
    // #354: the scholarly export's honesty check -- whether the session it's
    // exporting has a complete turn-level record, and the note to print when
    // it doesn't. Injected rather than read off window.Record, per this
    // module's own deps convention.
    recordCompleteness: window.Record.recordCompleteness,
    recordCompletenessNote: window.Record.recordCompletenessNote,
  };
}
window.Export.configure(exportDeps());

// Live core-state accessors handed to window.Sessions (#142) -- same
// getCore()-plus-setters shape as exportDeps() above, just with more entries:
// restoreSession() alone hydrates most of app.js's session/player state, so
// this is the biggest deps bag of the three extractions. resetLiveStage
// and resetTranscriptCounters bundle small groups of related
// state/cross-module calls that always change together in restoreSession(),
// rather than exposing each one as its own setter.
function sessionsDeps() {
  return {
    getCore: () => ({
      MEMBERS,
      activeMembers,
      currentSessionId,
      currentEntry,
      currentSourceSessionId,
      transcriptText,
      sessionDate,
      segmentCount,
      playerMode,
      playerMemberId,
      playerName,
      currentPlayerSpeakerName,
      sessionPlayerTurns,
      playerTurnsRevealed,
    }),
    setCurrentSessionId: id => {
      currentSessionId = id;
    },
    setSessionDate: d => {
      sessionDate = d;
    },
    setCurrentEntry: text => {
      currentEntry = text;
    },
    setCurrentSourceSessionId: id => {
      currentSourceSessionId = id;
    },
    setSegmentCount: n => {
      segmentCount = n;
    },
    setPlayerMode: m => {
      playerMode = m;
    },
    setPlayerMemberId: id => {
      playerMemberId = id;
    },
    setPlayerName: n => {
      playerName = n;
    },
    setCurrentPlayerSpeakerName: n => {
      currentPlayerSpeakerName = n;
    },
    setSessionPlayerTurns: turns => {
      sessionPlayerTurns = turns;
    },
    setPlayerTurnsRevealed: v => {
      playerTurnsRevealed = v;
    },
    setTranscriptText: t => {
      transcriptText = t;
    },
    setActiveMembers: set => {
      activeMembers = set;
    },
    resetTranscriptCounters: () => {
      releasePendingLull();
      _entryCounter = 0;
      lastSpeakerId = null;
      currentSpeakerSide = 'right';
      recordAttached = true;
      document.getElementById('record-live-pill')?.classList.remove('visible');
    },
    resetLiveStage: () => window.Witness.resetLiveStage(),
    collapseStage: () => window.Witness.collapseStage(),
    // #356: whether the just-restored session has always-on-captured
    // citations/invoked works to show a bibliography for -- see
    // export.js's setSessionHasCitations for why this needs its own signal.
    setSessionHasCitations: v => window.Export.setSessionHasCitations(v),
    escapeHTML,
    resolveMember: window.Speaker.resolveMember,
    isKnownSpeakerHeader: window.Speaker.isKnownSpeakerHeader,
    renderActions,
    setStatus,
    restorePlayAsControlDisplay,
    addRoundHeader,
    addLullDivider,
    setRenderSegment,
    addBranchControl,
    parseAndRenderTranscript,
    renderMembers,
    applyCitationFlags,
    applyPlayerTurnMarkers,
    showSessionControls,
    // #354: which side of a segment its label belongs on -- now a shared
    // rule (record.js) rather than a bare `endedBy` check, since an
    // interjection segment carries an endedBy of its own but still opens
    // with its label like an old round header. Injected rather than read
    // directly off window.Record, per this module's own deps convention.
    labelOpensSegment: window.Record.labelOpensSegment,
  };
}

// window.Speaker (#285) is pure text matching with one read of core state —
// the active player-as-member identity, for recognizing custom (non-roster)
// speaker headers. See speaker.js's own isKnownSpeakerHeader comment.
function speakerDeps() {
  return { getPlayerSpeakerName: () => currentPlayerSpeakerName };
}
window.Speaker.configure(speakerDeps());
window.Sessions.configure(sessionsDeps());
window.Witness.configure(witnessDeps());

// window.Casting (#185) owns regulars and the pre-convene proposal; app.js
// keeps ownership of activeMembers, so the deps bag hands over the live Set
// itself rather than a snapshot — casting seats and unseats people, and every
// such change is followed by renderMembers() here.
function castingDeps() {
  return {
    getCore: () => ({ activeMembers, MEMBERS }),
    getEntry: () => window.Export.getEntry(),
    renderMembers,
    setStatus,
  };
}
window.Casting.configure(castingDeps());
initCastingTriggers();

// window.Metrics (#191) reads currentSessionId only for the after-panel's
// footer button (no-arg toggle()) — the Past Meetings list passes its own
// session id explicitly and never touches this.
function metricsDeps() {
  return {
    getCore: () => ({ currentSessionId, MEMBERS }),
    escapeHTML,
  };
}
window.Metrics.configure(metricsDeps());

initRecordScroll();

// #379: a stranger lands here unauthenticated on a deployed instance —
// reading is open, but convening costs Anthropic money and mutates shared
// state, so the provocation/casting/convene controls render inert with a
// sign-in prompt on top rather than being fully interactive. `inert` (not
// just CSS) so the disabled controls also drop out of the tab order and
// screen-reader tree, per Principle 4 — a keyboard/AT user shouldn't be
// able to reach a control that silently does nothing. Local dev and an
// authenticated deployed session both get `authed: true` back and this is a
// no-op. A failed /api/config fetch (config is null) fails closed — gated,
// not open — same as an explicit `authed: false`.
function applyConveneGate(config) {
  const authed = !!(config && config.authed);
  document.getElementById('control-rail')?.classList.toggle('is-gated', !authed);
  const content = document.getElementById('control-rail-content');
  if (content) content.inert = !authed;
}

window.Export.applyEnvConfig().then(applyConveneGate);
initSceneLayer();
fetchMembers().then(() => {
  window.Casting.seatRegulars();
  renderMembers();
});
window.Export.updateExportJournalLabel();
handlePlayAsModeChange();
window.Export.restoreSavedSettings();

// Load session from URL param if present (e.g. ?session=<id>)
const _urlSession = new URLSearchParams(location.search).get('session');
if (_urlSession) window.Sessions.restoreSession(_urlSession);

// Load session count on startup
fetch('/api/sessions')
  .then(r => r.json())
  .then(sessions => {
    if (sessions.length) document.getElementById('sessions-count').textContent = sessions.length;
  })
  .catch(() => {});
