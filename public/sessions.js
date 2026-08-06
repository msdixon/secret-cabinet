'use strict';

// #142: extracted from app.js's "Sessions drawer" / "Comparative mode" /
// "Dossier drawer" sections -- the third and last target named in the seam
// mapping (https://github.com/msdixon/secret-cabinet/issues/142#issuecomment-5197135471),
// following the same script-tag/IIFE convention as scene.js, witness.js, and
// export.js. window.Sessions exposes a small API; app.js calls into it and
// never touches these internals directly.
//
// This is the most core-state-coupled of the three extractions -- the seam
// mapping called it out explicitly ("more coupled to core render functions
// -- do this one last, once the pattern's proven twice already"), mainly
// because of restoreSession(), which hydrates nearly every piece of core
// session/player state app.js owns. Rather than reach into app.js's globals
// directly, app.js hands this module a `deps` bag once via configure() --
// a live getCore() accessor plus setters for every field this module needs
// to write, and the handful of core render/helper functions it calls into
// (escapeHTML, resolveMember, addRoundHeader, ...) -- same shape as
// export.js's exportDeps(), just with more entries given the extra coupling.
window.Sessions = (function () {
  let deps = null; // set by configure(); see app.js's sessionsDeps()

  function configure(injectedDeps) {
    deps = injectedDeps;
  }

  // ── Sessions drawer ───────────────────────────────────────────────────────

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
      deps.setCurrentEntry(truncated);
      deps.setCurrentSourceSessionId(id);

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

      deps.setStatus('A prior transcript has been placed on the table. Assemble the room and reconvene.', false);
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
        hdr.innerHTML = `<span class="thread-header-name">${deps.escapeHTML(sessions[0].threadName)}</span><span class="thread-header-count">${sessions.length} meeting${sessions.length !== 1 ? 's' : ''}</span><button class="thread-clear-btn" onclick="window.Sessions.loadSessionsList()">✕ All meetings</button>`;
        list.appendChild(hdr);
      }

      // #33: nest branch children under their parent when the parent is also
      // in this (possibly filtered/paginated) batch. A child whose parent fell
      // outside the current batch just renders flat with its branch badge --
      // no extra fetch to go find an off-screen parent.
      const byId = {};
      sessions.forEach(s => { byId[s.id] = s; });
      const childrenOf = {};
      sessions.forEach(s => {
        if (s.parentId && byId[s.parentId]) {
          (childrenOf[s.parentId] = childrenOf[s.parentId] || []).push(s);
        }
      });
      const isNestedChild = s => s.parentId && byId[s.parentId];

      const renderSessionItem = (s, depth) => {
        const el = document.createElement('div');
        el.className = 'session-item';
        if (depth > 0) el.style.marginLeft = `${depth * 20}px`;
        const tagsHtml = (s.tags || []).map(t =>
          `<span class="session-tag" onclick="window.Sessions.filterByTag('${deps.escapeHTML(t)}')">${deps.escapeHTML(t)}<span class="tag-remove" onclick="event.stopPropagation();window.Sessions.removeTagById('${s.id}','${deps.escapeHTML(t)}',this)">×</span></span>`
        ).join('');
        const threadBadge = s.threadId
          ? `<span class="session-thread-badge" onclick="window.Sessions.filterByThread('${deps.escapeHTML(s.threadId)}','${deps.escapeHTML(s.threadName || '')}')" title="View thread: ${deps.escapeHTML(s.threadName || '')}">⬡ ${deps.escapeHTML(s.threadName || s.threadId)}</span>`
          : '';
        const branchBadge = s.parentId
          ? `<span class="session-branch-badge" title="Branched from round ${(s.branchRound ?? 0) + 1} of another meeting">⑂ branch</span>`
          : '';
        const publishedBadge = s.published
          ? `<a class="session-published-badge" href="/reading-room/${s.id}" target="_blank" rel="noopener" title="View the public reading-room page">★ Public</a>`
          : '';
        el.innerHTML = `
          <div class="session-item-date">
            ${s.date}
            <span class="session-item-rounds">${s.rounds} round${s.rounds !== 1 ? 's' : ''}</span>
            ${threadBadge}
            ${branchBadge}
            ${publishedBadge}
          </div>
          <div class="session-item-entry">${deps.escapeHTML(s.entry || '—')}</div>
          <div class="session-item-members">${(s.members || []).map(deps.escapeHTML).join(' · ')}</div>
          <div class="session-tags-row">${tagsHtml}<button class="add-tag-btn" onclick="window.Sessions.addTagUI('${s.id}', this)">+</button></div>
          <div class="session-item-actions">
            <button class="session-load-btn" onclick="window.Sessions.restoreSession('${s.id}')">Load this meeting</button>
            <button class="session-witness-btn" onclick="startWitnessFromSession('${s.id}')" title="Watch this meeting play back">◎ Watch</button>
            <button class="session-reconvene-btn" onclick="window.Sessions.reconveneOnSession('${s.id}')" title="Use this transcript as the document for a new session">↩ Reconvene</button>
            <button class="session-thread-btn" onclick="window.Sessions.assignThreadUI('${s.id}', '${deps.escapeHTML(s.threadId||'')}', '${deps.escapeHTML(s.threadName||'')}', this)">⬡ Thread</button>
            <button class="session-compare-btn" id="compare-btn-${s.id}" onclick="window.Sessions.toggleCompareSelect('${s.id}', this)">⊕ Compare</button>
            <button class="session-publish-btn${s.published ? ' is-published' : ''}" onclick="window.Sessions.togglePublish('${s.id}', ${!!s.published}, this)" title="${s.published ? 'Unpublish from the public reading room' : 'Publish to the public reading room'}">${s.published ? '★ Unpublish' : '☆ Publish'}</button>
            <button class="session-delete-btn" onclick="window.Sessions.deleteSession('${s.id}', this)">Delete</button>
          </div>`;
        list.appendChild(el);
        (childrenOf[s.id] || []).forEach(child => renderSessionItem(child, depth + 1));
      };

      sessions.forEach(s => {
        if (isNestedChild(s)) return; // rendered under its parent instead
        renderSessionItem(s, 0);
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
          `<button class="thread-pick-btn" onclick="window.Sessions.setThread('${sessionId}','${deps.escapeHTML(t.id)}','${deps.escapeHTML(t.name)}',this)">${deps.escapeHTML(t.name)}</button>`
        ).join('')
      : '';
    const clearHtml = currentThreadId
      ? `<button class="thread-pick-btn thread-pick-clear" onclick="window.Sessions.setThread('${sessionId}','','',this)">Remove from thread</button>`
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
        <button class="thread-pick-btn" onclick="window.Sessions.createAndSetThread('${sessionId}',this)">Create</button>
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
    deps.setStatus('Restoring past meeting...', true);
    try {
      const res = await fetch(`/api/sessions/${id}`);
      if (!res.ok) throw new Error('Not found');
      const session = await res.json();

      // A restored session is static, read-only history -- never render it into
      // the live Witness stage even if that toggle happened to be left on. Also
      // clear the stage itself: resetTranscriptCounters() below resets
      // _entryCounter, so a stale node left over from a *previous* session
      // could collide on entryId with a freshly restored one, and the global
      // .transcript-entry queries annotation/export logic runs (saveAnnotation,
      // buildAnnotatedTranscript) would pick it up.
      deps.forceWitnessLiveOff();

      // Reset UI state
      document.getElementById('transcript-empty').style.display = 'none';
      document.getElementById('transcript-content').innerHTML = '';
      deps.resetTranscriptCounters();

      deps.setCurrentSessionId(session.id);
      deps.setSessionDate(session.date);
      deps.setCurrentEntry(session.entry || '');
      deps.setCurrentRound(session.rounds?.length || 0);
      const roundCount = session.roundCount || 3;
      deps.setActiveConveneRoundCount(roundCount);
      deps.setRoundCount(roundCount);

      // Restore player-as-member state before re-parsing rounds — the parser's
      // custom-identity recognition (isKnownSpeakerHeader) reads currentPlayerSpeakerName.
      const { MEMBERS } = deps.getCore();
      const playerMode = session.playerMode || 'none';
      const playerMemberId = session.playerMemberId || null;
      const playerName = session.playerName || null;
      const currentPlayerSpeakerName = playerMode === 'member'
        ? MEMBERS.find(m => m.id === playerMemberId)?.name || null
        : playerMode === 'custom' ? playerName : null;
      deps.setPlayerMode(playerMode);
      deps.setPlayerMemberId(playerMemberId);
      deps.setPlayerName(playerName);
      deps.setCurrentPlayerSpeakerName(currentPlayerSpeakerName);
      const restoredPlayerTurns = session.playerTurns || [];
      deps.setSessionPlayerTurns(restoredPlayerTurns);
      deps.setPlayerTurnsRevealed(false);
      document.getElementById('transcript-panel')?.classList.remove('reveal-player-turns');
      deps.restorePlayAsControlDisplay();

      // Rebuild transcriptText from scratch with current formatting
      const names = (session.members || []).map(id => MEMBERS.find(m => m.id === id)?.name).filter(Boolean).join(', ');
      deps.setTranscriptText(`THE SECRET-CABIN-ET\nMeeting Notes — ${session.date}\nAssembled: ${names}\n\nSource material:\n${session.entry || ''}\n`);

      // Build annotation lookup by entryId for restoration
      const annotationMap = {};
      (session.annotations || []).forEach(a => { annotationMap[a.entryId] = a.note; });

      // Re-render rounds from stored data
      (session.rounds || []).forEach((round, idx) => {
        const header = deps.addRoundHeader(round.label, idx);
        deps.addBranchControl(header, idx);
        deps.parseAndRenderTranscript(round.text);
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
      deps.setActiveMembers(new Set(session.members || []));
      deps.renderMembers();
      buildDossier(session.members || []);

      // Restore citation flags after render (matches by speaker+quote content)
      if (session.citationFlags?.length) deps.applyCitationFlags(session.citationFlags);

      // Restore player-turn markers after render (matches by exact round index)
      if (restoredPlayerTurns.length) deps.applyPlayerTurnMarkers(restoredPlayerTurns);

      // Show controls
      deps.showSessionControls();
      deps.setStatus(`Meeting of ${session.date} restored. The embers hold.`, false);
    } catch (e) {
      deps.setStatus('Could not restore the meeting.', false);
    }
  }

  // #38: toggles a session's public reading-room page. Publishing exposes the
  // source document (often a personal journal entry pulled from Day One) and
  // the full transcript at an unauthenticated URL — confirm plainly rather
  // than treating it as a low-stakes flip, unlike this row's other toggles.
  async function togglePublish(id, currentlyPublished, btn) {
    const confirmMsg = currentlyPublished
      ? 'Unpublish this meeting? Its public reading-room page will stop working.'
      : 'Publish this meeting?\n\nThe source document and full transcript will become viewable by anyone with the link — no login required. (Portraits and researcher notes are not included.)';
    if (!confirm(confirmMsg)) return;
    try {
      const res = await fetch(`/api/sessions/${id}/publish`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ published: !currentlyPublished }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update publish status');

      btn.outerHTML = `<button class="session-publish-btn${data.published ? ' is-published' : ''}" onclick="window.Sessions.togglePublish('${id}', ${data.published}, this)" title="${data.published ? 'Unpublish from the public reading room' : 'Publish to the public reading room'}">${data.published ? '★ Unpublish' : '☆ Publish'}</button>`;

      const dateRow = document.getElementById(`compare-btn-${id}`)?.closest('.session-item')?.querySelector('.session-item-date');
      const existingBadge = dateRow?.querySelector('.session-published-badge');
      if (data.published) {
        if (!existingBadge && dateRow) {
          const badge = document.createElement('a');
          badge.className = 'session-published-badge';
          badge.href = data.url;
          badge.target = '_blank';
          badge.rel = 'noopener';
          badge.title = 'View the public reading-room page';
          badge.textContent = '★ Public';
          dateRow.appendChild(badge);
        }
        prompt('Published. Public URL:', `${location.origin}${data.url}`);
      } else {
        existingBadge?.remove();
      }
    } catch (e) {
      alert('Could not update publish status.');
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

  // ── Comparative mode ──────────────────────────────────────────────────────

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
      ? '<span class="compare-bar-hint">Select one more to compare</span><button class="compare-bar-cancel" onclick="window.Sessions.clearCompareSelection()">✕</button>'
      : `<button class="lodge-btn compare-bar-go" onclick="window.Sessions.openCompareView()">Compare these two</button><button class="compare-bar-cancel" onclick="window.Sessions.clearCompareSelection()">✕</button>`;
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
    const { MEMBERS } = deps.getCore();
    const panel = document.getElementById(containerId);
    const memberNames = (session.members || [])
      .map(id => MEMBERS.find(m => m.id === id)?.name || id).join(' · ');
    panel.innerHTML = `
      <div class="compare-panel-header">
        <div class="compare-panel-date">${session.date}</div>
        <div class="compare-panel-members">${memberNames}</div>
        <div class="compare-panel-source">${deps.escapeHTML((session.entry || '').slice(0, 120))}</div>
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
    const { MEMBERS } = deps.getCore();
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
      const m = deps.resolveMember(speaker, MEMBERS);
      const nc = m ? `voice-${m.id}` : '';
      const side = localSide(m?.id || speaker);
      const e = document.createElement('div');
      e.className = `transcript-entry bubble-${side}`;
      e.innerHTML = `<div class="speaker-name ${nc}">${deps.escapeHTML(speaker)}</div><div class="bubble-body"><div class="speech-text">${deps.renderActions(textLines.join('\n').trim())}</div></div>`;
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
      const isKnownName = deps.isKnownSpeakerHeader(t, MEMBERS);
      const looksLikeName = !t.includes(' ') && t.length < 30 && /^[A-Z]/.test(t) && !t.includes('*');
      if (isKnownName || looksLikeName) { flush(); speaker = t.replace(/:$/, ''); textLines = []; }
      else if (speaker) textLines.push(t);
    });
    flush();
  }

  // ── Dossier drawer ────────────────────────────────────────────────────────

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
        <div class="dossier-header">
          <img class="dossier-portrait" src="/portraits/${d.id}.png" alt="" loading="lazy" onerror="this.remove()">
          <div class="dossier-name">${deps.escapeHTML(d.name)}</div>
        </div>
        ${d.bio ? `<div class="dossier-section-label">Who they are</div>
        <div class="dossier-text">${deps.escapeHTML(d.bio)}</div>` : ''}
        ${d.voice ? `<button class="dossier-toggle" onclick="this.nextElementSibling.classList.toggle('open');this.textContent=this.nextElementSibling.classList.contains('open')?'▲ Voice':'▼ Voice'">▼ Voice</button>
        <div class="dossier-voice"><div class="dossier-section-label">How they speak</div>
        <div class="dossier-text">${deps.escapeHTML(d.voice)}</div></div>` : ''}
        <div class="dossier-section-label" style="margin-top:10px;">Session note</div>
        <textarea class="dossier-note arc-textarea" data-member-id="${d.id}" rows="2"
          placeholder="Context for this session only — not saved to the character file."
          oninput="window.Sessions.setSessionNote('${d.id}', this.value)"
        >${deps.escapeHTML(existingNote)}</textarea>`;
      body.appendChild(el);
    });
  }

  function setSessionNote(memberId, value) {
    sessionNotes[memberId] = value;
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

  return {
    configure,
    onSessionsSearch,
    openSessionsDrawer,
    closeSessionsDrawer,
    reconveneOnSession,
    loadSessionsList,
    filterByThread,
    assignThreadUI,
    createAndSetThread,
    setThread,
    filterByTag,
    addTagUI,
    removeTagById,
    restoreSession,
    togglePublish,
    deleteSession,
    toggleCompareSelect,
    clearCompareSelection,
    openCompareView,
    toggleDossier,
    buildDossier,
    setSessionNote,
    collectSessionNotes,
    highlightDossierEntry,
  };
})();
