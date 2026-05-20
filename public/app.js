'use strict';

const DAYONE_JOURNAL_ID   = '109509802833';
const DAYONE_JOURNAL_NAME = 'PreSeedings of the Secret Cabinet';

const MEMBERS = [
  {id:'crowley',  name:'Crowley',        guest:false},
  {id:'waite',    name:'Waite',          guest:false},
  {id:'pixie',    name:'Coleman-Smith',  guest:false},
  {id:'yeats',    name:'Yeats',          guest:false},
  {id:'blavatsky',name:'Blavatsky',      guest:false},
  {id:'levi',     name:'Lévi',           guest:false},
  {id:'teresa',   name:'Teresa of Ávila',guest:false},
  {id:'arabi',    name:'Ibn Arabi',      guest:false},
  {id:'llull',    name:'Llull',          guest:true},
  {id:'khaldun',  name:'Ibn Khaldun',    guest:true},
  {id:'dee',      name:'John Dee',       guest:true},
];

let activeMembers = new Set(['crowley','waite','pixie','yeats','blavatsky','levi','teresa','arabi']);
let currentRound = 0;
let currentSessionId = null;
let transcriptText = '';
let sessionDate = '';
let journalList = [];
let currentEntry = '';

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
}

function addSpeech(speaker, text, isGuest, isObserver) {
  const c = document.getElementById('transcript-content');
  const e = document.createElement('div');
  e.className = 'transcript-entry';
  const nc = isObserver ? 'observer-voice' : (isGuest ? 'guest-voice' : '');
  e.innerHTML = `<div class="speaker-name ${nc}">${speaker}</div><div class="speech-text">${text.replace(/\n/g, '<br>')}</div>`;
  c.appendChild(e);
  c.scrollTop = c.scrollHeight;
  transcriptText += `${speaker}\n${text}\n\n`;
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

// Attaches a live-streaming div to the transcript; returns { append, finalize }.
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
  };
}

// ── Day One ───────────────────────────────────────────────────────────────────

function handleSourceChange() {
  const v = document.getElementById('source-select').value;
  document.getElementById('paste-area-container').style.display = v === 'paste' ? 'block' : 'none';
  document.getElementById('fetched-display').style.display = v === 'dayone' ? 'block' : 'none';
}

async function fetchEntry() {
  const display = document.getElementById('entry-display');
  display.textContent = 'Reaching through the veil...';
  display.classList.add('placeholder');
  setStatus('Fetching from PreSeedings of the Secret Cabinet...', true);
  try {
    const res = await fetch('/api/dayone/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ journalId: DAYONE_JOURNAL_ID, journalName: DAYONE_JOURNAL_NAME }),
    });
    const data = await res.json();
    currentEntry = data.text;
    display.textContent = data.text;
    display.classList.remove('placeholder');
    document.getElementById('entry-date-tag').textContent = data.date || '';
    document.getElementById('entry-journal-tag').textContent = DAYONE_JOURNAL_NAME;
    setStatus('The document has been read aloud. The room has heard it.', false);
  } catch (e) {
    display.textContent = 'The transmission failed. Try paste instead.';
    display.classList.add('placeholder');
    setStatus('Fetch failed. Use paste instead.', false);
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

  const roundLabels = ['First Movement', 'The Room Responds', 'Final Embers'];

  try {
    // Round 1 — POST /api/convene (streaming)
    currentRound = 1;
    updatePips();
    setStatus('First Movement... the room is speaking.', true);
    addRoundHeader('First Movement');

    let accumulated = '';
    const s1 = startStreamEntry();
    const d1 = await streamPost('/api/convene', { entry, members: [...activeMembers] }, chunk => {
      accumulated += chunk;
      s1.append(chunk);
    });
    s1.finalize(accumulated);
    currentSessionId = d1.sessionId;
    accumulated = '';

    // Rounds 2 and 3
    for (let i = 1; i < roundLabels.length; i++) {
      currentRound = i + 1;
      updatePips();
      setStatus(`${roundLabels[i]}... the room is speaking.`, true);
      await new Promise(r => setTimeout(r, 300));
      addRoundHeader(roundLabels[i]);

      const sn = startStreamEntry();
      await streamPost('/api/round', { sessionId: currentSessionId }, chunk => {
        accumulated += chunk;
        sn.append(chunk);
      });
      sn.finalize(accumulated);
      accumulated = '';
    }

    document.getElementById('interject-panel').className = 'interject-panel visible';
    document.getElementById('additional-round-btn').className = 'lodge-btn visible';
    document.getElementById('export-panel').className = 'export-panel visible';
    updatePips();
    setStatus('The meeting has found its natural pause. The embers hold.', false);

  } catch (err) {
    console.error(err);
    setStatus('The lodge could not convene. Check the server.', false);
  } finally {
    document.getElementById('convene-btn').disabled = false;
  }
}

// ── Additional round ──────────────────────────────────────────────────────────

async function addRound() {
  if (!currentSessionId) return;
  const btn = document.getElementById('additional-round-btn');
  btn.disabled = true;
  currentRound++;
  updatePips();
  setStatus('One More Turn... the room continues.', true);
  addRoundHeader('One More Turn');

  try {
    let accumulated = '';
    const s = startStreamEntry();
    await streamPost('/api/round', { sessionId: currentSessionId }, chunk => {
      accumulated += chunk;
      s.append(chunk);
    });
    s.finalize(accumulated);
    setStatus('The embers hold a while longer.', false);
  } catch (err) {
    console.error(err);
    setStatus('The round could not continue.', false);
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

  addRoundHeader('A Presence Passes Through');
  addSpeech('— a voice from elsewhere —', text, false, true);
  setStatus('The room notices...', true);

  try {
    let accumulated = '';
    const s = startStreamEntry();
    await streamPost('/api/interject', { sessionId: currentSessionId, text }, chunk => {
      accumulated += chunk;
      s.append(chunk);
    });
    s.finalize(accumulated);
    setStatus('The presence withdraws. The room continues.', false);
  } catch (err) {
    console.error(err);
    setStatus('The interjection went unheard.', false);
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
  document.getElementById('export-status').textContent = 'Saving to PreSeedings of the Secret Cabinet...';
  try {
    const res = await fetch('/api/dayone/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        journalId: DAYONE_JOURNAL_ID,
        journalName: DAYONE_JOURNAL_NAME,
        transcriptText,
        sessionDate,
      }),
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    document.getElementById('export-status').textContent = `Saved to ${DAYONE_JOURNAL_NAME}.`;
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
    transcriptText = session.transcriptText || '';
    currentSessionId = session.id;
    sessionDate = session.date;
    currentEntry = session.entry || '';
    currentRound = session.rounds?.length || 0;

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

// ── Init ──────────────────────────────────────────────────────────────────────

renderMembers();

// Load session count on startup
fetch('/api/sessions')
  .then(r => r.json())
  .then(sessions => {
    if (sessions.length) document.getElementById('sessions-count').textContent = sessions.length;
  })
  .catch(() => {});
