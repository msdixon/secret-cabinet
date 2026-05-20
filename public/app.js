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
    // Round 1 — POST /api/convene
    currentRound = 1;
    updatePips();
    setStatus('First Movement... the room is speaking.', true);
    addRoundHeader('First Movement');

    const r1 = await fetch('/api/convene', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry, members: [...activeMembers] }),
    });
    if (!r1.ok) throw new Error(`Server error ${r1.status}`);
    const d1 = await r1.json();
    currentSessionId = d1.sessionId;
    parseAndRenderTranscript(d1.text);

    // Rounds 2 and 3
    for (let i = 1; i < roundLabels.length; i++) {
      currentRound = i + 1;
      updatePips();
      setStatus(`${roundLabels[i]}... the room is speaking.`, true);
      await new Promise(r => setTimeout(r, 400));
      addRoundHeader(roundLabels[i]);

      const rn = await fetch('/api/round', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: currentSessionId }),
      });
      if (!rn.ok) throw new Error(`Server error ${rn.status}`);
      const dn = await rn.json();
      parseAndRenderTranscript(dn.text);
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
    const res = await fetch('/api/round', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentSessionId }),
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    parseAndRenderTranscript(data.text);
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
    const res = await fetch('/api/interject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentSessionId, text }),
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    parseAndRenderTranscript(data.response);
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

// ── Init ──────────────────────────────────────────────────────────────────────

renderMembers();
