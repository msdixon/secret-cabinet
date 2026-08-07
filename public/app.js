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

const ROUND_LABELS = ['First Movement', 'The Room Responds', 'Final Embers'];

// Seeded at startup from the user's pinned regulars (#185, window.Casting);
// empty until someone pins their first, and hand-castable from the grid
// either way.
let activeMembers = new Set();
let currentRound = 0;
let selectedRoundCount = 3;       // live round-count selector value
let activeConveneRoundCount = 3;  // snapshot at convene() start; a mid-run selector change never affects an in-flight session
let currentSessionId = null;
let currentSourceSessionId = null; // set when reconvening on a prior transcript
let transcriptText = '';
let sessionDate = '';
let journalList = [];
let currentEntry = '';
let pendingRetry = null;
let lastInterjectText = '';

// ── Player-as-member ─────────────────────────────────────────────────────────
let playerMode = 'none';             // 'none' | 'member' | 'custom' — snapshotted at convene() start
let playerMemberId = null;
let playerName = null;
let currentPlayerSpeakerName = null; // resolved display name; drives parser recognition of custom identities
let sessionPlayerTurns = [];         // [{round, speakerName, text}]
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
    const ra = window.Casting.isRegular(a.id), rb = window.Casting.isRegular(b.id);
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
    el.innerHTML = `<img class="member-portrait" src="/portraits/${m.id}.png" alt="" loading="lazy" onerror="portraitFallback(this,'dot')"><span class="member-name">${m.name}</span>`
      + `<button type="button" class="member-pin${isRegular ? ' pinned' : ''}" aria-pressed="${isRegular}"`
      + ` title="${isRegular ? `${safeName} is a regular — always drawn to the room. Click to release.` : `Keep ${safeName} as a regular — always drawn to the room.`}"`
      + ` aria-label="${isRegular ? 'Release' : 'Keep'} ${safeName} as a regular">✦</button>`;
    el.onclick = () => {
      if (isActive) activeMembers.delete(m.id);
      else activeMembers.add(m.id);
      window.Casting.noteHandCast();
      renderMembers();
    };
    // The pin sits inside the token but answers a different question — who is
    // always here, not who is here tonight — so it must not also toggle presence.
    el.querySelector('.member-pin').onclick = (e) => {
      e.stopPropagation();
      window.Casting.toggleRegular(m.id);
    };
    grid.appendChild(el);
  });

  const emptyHint = document.getElementById('members-empty-hint');
  emptyHint.style.display = (filter && visibleCount === 0) ? 'block' : 'none';
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
  active.map(id => MEMBERS.find(m => m.id === id)).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      sel.appendChild(opt);
    });
  if (current && active.includes(current)) { sel.value = current; return; }
  // The previously "played" member is no longer present — reset defensively
  // rather than silently keeping a stale selection.
  const modeSel = document.getElementById('play-as-mode-select');
  if (modeSel?.value === 'member') { modeSel.value = 'none'; handlePlayAsModeChange(); }
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
    passBtn.onclick = () => { cleanup(); resolve(null); };
  });
}

function updateMemberCount() {
  const n = activeMembers.size;
  const badge = document.getElementById('member-count-badge');
  if (!badge) return;
  badge.textContent = `${n} present`;
  badge.className = 'member-count-badge' + (n >= 8 ? ' over' : n >= 6 ? ' warn' : '');
  badge.title = n >= 6
    ? `${n} members active — larger casts reduce individual voice distinction and increase generation time. 4–6 recommended.`
    : '';
}

// ── Ember animation ───────────────────────────────────────────────────────────

function setEmber(active) {
  document.getElementById('ember-bar').className = 'ember-bar' + (active ? ' active' : '');
  ['s1','s2','s3','s4','s5'].forEach(id => {
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

// ── Round pips ────────────────────────────────────────────────────────────────

function updatePips() {
  for (let i = 1; i <= 3; i++) {
    const p = document.getElementById(`pip-${i}`);
    if (i < currentRound) p.className = 'round-pip complete';
    else if (i === currentRound) p.className = 'round-pip active';
    else if (i > selectedRoundCount) p.className = 'round-pip inert';
    else p.className = 'round-pip';
  }
}

// ── Round count selector ─────────────────────────────────────────────────────

function setRoundCount(n) {
  selectedRoundCount = n;
  document.querySelectorAll('.round-count-btn').forEach(b => {
    b.classList.toggle('selected', Number(b.dataset.count) === n);
  });
  updatePips();
}

// ── Transcript rendering ──────────────────────────────────────────────────────

// roundIndex is the session-relative round index (0-based) this header opens,
// or null for headers that never enter session.rounds (interjections) — used
// to tag the round's entries so player-turn markers can find them later.
let currentRenderRound = null;
function addRoundHeader(label, roundIndex = null) {
  currentRenderRound = roundIndex;
  const c = document.getElementById('transcript-content');
  const h = document.createElement('div');
  h.className = 'transcript-round-header';
  h.innerHTML = `<div class="round-rule"></div><span class="round-rule-label">${label}</span><div class="round-rule"></div>`;
  c.appendChild(h);
  transcriptText += `\n\n— ${label} —\n\n`;
  return h;
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
  if (!confirm('Branch from this round? A new meeting is created sharing everything up to here, and you continue from there — the original stays untouched.')) return;
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
  return s.replace(/&/g, '&amp;')
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
//   2. Inline *...* becomes inline action italics.
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
      return line.replace(/\*([^*\n]+?)\*/g, '<span class="action-inline">$1</span>');
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

function recordScrollEl() { return document.getElementById('record-scroll'); }

function initRecordScroll() {
  const el = recordScrollEl();
  const pill = document.getElementById('record-live-pill');
  if (!el || !pill) return;
  el.addEventListener('scroll', () => {
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom && !recordAttached) { recordAttached = true; pill.classList.remove('visible'); }
    else if (!atBottom && recordAttached) { recordAttached = false; pill.classList.add('visible'); }
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
  const nonEmptyLines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
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
  e.innerHTML = `${nameEl}<div class="bubble-body"><div class="speech-text" onclick="toggleAnnotation(this.closest('.transcript-entry'))">${renderActions(text)}</div><div class="annotation-area" style="display:none"><textarea class="annotation-input" placeholder="Note…" onblur="saveAnnotation(this)" onkeydown="if(event.key==='Escape')closeAnnotation(this.closest('.transcript-entry'))"></textarea></div></div>`;
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
  const all = [...document.querySelectorAll('.transcript-entry')].map(e => ({
    entryId: e.dataset.entryId,
    speaker: e.dataset.speaker,
    note: e.querySelector('.annotation-input')?.value.trim() || '',
  })).filter(a => a.note);
  await fetch(`/api/sessions/${currentSessionId}/annotations`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ annotations: all }),
  }).catch(() => {});
  window.Export.updateScholarlyExportButton();
}

// ── Speaker attribution ────────────────────────────────────────────────────
// Members sign transcripts with a short form (surname, first name, or a
// nickname) rather than their full roster name. Short forms are derived
// automatically from each member's `name` in roster.json; a member's
// `aliases` array (also in roster.json) covers nicknames that aren't
// derivable from the name itself (e.g. "Pamela" for Coleman-Smith). This
// keeps the roster the single source of truth — adding a Wave 2 guest to
// roster.json is enough; nothing here needs hand-editing.
//
// If two members derive the same token (e.g. "Ibn" from both "Ibn Arabi"
// and "Ibn Khaldun", or "Blake" from both Blakes), that token is ambiguous
// and dropped from the index — lodge-context.md's FORMAT section instructs
// members with colliding surnames to sign in full, which the exact
// full-name match in resolveMember/isKnownSpeakerHeader still catches.
const ALIAS_STOPWORDS = new Set(['of', 'the', 'van', 'der', 'de', 'la', 'lady', 'sir', 'dr', 'st']);

function normalizeSpeaker(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '').toLowerCase().replace(/[\s-]+/g, ' ').trim();
}

function buildAliasIndex(members) {
  const index = new Map(); // normalized alias -> member id, or null if ambiguous
  const register = (key, id) => {
    const k = normalizeSpeaker(key);
    if (!k) return;
    if (index.has(k) && index.get(k) !== id) index.set(k, null);
    else if (!index.has(k)) index.set(k, id);
  };
  members.forEach(m => {
    register(m.name, m.id);
    m.name.split(/[\s-]+/)
      .filter(tok => tok.length > 2 && !ALIAS_STOPWORDS.has(tok.toLowerCase()))
      .forEach(tok => register(tok, m.id));
    (m.aliases || []).forEach(a => register(a, m.id));
  });
  return index;
}

// Resolves a signed speaker string (e.g. "Warburg", "Ibn 'Arabi") to its roster member.
function resolveMember(speaker, members) {
  const norm = normalizeSpeaker(speaker);
  const candidates = [...buildAliasIndex(members).entries()]
    .filter(([, id]) => id)
    .sort((a, b) => b[0].length - a[0].length); // prefer the more specific (longer) alias
  const hit = candidates.find(([alias]) => norm.includes(alias));
  if (hit) return members.find(m => m.id === hit[1]);
  // No alias hit — fall back to loose name-substring matching, but only when
  // exactly one member matches. A speaker string that partially overlaps two
  // members' names (e.g. bare "Blake") is ambiguous and stays unresolved
  // rather than silently picking whichever member happens to be listed first.
  const matches = members.filter(m => speaker.includes(m.name) || m.name.includes(speaker));
  return matches.length === 1 ? matches[0] : undefined;
}

// True if a trimmed transcript line is a recognized speaker header (full name or alias).
// Also recognizes the active session's player-as-member identity — needed
// for custom (non-roster) identities, which have no alias-index entry.
function isKnownSpeakerHeader(t, members) {
  const norm = normalizeSpeaker(t.replace(/:$/, ''));
  if (currentPlayerSpeakerName && norm === normalizeSpeaker(currentPlayerSpeakerName)) return true;
  const index = buildAliasIndex(members);
  return index.has(norm) && index.get(norm) != null;
}

function parseAndRenderTranscript(response) {
  const c0 = document.getElementById('transcript-content');
  const lines = response.split('\n');
  let speaker = null, textLines = [];

  const flush = () => {
    if (speaker && textLines.length) {
      const text = textLines.join('\n').trim();
      const m = resolveMember(speaker, MEMBERS);
      addSpeech(speaker, text, false, m?.id, null);
      // If the block was pure action, preserve speaker so the next speech
      // (without a repeated header) still gets attributed correctly.
      const nonEmpty = text.split('\n').map(l => l.trim()).filter(Boolean);
      const wasPureAction = nonEmpty.length > 0 && nonEmpty.every(l => /^\*[^*]+\*$/.test(l));
      if (!wasPureAction) speaker = null;
      textLines = [];
    }
  };

  lines.forEach(line => {
    const t = line.trim();
    if (!t) { flush(); return; }
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
    const isKnownName = isKnownSpeakerHeader(t, MEMBERS);
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
        if (data.done) { donePayload = data; }
        else if (data.text) { onChunk(data.text); }
        else if (data.speaking) { window.LodgeScene?.setSpeaking(data.speaking); onSpeaking?.(data.speaking); }
        else if (data.speakerDone) { onSpeakerDone?.(data.speakerDone); }
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
// #184: every stage change here has a matching window.Witness.live*() call
// right after it, mirroring the same beat into the stage a moment after the
// record gets it -- the stage renders its own lightweight copy (see
// witness.js's top-of-file comment), it never reads these DOM nodes.
//
// finalize() only falls back to the old whole-text reparse if nothing
// rendered live this round -- a safety net, not the normal path, so a
// missed or malformed speakerDone event can't silently drop content. In that
// rare case the record still gets the round correctly; only the stage misses
// mirroring it, self-healing on the next round's beats.
function startStreamEntry() {
  const c = document.getElementById('transcript-content');
  let typingEl = null;
  let renderedLive = false;

  function clearTyping() {
    if (typingEl) { typingEl.remove(); typingEl = null; }
    window.Witness.liveClearTyping();
  }

  return {
    append(chunk) {
      if (!typingEl) return; // nothing streaming yet worth showing raw (e.g. the name-header chunk before onSpeaking fires)
      typingEl.querySelector('.typing-text').textContent += chunk;
      recordFollow();
      window.Witness.liveTypingAppend(chunk);
    },
    onSpeaking(memberId) {
      clearTyping();
      const m = MEMBERS.find(mm => mm.id === memberId);
      typingEl = document.createElement('div');
      typingEl.className = 'transcript-typing';
      typingEl.innerHTML = `<div class="speaker-name">${escapeHTML(m?.name || '…')}</div><div class="typing-text transcript-stream-live"></div>`;
      c.appendChild(typingEl);
      recordFollow();
      window.Witness.liveTypingStart(m?.name || '…');
    },
    onSpeakerDone({ memberId, name, text }) {
      clearTyping();
      addSpeech(name, text, false, memberId || undefined, null);
      renderedLive = true;
      window.Witness.liveSpeech({ speaker: name, text, memberId: memberId || null });
    },
    finalize(fullText) {
      clearTyping();
      if (!renderedLive) parseAndRenderTranscript(fullText);
    },
    abort() {
      clearTyping();
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
  if (!entry) { setStatus('The room requires a document.', false); return; }
  if (activeMembers.size < 2) { setStatus('At least two must be present.', false); return; }

  document.getElementById('transcript-empty').style.display = 'none';
  document.getElementById('transcript-content').innerHTML = '';
  window.Witness.liveReset();
  _entryCounter = 0;
  recordAttached = true;
  document.getElementById('record-live-pill')?.classList.remove('visible');

  lastSpeakerId = null; currentSpeakerSide = 'right';
  document.getElementById('convene-btn').disabled = true;
  document.querySelectorAll('.round-count-btn').forEach(b => b.disabled = true);
  document.getElementById('additional-round-btn').className = 'lodge-btn';
  document.getElementById('after-panel').className = 'after-panel';
  document.getElementById('interject-form').style.display = 'none';

  currentSessionId = null;
  currentRound = 0;
  activeConveneRoundCount = selectedRoundCount;
  sessionDate = new Date().toISOString().split('T')[0];

  // Re-enable the "Play as" controls in case the last thing shown was a
  // restored (read-only) session — restorePlayAsControlDisplay() disables them.
  ['play-as-mode-select', 'play-as-member-select', 'play-as-custom-name'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = false;
  });

  // Snapshot "Play as" state — a mid-session change to the (now-hidden) controls
  // should never affect an in-flight session, same principle as round count.
  playerMode = document.getElementById('play-as-mode-select')?.value || 'none';
  playerMemberId = playerMode === 'member' ? (document.getElementById('play-as-member-select')?.value || null) : null;
  playerName = playerMode === 'custom' ? (document.getElementById('play-as-custom-name')?.value.trim() || null) : null;
  currentPlayerSpeakerName = playerMode === 'member'
    ? MEMBERS.find(m => m.id === playerMemberId)?.name || null
    : playerMode === 'custom' ? playerName : null;
  sessionPlayerTurns = [];
  playerTurnsRevealed = false;
  document.getElementById('transcript-panel')?.classList.remove('reveal-player-turns');

  const members = [...activeMembers];
  const memberNames = members.map(id => MEMBERS.find(m => m.id === id)?.name).filter(Boolean).join(', ');
  const entryForHeader = window.Export.getEntry();
  transcriptText = `THE SECRET-CABIN-ET\nMeeting Notes — ${sessionDate}\nAssembled: ${memberNames}\n\nSource material:\n${entryForHeader}\n`;

  const artifactText = document.getElementById('artifact-text')?.value.trim();
  const artifactMemberId = document.getElementById('artifact-member')?.value;
  const artifact = (artifactText && artifactMemberId) ? { text: artifactText, memberId: artifactMemberId } : null;
  const notes = window.Sessions.collectSessionNotes();

  try {
    // Round 1
    currentRound = 1;
    updatePips();
    const playerTurn1 = isPlayerActive() ? await awaitPlayerTurn('First Movement') : null;
    setStatus('First Movement... the room is speaking.', true);
    const txtBefore1 = transcriptText;
    const h1 = addRoundHeader('First Movement', 0);
    const sh1 = window.Witness.liveRoundHeader('First Movement');
    const s1 = startStreamEntry();
    let d1;
    try {
      d1 = await streamPost('/api/convene', { entry, members, roundCount: activeConveneRoundCount, artifact, notes, sourceSessionId: currentSourceSessionId || undefined, playerMode, playerMemberId, playerName, playerTurn: playerTurn1 || undefined }, chunk => s1.append(chunk), s1.onSpeaking, s1.onSpeakerDone);
      s1.finalize(d1.text);
      currentSessionId = d1.sessionId;
      window.Sessions.buildDossier(members);
      if (playerTurn1) {
        sessionPlayerTurns.push({ round: 0, speakerName: currentPlayerSpeakerName, text: playerTurn1.text });
        applyPlayerTurnMarkers(sessionPlayerTurns);
      }
    } catch (err) {
      s1.abort(); h1.remove(); sh1.remove(); transcriptText = txtBefore1;
      const msg = err.message && !err.message.startsWith('Server error')
        ? err.message
        : 'The first movement could not begin. The fire may be low.';
      setError(msg, convene);
      return;
    }

    // Remaining rounds up to the selected round count
    for (let i = 1; i < activeConveneRoundCount; i++) {
      currentRound = i + 1;
      updatePips();
      const playerTurnI = isPlayerActive() ? await awaitPlayerTurn(ROUND_LABELS[i]) : null;
      setStatus(`${ROUND_LABELS[i]}... the room is speaking.`, true);
      await new Promise(r => setTimeout(r, 300));
      const txtBefore = transcriptText;
      const h = addRoundHeader(ROUND_LABELS[i], i);
      const sh = window.Witness.liveRoundHeader(ROUND_LABELS[i]);
      const s = startStreamEntry();
      const ri = i;
      try {
        const d = await streamPost('/api/round', { sessionId: currentSessionId, playerTurn: playerTurnI || undefined }, chunk => s.append(chunk), s.onSpeaking, s.onSpeakerDone);
        s.finalize(d.text);
        if (playerTurnI) {
          sessionPlayerTurns.push({ round: ri, speakerName: currentPlayerSpeakerName, text: playerTurnI.text });
          applyPlayerTurnMarkers(sessionPlayerTurns);
        }
      } catch (err) {
        s.abort(); h.remove(); sh.remove(); transcriptText = txtBefore;
        showSessionControls();
        setError(`${ROUND_LABELS[ri]} could not continue.`, () => resumeRounds(ri));
        return;
      }
    }

    showSessionControls();
    window.Witness.collapseStage();
    setStatus('The meeting has found its natural pause. The embers hold.', false);
  } finally {
    document.getElementById('convene-btn').disabled = false;
    document.querySelectorAll('.round-count-btn').forEach(b => b.disabled = false);
  }
}

// Resume rounds starting from index i (used when a mid-convene round fails and user retries).
async function resumeRounds(fromIndex) {
  if (!currentSessionId) return;
  document.getElementById('convene-btn').disabled = true;
  document.querySelectorAll('.round-count-btn').forEach(b => b.disabled = true);
  try {
    for (let i = fromIndex; i < activeConveneRoundCount; i++) {
      currentRound = i + 1;
      updatePips();
      const playerTurnI = isPlayerActive() ? await awaitPlayerTurn(ROUND_LABELS[i]) : null;
      setStatus(`${ROUND_LABELS[i]}... the room is speaking.`, true);
      if (i > fromIndex) await new Promise(r => setTimeout(r, 300));
      const txtBefore = transcriptText;
      const h = addRoundHeader(ROUND_LABELS[i], i);
      const sh = window.Witness.liveRoundHeader(ROUND_LABELS[i]);
      const s = startStreamEntry();
      const ri = i;
      try {
        const d = await streamPost('/api/round', { sessionId: currentSessionId, playerTurn: playerTurnI || undefined }, chunk => s.append(chunk), s.onSpeaking, s.onSpeakerDone);
        s.finalize(d.text);
        if (playerTurnI) {
          sessionPlayerTurns.push({ round: ri, speakerName: currentPlayerSpeakerName, text: playerTurnI.text });
          applyPlayerTurnMarkers(sessionPlayerTurns);
        }
      } catch (err) {
        s.abort(); h.remove(); sh.remove(); transcriptText = txtBefore;
        setError(`${ROUND_LABELS[ri]} could not continue.`, () => resumeRounds(ri));
        return;
      }
    }
    window.Witness.collapseStage();
    setStatus('The meeting has found its natural pause. The embers hold.', false);
  } finally {
    document.getElementById('convene-btn').disabled = false;
    document.querySelectorAll('.round-count-btn').forEach(b => b.disabled = false);
  }
}

function showSessionControls() {
  document.getElementById('after-panel').className = 'after-panel visible';
  document.getElementById('additional-round-btn').className = 'lodge-btn visible';
  document.getElementById('verify-citations-btn').className = 'lodge-btn visible';
  document.getElementById('reveal-player-turns-btn').className = 'lodge-btn' + (sessionPlayerTurns.length ? ' visible' : '');
  window.Export.updateScholarlyExportButton();
  updatePips();
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
const CITATION_SOURCE_LABEL = { library: 'checked against curated text', web: 'checked via live lookup', 'model-knowledge': "Claude's own knowledge" };

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
      CITATION_VERDICT_SEVERITY[b.verdict] > CITATION_VERDICT_SEVERITY[a.verdict] ? b : a);
    entry.classList.add('flagged-citation', `citation-${worst.verdict}`);
    const speechEl = entry.querySelector('.speech-text');
    speechEl.title = flags.map(f => {
      const sourceLabel = CITATION_SOURCE_LABEL[f.source || 'model-knowledge'];
      const groundedIn = f.libraryCitation || f.webSourceTitle;
      return `[${sourceLabel}] ${f.note}` + (groundedIn ? `\nGrounded in: ${groundedIn}` : '');
    }).join('\n\n');
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
  const href = flag.librarySourceUrl ? ` href="${escapeHTML(flag.librarySourceUrl)}" target="_blank" rel="noopener"` : '';
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
  document.getElementById('reveal-player-turns-btn').textContent =
    playerTurnsRevealed ? 'Hide Player Turns ◆' : 'Reveal Player Turns ◆';
}

// ── Additional round ──────────────────────────────────────────────────────────

async function addRound() {
  if (!currentSessionId) return;
  const btn = document.getElementById('additional-round-btn');
  btn.disabled = true;
  currentRound++;
  updatePips();
  setStatus('One More Turn... the room continues.', true);
  const txtBefore = transcriptText;
  // Player turns are AI-only for "One More Turn" (v1 scope limit) — round
  // index is still tagged so this round's entries are consistently addressable.
  const h = addRoundHeader('One More Turn', currentRound - 1);
  const sh = window.Witness.liveRoundHeader('One More Turn');
  const s = startStreamEntry();

  try {
    const d = await streamPost('/api/round', { sessionId: currentSessionId }, chunk => s.append(chunk), s.onSpeaking, s.onSpeakerDone);
    s.finalize(d.text);
    setStatus('The embers hold a while longer.', false);
  } catch (err) {
    s.abort(); h.remove(); sh.remove(); transcriptText = txtBefore; currentRound--;
    updatePips();
    setError('The turn could not complete.', addRound);
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
    const d = await streamPost('/api/interject', { sessionId: currentSessionId, text }, chunk => s.append(chunk), s.onSpeaking, s.onSpeakerDone);
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
  const truncated = full.length > FILE_TEXT_LIMIT
    ? full.slice(0, FILE_TEXT_LIMIT) + '\n\n[transcript truncated]'
    : full;

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
  document.getElementById('transcript-content').innerHTML = '';
  document.getElementById('after-panel').className = 'after-panel';
  document.getElementById('additional-round-btn').className = 'lodge-btn';
  document.getElementById('interject-form').style.display = 'none';
  currentRound = 0;
  currentSessionId = null;
  transcriptText = '';
  updatePips();

  window.scrollTo({ top: 0, behavior: 'smooth' });
  setStatus('The transcript has been placed on the table. Assemble a new room and reconvene.', false);
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
    resolveMember,
    isKnownSpeakerHeader,
    escapeHTML,
    renderActions,
    restoreSession: restoreSessionIfDifferent,
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

  if (!name) { statusEl.textContent = 'A name is required.'; return; }
  if (!bio) { statusEl.textContent = 'A biography is required.'; return; }

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
    ['new-member-name','new-member-bio','new-member-voice','new-member-cognitive','new-member-relationships']
      .forEach(id => { document.getElementById(id).value = ''; });

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

function initSceneLayer() {
  try {
    if (new URLSearchParams(location.search).get('noscene')) return;
    if (localStorage.getItem('sc-scene-disabled')) return;
    if (typeof BABYLON === 'undefined' || !window.LodgeScene) return;
    const canvas = document.getElementById('scene-canvas');
    if (!canvas) return;
    if (!LodgeScene.init(canvas)) {
      document.getElementById('scene-panel')?.classList.add('scene-failed');
    }
  } catch (e) {
    console.error('[scene] failed to initialize, continuing without it', e);
    document.getElementById('scene-panel')?.classList.add('scene-failed');
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
      currentEntry, currentJournal, currentSessionId, sessionDate,
      transcriptText, activeMembers, MEMBERS,
    }),
    setCurrentEntry: (text) => { currentEntry = text; },
    setCurrentJournal: (journal) => {
      currentJournal = journal;
      localStorage.setItem('sc-journal', JSON.stringify(currentJournal));
    },
    setCurrentSourceSessionId: (id) => { currentSourceSessionId = id; },
    setStatus,
    // #185 — the non-paste document paths (Day One, library, file import) land
    // asynchronously inside export.js, so there is no DOM event app.js could
    // listen for. This is the notification that a document is now readable.
    onDocumentReady: autoProposeCast,
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
      MEMBERS, activeMembers, currentSessionId, currentEntry, currentSourceSessionId,
      transcriptText, sessionDate, currentRound, activeConveneRoundCount,
      playerMode, playerMemberId, playerName, currentPlayerSpeakerName,
      sessionPlayerTurns, playerTurnsRevealed,
    }),
    setCurrentSessionId: (id) => { currentSessionId = id; },
    setSessionDate: (d) => { sessionDate = d; },
    setCurrentEntry: (text) => { currentEntry = text; },
    setCurrentSourceSessionId: (id) => { currentSourceSessionId = id; },
    setCurrentRound: (n) => { currentRound = n; },
    setActiveConveneRoundCount: (n) => { activeConveneRoundCount = n; },
    setPlayerMode: (m) => { playerMode = m; },
    setPlayerMemberId: (id) => { playerMemberId = id; },
    setPlayerName: (n) => { playerName = n; },
    setCurrentPlayerSpeakerName: (n) => { currentPlayerSpeakerName = n; },
    setSessionPlayerTurns: (turns) => { sessionPlayerTurns = turns; },
    setPlayerTurnsRevealed: (v) => { playerTurnsRevealed = v; },
    setTranscriptText: (t) => { transcriptText = t; },
    setActiveMembers: (set) => { activeMembers = set; },
    resetTranscriptCounters: () => {
      _entryCounter = 0; lastSpeakerId = null; currentSpeakerSide = 'right';
      recordAttached = true;
      document.getElementById('record-live-pill')?.classList.remove('visible');
    },
    resetLiveStage: () => window.Witness.resetLiveStage(),
    escapeHTML, resolveMember, isKnownSpeakerHeader, renderActions,
    setStatus, setRoundCount, restorePlayAsControlDisplay,
    addRoundHeader, addBranchControl, parseAndRenderTranscript,
    renderMembers, applyCitationFlags, applyPlayerTurnMarkers, showSessionControls,
  };
}
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

initRecordScroll();

window.Export.applyEnvConfig();
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
