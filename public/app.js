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

// Maud is a guest but default-present alongside the eight core members.
let activeMembers = new Set(['crowley','waite','pixie','yeats','blavatsky','levi','teresa','arabi','maud']);
let currentRound = 0;
let currentSessionId = null;
let transcriptText = '';
let sessionDate = '';
let journalList = [];
let currentEntry = '';
let pendingRetry = null;
let lastInterjectText = '';

// ── Render member tokens ──────────────────────────────────────────────────────

function renderMembers() {
  ['members-grid','guests-grid'].forEach(id => document.getElementById(id).innerHTML = '');
  MEMBERS.forEach(m => {
    const el = document.createElement('div');
    el.className = 'member-token' + (m.guest ? ' guest' : '') + (activeMembers.has(m.id) ? ' active' : '');
    el.innerHTML = `<div class="member-dot"></div><span class="member-name">${m.name}</span>`;
    el.onclick = () => {
      activeMembers.has(m.id) ? activeMembers.delete(m.id) : activeMembers.add(m.id);
      renderMembers();
    };
    document.getElementById(m.guest ? 'guests-grid' : 'members-grid').appendChild(el);
  });
  updateMemberCount();
  populateArtifactSelect();
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
    else p.className = 'round-pip';
  }
}

// ── Transcript rendering ──────────────────────────────────────────────────────

function addRoundHeader(label) {
  const c = document.getElementById('transcript-content');
  const h = document.createElement('div');
  h.className = 'transcript-round-header';
  h.innerHTML = `<div class="round-rule"></div><span class="round-rule-label">${label}</span><div class="round-rule"></div>`;
  c.appendChild(h);
  transcriptText += `\n\n— ${label} —\n\n`;
  return h;
}

// Escape HTML to avoid injecting from model output, then transform asterisk-actions.
function escapeHTML(s) {
  return s.replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
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

function addSpeech(speaker, text, isGuest, isObserver) {
  const c = document.getElementById('transcript-content');
  const e = document.createElement('div');
  e.className = 'transcript-entry';
  const nc = isObserver ? 'observer-voice' : (isGuest ? 'guest-voice' : '');
  e.innerHTML = `<div class="speaker-name ${nc}">${escapeHTML(speaker)}</div><div class="speech-text">${renderActions(text)}</div>`;
  c.appendChild(e);
  c.scrollTop = c.scrollHeight;
  transcriptText += `${speaker} —\n${text}\n\n`;
}

function parseAndRenderTranscript(response) {
  const lines = response.split('\n');
  let speaker = null, textLines = [];

  const flush = () => {
    if (speaker && textLines.length) {
      const m = MEMBERS.find(m => speaker.includes(m.name) || m.name.includes(speaker));
      addSpeech(speaker, textLines.join('\n').trim(), m?.guest || false, false);
      speaker = null; textLines = [];
    }
  };

  lines.forEach(line => {
    const t = line.trim();
    if (!t) { flush(); return; }
    // Unattributed action line between speakers — render directly, no speaker needed
    const isActionLine = /^\*[^*\n]+\*$/.test(t);
    if (isActionLine && !speaker) {
      const c = document.getElementById('transcript-content');
      const d = document.createElement('div');
      d.className = 'action-line';
      d.textContent = t.slice(1, -1);
      c.appendChild(d);
      transcriptText += `${t}\n\n`;
      return;
    }
    const isKnownName = MEMBERS.some(m => t === m.name || t === m.name + ':');
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
async function streamPost(url, body, onChunk) {
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
    }
  }
  return donePayload;
}

// Attaches a live-streaming div to the transcript; returns { append, finalize, abort }.
function startStreamEntry() {
  const c = document.getElementById('transcript-content');
  const live = document.createElement('div');
  live.className = 'transcript-stream-live';
  c.appendChild(live);
  return {
    append(chunk) {
      live.textContent += chunk;
      c.scrollTop = c.scrollHeight;
    },
    finalize(fullText) {
      live.remove();
      parseAndRenderTranscript(fullText);
    },
    abort() {
      live.remove();
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

// ── Day One ───────────────────────────────────────────────────────────────────

const entryCache = new Map(); // key: "dayone:journalId:idx" → { text, date, journalId, journalName }
let sourceOptionsLoaded = false;

function updateExportJournalLabel() {
  const el = document.getElementById('export-journal-name');
  if (el) el.textContent = currentJournal.name || 'No journal selected';
}

// Called on mousedown of source-select — loads journals + 3 recent entries per
// journal into optgroups. Runs once; subsequent mousedowns are no-ops.
async function loadSourceOptions() {
  if (sourceOptionsLoaded) return;
  sourceOptionsLoaded = true; // prevent double-load

  const sel = document.getElementById('source-select');
  const loadingGroup = document.getElementById('source-loading-group');

  try {
    const res = await fetch('/api/dayone/journals', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const data = await res.json();
    const journals = data.journals || [];
    if (!journals.length) {
      if (loadingGroup) loadingGroup.label = 'No Day One journals found';
      return;
    }

    // Float PreSeedings to top
    const isPreferred = j => /preseedings|secret.cabin/i.test(j.name);
    const sorted = [...journals].sort((a, b) => isPreferred(b) - isPreferred(a));

    // Remove the placeholder loading group
    if (loadingGroup) loadingGroup.remove();

    // Pre-create groups in sorted order so the DOM order is guaranteed
    const groups = sorted.map(journal => {
      const group = document.createElement('optgroup');
      group.label = journal.name;
      sel.appendChild(group);
      return { journal, group };
    });

    // Load entries for each journal in parallel, fill the pre-created groups
    await Promise.all(groups.map(async ({ journal, group }) => {
      try {
        const er = await fetch('/api/dayone/entries', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ journalId: journal.id, limit: 3 }),
        });
        const ed = await er.json();
        const entries = ed.entries || [];

        entries.forEach((entry, idx) => {
          const key = `dayone:${journal.id}:${idx}`;
          entryCache.set(key, { ...entry, journalId: journal.id, journalName: journal.name });
          const opt = document.createElement('option');
          opt.value = key;
          opt.textContent = `${entry.date}  ${entry.preview}`;
          group.appendChild(opt);
        });

        if (!entries.length) {
          const opt = document.createElement('option');
          opt.disabled = true;
          opt.textContent = 'No entries found';
          group.appendChild(opt);
        }
      } catch {
        const opt = document.createElement('option');
        opt.disabled = true;
        opt.textContent = 'Could not load entries';
        group.appendChild(opt);
      }
    }));

    // If we had a saved journal preference, try to pre-select its first entry
    if (currentJournal.id) {
      const key = `dayone:${currentJournal.id}:0`;
      if (entryCache.has(key)) sel.value = key;
    }

  } catch (e) {
    if (loadingGroup) loadingGroup.label = 'Could not connect to Day One';
  }
}

function handleSourceChange() {
  const v = document.getElementById('source-select').value;
  const isPaste = v === 'paste';
  document.getElementById('paste-area-container').style.display = isPaste ? 'block' : 'none';
  document.getElementById('fetched-display').style.display = isPaste ? 'none' : 'block';

  if (!isPaste && entryCache.has(v)) {
    const cached = entryCache.get(v);
    currentEntry = cached.text;
    currentJournal = { id: cached.journalId, name: cached.journalName };
    localStorage.setItem('sc-journal', JSON.stringify(currentJournal));
    updateExportJournalLabel();

    const display = document.getElementById('entry-display');
    display.textContent = cached.text;
    display.classList.remove('placeholder');
    document.getElementById('entry-date-tag').textContent = cached.date || '';
    document.getElementById('entry-journal-tag').textContent = cached.journalName;
    setStatus('The document has been read aloud. The room has heard it.', false);
  } else if (isPaste) {
    currentEntry = '';
  }
}

function getEntry() {
  return document.getElementById('source-select').value === 'paste'
    ? document.getElementById('paste-area').value.trim()
    : currentEntry;
}


// ── Convene ───────────────────────────────────────────────────────────────────

async function convene() {
  const entry = getEntry();
  if (!entry) { setStatus('The room requires a document.', false); return; }
  if (activeMembers.size < 2) { setStatus('At least two must be present.', false); return; }

  document.getElementById('transcript-empty').style.display = 'none';
  document.getElementById('transcript-content').innerHTML = '';
  document.getElementById('convene-btn').disabled = true;
  document.getElementById('additional-round-btn').className = 'lodge-btn';
  document.getElementById('export-panel').className = 'export-panel';
  document.getElementById('interject-panel').className = 'interject-panel';

  currentSessionId = null;
  currentRound = 0;
  transcriptText = '';
  sessionDate = new Date().toISOString().split('T')[0];
  const members = [...activeMembers];
  const roundInstructions = [1, 2, 3].map(i => document.getElementById(`arc-${i}`)?.value.trim()).filter(Boolean);

  const artifactText = document.getElementById('artifact-text')?.value.trim();
  const artifactMemberId = document.getElementById('artifact-member')?.value;
  const artifact = (artifactText && artifactMemberId) ? { text: artifactText, memberId: artifactMemberId } : null;

  try {
    // Round 1
    currentRound = 1;
    updatePips();
    setStatus('First Movement... the room is speaking.', true);
    const txtBefore1 = transcriptText;
    const h1 = addRoundHeader('First Movement');
    const s1 = startStreamEntry();
    let acc = '';
    let d1;
    try {
      d1 = await streamPost('/api/convene', { entry, members, roundInstructions, artifact }, chunk => { acc += chunk; s1.append(chunk); });
      s1.finalize(acc);
      currentSessionId = d1.sessionId;
    } catch (err) {
      s1.abort(); h1.remove(); transcriptText = txtBefore1;
      setError('The first movement could not begin. The fire may be low.', convene);
      return;
    }

    // Rounds 2 and 3
    for (let i = 1; i < ROUND_LABELS.length; i++) {
      currentRound = i + 1;
      updatePips();
      setStatus(`${ROUND_LABELS[i]}... the room is speaking.`, true);
      await new Promise(r => setTimeout(r, 300));
      const txtBefore = transcriptText;
      const h = addRoundHeader(ROUND_LABELS[i]);
      const s = startStreamEntry();
      acc = '';
      const ri = i;
      try {
        await streamPost('/api/round', { sessionId: currentSessionId }, chunk => { acc += chunk; s.append(chunk); });
        s.finalize(acc);
      } catch (err) {
        s.abort(); h.remove(); transcriptText = txtBefore;
        showSessionControls();
        setError(`${ROUND_LABELS[ri]} could not continue.`, () => resumeRounds(ri));
        return;
      }
    }

    showSessionControls();
    setStatus('The meeting has found its natural pause. The embers hold.', false);
  } finally {
    document.getElementById('convene-btn').disabled = false;
  }
}

// Resume rounds starting from index i (used when a mid-convene round fails and user retries).
async function resumeRounds(fromIndex) {
  if (!currentSessionId) return;
  document.getElementById('convene-btn').disabled = true;
  try {
    for (let i = fromIndex; i < ROUND_LABELS.length; i++) {
      currentRound = i + 1;
      updatePips();
      setStatus(`${ROUND_LABELS[i]}... the room is speaking.`, true);
      if (i > fromIndex) await new Promise(r => setTimeout(r, 300));
      const txtBefore = transcriptText;
      const h = addRoundHeader(ROUND_LABELS[i]);
      const s = startStreamEntry();
      let acc = '';
      const ri = i;
      try {
        await streamPost('/api/round', { sessionId: currentSessionId }, chunk => { acc += chunk; s.append(chunk); });
        s.finalize(acc);
      } catch (err) {
        s.abort(); h.remove(); transcriptText = txtBefore;
        setError(`${ROUND_LABELS[ri]} could not continue.`, () => resumeRounds(ri));
        return;
      }
    }
    setStatus('The meeting has found its natural pause. The embers hold.', false);
  } finally {
    document.getElementById('convene-btn').disabled = false;
  }
}

function showSessionControls() {
  document.getElementById('interject-panel').className = 'interject-panel visible';
  document.getElementById('additional-round-btn').className = 'lodge-btn visible';
  document.getElementById('export-panel').className = 'export-panel visible';
  updatePips();
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
  const h = addRoundHeader('One More Turn');
  const s = startStreamEntry();
  let accumulated = '';

  try {
    await streamPost('/api/round', { sessionId: currentSessionId }, chunk => {
      accumulated += chunk;
      s.append(chunk);
    });
    s.finalize(accumulated);
    setStatus('The embers hold a while longer.', false);
  } catch (err) {
    s.abort(); h.remove(); transcriptText = txtBefore; currentRound--;
    updatePips();
    setError('The turn could not complete.', addRound);
  } finally {
    btn.disabled = false;
  }
}

// ── Interject ─────────────────────────────────────────────────────────────────

async function interject() {
  if (!currentSessionId) return;
  const input = document.getElementById('interject-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  lastInterjectText = text;

  addRoundHeader('A Presence Passes Through');
  addSpeech('— a voice from elsewhere —', text, false, true);
  setStatus('The room notices...', true);
  await sendInterject(text);
}

async function sendInterject(text) {
  const s = startStreamEntry();
  let accumulated = '';
  try {
    await streamPost('/api/interject', { sessionId: currentSessionId, text }, chunk => {
      accumulated += chunk;
      s.append(chunk);
    });
    s.finalize(accumulated);
    lastInterjectText = '';
    setStatus('The presence withdraws. The room continues.', false);
  } catch (err) {
    s.abort();
    setError('The interjection went unheard.', () => sendInterject(lastInterjectText));
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

function exportTxt() {
  const blob = new Blob([transcriptText], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `secret-cabinets-${sessionDate}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  document.getElementById('export-status').textContent = 'Downloaded.';
}

async function exportDayOne() {
  if (!currentJournal.id) {
    document.getElementById('export-status').textContent = 'Select a Day One journal first.';
    return;
  }
  document.getElementById('export-status').textContent = `Saving to ${currentJournal.name}...`;
  try {
    const res = await fetch('/api/dayone/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        journalId: currentJournal.id,
        journalName: currentJournal.name,
        transcriptText,
        sessionDate,
      }),
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    document.getElementById('export-status').textContent = `Saved to ${currentJournal.name}.`;
  } catch (err) {
    console.error(err);
    document.getElementById('export-status').textContent = 'Export failed. Try .txt download.';
  }
}

// ── Sessions drawer ───────────────────────────────────────────────────────────

async function openSessionsDrawer() {
  document.getElementById('sessions-overlay').classList.add('open');
  document.getElementById('sessions-drawer').classList.add('open');
  await loadSessionsList();
}

function closeSessionsDrawer() {
  document.getElementById('sessions-overlay').classList.remove('open');
  document.getElementById('sessions-drawer').classList.remove('open');
}

async function loadSessionsList() {
  const list = document.getElementById('sessions-list');
  list.innerHTML = '<div class="sessions-empty">Loading...</div>';
  try {
    const res = await fetch('/api/sessions');
    const sessions = await res.json();
    if (!sessions.length) {
      list.innerHTML = '<div class="sessions-empty">No past meetings found.</div>';
      document.getElementById('sessions-count').textContent = '';
      return;
    }
    document.getElementById('sessions-count').textContent = sessions.length;
    list.innerHTML = '';
    sessions.forEach(s => {
      const el = document.createElement('div');
      el.className = 'session-item';
      el.innerHTML = `
        <div class="session-item-date">
          ${s.date}
          <span class="session-item-rounds">${s.rounds} round${s.rounds !== 1 ? 's' : ''}</span>
        </div>
        <div class="session-item-entry">${s.entry || '—'}</div>
        <div class="session-item-members">${(s.members || []).join(' · ')}</div>
        <div class="session-item-actions">
          <button class="session-load-btn" onclick="restoreSession('${s.id}')">Load this meeting</button>
          <button class="session-delete-btn" onclick="deleteSession('${s.id}', this)">Delete</button>
        </div>`;
      list.appendChild(el);
    });
  } catch (e) {
    list.innerHTML = '<div class="sessions-empty">Could not load past meetings.</div>';
  }
}

async function restoreSession(id) {
  closeSessionsDrawer();
  setStatus('Restoring past meeting...', true);
  try {
    const res = await fetch(`/api/sessions/${id}`);
    if (!res.ok) throw new Error('Not found');
    const session = await res.json();

    // Reset UI state
    document.getElementById('transcript-empty').style.display = 'none';
    document.getElementById('transcript-content').innerHTML = '';
    currentSessionId = session.id;
    sessionDate = session.date;
    currentEntry = session.entry || '';
    currentRound = session.rounds?.length || 0;

    // Rebuild transcriptText from scratch with current formatting
    const names = (session.members || []).map(id => MEMBERS.find(m => m.id === id)?.name).filter(Boolean).join(', ');
    transcriptText = `THE SECRET-CABIN-ET\nMeeting Notes — ${session.date}\nAssembled: ${names}\n\nSource material:\n${session.entry || ''}\n`;

    // Re-render rounds from stored data
    (session.rounds || []).forEach(round => {
      addRoundHeader(round.label);
      parseAndRenderTranscript(round.text);
    });

    // Restore member selection
    activeMembers = new Set(session.members || []);
    renderMembers();

    // Show controls
    document.getElementById('interject-panel').className = 'interject-panel visible';
    document.getElementById('additional-round-btn').className = 'lodge-btn visible';
    document.getElementById('export-panel').className = 'export-panel visible';
    updatePips();
    setStatus(`Meeting of ${session.date} restored. The embers hold.`, false);
  } catch (e) {
    setStatus('Could not restore the meeting.', false);
  }
}

async function deleteSession(id, btn) {
  if (!confirm('Remove this meeting from the record? This cannot be undone.')) return;
  try {
    const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    // Remove the item from the list
    btn.closest('.session-item').remove();
    // Update count
    const remaining = document.getElementById('sessions-list').querySelectorAll('.session-item').length;
    document.getElementById('sessions-count').textContent = remaining || '';
    if (!remaining) {
      document.getElementById('sessions-list').innerHTML = '<div class="sessions-empty">No past meetings found.</div>';
    }
  } catch (e) {
    alert('The meeting could not be removed.');
  }
}

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
  const isGuest = document.getElementById('new-member-guest').checked;
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
      body: JSON.stringify({ name, bio, voiceRegister, cognitiveStyle, relationships, isGuest }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unknown error');

    MEMBERS.push(data.member);
    renderMembers();

    // Clear form
    ['new-member-name','new-member-bio','new-member-voice','new-member-cognitive','new-member-relationships']
      .forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('new-member-guest').checked = false;

    statusEl.style.color = 'var(--lodge-muted)';
    statusEl.textContent = `${data.member.name} has joined the lodge.`;
    setTimeout(closeAddMemberModal, 1400);
  } catch (e) {
    statusEl.style.color = '#a06060';
    statusEl.textContent = e.message || 'The invitation could not be sent.';
    btn.disabled = false;
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

fetchMembers().then(() => renderMembers());
updateExportJournalLabel();

// Load session from URL param if present (e.g. ?session=<id>)
const _urlSession = new URLSearchParams(location.search).get('session');
if (_urlSession) restoreSession(_urlSession);

// Load session count on startup
fetch('/api/sessions')
  .then(r => r.json())
  .then(sessions => {
    if (sessions.length) document.getElementById('sessions-count').textContent = sessions.length;
  })
  .catch(() => {});
