'use strict';

// #137 — export.js's deps-bag seam.
//
// This is the module the #142 seam mapping called "moderate coupling: reads
// transcript/session state, doesn't own it" — app.js hands it a `deps` bag
// once via configure(), and every read of core state goes through
// deps.getCore(). The tests below drive it through that seam with a fake
// core, which is exactly what makes the seam worth having.
//
// buildAnnotatedTranscript is the highest-value target here: it is the only
// place annotations and player-turn markers get woven into exported text, it
// has real line-walking logic, and every export path downstream of it
// (Ulysses, Obsidian, Day One, .md, .txt) inherits whatever it gets wrong.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadPublicModule, assertIdsExistInIndexHtml } = require('./helpers/dom.js');
const record = require('../public/js/record.js');

const FIXTURE = `
  <div id="transcript-content"></div>
  <button id="export-scholarly-btn"></button>
  <span id="export-journal-name"></span>
  <span id="export-status"></span>
  <input id="ulysses-group" />
  <input id="ulysses-group-id" />
  <input id="obsidian-vault" />
`;

const TRANSCRIPT = [
  'THE SECRET-CABIN-ET',
  'Meeting Notes — 1926-11-02',
  '',
  'Crowley —',
  'The book is not the point.',
  '',
  'Blavatsky —',
  'It is exactly the point.',
  'And you know it.',
  '',
].join('\n');

function makeCore(overrides = {}) {
  return {
    transcriptText: TRANSCRIPT,
    currentEntry: 'the source document',
    currentJournal: { id: null, name: '' },
    currentSessionId: 'sess-1',
    sessionDate: '1926-11-02',
    activeMembers: new Set(['crowley', 'blavatsky']),
    MEMBERS: [
      { id: 'crowley', name: 'Crowley' },
      { id: 'blavatsky', name: 'Blavatsky' },
    ],
    ...overrides,
  };
}

function boot(t, { core = makeCore(), bodyHtml = FIXTURE, fetchImpl } = {}) {
  const loaded = loadPublicModule('export.js', bodyHtml);
  t.after(loaded.cleanup);
  if (fetchImpl) loaded.window.fetch = fetchImpl;
  loaded.module.configure({
    getCore: () => core,
    setCurrentEntry: () => {},
    setCurrentJournal: () => {},
    setCurrentSourceSessionId: () => {},
    setStatus: () => {},
    // #354: the real implementations, not stand-ins -- the honesty check
    // exportScholarly's own tests exercise is exactly this pair.
    recordCompleteness: record.recordCompleteness,
    recordCompletenessNote: record.recordCompletenessNote,
  });
  return loaded;
}

// Appends a rendered transcript entry of the kind app.js's addSpeech()
// produces — buildAnnotatedTranscript reads these back out of the DOM.
function addEntry(document, { speaker, text, note = null, playerTurn = false }) {
  const el = document.createElement('div');
  el.className = 'transcript-entry' + (note !== null ? ' annotated' : '') + (playerTurn ? ' player-turn' : '');
  el.dataset.speaker = speaker;
  el.innerHTML =
    `<div class="speech-text">${text}</div>` +
    (note !== null ? `<textarea class="annotation-input">${note}</textarea>` : '');
  document.getElementById('transcript-content').appendChild(el);
  return el;
}

test('the export fixture matches the ids index.html actually ships', () => {
  assertIdsExistInIndexHtml([
    'export-scholarly-btn',
    'export-journal-name',
    'ulysses-group',
    'ulysses-group-id',
    'obsidian-vault',
  ]);
});

test('buildAnnotatedTranscript', async t => {
  await t.test('returns the transcript untouched when nothing is annotated or played', t2 => {
    const { module: Export } = boot(t2);
    assert.equal(Export.buildAnnotatedTranscript(), TRANSCRIPT);
  });

  await t.test('weaves an annotation in after the whole speech block, not after the speaker line', t2 => {
    const { document, module: Export } = boot(t2);
    addEntry(document, { speaker: 'Blavatsky', text: 'It is exactly the point.', note: 'cf. Isis Unveiled I.' });

    const lines = Export.buildAnnotatedTranscript().split('\n');
    const noteIdx = lines.indexOf('  ↳ cf. Isis Unveiled I.');
    assert.ok(noteIdx > -1, 'the note should appear in the output');
    assert.equal(lines[noteIdx - 1], 'And you know it.', 'the note follows the last line of the speech');
  });

  await t.test('marks a player turn even though the live view never shows it', t2 => {
    // Invisible-during-play is a live-viewing choice, not a data-hiding one.
    const { document, module: Export } = boot(t2);
    addEntry(document, { speaker: 'Crowley', text: 'The book is not the point.', playerTurn: true });

    const out = Export.buildAnnotatedTranscript();
    assert.match(out, /^ {2}⟡ played by a human participant, live$/m);
  });

  await t.test('emits both markers for a speech that is annotated and player-played', t2 => {
    const { document, module: Export } = boot(t2);
    addEntry(document, {
      speaker: 'Crowley',
      text: 'The book is not the point.',
      note: 'my own gloss',
      playerTurn: true,
    });

    const out = Export.buildAnnotatedTranscript();
    assert.match(out, /↳ my own gloss/);
    assert.match(out, /⟡ played by a human participant, live/);
  });

  await t.test('does not re-attach one annotation to a later block by the same speaker', t2 => {
    // Entries are consumed as they match, so two turns from one speaker get
    // one note each rather than the first note twice.
    const core = makeCore({
      transcriptText: 'Crowley —\nFirst turn.\n\nCrowley —\nSecond turn.\n',
    });
    const { document, module: Export } = boot(t2, { core });
    addEntry(document, { speaker: 'Crowley', text: 'First turn.', note: 'note one' });

    const out = Export.buildAnnotatedTranscript();
    assert.equal((out.match(/↳ note one/g) || []).length, 1);
  });

  await t.test('ignores an annotated entry whose note is only whitespace', t2 => {
    const { document, module: Export } = boot(t2);
    addEntry(document, { speaker: 'Crowley', text: 'The book is not the point.', note: '   ' });
    assert.equal(Export.buildAnnotatedTranscript(), TRANSCRIPT);
  });

  await t.test('leaves the transcript alone when the annotated speaker is not in it', t2 => {
    const { document, module: Export } = boot(t2);
    addEntry(document, { speaker: 'Yeats', text: 'Never said.', note: 'orphaned note' });
    assert.equal(Export.buildAnnotatedTranscript(), TRANSCRIPT);
  });

  await t.test('reads core state through the deps bag, never off the window', t2 => {
    // The #142 rule, checked behaviourally: app.js is the sole owner of
    // transcriptText, so a decoy on the window must be ignored.
    const { window, module: Export } = boot(t2);
    window.transcriptText = 'DECOY TRANSCRIPT';
    assert.equal(Export.buildAnnotatedTranscript(), TRANSCRIPT);
  });

  await t.test('picks up a later core value, since getCore() is a live accessor', t2 => {
    const core = makeCore();
    const { module: Export } = boot(t2, { core });
    core.transcriptText = 'Crowley —\nA different session entirely.\n';
    assert.match(Export.buildAnnotatedTranscript(), /A different session entirely/);
  });
});

test('updateScholarlyExportButton', async t => {
  await t.test('is disabled while nothing is annotated', t2 => {
    const { document, module: Export } = boot(t2);
    addEntry(document, { speaker: 'Crowley', text: 'The book is not the point.' });
    Export.updateScholarlyExportButton();
    assert.equal(document.getElementById('export-scholarly-btn').disabled, true);
  });

  await t.test('enables once a passage carries an annotation', t2 => {
    const { document, module: Export } = boot(t2);
    addEntry(document, { speaker: 'Crowley', text: 'The book is not the point.', note: 'a gloss' });
    Export.updateScholarlyExportButton();
    assert.equal(document.getElementById('export-scholarly-btn').disabled, false);
  });

  // #356 — a third, independent unlock signal: the loaded session has
  // always-on-captured citations/invoked works, whether or not anyone ran
  // Verify Citations or annotated anything. Set by sessions.js's
  // restoreSession via setSessionHasCitations.
  await t.test('enables once setSessionHasCitations(true) is called, with nothing annotated', t2 => {
    const { document, module: Export } = boot(t2);
    Export.setSessionHasCitations(true);
    assert.equal(document.getElementById('export-scholarly-btn').disabled, false);
  });

  await t.test('setSessionHasCitations(false) re-disables a button with no other signal', t2 => {
    const { document, module: Export } = boot(t2);
    Export.setSessionHasCitations(true);
    Export.setSessionHasCitations(false);
    assert.equal(document.getElementById('export-scholarly-btn').disabled, true);
  });
});

// #354 item 4: pre-#244 sessions have no `beats` at all, and this export is
// exactly the "reliably produce a record of itself as a bibliographic
// source" claim -- so a session that can't back that claim says so.
test('exportScholarly', async t => {
  function captureDownload(window, document) {
    window.URL.createObjectURL = blob => {
      window.__capturedBlob = blob;
      return 'blob:fake';
    };
    window.URL.revokeObjectURL = () => {};
    const origCreateElement = document.createElement.bind(document);
    document.createElement = tag => {
      const el = origCreateElement(tag);
      if (tag === 'a') el.click = () => {};
      return el;
    };
  }

  await t.test('a fully post-#244 session (beats on every segment) prints no completeness caveat', async t2 => {
    const {
      window,
      document,
      module: Export,
    } = boot(t2, {
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ rounds: [{ beats: [{ memberId: 'crowley', text: 'a' }] }], citationFlags: [] }),
        }),
    });
    captureDownload(window, document);
    await Export.exportScholarly();
    const text = await window.__capturedBlob.text();
    assert.doesNotMatch(text, /Turn-level record/);
  });

  await t.test(
    'a session with any pre-#244 segment (no beats array) prints the caveat before the Bibliography',
    async t2 => {
      const {
        window,
        document,
        module: Export,
      } = boot(t2, {
        fetchImpl: () =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ rounds: [{ label: 'First Movement', text: 'x' }], citationFlags: [] }),
          }),
      });
      captureDownload(window, document);
      await Export.exportScholarly();
      const text = await window.__capturedBlob.text();
      assert.match(text, /Turn-level record: incomplete/);
      assert.ok(
        text.indexOf('Turn-level record') < text.indexOf('## Bibliography'),
        'the caveat reads before the Bibliography it qualifies'
      );
    }
  );

  // #453 — a passage selected into the Scholarly Note is exactly the
  // material that ends up quoted as if it were the room's own record; if the
  // selected passage was actually the player's own submitted turn (playing
  // as a member), the note has to say so rather than silently attributing it
  // to that member.
  await t.test('marks a selected passage that was actually the player playing as that member', async t2 => {
    const {
      window,
      document,
      module: Export,
    } = boot(t2, {
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              rounds: [{ beats: [{ memberId: 'blavatsky', text: 'I never said that.', playerAuthored: true }] }],
              citationFlags: [],
            }),
        }),
    });
    addEntry(document, {
      speaker: 'Blavatsky',
      text: 'I never said that.',
      note: 'flagging this for later',
      playerTurn: true,
    });
    captureDownload(window, document);
    await Export.exportScholarly();
    const text = await window.__capturedBlob.text();
    assert.match(text, /\*\*Blavatsky\*\* ⟡ played by a human participant, live —/);
  });

  await t.test('leaves a genuine member passage unmarked', async t2 => {
    const {
      window,
      document,
      module: Export,
    } = boot(t2, {
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ rounds: [{ beats: [{ memberId: 'crowley', text: 'a' }] }], citationFlags: [] }),
        }),
    });
    addEntry(document, { speaker: 'Crowley', text: 'The book is not the point.', note: 'a gloss' });
    captureDownload(window, document);
    await Export.exportScholarly();
    const text = await window.__capturedBlob.text();
    assert.match(text, /\*\*Crowley\*\* —/);
    assert.doesNotMatch(text, /played by a human participant/);
  });

  // #356 — the appendix-form bibliography: Works Cited (direct citations)
  // kept separate from Works Referenced (invoked, not quoted), and falling
  // back to always-on beat capture when the session was never run through
  // Verify Citations (the exact PROJECT.md-flagged bug: 10 of 11 sessions
  // showed an empty Bibliography because only citationFlags was ever read).
  await t.test('falls back to always-on beat citations when a session has no citationFlags at all', async t2 => {
    const {
      window,
      document,
      module: Export,
    } = boot(t2, {
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: () =>
            // No `citationFlags` key at all -- Verify Citations has never run
            // on this session, only #355's always-on capture has anything.
            Promise.resolve({
              rounds: [
                {
                  beats: [
                    {
                      memberId: 'crowley',
                      text: 'a',
                      citations: [
                        { quote: 'a real quote', work: 'The Book of the Law', verdict: 'verified', note: 'It exists.' },
                      ],
                    },
                  ],
                },
              ],
            }),
        }),
    });
    captureDownload(window, document);
    await Export.exportScholarly();
    const text = await window.__capturedBlob.text();
    assert.match(text, /### Works Cited/);
    assert.match(text, /#### The Book of the Law/);
    assert.match(text, /> "a real quote"/);
    assert.match(text, /captured at write time — not yet run through Verify Citations/);
  });

  await t.test('lists invoked-not-quoted works in their own section, separate from Works Cited', async t2 => {
    const {
      window,
      document,
      module: Export,
    } = boot(t2, {
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              rounds: [
                {
                  beats: [
                    {
                      memberId: 'crowley',
                      text: 'a',
                      invokedWorks: [{ work: "Corbin's reading of Ibn Arabi", note: 'named in passing' }],
                    },
                  ],
                },
              ],
              citationFlags: [],
            }),
        }),
    });
    captureDownload(window, document);
    await Export.exportScholarly();
    const text = await window.__capturedBlob.text();
    assert.match(text, /### Works Referenced/);
    assert.match(text, /#### Corbin's reading of Ibn Arabi/);
    const worksReferenced = text.slice(text.indexOf('### Works Referenced'));
    assert.doesNotMatch(worksReferenced, /> "/, 'the invoked tier never carries a quote block');
  });

  await t.test('honestly says so when a session has cited and invoked nothing', async t2 => {
    const {
      window,
      document,
      module: Export,
    } = boot(t2, {
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ rounds: [{ beats: [{ memberId: 'crowley', text: 'a' }] }], citationFlags: [] }),
        }),
    });
    captureDownload(window, document);
    await Export.exportScholarly();
    const text = await window.__capturedBlob.text();
    assert.match(text, /No citations captured for this session/);
    assert.match(text, /None captured for this session/);
  });
});

test('updateExportJournalLabel', async t => {
  await t.test('shows the selected journal name from core state', t2 => {
    const { document, module: Export } = boot(t2, {
      core: makeCore({ currentJournal: { id: 'j1', name: 'PreSeedings' } }),
    });
    Export.updateExportJournalLabel();
    assert.equal(document.getElementById('export-journal-name').textContent, 'PreSeedings');
  });

  await t.test('falls back to a placeholder when no journal is selected', t2 => {
    const { document, module: Export } = boot(t2);
    Export.updateExportJournalLabel();
    assert.equal(document.getElementById('export-journal-name').textContent, 'No journal selected');
  });
});

test('exportMd', async t => {
  // Regression test for #298: exportMd() referenced currentTranscript/
  // currentSession, globals that don't exist in this module -- leftover
  // names from before the #142 extraction, carried over verbatim and never
  // caught because nothing exercised this path. It must read through the
  // deps bag like every other export function here.
  await t.test('downloads via the deps bag instead of throwing on undefined globals', t2 => {
    const { window, document, module: Export } = boot(t2);
    window.URL.createObjectURL = () => 'blob:fake';
    window.URL.revokeObjectURL = () => {};
    let downloadedAs = null;
    const origCreateElement = document.createElement.bind(document);
    document.createElement = tag => {
      const el = origCreateElement(tag);
      if (tag === 'a') el.click = () => (downloadedAs = el.download);
      return el;
    };

    assert.doesNotThrow(() => Export.exportMd());
    assert.equal(downloadedAs, 'secret-cabinet-1926-11-02.md');
  });

  await t.test('does nothing when there is no transcript yet', t2 => {
    const { window, document, module: Export } = boot(t2, { core: makeCore({ transcriptText: '' }) });
    window.URL.createObjectURL = () => 'blob:fake';
    let created = false;
    const origCreateElement = document.createElement.bind(document);
    document.createElement = tag => {
      if (tag === 'a') created = true;
      return origCreateElement(tag);
    };

    Export.exportMd();
    assert.equal(created, false);
  });
});

test('restoreSavedSettings', async t => {
  await t.test('reads the Ulysses and Obsidian fields back out of localStorage', t2 => {
    const { window, document, module: Export } = boot(t2);
    window.localStorage.setItem('sc-ulysses-group', 'Cabinet');
    window.localStorage.setItem('sc-ulysses-group-id', 'abc123');
    window.localStorage.setItem('sc-obsidian-vault', 'Grimoire');

    Export.restoreSavedSettings();

    assert.equal(document.getElementById('ulysses-group').value, 'Cabinet');
    assert.equal(document.getElementById('ulysses-group-id').value, 'abc123');
    assert.equal(document.getElementById('obsidian-vault').value, 'Grimoire');
  });

  await t.test('leaves fields untouched when nothing was saved', t2 => {
    const { document, module: Export } = boot(t2);
    document.getElementById('ulysses-group').value = 'typed by hand';
    Export.restoreSavedSettings();
    assert.equal(document.getElementById('ulysses-group').value, 'typed by hand');
  });

  await t.test('survives a page whose settings fields are absent', t2 => {
    const { window, module: Export } = boot(t2, { bodyHtml: '<div id="transcript-content"></div>' });
    window.localStorage.setItem('sc-obsidian-vault', 'Grimoire');
    assert.doesNotThrow(() => Export.restoreSavedSettings());
  });
});
