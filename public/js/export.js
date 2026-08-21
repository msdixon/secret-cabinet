'use strict';

// #142: extracted from app.js's "Day One" / "File import" / "Export" /
// "Environment config" sections (in that order in the seam mapping —
// witness.js first, this second), following the same script-tag/IIFE
// convention as scene.js and witness.js. window.Export exposes a small API;
// app.js calls into it and never touches these internals directly.
//
// This module has more core-state coupling than witness.js did (the seam
// mapping called this "moderate coupling: reads transcript/session state,
// doesn't own it") -- nearly every function here reads currentEntry,
// currentJournal, currentSessionId, sessionDate, transcriptText, or the
// roster, and a few write currentEntry/currentJournal/currentSourceSessionId
// as the user picks a document source. Rather than reach into app.js's
// globals directly, app.js hands this module a `deps` bag once via
// configure() -- a live getCore() accessor plus setters for the fields this
// module needs to write -- called during app.js's own Init section, the same
// place initSceneLayer() calls LodgeScene.init().
window.Export = (function () {
  let deps = null; // set by configure(); see app.js's exportDeps()

  function configure(injectedDeps) {
    deps = injectedDeps;
  }

  // ── Day One ────────────────────────────────────────────────────────────────
  const entryCache = new Map(); // key: "dayone:journalId:idx" → { text, date, journalId, journalName }
  let sourceOptionsLoaded = false;

  // ── Archival Library (#82) ─────────────────────────────────────────────────
  let libraryEntries = []; // full unfiltered index, fetched once in loadSourceOptions
  let libraryOptgroup = null; // the <optgroup> DOM node, rebuilt on each filter keystroke

  // Same AND-of-terms matching as the server's GET /api/library?q= (server.js),
  // reimplemented client-side so filtering doesn't round-trip while typing.
  function libraryEntryMatches(entry, terms) {
    return terms.every(
      t =>
        entry.title.toLowerCase().includes(t) ||
        entry.source.toLowerCase().includes(t) ||
        entry.date?.toLowerCase().includes(t) ||
        entry.themes?.some(th => th.includes(t)) ||
        entry.members?.some(m => m.includes(t))
    );
  }

  // Rebuilds the Archival Library optgroup from libraryEntries, filtered by
  // filterText. Keeps the currently-selected option in the list even if it no
  // longer matches, so typing a filter never yanks away the loaded entry.
  function renderLibraryOptions(filterText) {
    if (!libraryOptgroup) return;
    const sel = document.getElementById('source-select');
    const currentValue = sel.value;
    const term = (filterText || '').trim().toLowerCase();
    const terms = term ? term.split(/\s+/) : [];

    const visible = libraryEntries.filter(
      entry => !terms.length || libraryEntryMatches(entry, terms) || `library:${entry.id}` === currentValue
    );

    libraryOptgroup.innerHTML = '';
    if (!visible.length) {
      const opt = document.createElement('option');
      opt.disabled = true;
      opt.textContent = 'No matching entries';
      libraryOptgroup.appendChild(opt);
      return;
    }
    visible.forEach(entry => {
      const opt = document.createElement('option');
      opt.value = `library:${entry.id}`;
      opt.textContent = `${entry.date}  ${entry.title}`;
      libraryOptgroup.appendChild(opt);
    });
    sel.value = currentValue; // reselect — rebuilding options can reset it
  }

  function filterLibraryOptions(term) {
    renderLibraryOptions(term);
  }

  function updateExportJournalLabel() {
    const el = document.getElementById('export-journal-name');
    if (el) el.textContent = deps.getCore().currentJournal.name || 'No journal selected';
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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json();
      const journals = data.journals || [];
      if (!journals.length) {
        if (loadingGroup) loadingGroup.label = 'No Day One journals found';
      } else {
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
        await Promise.all(
          groups.map(async ({ journal, group }) => {
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
          })
        );

        // If we had a saved journal preference, try to pre-select its first entry
        const savedJournalId = deps.getCore().currentJournal.id;
        if (savedJournalId) {
          const key = `dayone:${savedJournalId}:0`;
          if (entryCache.has(key)) {
            sel.value = key;
            handleSourceChange(); // load entry text into state
          }
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
        libraryEntries = libEntries;
        libraryOptgroup = document.createElement('optgroup');
        libraryOptgroup.label = 'Archival Library';
        sel.appendChild(libraryOptgroup);
        renderLibraryOptions('');
        const searchInput = document.getElementById('library-search-input');
        if (searchInput) searchInput.hidden = false;
      }
    } catch (_) {}
  }

  function handleSourceChange() {
    const v = document.getElementById('source-select').value;
    const isPaste = v === 'paste';
    document.getElementById('paste-area-container').style.display = isPaste ? 'block' : 'none';
    document.getElementById('fetched-display').style.display = isPaste ? 'none' : 'block';

    // Changing source clears any prior transcript reconvene state
    if (!v.startsWith('transcript:')) deps.setCurrentSourceSessionId(null);

    if (v.startsWith('library:')) {
      const id = v.slice('library:'.length);
      deps.setCurrentEntry('');
      const display = document.getElementById('entry-display');
      display.textContent = 'Loading…';
      display.classList.add('placeholder');
      fetch(`/api/library/${id}`)
        .then(r => r.json())
        .then(entry => {
          deps.setCurrentEntry(entry.text);
          display.textContent = entry.text;
          display.classList.remove('placeholder');
          document.getElementById('entry-date-tag').textContent = entry.date || '';
          document.getElementById('entry-journal-tag').textContent = entry.source || 'Library';
          deps.setStatus('The document has been read aloud. The room has heard it.', false);
          deps.onDocumentReady?.();
        })
        .catch(() => {
          display.textContent = 'Could not load entry.';
        });
    } else if (!isPaste && entryCache.has(v)) {
      const cached = entryCache.get(v);
      deps.setCurrentEntry(cached.text);
      deps.setCurrentJournal({ id: cached.journalId, name: cached.journalName });
      updateExportJournalLabel();

      const display = document.getElementById('entry-display');
      display.textContent = cached.text;
      display.classList.remove('placeholder');
      document.getElementById('entry-date-tag').textContent = cached.date || '';
      document.getElementById('entry-journal-tag').textContent = cached.journalName;
      deps.setStatus('The document has been read aloud. The room has heard it.', false);
      deps.onDocumentReady?.();
    } else if (isPaste) {
      deps.setCurrentEntry('');
    }
  }

  function getEntry() {
    return document.getElementById('source-select').value === 'paste'
      ? document.getElementById('paste-area').value.trim()
      : deps.getCore().currentEntry;
  }

  // ── File import ────────────────────────────────────────────────────────────
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
      const lastStop = Math.max(
        text.lastIndexOf('. '),
        text.lastIndexOf('.\n'),
        text.lastIndexOf('? '),
        text.lastIndexOf('! ')
      );
      if (lastStop > FILE_TEXT_LIMIT * 0.7) text = text.slice(0, lastStop + 1);
      notice = ' (trimmed to first ~4,000 chars — paste a specific passage for longer texts)';
    }
    area.value = text;
    document.getElementById('file-pick-name').textContent = filename + notice;
    // Ensure paste mode is active
    const sel = document.getElementById('source-select');
    sel.value = 'paste';
    handleSourceChange();
    deps.setStatus(`"${filename}" loaded.${notice ? ' Long document trimmed.' : ' The room has heard it.'}`, false);
    deps.onDocumentReady?.();
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  function buildAnnotatedTranscript() {
    // Weave annotations and player-turn markers into the transcript text after
    // each relevant speech block. Exports always carry the player-turn marker
    // even though the live view never shows it (invisible-during-play is a
    // live-viewing choice, not a data-hiding one).
    let out = deps.getCore().transcriptText;
    const annotated = [...document.querySelectorAll('.transcript-entry.annotated')];
    const playerTurnEntries = [...document.querySelectorAll('.transcript-entry.player-turn')];
    if (!annotated.length && !playerTurnEntries.length) return out;
    // Rebuild line-by-line, inserting markers after each matching speaker's block
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
        const playerEntry = playerTurnEntries.find(e => e.dataset.speaker === speaker);
        if ((note && entry) || playerEntry) {
          // Collect the speech block (next non-empty lines until blank)
          while (i + 1 < lines.length && lines[i + 1] !== '') {
            i++;
            result.push(lines[i]);
          }
          if (note && entry) {
            result.push(`  ↳ ${note}`);
            annotated.splice(annotated.indexOf(entry), 1); // consume so dupes don't re-match
          }
          if (playerEntry) {
            result.push('  ⟡ played by a human participant, live');
            playerTurnEntries.splice(playerTurnEntries.indexOf(playerEntry), 1);
          }
        }
      }
      i++;
    }
    return result.join('\n');
  }

  // Annotated passages in document order — DOM order matches speech order since
  // entries are appended sequentially by addSpeech()/parseAndRenderTranscript(),
  // so no round-grouping or re-sorting is needed.
  function getAnnotatedPassages() {
    return [...document.querySelectorAll('.transcript-entry.annotated')].map(e => ({
      speaker: e.dataset.speaker,
      text: e.querySelector('.speech-text')?.textContent.trim() || '',
      note: e.querySelector('.annotation-input')?.value.trim() || '',
    }));
  }

  // #331 — verifying citations is the instinctive first move for a feature framed
  // around scholarly citation, and a fully-cited session with zero annotations is
  // still a complete-enough artifact (bibliography only). So either signal unlocks
  // the export, not just the (undiscoverable) click-to-annotate path.
  //
  // #356: a third signal, sessionHasCitationData -- whether the loaded
  // session's beats carry always-on-captured citations or invoked works
  // (#355/#356), regardless of whether anyone has ever clicked Verify
  // Citations. Set by sessions.js's restoreSession via setSessionHasCitations
  // below; without it, a freshly-restored session with real bibliographic
  // content stayed locked behind the button's own "verified" DOM check, which
  // only ever gets set by *running* Verify Citations in the current page
  // load -- exactly the "reliably produce a record of itself" gap #356 exists
  // to close.
  let sessionHasCitationData = false;

  function setSessionHasCitations(v) {
    sessionHasCitationData = !!v;
    updateScholarlyExportButton();
  }

  function updateScholarlyExportButton() {
    const btn = document.getElementById('export-scholarly-btn');
    if (!btn) return;
    const hasAnnotations = getAnnotatedPassages().length > 0;
    const hasVerifiedCitations = document.querySelector('.transcript-entry.flagged-citation') != null;
    btn.disabled = !hasAnnotations && !hasVerifiedCitations && !sessionHasCitationData;
    btn.title = btn.disabled
      ? 'Verify Citations, or click a passage above to add a note, to enable'
      : 'Export a Markdown note with your annotated passages and/or citation bibliography';
  }

  // #153 part 3 — how a verdict was actually reached. Own copy rather than
  // reaching across script tags into app.js's CITATION_SOURCE_LABEL, matching
  // this module's stated preference for explicit boundaries (see the deps-bag
  // note at the top of this file) — same duplication convention already used
  // between app.js and scripts/build-citation-manifest.js. Missing on
  // pre-#153 sessions — default to 'model-knowledge' there, since that was
  // the only method available at the time.
  // #356: 'ungrounded' added for the always-on capture (#355) that's never
  // been through Verify Citations at all -- distinct from 'model-knowledge',
  // which means grounding *was* attempted and simply found no match. Same
  // convention as scripts/build-citation-manifest.js's SOURCE_LABEL.
  const CITATION_SOURCE_LABEL = {
    library: 'checked against curated text',
    web: 'checked via live lookup',
    'model-knowledge': "Claude's own knowledge (grounding attempted, no match)",
    ungrounded: 'captured at write time — not yet run through Verify Citations',
  };

  // #356: reads a beat's always-on-captured citations/invoked works back out
  // of a session -- client-side port of src/citations.js's
  // flattenBeatCitations/flattenBeatInvokedWorks (see that file's header for
  // why client and server keep their own small copies rather than sharing a
  // module across the script-tag/require boundary). `speaker` resolves off
  // the roster already in core state, the same MEMBERS array the rest of
  // this module reads.
  function flattenBeatEntries(session, field) {
    const { MEMBERS } = deps.getCore();
    const flat = [];
    (session.rounds || []).forEach(segment => {
      (segment.beats || []).forEach(beat => {
        if (beat.failed || !Array.isArray(beat[field]) || !beat[field].length) return;
        const speaker = MEMBERS.find(m => m.id === beat.memberId)?.name || beat.speakerName || beat.memberId;
        beat[field].forEach(entry => flat.push({ ...entry, speaker, memberId: beat.memberId }));
      });
    });
    return flat;
  }

  // A session's direct citations: its grounded `citationFlags` if Verify
  // Citations has ever run, else the always-on raw capture off its beats —
  // same fallback src/bibliography.js's citationsForSession uses server-side,
  // so a session that's never been through the deliberate grounding pass
  // still shows a bibliography instead of the empty one PROJECT.md flagged
  // (10 of 11 sessions, before #355/#356).
  function citationsForSession(session) {
    if (Array.isArray(session.citationFlags)) return session.citationFlags;
    return flattenBeatEntries(session, 'citations');
  }

  function groupByWork(entries) {
    const byWork = new Map();
    entries.forEach(e => {
      if (!byWork.has(e.work)) byWork.set(e.work, []);
      byWork.get(e.work).push(e);
    });
    return [...byWork.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  // #356: appendix-form bibliography, in two honestly-separated tiers — see
  // src/bibliography.js's header for why this shape (alphabetical, tiered by
  // evidence) replaced the flat "no citations yet" fallback this used to be.
  // Works Cited: direct citations, each with a quote. Works Referenced: texts/
  // authors/traditions invoked by name or allusion without a supporting quote
  // — weaker evidence, kept in its own section so it never reads as verified.
  function renderBibliography(session) {
    const citations = citationsForSession(session);
    const invoked = flattenBeatEntries(session, 'invokedWorks');
    const lines = ['### Works Cited', ''];
    if (!citations.length) {
      lines.push('_No citations captured for this session._', '');
    } else {
      groupByWork(citations).forEach(([work, occurrences]) => {
        lines.push(`#### ${work}`, '');
        occurrences.forEach(o => {
          const groundedIn =
            o.libraryCitation || (o.webSourceUrl ? `[${o.webSourceTitle}](${o.webSourceUrl})` : o.webSourceTitle);
          const grounding = groundedIn ? ` — grounded in: ${groundedIn}` : '';
          const sourceLabel = CITATION_SOURCE_LABEL[o.source || 'ungrounded'];
          lines.push(`- **${o.verdict}** (${sourceLabel}) — ${(o.speaker || '').replace(/\s*—\s*$/, '').trim()}`);
          lines.push(`  > "${o.quote}"`);
          lines.push(`  ${o.note || ''}${grounding}`, '');
        });
      });
    }
    lines.push(
      '### Works Referenced — Invoked, Not Quoted',
      '',
      'A member reaching for a reading without quoting it, or naming a tradition rather than a title — named in passing, never independently checked.'
    );
    lines.push('');
    if (!invoked.length) {
      lines.push('_None captured for this session._', '');
    } else {
      groupByWork(invoked).forEach(([work, occurrences]) => {
        lines.push(`#### ${work}`, '');
        occurrences.forEach(o => {
          const detail = o.note ? ` — ${o.note}` : '';
          lines.push(`- ${(o.speaker || '').replace(/\s*—\s*$/, '').trim()}${detail}`);
        });
        lines.push('');
      });
    }
    return lines.join('\n');
  }

  async function exportScholarly() {
    if (!deps.getCore().currentSessionId) return;
    const passages = getAnnotatedPassages();
    const statusEl = document.getElementById('export-status');
    statusEl.textContent = 'Building scholarly note...';
    try {
      const res = await fetch(`/api/sessions/${deps.getCore().currentSessionId}`);
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const session = await res.json();

      const { activeMembers, MEMBERS, currentEntry, sessionDate } = deps.getCore();
      const names = [...activeMembers]
        .map(id => MEMBERS.find(m => m.id === id)?.name)
        .filter(Boolean)
        .join(', ');
      const source = (currentEntry || '').trim();
      const sourceExcerpt = source.length > 300 ? source.slice(0, 300) + '…' : source;

      const lines = [
        '# Secret-Cabin-et — Scholarly Note',
        '',
        `**Date:** ${sessionDate}`,
        `**Members:** ${names}`,
        `**Source:** ${sourceExcerpt}`,
        '',
      ];
      if (passages.length) {
        lines.push('## Selected Passages', '');
        passages.forEach(p => {
          lines.push(`**${p.speaker}** —`, '', p.text, '', `> ${p.note}`, '');
        });
      }
      // #354 item 4: pre-#244 sessions have no turn-level record at all, and
      // this export is exactly the "reliably produce a record of itself as a
      // bibliographic source" claim (PROJECT.md's Research-grounding row) --
      // so a session that can't back that claim says so, rather than a gap
      // that only shows up as citations quietly missing.
      const completeness = deps.recordCompletenessNote(session);
      if (!deps.recordCompleteness(session).complete) lines.push(`*${completeness}*`, '');
      lines.push('## Bibliography', '', renderBibliography(session));

      const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `secret-cabinet-scholarly-${sessionDate}.md`;
      a.click();
      URL.revokeObjectURL(url);
      statusEl.textContent = 'Scholarly note downloaded.';
    } catch (err) {
      console.error(err);
      statusEl.textContent = 'Scholarly export failed.';
    }
  }

  function exportTxt() {
    const blob = new Blob([buildAnnotatedTranscript()], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `secret-cabinets-${deps.getCore().sessionDate}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    document.getElementById('export-status').textContent = 'Downloaded.';
  }

  async function exportDayOne() {
    const { currentJournal } = deps.getCore();
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
          sessionDate: deps.getCore().sessionDate,
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
    if (!vaultPath) {
      statusEl.textContent = 'Enter your Obsidian vault path first.';
      return;
    }
    statusEl.textContent = 'Writing to Obsidian…';
    try {
      const { sessionDate, activeMembers, MEMBERS, currentEntry, currentSessionId } = deps.getCore();
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
    const groupId = document.getElementById('ulysses-group-id')?.value.trim() || '';
    statusEl.textContent = 'Opening Ulysses…';
    try {
      const { sessionDate, currentEntry } = deps.getCore();
      const res = await fetch('/api/ulysses/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcriptText: buildAnnotatedTranscript(),
          sessionDate,
          title: currentEntry?.slice(0, 60) || sessionDate,
          group,
          groupId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      statusEl.textContent = groupId
        ? `Sent to Ulysses — ${group || 'identifier'} (by ID).`
        : group
          ? `Sent to Ulysses — ${group}.`
          : 'Sent to Ulysses.';
    } catch (err) {
      statusEl.textContent = err.message || 'Ulysses export failed.';
    }
  }

  function exportMd() {
    if (!deps.getCore().transcriptText) return;
    const text = buildAnnotatedTranscript();
    const blob = new Blob([text], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `secret-cabinet-${deps.getCore().sessionDate}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Environment config ─────────────────────────────────────────────────────
  async function applyEnvConfig() {
    try {
      const { isLocal } = await fetch('/api/config').then(r => r.json());
      if (!isLocal) {
        [
          'export-ulysses-row',
          'export-ulysses-config',
          'export-ulysses-id-config',
          'export-obsidian-row',
          'export-obsidian-config',
        ].forEach(id => document.getElementById(id)?.style.setProperty('display', 'none'));
        document.getElementById('export-md-row')?.style.setProperty('display', 'inline-flex');
      }
    } catch (_) {}
  }

  // Restores the Ulysses group/group-id and Obsidian vault path fields from
  // localStorage on load -- the fields themselves save on every keystroke via
  // inline oninput handlers in index.html, so this is the read-back half only.
  function restoreSavedSettings() {
    const savedGroup = localStorage.getItem('sc-ulysses-group');
    if (savedGroup) {
      const gi = document.getElementById('ulysses-group');
      if (gi) gi.value = savedGroup;
    }
    const savedGroupId = localStorage.getItem('sc-ulysses-group-id');
    if (savedGroupId) {
      const gid = document.getElementById('ulysses-group-id');
      if (gid) gid.value = savedGroupId;
    }
    const savedVault = localStorage.getItem('sc-obsidian-vault');
    if (savedVault) {
      const vi = document.getElementById('obsidian-vault');
      if (vi) vi.value = savedVault;
    }
  }

  return {
    configure,
    updateExportJournalLabel,
    loadSourceOptions,
    handleSourceChange,
    filterLibraryOptions,
    getEntry,
    handleFileSelect,
    buildAnnotatedTranscript,
    updateScholarlyExportButton,
    setSessionHasCitations,
    exportScholarly,
    exportTxt,
    exportDayOne,
    exportObsidian,
    exportUlysses,
    exportMd,
    applyEnvConfig,
    restoreSavedSettings,
  };
})();
