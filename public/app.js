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

// No members selected by default — user assembles the room each session.
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

// ── Render member tokens ──────────────────────────────────────────────────────

function renderMembers() {
  document.getElementById('members-grid').innerHTML = '';

  // No core/guest distinction — one sorted, filterable roster. An already-active
  // member stays visible even when the filter no longer matches them, so casting
  // someone doesn't make them disappear.
  const filter = (document.getElementById('member-filter')?.value || '').trim().toLowerCase();
  const roster = [...MEMBERS].sort((a, b) => a.name.localeCompare(b.name));
  const grid = document.getElementById('members-grid');
  let visibleCount = 0;

  roster.forEach(m => {
    const isActive = activeMembers.has(m.id);
    if (filter && !isActive && !m.name.toLowerCase().includes(filter)) return;
    visibleCount++;
    const el = document.createElement('div');
    el.className = 'member-token' + (isActive ? ' active' : '');
    el.innerHTML = `<div class="member-dot"></div><span class="member-name">${m.name}</span>`;
    el.onclick = () => {
      if (isActive) activeMembers.delete(m.id);
      else activeMembers.add(m.id);
      renderMembers();
    };
    grid.appendChild(el);
  });

  const emptyHint = document.getElementById('members-empty-hint');
  emptyHint.style.display = (filter && visibleCount === 0) ? 'block' : 'none';
  if (filter) document.getElementById('members-empty-hint-term').textContent = filter;

  updateMemberCount();
  populateArtifactSelect();
  if (activeMembers.size > 0) buildDossier([...activeMembers]);
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
  updateArcFieldAvailability();
  updatePips();
}

function updateArcFieldAvailability() {
  [1, 2, 3].forEach(i => {
    const disabled = i > selectedRoundCount;
    document.getElementById(`arc-${i}`).disabled = disabled;
    document.getElementById(`arc-field-${i}`)?.classList.toggle('arc-field-disabled', disabled);
  });
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

// ── Speaker glyphs ────────────────────────────────────────────────────────────
// Historically grounded symbols rendered beside each speaker's name.

const MEMBER_GLYPHS = {
  crowley:   '☿',  // Mercury / Thoth — his magical motto and Thoth correspondence
  waite:     '✡',  // Hexagram — Kabbalistic centre of his work
  pixie:     '♃',  // Jupiter — abundance, vision, her Tarot suits
  yeats:     '☽',  // Crescent moon — A Vision, lunar obsession
  blavatsky: '☸',  // Dharma wheel — Theosophical Society seal
  levi:      '△',  // Upward triangle — Baphomet, elemental fire
  teresa:    '✦',  // Four-pointed star — the Interior Castle
  arabi:     '◯',  // Circle — wahdat al-wujud, unity of being
  maud:      '✿',  // Flower / rose — Irish nationalism, beauty as weapon
  llull:     '✺',  // Asterisk — the Lullian combinatory wheel
  khaldun:   '⬡',  // Hexagon — asabiyyah cycles, civilisational geometry
  dee:       '✧',  // Four-pointed star — Monas Hieroglyphica
};

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
    c.scrollTop = c.scrollHeight;
    transcriptText += nonEmptyLines.join('\n') + '\n\n';
    return;
  }
  const e = document.createElement('div');
  const entryId = `entry-${++_entryCounter}`;
  const side = getSpeakerSide(memberId || speaker);
  e.className = `transcript-entry bubble-${side}`;
  e.dataset.entryId = entryId;
  e.dataset.speaker = speaker;
  let nc;
  if (isObserver) nc = 'observer-voice';
  else if (memberId) nc = `voice-${memberId}`;
  else nc = '';
  const glyph = memberId && MEMBER_GLYPHS[memberId]
    ? `<span class="speaker-glyph">${MEMBER_GLYPHS[memberId]}</span>`
    : '';
  const nameEl = `<div class="speaker-name ${nc}" ${memberId ? `onclick="highlightDossierEntry('${memberId}')" style="cursor:pointer"` : ''}>${glyph}${escapeHTML(speaker)}</div>`;
  e.innerHTML = `${nameEl}<div class="bubble-body"><div class="speech-text" onclick="toggleAnnotation(this.closest('.transcript-entry'))">${renderActions(text)}</div><div class="annotation-area" style="display:none"><textarea class="annotation-input" placeholder="Note…" onblur="saveAnnotation(this)" onkeydown="if(event.key==='Escape')closeAnnotation(this.closest('.transcript-entry'))"></textarea></div></div>`;
  if (existingAnnotation) {
    e.classList.add('annotated');
    e.querySelector('.annotation-input').value = existingAnnotation;
  }
  c.appendChild(e);
  c.scrollTop = c.scrollHeight;
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
function isKnownSpeakerHeader(t, members) {
  const norm = normalizeSpeaker(t.replace(/:$/, ''));
  const index = buildAliasIndex(members);
  return index.has(norm) && index.get(norm) != null;
}

function parseAndRenderTranscript(response) {
  const lines = response.split('\n');
  let speaker = null, textLines = [];

  const flush = () => {
    if (speaker && textLines.length) {
      const text = textLines.join('\n').trim();
      const m = resolveMember(speaker, MEMBERS);
      addSpeech(speaker, text, false, m?.id);
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
      const c = document.getElementById('transcript-content');
      const d = document.createElement('div');
      d.className = 'action-line';
      d.textContent = t.slice(1, -1);
      c.appendChild(d);
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
      if (entryCache.has(key)) {
        sel.value = key;
        handleSourceChange(); // load entry text into state
      }
    }

  } catch (e) {
    if (loadingGroup) loadingGroup.label = 'Could not connect to Day One';
  }

  // Add library entries as an optgroup
  try {
    const libRes = await fetch('/api/library');
    const libEntries = await libRes.json();
    if (Array.isArray(libEntries) && libEntries.length) {
      const libGroup = document.createElement('optgroup');
      libGroup.label = 'Archival Library';
      libEntries.forEach(entry => {
        const opt = document.createElement('option');
        opt.value = `library:${entry.id}`;
        opt.textContent = `${entry.date}  ${entry.title}`;
        libGroup.appendChild(opt);
      });
      sel.appendChild(libGroup);
    }
  } catch (_) {}
}

function handleSourceChange() {
  const v = document.getElementById('source-select').value;
  const isPaste = v === 'paste';
  document.getElementById('paste-area-container').style.display = isPaste ? 'block' : 'none';
  document.getElementById('fetched-display').style.display = isPaste ? 'none' : 'block';

  // Changing source clears any prior transcript reconvene state
  if (!v.startsWith('transcript:')) currentSourceSessionId = null;

  if (v.startsWith('library:')) {
    const id = v.slice('library:'.length);
    currentEntry = '';
    const display = document.getElementById('entry-display');
    display.textContent = 'Loading…';
    display.classList.add('placeholder');
    fetch(`/api/library/${id}`)
      .then(r => r.json())
      .then(entry => {
        currentEntry = entry.text;
        display.textContent = entry.text;
        display.classList.remove('placeholder');
        document.getElementById('entry-date-tag').textContent = entry.date || '';
        document.getElementById('entry-journal-tag').textContent = entry.source || 'Library';
        setStatus('The document has been read aloud. The room has heard it.', false);
      })
      .catch(() => {
        display.textContent = 'Could not load entry.';
      });
  } else if (!isPaste && entryCache.has(v)) {
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


// ── File import ───────────────────────────────────────────────────────────────

async function handleFileSelect(input) {
  const file = input.files[0];
  if (!file) return;
  const nameEl = document.getElementById('file-pick-name');
  nameEl.textContent = 'Reading…';

  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'txt' || ext === 'md') {
    // Read client-side — no server round-trip
    const text = await file.text();
    fillFromFile(text.trim(), file.name);
  } else if (ext === 'pdf') {
    // Send to server for extraction
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      fillFromFile(data.text, data.filename);
    } catch (e) {
      nameEl.textContent = `Error: ${e.message}`;
    }
  }
  // Reset input so the same file can be re-selected
  input.value = '';
}

const FILE_TEXT_LIMIT = 4000; // chars — keeps context manageable across rounds

function fillFromFile(text, filename) {
  const area = document.getElementById('paste-area');
  let notice = '';
  if (text.length > FILE_TEXT_LIMIT) {
    text = text.slice(0, FILE_TEXT_LIMIT);
    // Trim to last complete sentence
    const lastStop = Math.max(text.lastIndexOf('. '), text.lastIndexOf('.\n'), text.lastIndexOf('? '), text.lastIndexOf('! '));
    if (lastStop > FILE_TEXT_LIMIT * 0.7) text = text.slice(0, lastStop + 1);
    notice = ' (trimmed to first ~4,000 chars — paste a specific passage for longer texts)';
  }
  area.value = text;
  document.getElementById('file-pick-name').textContent = filename + notice;
  // Ensure paste mode is active
  const sel = document.getElementById('source-select');
  sel.value = 'paste';
  handleSourceChange();
  setStatus(`"${filename}" loaded.${notice ? ' Long document trimmed.' : ' The room has heard it.'}`, false);
}

// ── Convene ───────────────────────────────────────────────────────────────────

async function convene() {
  const entry = getEntry();
  if (!entry) { setStatus('The room requires a document.', false); return; }
  if (activeMembers.size < 2) { setStatus('At least two must be present.', false); return; }

  document.getElementById('transcript-empty').style.display = 'none';
  document.getElementById('transcript-content').innerHTML = '';
  _entryCounter = 0;

  lastSpeakerId = null; currentSpeakerSide = 'right';
  document.getElementById('convene-btn').disabled = true;
  document.querySelectorAll('.round-count-btn').forEach(b => b.disabled = true);
  document.getElementById('additional-round-btn').className = 'lodge-btn';
  document.getElementById('export-panel').className = 'export-panel';
  document.getElementById('interject-panel').className = 'interject-panel';

  currentSessionId = null;
  currentRound = 0;
  activeConveneRoundCount = selectedRoundCount;
  sessionDate = new Date().toISOString().split('T')[0];
  const members = [...activeMembers];
  const memberNames = members.map(id => MEMBERS.find(m => m.id === id)?.name).filter(Boolean).join(', ');
  const entryForHeader = getEntry();
  transcriptText = `THE SECRET-CABIN-ET\nMeeting Notes — ${sessionDate}\nAssembled: ${memberNames}\n\nSource material:\n${entryForHeader}\n`;
  const roundInstructions = Array.from({ length: activeConveneRoundCount }, (_, idx) => idx + 1)
    .map(i => document.getElementById(`arc-${i}`)?.value.trim()).filter(Boolean);

  const artifactText = document.getElementById('artifact-text')?.value.trim();
  const artifactMemberId = document.getElementById('artifact-member')?.value;
  const artifact = (artifactText && artifactMemberId) ? { text: artifactText, memberId: artifactMemberId } : null;
  const notes = collectSessionNotes();

  try {
    // Round 1
    currentRound = 1;
    updatePips();
    setStatus('First Movement... the room is speaking.', true);
    const txtBefore1 = transcriptText;
    const h1 = addRoundHeader('First Movement');
    const s1 = startStreamEntry();
    // acc (below) is only for the live-typing view as chunks arrive — the
    // settled render uses the server's `text` from the done event instead,
    // since the server may post-process the raw stream (e.g. stripping
    // blank lines the per-speaker pipeline can introduce) before storing it.
    let acc = '';
    let d1;
    try {
      d1 = await streamPost('/api/convene', { entry, members, roundInstructions, roundCount: activeConveneRoundCount, artifact, notes, sourceSessionId: currentSourceSessionId || undefined }, chunk => { acc += chunk; s1.append(chunk); });
      s1.finalize(d1.text);
      currentSessionId = d1.sessionId;
      buildDossier(members);
    } catch (err) {
      s1.abort(); h1.remove(); transcriptText = txtBefore1;
      setError('The first movement could not begin. The fire may be low.', convene);
      return;
    }

    // Remaining rounds up to the selected round count
    for (let i = 1; i < activeConveneRoundCount; i++) {
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
        const d = await streamPost('/api/round', { sessionId: currentSessionId }, chunk => { acc += chunk; s.append(chunk); });
        s.finalize(d.text);
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
      setStatus(`${ROUND_LABELS[i]}... the room is speaking.`, true);
      if (i > fromIndex) await new Promise(r => setTimeout(r, 300));
      const txtBefore = transcriptText;
      const h = addRoundHeader(ROUND_LABELS[i]);
      const s = startStreamEntry();
      let acc = '';
      const ri = i;
      try {
        const d = await streamPost('/api/round', { sessionId: currentSessionId }, chunk => { acc += chunk; s.append(chunk); });
        s.finalize(d.text);
      } catch (err) {
        s.abort(); h.remove(); transcriptText = txtBefore;
        setError(`${ROUND_LABELS[ri]} could not continue.`, () => resumeRounds(ri));
        return;
      }
    }
    setStatus('The meeting has found its natural pause. The embers hold.', false);
  } finally {
    document.getElementById('convene-btn').disabled = false;
    document.querySelectorAll('.round-count-btn').forEach(b => b.disabled = false);
  }
}

function showSessionControls() {
  document.getElementById('interject-panel').className = 'interject-panel visible';
  document.getElementById('additional-round-btn').className = 'lodge-btn visible';
  document.getElementById('verify-citations-btn').className = 'lodge-btn visible';
  document.getElementById('export-panel').className = 'export-panel visible';
  updatePips();
}

// ── Citation verification ────────────────────────────────────────────────────

// A speech turn can contain more than one citation — worst verdict wins the
// border color (so a hallucination is never masked by a verified one in the
// same turn), and all notes are concatenated rather than the last one clobbering
// the rest.
const CITATION_VERDICT_SEVERITY = { unverified: 2, uncertain: 1, verified: 0 };

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
    speechEl.title = flags.map(f =>
      f.note + (f.libraryCitation ? `\nGrounded in: ${f.libraryCitation}` : '')).join('\n\n');
  });
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
    const d = await streamPost('/api/round', { sessionId: currentSessionId }, chunk => {
      accumulated += chunk;
      s.append(chunk);
    });
    s.finalize(d.text);
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
  addSpeech('— a voice from elsewhere —', text, true);
  setStatus('The room notices...', true);
  await sendInterject(text);
}

async function sendInterject(text) {
  const s = startStreamEntry();
  let accumulated = '';
  try {
    const d = await streamPost('/api/interject', { sessionId: currentSessionId, text }, chunk => {
      accumulated += chunk;
      s.append(chunk);
    });
    s.finalize(d.text);
    lastInterjectText = '';
    setStatus('The presence withdraws. The room continues.', false);
  } catch (err) {
    s.abort();
    setError('The interjection went unheard.', () => sendInterject(lastInterjectText));
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

function buildAnnotatedTranscript() {
  // Weave annotations into the transcript text after each annotated speech block
  let out = transcriptText;
  const annotated = [...document.querySelectorAll('.transcript-entry.annotated')];
  if (!annotated.length) return out;
  // Rebuild line-by-line, inserting annotations after each speaker's block
  const lines = out.split('\n');
  const result = [];
  let i = 0;
  while (i < lines.length) {
    result.push(lines[i]);
    // Check if this is a speaker — line ending in " —" followed by speech
    const match = lines[i].match(/^(.+) —$/);
    if (match) {
      const speaker = match[1];
      const entry = annotated.find(e => e.dataset.speaker === speaker);
      const note = entry?.querySelector('.annotation-input')?.value.trim();
      if (note && entry) {
        // Collect the speech block (next non-empty lines until blank)
        while (i + 1 < lines.length && lines[i + 1] !== '') {
          i++;
          result.push(lines[i]);
        }
        result.push(`  ↳ ${note}`);
        annotated.splice(annotated.indexOf(entry), 1); // consume so dupes don't re-match
      }
    }
    i++;
  }
  return result.join('\n');
}

function reconveneOnCurrentSession() {
  if (!currentSessionId || !transcriptText) return;
  const FILE_TEXT_LIMIT = 4000;
  const full = buildAnnotatedTranscript();
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
  document.getElementById('export-panel').className = 'export-panel';
  currentRound = 0;
  currentSessionId = null;
  transcriptText = '';
  updatePips();

  window.scrollTo({ top: 0, behavior: 'smooth' });
  setStatus('The transcript has been placed on the table. Assemble a new room and reconvene.', false);
}

// ── Witness mode ──────────────────────────────────────────────────────────────

let witnessBlocks = [];      // parsed sequence of blocks to play
let witnessIndex = 0;        // current block position
let witnessTimer = null;     // auto-advance timer
let witnessActive = false;
let witnessSourceSessionId = null; // session being witnessed (for restore on exit)

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
      const m = resolveMember(speaker, MEMBERS);
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
      const isKnownName = isKnownSpeakerHeader(t, MEMBERS);
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
    el.innerHTML = `<div class="witness-rule"></div><span class="witness-round-label">${escapeHTML(block.label)}</span><div class="witness-rule"></div>`;
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
    const glyph = block.memberId && MEMBER_GLYPHS[block.memberId]
      ? `<span class="speaker-glyph">${MEMBER_GLYPHS[block.memberId]}</span>` : '';
    const side = getSpeakerSide(block.memberId || block.speaker);

    const e = document.createElement('div');
    e.className = `transcript-entry bubble-${side}`;
    const nameHtml = `<div class="speaker-name ${nc}">${glyph}${escapeHTML(block.speaker)}</div>`;
    let bodyHtml = `<div class="bubble-body"><div class="speech-text">${renderActions(block.text)}</div>`;
    if (block.annotation) bodyHtml += `<div class="witness-annotation">↳ ${escapeHTML(block.annotation)}</div>`;
    bodyHtml += '</div>';
    e.innerHTML = nameHtml + bodyHtml;
    stage.appendChild(e);
    stage.scrollTop = stage.scrollHeight;
    return witnessReadingTime(block.text);
  }

  return WITNESS_MIN_PAUSE;
}

function witnessAdvance() {
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
  witnessTimer = setTimeout(witnessAdvance, delay);
}

function startWitness(sessionData) {
  // sessionData is optional — if omitted, use the current in-memory session
  const session = sessionData || {
    rounds: (() => {
      // Reconstruct rounds from the current live transcript
      // We don't have rounds split out in memory, so use the stored session
      return null;
    })(),
    annotations: (() => {
      const result = {};
      document.querySelectorAll('.transcript-entry.annotated').forEach(e => {
        const note = e.querySelector('.annotation-input')?.value.trim();
        const speaker = e.dataset.speaker;
        if (note && speaker) result[e.dataset.entryId] = { speaker, note };
      });
      return result;
    })(),
  };

  if (!session.rounds) {
    // No rounds yet — need to fetch from server
    if (!currentSessionId) return;
    fetch(`/api/sessions/${currentSessionId}`)
      .then(r => r.json())
      .then(s => {
        // Merge live annotations into stored session
        const liveAnnotations = {};
        document.querySelectorAll('.transcript-entry.annotated').forEach(e => {
          const note = e.querySelector('.annotation-input')?.value.trim();
          const speaker = e.dataset.speaker;
          if (note && speaker) liveAnnotations[e.dataset.entryId] = { speaker, note };
        });
        s.annotations = { ...( s.annotations || {}), ...liveAnnotations };
        startWitness(s);
      });
    return;
  }

  witnessBlocks = parseWitnessBlocks(session);
  witnessIndex = 0;
  witnessActive = true;
  witnessSourceSessionId = session.id || null;

  // Reset side map for a clean Witness run

  lastSpeakerId = null; currentSpeakerSide = 'right';
  document.getElementById('witness-stage').innerHTML = '';

  // Show witness panel
  document.getElementById('witness-panel').style.display = 'block';
  document.getElementById('witness-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('witness-progress').style.width = '0%';
  document.getElementById('witness-hint').textContent = 'Space or click to advance';

  // Keyboard handler
  document.addEventListener('keydown', witnessKeyHandler);

  witnessAdvance();
}

function witnessKeyHandler(e) {
  if (e.code === 'Space' && witnessActive) {
    e.preventDefault();
    witnessAdvance();
  }
  if (e.code === 'Escape' && witnessActive) {
    exitWitness();
  }
}

function exitWitness() {
  const sessionToRestore = witnessSourceSessionId;
  witnessActive = false;
  witnessSourceSessionId = null;
  clearTimeout(witnessTimer);
  document.removeEventListener('keydown', witnessKeyHandler);
  document.getElementById('witness-panel').style.display = 'none';
  document.getElementById('witness-stage').innerHTML = '';
  // Restore the session transcript so the user lands back in the full view
  if (sessionToRestore && sessionToRestore !== currentSessionId) {
    restoreSession(sessionToRestore);
  }
}

// Entry point from Past Meetings drawer
async function startWitnessFromSession(id) {
  try {
    const session = await fetch(`/api/sessions/${id}`).then(r => r.json());
    closeSessionsDrawer();
    startWitness(session);
  } catch (e) {
    alert('Could not load session for playback.');
  }
}

function exportTxt() {
  const blob = new Blob([buildAnnotatedTranscript()], { type: 'text/plain' });
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
        transcriptText: buildAnnotatedTranscript(),
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

async function exportObsidian() {
  const statusEl = document.getElementById('export-status');
  const vaultPath = document.getElementById('obsidian-vault')?.value.trim();
  if (!vaultPath) { statusEl.textContent = 'Enter your Obsidian vault path first.'; return; }
  statusEl.textContent = 'Writing to Obsidian…';
  try {
    const res = await fetch('/api/export/obsidian', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vaultPath,
        transcriptText: buildAnnotatedTranscript(),
        sessionDate,
        members: [...activeMembers].map(id => MEMBERS.find(m => m.id === id)?.name).filter(Boolean),
        tags: [],
        sourceExcerpt: currentEntry?.slice(0, 120) || '',
        sessionId: currentSessionId,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    statusEl.textContent = `Saved to Obsidian — ${data.filename}`;
  } catch (err) {
    statusEl.textContent = err.message || 'Obsidian export failed.';
  }
}

async function exportUlysses() {
  const statusEl = document.getElementById('export-status');
  const group = document.getElementById('ulysses-group')?.value.trim() || '';
  statusEl.textContent = 'Opening Ulysses…';
  try {
    const res = await fetch('/api/ulysses/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcriptText: buildAnnotatedTranscript(),
        sessionDate,
        title: currentEntry?.slice(0, 60) || sessionDate,
        group,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    statusEl.textContent = group ? `Sent to Ulysses — ${group}.` : 'Sent to Ulysses.';
  } catch (err) {
    statusEl.textContent = err.message || 'Ulysses export failed.';
  }
}

// ── Sessions drawer ───────────────────────────────────────────────────────────

let _searchTimer = null;
function onSessionsSearch(val) {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => {
    const v = val.trim();
    const isTag = v.startsWith('#');
    const isThread = v.startsWith('@');
    if (isTag) loadSessionsList('', v.slice(1).toLowerCase(), '');
    else if (isThread) loadSessionsList('', '', v.slice(1).toLowerCase());
    else loadSessionsList(v, '', '');
  }, 280);
}

async function openSessionsDrawer() {
  document.getElementById('sessions-overlay').classList.add('open');
  document.getElementById('sessions-drawer').classList.add('open');
  const searchEl = document.getElementById('sessions-search');
  if (searchEl) searchEl.value = '';
  await loadSessionsList();
}

function closeSessionsDrawer() {
  document.getElementById('sessions-overlay').classList.remove('open');
  document.getElementById('sessions-drawer').classList.remove('open');
}

async function reconveneOnSession(id) {
  try {
    const data = await fetch(`/api/sessions/${id}/transcript`).then(r => r.json());
    if (data.error) { alert('Could not load transcript.'); return; }

    // Truncate to file import limit to avoid context overflow
    const FILE_TEXT_LIMIT = 4000;
    const truncated = data.transcript.length > FILE_TEXT_LIMIT
      ? data.transcript.slice(0, FILE_TEXT_LIMIT) + '\n\n[transcript truncated]'
      : data.transcript;

    // Set as current document source
    currentEntry = truncated;
    currentSourceSessionId = id;

    // Show in the document panel
    const sourceLabel = `Transcript — ${data.date}${data.members?.length ? ' · ' + data.members.slice(0, 3).join(', ') : ''}`;
    document.getElementById('paste-area-container').style.display = 'none';
    document.getElementById('fetched-display').style.display = 'block';
    const display = document.getElementById('entry-display');
    display.textContent = truncated;
    display.classList.remove('placeholder');
    document.getElementById('entry-date-tag').textContent = data.date || '';
    document.getElementById('entry-journal-tag').textContent = '↩ Prior transcript';

    // Reset source select to avoid confusion
    const sel = document.getElementById('source-select');
    const opt = document.createElement('option');
    opt.value = `transcript:${id}`;
    opt.textContent = sourceLabel;
    opt.selected = true;
    sel.prepend(opt);
    sel.value = `transcript:${id}`;

    setStatus('A prior transcript has been placed on the table. Assemble the room and reconvene.', false);
    closeSessionsDrawer();
  } catch (e) {
    alert('Could not load transcript.');
  }
}

async function loadSessionsList(q = '', tag = '', thread = '') {
  const list = document.getElementById('sessions-list');
  list.innerHTML = '<div class="sessions-empty">Loading...</div>';
  try {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (tag) params.set('tag', tag);
    if (thread) params.set('thread', thread);
    const res = await fetch('/api/sessions' + (params.toString() ? '?' + params : ''));
    const sessions = await res.json();
    const isFiltered = q || tag || thread;
    if (!sessions.length) {
      list.innerHTML = `<div class="sessions-empty">${isFiltered ? 'No meetings match.' : 'No past meetings found.'}</div>`;
      if (!isFiltered) document.getElementById('sessions-count').textContent = '';
      return;
    }
    if (!isFiltered) document.getElementById('sessions-count').textContent = sessions.length;
    list.innerHTML = '';

    // Thread view header
    if (thread && sessions[0]?.threadName) {
      const hdr = document.createElement('div');
      hdr.className = 'thread-header';
      hdr.innerHTML = `<span class="thread-header-name">${escapeHTML(sessions[0].threadName)}</span><span class="thread-header-count">${sessions.length} meeting${sessions.length !== 1 ? 's' : ''}</span><button class="thread-clear-btn" onclick="loadSessionsList()">✕ All meetings</button>`;
      list.appendChild(hdr);
    }

    sessions.forEach(s => {
      const el = document.createElement('div');
      el.className = 'session-item';
      const tagsHtml = (s.tags || []).map(t =>
        `<span class="session-tag" onclick="filterByTag('${escapeHTML(t)}')">${escapeHTML(t)}<span class="tag-remove" onclick="event.stopPropagation();removeTagById('${s.id}','${escapeHTML(t)}',this)">×</span></span>`
      ).join('');
      const threadBadge = s.threadId
        ? `<span class="session-thread-badge" onclick="filterByThread('${escapeHTML(s.threadId)}','${escapeHTML(s.threadName || '')}')" title="View thread: ${escapeHTML(s.threadName || '')}">⬡ ${escapeHTML(s.threadName || s.threadId)}</span>`
        : '';
      el.innerHTML = `
        <div class="session-item-date">
          ${s.date}
          <span class="session-item-rounds">${s.rounds} round${s.rounds !== 1 ? 's' : ''}</span>
          ${threadBadge}
        </div>
        <div class="session-item-entry">${escapeHTML(s.entry || '—')}</div>
        <div class="session-item-members">${(s.members || []).map(escapeHTML).join(' · ')}</div>
        <div class="session-tags-row">${tagsHtml}<button class="add-tag-btn" onclick="addTagUI('${s.id}', this)">+</button></div>
        <div class="session-item-actions">
          <button class="session-load-btn" onclick="restoreSession('${s.id}')">Load this meeting</button>
          <button class="session-witness-btn" onclick="startWitnessFromSession('${s.id}')" title="Watch this meeting play back">◎ Watch</button>
          <button class="session-reconvene-btn" onclick="reconveneOnSession('${s.id}')" title="Use this transcript as the document for a new session">↩ Reconvene</button>
          <button class="session-thread-btn" onclick="assignThreadUI('${s.id}', '${escapeHTML(s.threadId||'')}', '${escapeHTML(s.threadName||'')}', this)">⬡ Thread</button>
          <button class="session-compare-btn" id="compare-btn-${s.id}" onclick="toggleCompareSelect('${s.id}', this)">⊕ Compare</button>
          <button class="session-delete-btn" onclick="deleteSession('${s.id}', this)">Delete</button>
        </div>`;
      list.appendChild(el);
    });
  } catch (e) {
    list.innerHTML = '<div class="sessions-empty">Could not load past meetings.</div>';
  }
}

function filterByThread(threadId, threadName) {
  const input = document.getElementById('sessions-search');
  if (input) input.value = '';
  loadSessionsList('', '', threadId);
}

async function assignThreadUI(sessionId, currentThreadId, currentThreadName, btn) {
  const item = btn.closest('.session-item');
  // Toggle off if already open
  const existing = item.querySelector('.thread-picker');
  if (existing) { existing.remove(); return; }

  const threadsRes = await fetch('/api/threads').then(r => r.json()).catch(() => []);

  const picker = document.createElement('div');
  picker.className = 'thread-picker';

  const others = threadsRes.filter(t => t.id !== currentThreadId);
  const optionsHtml = others.length
    ? `<div class="thread-pick-label">Add to existing thread</div>` +
      others.map(t =>
        `<button class="thread-pick-btn" onclick="setThread('${sessionId}','${escapeHTML(t.id)}','${escapeHTML(t.name)}',this)">${escapeHTML(t.name)}</button>`
      ).join('')
    : '';
  const clearHtml = currentThreadId
    ? `<button class="thread-pick-btn thread-pick-clear" onclick="setThread('${sessionId}','','',this)">Remove from thread</button>`
    : '';

  picker.innerHTML = `
    <div class="thread-picker-header">
      <span class="thread-pick-label">Thread</span>
      <button class="thread-picker-close" onclick="this.closest('.thread-picker').remove()">✕</button>
    </div>
    ${optionsHtml}
    <div class="thread-pick-label" style="margin-top:${others.length ? '8px' : '0'}">New thread</div>
    <div class="thread-new-row">
      <input class="tag-input" style="flex:1;min-width:0" placeholder="Thread name…" id="new-thread-input-${sessionId}" />
      <button class="thread-pick-btn" onclick="createAndSetThread('${sessionId}',this)">Create</button>
    </div>
    ${clearHtml}`;

  // Append to session-item (outside the flex actions row) so layout isn't constrained
  item.appendChild(picker);
  picker.querySelector(`#new-thread-input-${sessionId}`)?.focus();
}

async function createAndSetThread(sessionId, btn) {
  const inp = btn.previousElementSibling;
  const name = inp.value.trim();
  if (!name) return;
  await setThread(sessionId, null, name, btn);
}

async function setThread(sessionId, threadId, threadName, el) {
  const body = (threadId || threadName)
    ? { threadId: threadId || threadName, threadName: threadName || threadId }
    : {};
  await fetch(`/api/sessions/${sessionId}/thread`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  el.closest('.thread-picker')?.remove();
  // Refresh list
  loadSessionsList();
}

function filterByTag(tag) {
  const input = document.getElementById('sessions-search');
  if (input) input.value = '';
  loadSessionsList('', tag);
  const active = document.querySelector('.session-tag.active-filter');
  if (active) active.classList.remove('active-filter');
}

function addTagUI(sessionId, btn) {
  const row = btn.closest('.session-tags-row');
  if (row.querySelector('.tag-input')) return; // already open
  const inp = document.createElement('input');
  inp.className = 'tag-input';
  inp.placeholder = 'tag…';
  inp.maxLength = 30;
  row.insertBefore(inp, btn);
  inp.focus();

  let committed = false;
  const commit = async () => {
    if (committed) return;
    committed = true;
    const val = inp.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/(^-|-$)/g, '');
    inp.remove();
    if (!val) return;
    const existing = [...row.querySelectorAll('.session-tag')].map(el => el.textContent);
    if (existing.includes(val)) return;
    const newTags = [...existing, val];
    await saveTags(sessionId, newTags, row, btn);
  };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { committed = true; inp.remove(); } });
  inp.addEventListener('blur', commit);
}

async function removeTagById(sessionId, tag, el) {
  const row = el.closest('.session-tags-row');
  const addBtn = row.querySelector('.add-tag-btn');
  // Read tag text from first child text node to exclude the × span
  const existing = [...row.querySelectorAll('.session-tag')].map(c => c.firstChild.textContent.trim());
  const newTags = existing.filter(t => t !== tag);
  await saveTags(sessionId, newTags, row, addBtn);
}

function makeTagChip(sessionId, tag, addBtn) {
  const chip = document.createElement('span');
  chip.className = 'session-tag';
  chip.appendChild(document.createTextNode(tag));
  const x = document.createElement('span');
  x.className = 'tag-remove';
  x.textContent = '×';
  x.onclick = (e) => { e.stopPropagation(); removeTagById(sessionId, tag, x); };
  chip.appendChild(x);
  chip.onclick = () => filterByTag(tag);
  return chip;
}

async function saveTags(sessionId, tags, row, addBtn) {
  try {
    await fetch(`/api/sessions/${sessionId}/tags`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags }),
    });
    row.querySelectorAll('.session-tag').forEach(c => c.remove());
    tags.forEach(t => row.insertBefore(makeTagChip(sessionId, t, addBtn), addBtn));
  } catch (e) { /* silent */ }
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
    _entryCounter = 0;
  
    lastSpeakerId = null; currentSpeakerSide = 'right';
    currentSessionId = session.id;
    sessionDate = session.date;
    currentEntry = session.entry || '';
    currentRound = session.rounds?.length || 0;
    activeConveneRoundCount = session.roundCount || 3;
    setRoundCount(activeConveneRoundCount);

    // Rebuild transcriptText from scratch with current formatting
    const names = (session.members || []).map(id => MEMBERS.find(m => m.id === id)?.name).filter(Boolean).join(', ');
    transcriptText = `THE SECRET-CABIN-ET\nMeeting Notes — ${session.date}\nAssembled: ${names}\n\nSource material:\n${session.entry || ''}\n`;

    // Build annotation lookup by entryId for restoration
    const annotationMap = {};
    (session.annotations || []).forEach(a => { annotationMap[a.entryId] = a.note; });

    // Re-render rounds from stored data
    (session.rounds || []).forEach(round => {
      addRoundHeader(round.label);
      parseAndRenderTranscript(round.text);
    });

    // Restore annotations after render (entry IDs are now stable)
    document.querySelectorAll('.transcript-entry').forEach(e => {
      const note = annotationMap[e.dataset.entryId];
      if (note) {
        e.classList.add('annotated');
        const ta = e.querySelector('.annotation-input');
        if (ta) ta.value = note;
      }
    });

    // Restore member selection
    activeMembers = new Set(session.members || []);
    renderMembers();
    buildDossier(session.members || []);

    // Restore citation flags after render (matches by speaker+quote content)
    if (session.citationFlags?.length) applyCitationFlags(session.citationFlags);

    // Show controls
    document.getElementById('interject-panel').className = 'interject-panel visible';
    document.getElementById('additional-round-btn').className = 'lodge-btn visible';
    document.getElementById('verify-citations-btn').className = 'lodge-btn visible';
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

// ── Comparative mode ──────────────────────────────────────────────────────────

const compareSelected = new Set(); // up to 2 session ids

function toggleCompareSelect(id, btn) {
  if (compareSelected.has(id)) {
    compareSelected.delete(id);
    btn.classList.remove('active');
    btn.textContent = '⊕ Compare';
  } else {
    if (compareSelected.size >= 2) return; // already have two
    compareSelected.add(id);
    btn.classList.add('active');
    btn.textContent = '✓ Selected';
  }
  updateCompareBar();
}

function updateCompareBar() {
  let bar = document.getElementById('compare-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'compare-bar';
    bar.className = 'compare-bar';
    const drawerBody = document.getElementById('sessions-list');
    drawerBody.parentElement.insertBefore(bar, drawerBody);
  }
  if (compareSelected.size === 0) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  bar.innerHTML = compareSelected.size === 1
    ? '<span class="compare-bar-hint">Select one more to compare</span><button class="compare-bar-cancel" onclick="clearCompareSelection()">✕</button>'
    : `<button class="lodge-btn compare-bar-go" onclick="openCompareView()">Compare these two</button><button class="compare-bar-cancel" onclick="clearCompareSelection()">✕</button>`;
}

function clearCompareSelection() {
  compareSelected.forEach(id => {
    const btn = document.getElementById(`compare-btn-${id}`);
    if (btn) { btn.classList.remove('active'); btn.textContent = '⊕ Compare'; }
  });
  compareSelected.clear();
  updateCompareBar();
}

async function openCompareView() {
  const [id1, id2] = [...compareSelected];
  closeSessionsDrawer();
  clearCompareSelection();

  const [s1, s2] = await Promise.all([
    fetch(`/api/sessions/${id1}`).then(r => r.json()),
    fetch(`/api/sessions/${id2}`).then(r => r.json()),
  ]);

  const overlay = document.createElement('div');
  overlay.id = 'compare-overlay';
  overlay.className = 'compare-overlay';
  overlay.innerHTML = `
    <div class="compare-header">
      <span class="compare-title">Comparative View</span>
      <button class="sessions-close-btn" onclick="this.closest('.compare-overlay').remove()">✕ Close</button>
    </div>
    <div class="compare-panels">
      <div class="compare-panel" id="cp-left"></div>
      <div class="compare-panel" id="cp-right"></div>
    </div>`;
  document.body.appendChild(overlay);

  renderComparePanel('cp-left', s1);
  renderComparePanel('cp-right', s2);
}

function renderComparePanel(containerId, session) {
  const panel = document.getElementById(containerId);
  const memberNames = (session.members || [])
    .map(id => MEMBERS.find(m => m.id === id)?.name || id).join(' · ');
  panel.innerHTML = `
    <div class="compare-panel-header">
      <div class="compare-panel-date">${session.date}</div>
      <div class="compare-panel-members">${memberNames}</div>
      <div class="compare-panel-source">${escapeHTML((session.entry || '').slice(0, 120))}</div>
    </div>
    <div class="compare-panel-transcript" id="${containerId}-transcript"></div>`;

  // Render each round into the panel
  const transcriptEl = document.getElementById(`${containerId}-transcript`);
  (session.rounds || []).forEach(round => {
    const hdr = document.createElement('div');
    hdr.className = 'transcript-round-header';
    hdr.innerHTML = `<div class="round-rule"></div><span class="round-rule-label">${round.label}</span><div class="round-rule"></div>`;
    transcriptEl.appendChild(hdr);
    renderTranscriptInto(transcriptEl, round.text);
  });
}

function renderTranscriptInto(container, text) {
  let localLastId = null;
  let localCurrentSide = 'right';
  const localSide = id => {
    if (id !== localLastId) { localCurrentSide = localCurrentSide === 'left' ? 'right' : 'left'; localLastId = id; }
    return localCurrentSide;
  };

  const lines = text.split('\n');
  let speaker = null, textLines = [];

  const flush = () => {
    if (!speaker || !textLines.length) return;
    const m = resolveMember(speaker, MEMBERS);
    const nc = m ? `voice-${m.id}` : '';
    const side = localSide(m?.id || speaker);
    const e = document.createElement('div');
    e.className = `transcript-entry bubble-${side}`;
    e.innerHTML = `<div class="speaker-name ${nc}">${escapeHTML(speaker)}</div><div class="bubble-body"><div class="speech-text">${renderActions(textLines.join('\n').trim())}</div></div>`;
    container.appendChild(e);
    speaker = null; textLines = [];
  };

  lines.forEach(line => {
    const t = line.trim();
    if (!t) { flush(); return; }
    if (t === '---' || t === '—' || t === '--') return;
    const isAction = /^\*[^*\n]+\*$/.test(t);
    if (isAction && !speaker) {
      const d = document.createElement('div');
      d.className = 'action-line';
      d.textContent = t.slice(1, -1);
      container.appendChild(d);
      return;
    }
    const isKnownName = isKnownSpeakerHeader(t, MEMBERS);
    const looksLikeName = !t.includes(' ') && t.length < 30 && /^[A-Z]/.test(t) && !t.includes('*');
    if (isKnownName || looksLikeName) { flush(); speaker = t.replace(/:$/, ''); textLines = []; }
    else if (speaker) textLines.push(t);
  });
  flush();
}

// ── Dossier drawer ────────────────────────────────────────────────────────────

let dossierOpen = false;
const sessionNotes = {}; // memberId → override text

function toggleDossier() {
  dossierOpen = !dossierOpen;
  document.getElementById('dossier-drawer').classList.toggle('open', dossierOpen);
  document.getElementById('dossier-overlay').classList.toggle('open', dossierOpen);
}

async function buildDossier(memberIds) {
  const body = document.getElementById('dossier-body');
  body.innerHTML = '<div class="sessions-empty">Loading…</div>';
  document.getElementById('dossier-btn').style.display = 'inline-block';

  // Preserve any notes already typed before rebuilding
  document.querySelectorAll('.dossier-note').forEach(ta => {
    if (ta.value.trim()) sessionNotes[ta.dataset.memberId] = ta.value;
  });

  const entries = await Promise.all(memberIds.map(id =>
    fetch(`/api/members/${id}/dossier`).then(r => r.json()).catch(() => null)
  ));

  body.innerHTML = '';
  entries.filter(Boolean).forEach(d => {
    const el = document.createElement('div');
    el.className = 'dossier-entry';
    el.id = `dossier-${d.id}`;
    const existingNote = sessionNotes[d.id] || '';
    el.innerHTML = `
      <div class="dossier-name">${escapeHTML(d.name)}</div>
      ${d.bio ? `<div class="dossier-section-label">Who they are</div>
      <div class="dossier-text">${escapeHTML(d.bio)}</div>` : ''}
      ${d.voice ? `<button class="dossier-toggle" onclick="this.nextElementSibling.classList.toggle('open');this.textContent=this.nextElementSibling.classList.contains('open')?'▲ Voice':'▼ Voice'">▼ Voice</button>
      <div class="dossier-voice"><div class="dossier-section-label">How they speak</div>
      <div class="dossier-text">${escapeHTML(d.voice)}</div></div>` : ''}
      <div class="dossier-section-label" style="margin-top:10px;">Session note</div>
      <textarea class="dossier-note arc-textarea" data-member-id="${d.id}" rows="2"
        placeholder="Context for this session only — not saved to the character file."
        oninput="sessionNotes['${d.id}']=this.value"
      >${escapeHTML(existingNote)}</textarea>`;
    body.appendChild(el);
  });
}

function collectSessionNotes() {
  // Also sweep any live textareas in case oninput missed something
  document.querySelectorAll('.dossier-note').forEach(ta => {
    sessionNotes[ta.dataset.memberId] = ta.value;
  });
  return Object.fromEntries(Object.entries(sessionNotes).filter(([, v]) => v.trim()));
}

function highlightDossierEntry(memberId) {
  if (!memberId) return;
  document.querySelectorAll('.dossier-entry.highlighted').forEach(e => e.classList.remove('highlighted'));
  const entry = document.getElementById(`dossier-${memberId}`);
  if (!entry) return;
  entry.classList.add('highlighted');
  if (dossierOpen) entry.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

// ── Environment config ────────────────────────────────────────────────────────

async function applyEnvConfig() {
  try {
    const { isLocal } = await fetch('/api/config').then(r => r.json());
    if (!isLocal) {
      document.getElementById('export-ulysses-row')?.style.setProperty('display', 'none');
      document.getElementById('export-obsidian-row')?.style.setProperty('display', 'none');
      document.getElementById('export-md-row')?.style.setProperty('display', 'flex');
    }
  } catch (_) {}
}

function exportMd() {
  if (!currentTranscript) return;
  const text = buildAnnotatedTranscript();
  const blob = new Blob([text], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `secret-cabinet-${currentSession?.date || new Date().toISOString().slice(0,10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Init ──────────────────────────────────────────────────────────────────────

applyEnvConfig();
fetchMembers().then(() => renderMembers());
updateExportJournalLabel();
updateArcFieldAvailability();
// Restore saved Ulysses group preference
const _savedGroup = localStorage.getItem('sc-ulysses-group');
if (_savedGroup) { const _gi = document.getElementById('ulysses-group'); if (_gi) _gi.value = _savedGroup; }
const _savedVault = localStorage.getItem('sc-obsidian-vault');
if (_savedVault) { const _vi = document.getElementById('obsidian-vault'); if (_vi) _vi.value = _savedVault; }

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
