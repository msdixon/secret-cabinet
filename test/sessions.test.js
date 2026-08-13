'use strict';

// #137 — sessions.js's deps-bag seam.
//
// The #142 seam mapping called this "the most core-state-coupled of the three
// extractions... mainly because of restoreSession(), which hydrates nearly
// every piece of core session/player state app.js owns". That coupling is the
// reason it went last, and it is the reason it is worth testing: the deps bag
// is the entire contract between this module and app.js, and a recording fake
// makes that contract legible — what gets set, in what shape, in what order.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadPublicModule, assertIdsExistInIndexHtml } = require('./helpers/dom.js');

const FIXTURE = `
  <div id="sessions-overlay"></div>
  <div id="sessions-drawer"><input id="sessions-search" /><div id="sessions-list"></div></div>
  <div id="dossier-overlay"></div>
  <div id="dossier-drawer"><div id="dossier-body"></div></div>
  <button id="dossier-btn"></button>
  <div id="transcript-panel">
    <div id="transcript-empty"></div>
    <div id="transcript-content"></div>
  </div>
`;

const MEMBERS = [
  { id: 'crowley', name: 'Crowley' },
  { id: 'blavatsky', name: 'Blavatsky' },
];

const SESSION = {
  id: 'sess-1',
  date: '1926-11-02',
  entry: 'the source document',
  members: ['crowley', 'blavatsky'],
  roundCount: 4,
  rounds: [
    { label: 'Round I', text: 'Crowley —\nOne.' },
    { label: 'Round II', text: 'Blavatsky —\nTwo.' },
  ],
  annotations: [{ entryId: 'e0', note: 'restored note' }],
};

// Records every deps call so a test can assert on the contract rather than on
// app.js internals it has no business knowing.
function makeDeps(document, calls) {
  const record =
    name =>
    (...args) => {
      calls.push([name, ...args]);
    };
  return {
    getCore: () => ({ MEMBERS }),
    setStatus: record('setStatus'),
    resetLiveStage: record('resetLiveStage'),
    resetTranscriptCounters: record('resetTranscriptCounters'),
    setCurrentSessionId: record('setCurrentSessionId'),
    setSessionDate: record('setSessionDate'),
    setCurrentEntry: record('setCurrentEntry'),
    setCurrentSourceSessionId: record('setCurrentSourceSessionId'),
    setSegmentCount: record('setSegmentCount'),
    setRenderSegment: record('setRenderSegment'),
    setPlayerMode: record('setPlayerMode'),
    setPlayerMemberId: record('setPlayerMemberId'),
    setPlayerName: record('setPlayerName'),
    setCurrentPlayerSpeakerName: record('setCurrentPlayerSpeakerName'),
    setSessionPlayerTurns: record('setSessionPlayerTurns'),
    setPlayerTurnsRevealed: record('setPlayerTurnsRevealed'),
    setTranscriptText: record('setTranscriptText'),
    setActiveMembers: record('setActiveMembers'),
    restorePlayAsControlDisplay: record('restorePlayAsControlDisplay'),
    renderMembers: record('renderMembers'),
    showSessionControls: record('showSessionControls'),
    applyCitationFlags: record('applyCitationFlags'),
    applyPlayerTurnMarkers: record('applyPlayerTurnMarkers'),
    addBranchControl: record('addBranchControl'),
    escapeHTML: s => String(s),
    addRoundHeader: (label, idx) => {
      calls.push(['addRoundHeader', label, idx]);
      const h = document.createElement('div');
      h.className = 'round-header';
      document.getElementById('transcript-content').appendChild(h);
      return h;
    },
    addLullDivider: (note, idx) => {
      calls.push(['addLullDivider', note, idx]);
      const el = document.createElement('div');
      el.className = 'transcript-lull';
      document.getElementById('transcript-content').appendChild(el);
      return el;
    },
    // Stands in for app.js's real parser: appends one entry with a stable
    // entryId, which is all the annotation-restore step downstream reads.
    parseAndRenderTranscript: text => {
      calls.push(['parseAndRenderTranscript', text]);
      const el = document.createElement('div');
      el.className = 'transcript-entry';
      el.dataset.entryId = `e${document.querySelectorAll('.transcript-entry').length}`;
      el.innerHTML = '<textarea class="annotation-input"></textarea>';
      document.getElementById('transcript-content').appendChild(el);
    },
  };
}

function boot(t, { fetchImpl, bodyHtml = FIXTURE } = {}) {
  const loaded = loadPublicModule('sessions.js', bodyHtml);
  t.after(loaded.cleanup);
  const calls = [];
  // jsdom ships no fetch; every network call in this module goes through it,
  // so tests supply exactly the responses the case under test needs.
  loaded.window.fetch = fetchImpl || (() => Promise.reject(new Error('unexpected fetch')));
  loaded.module.configure(makeDeps(loaded.document, calls));
  return { ...loaded, calls };
}

const jsonOk = body => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

// Finds the single argument a recorded one-arg dep call received.
const argFor = (calls, name) => calls.find(c => c[0] === name)?.[1];

test('the sessions fixture matches the ids index.html actually ships', () => {
  assertIdsExistInIndexHtml([
    'sessions-overlay',
    'sessions-drawer',
    'sessions-search',
    'sessions-list',
    'dossier-overlay',
    'dossier-drawer',
    'dossier-body',
    'dossier-btn',
    'transcript-empty',
    'transcript-content',
  ]);
});

test('sessions drawer', async t => {
  await t.test('opening clears the search box and closing puts the drawer away', async t2 => {
    const { document, module: Sessions } = boot(t2, {
      fetchImpl: () => jsonOk({ sessions: [] }),
    });
    document.getElementById('sessions-search').value = 'stale query';

    await Sessions.openSessionsDrawer();
    assert.ok(document.getElementById('sessions-drawer').classList.contains('open'));
    assert.ok(document.getElementById('sessions-overlay').classList.contains('open'));
    assert.equal(document.getElementById('sessions-search').value, '');

    Sessions.closeSessionsDrawer();
    assert.equal(document.getElementById('sessions-drawer').classList.contains('open'), false);
    assert.equal(document.getElementById('sessions-overlay').classList.contains('open'), false);
  });
});

test('restoreSession', async t => {
  await t.test('hydrates core session state from the stored record', async t2 => {
    const { calls, module: Sessions } = boot(t2, { fetchImpl: () => jsonOk(SESSION) });
    await Sessions.restoreSession('sess-1');

    assert.equal(argFor(calls, 'setCurrentSessionId'), 'sess-1');
    assert.equal(argFor(calls, 'setSessionDate'), '1926-11-02');
    assert.equal(argFor(calls, 'setCurrentEntry'), 'the source document');
    assert.equal(argFor(calls, 'setSegmentCount'), 2, 'segment count is however many are stored');
    assert.deepEqual([...argFor(calls, 'setActiveMembers')], ['crowley', 'blavatsky']);
  });

  await t.test('resets the stage before rendering stored history', async t2 => {
    // A restored session is static, read-only history — the stage (#184's
    // performance pane) must not sit next to it showing something stale, and
    // it must be cleared before the entry counter resets, or a stale node
    // can collide on entryId with a restored one.
    const { calls, module: Sessions } = boot(t2, { fetchImpl: () => jsonOk(SESSION) });
    await Sessions.restoreSession('sess-1');

    const order = calls.map(c => c[0]);
    assert.ok(order.includes('resetLiveStage'), 'the stage must be reset');
    assert.ok(
      order.indexOf('resetLiveStage') < order.indexOf('resetTranscriptCounters'),
      'the stage resets before the counters reset'
    );
    assert.ok(
      order.indexOf('resetTranscriptCounters') < order.indexOf('parseAndRenderTranscript'),
      'counters reset before anything re-renders'
    );
  });

  await t.test('re-renders every stored round in order, with its branch control', async t2 => {
    const { calls, module: Sessions } = boot(t2, { fetchImpl: () => jsonOk(SESSION) });
    await Sessions.restoreSession('sess-1');

    const headers = calls.filter(c => c[0] === 'addRoundHeader');
    assert.deepEqual(
      headers.map(c => [c[1], c[2]]),
      [
        ['Round I', 0],
        ['Round II', 1],
      ]
    );
    assert.equal(calls.filter(c => c[0] === 'addBranchControl').length, 2);
    assert.deepEqual(
      calls.filter(c => c[0] === 'parseAndRenderTranscript').map(c => c[1]),
      ['Crowley —\nOne.', 'Blavatsky —\nTwo.']
    );
  });

  // #245: a segment's label means opposite things either side of the
  // continuous-stream migration, and `endedBy` is the only thing that says
  // which. The pre-#244 session above must keep rendering its label as an
  // opening header (asserted there); a post-#244 one renders the same field as
  // the lull that *ended* the passage, so it comes after the text.
  await t.test('renders a post-#244 segment label as a lull after its passage', async t2 => {
    const streamed = {
      ...SESSION,
      rounds: [
        { label: 'The room draws breath.', text: 'Crowley —\nOne.', endedBy: 'budget' },
        { label: 'The fire settles.', text: 'Blavatsky —\nTwo.', endedBy: 'closed' },
      ],
    };
    const { calls, module: Sessions } = boot(t2, { fetchImpl: () => jsonOk(streamed) });
    await Sessions.restoreSession('sess-1');

    assert.equal(calls.filter(c => c[0] === 'addRoundHeader').length, 0, 'no round headers survive');
    assert.deepEqual(
      calls.filter(c => c[0] === 'addLullDivider').map(c => [c[1], c[2]]),
      [
        ['The room draws breath.', 0],
        ['The fire settles.', 1],
      ]
    );
    // The passage renders before the lull that ended it, not after.
    const order = calls.map(c => c[0]);
    assert.ok(order.indexOf('parseAndRenderTranscript') < order.indexOf('addLullDivider'));
    // Branch points moved to lulls but kept their index meaning (#33/#194).
    assert.deepEqual(
      calls.filter(c => c[0] === 'addBranchControl').map(c => c[2]),
      [0, 1]
    );
  });

  await t.test('reattaches stored annotations to their entries after render', async t2 => {
    const { document, module: Sessions } = boot(t2, { fetchImpl: () => jsonOk(SESSION) });
    await Sessions.restoreSession('sess-1');

    const annotated = [...document.querySelectorAll('.transcript-entry.annotated')];
    assert.equal(annotated.length, 1);
    assert.equal(annotated[0].dataset.entryId, 'e0');
    assert.equal(annotated[0].querySelector('.annotation-input').value, 'restored note');
  });

  await t.test('rebuilds transcriptText from the roster rather than trusting stored text', async t2 => {
    const { calls, module: Sessions } = boot(t2, { fetchImpl: () => jsonOk(SESSION) });
    await Sessions.restoreSession('sess-1');

    const text = argFor(calls, 'setTranscriptText');
    assert.match(text, /Assembled: Crowley, Blavatsky/);
    assert.match(text, /1926-11-02/);
    assert.match(text, /the source document/);
  });

  await t.test('resolves a player-as-member identity to that member’s name', async t2 => {
    const session = { ...SESSION, playerMode: 'member', playerMemberId: 'blavatsky' };
    const { calls, module: Sessions } = boot(t2, { fetchImpl: () => jsonOk(session) });
    await Sessions.restoreSession('sess-1');

    assert.equal(argFor(calls, 'setPlayerMode'), 'member');
    assert.equal(argFor(calls, 'setCurrentPlayerSpeakerName'), 'Blavatsky');
  });

  await t.test('uses the stored name for a custom player identity', async t2 => {
    const session = { ...SESSION, playerMode: 'custom', playerName: 'The Visitor' };
    const { calls, module: Sessions } = boot(t2, { fetchImpl: () => jsonOk(session) });
    await Sessions.restoreSession('sess-1');
    assert.equal(argFor(calls, 'setCurrentPlayerSpeakerName'), 'The Visitor');
  });

  await t.test('leaves the player identity null when nobody played', async t2 => {
    const { calls, module: Sessions } = boot(t2, { fetchImpl: () => jsonOk(SESSION) });
    await Sessions.restoreSession('sess-1');
    assert.equal(argFor(calls, 'setPlayerMode'), 'none');
    assert.equal(argFor(calls, 'setCurrentPlayerSpeakerName'), null);
  });

  await t.test('resets the player-turn reveal so a restored session starts hidden', async t2 => {
    const { document, calls, module: Sessions } = boot(t2, { fetchImpl: () => jsonOk(SESSION) });
    document.getElementById('transcript-panel').classList.add('reveal-player-turns');
    await Sessions.restoreSession('sess-1');

    assert.equal(argFor(calls, 'setPlayerTurnsRevealed'), false);
    assert.equal(document.getElementById('transcript-panel').classList.contains('reveal-player-turns'), false);
  });

  await t.test('skips the citation and player-turn passes when the session has neither', async t2 => {
    const { calls, module: Sessions } = boot(t2, { fetchImpl: () => jsonOk(SESSION) });
    await Sessions.restoreSession('sess-1');
    assert.equal(
      calls.some(c => c[0] === 'applyCitationFlags'),
      false
    );
    assert.equal(
      calls.some(c => c[0] === 'applyPlayerTurnMarkers'),
      false
    );
  });

  await t.test('applies citation flags and player-turn markers when present', async t2 => {
    const session = {
      ...SESSION,
      citationFlags: [{ speaker: 'Crowley', quote: 'One.' }],
      playerTurns: [{ round: 0, text: 'One.' }],
    };
    const { calls, module: Sessions } = boot(t2, { fetchImpl: () => jsonOk(session) });
    await Sessions.restoreSession('sess-1');

    assert.deepEqual(argFor(calls, 'applyCitationFlags'), session.citationFlags);
    assert.deepEqual(argFor(calls, 'applyPlayerTurnMarkers'), session.playerTurns);
  });

  await t.test('reports failure through setStatus instead of throwing at app.js', async t2 => {
    const { calls, module: Sessions } = boot(t2, {
      fetchImpl: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
    });
    await assert.doesNotReject(() => Sessions.restoreSession('missing'));

    const statuses = calls.filter(c => c[0] === 'setStatus').map(c => c[1]);
    assert.equal(statuses.at(-1), 'Could not restore the meeting.');
    assert.equal(
      calls.some(c => c[0] === 'showSessionControls'),
      false,
      'no controls on a failed restore'
    );
  });
});

test('comparative mode', async t => {
  function compareBtn(document, id) {
    const btn = document.createElement('button');
    btn.id = `compare-btn-${id}`;
    btn.textContent = '⊕ Compare';
    document.getElementById('sessions-list').appendChild(btn);
    return btn;
  }

  await t.test('selects up to two sessions and refuses a third', t2 => {
    const { document, module: Sessions } = boot(t2);
    const a = compareBtn(document, 'a');
    const b = compareBtn(document, 'b');
    const c = compareBtn(document, 'c');

    Sessions.toggleCompareSelect('a', a);
    Sessions.toggleCompareSelect('b', b);
    Sessions.toggleCompareSelect('c', c);

    assert.equal(a.textContent, '✓ Selected');
    assert.equal(b.textContent, '✓ Selected');
    assert.equal(c.textContent, '⊕ Compare', 'the third selection is refused');
    assert.equal(c.classList.contains('active'), false);
  });

  await t.test('toggling a selected session off frees the slot', t2 => {
    const { document, module: Sessions } = boot(t2);
    const a = compareBtn(document, 'a');
    const b = compareBtn(document, 'b');
    const c = compareBtn(document, 'c');

    Sessions.toggleCompareSelect('a', a);
    Sessions.toggleCompareSelect('b', b);
    Sessions.toggleCompareSelect('a', a);
    Sessions.toggleCompareSelect('c', c);

    assert.equal(a.textContent, '⊕ Compare');
    assert.equal(c.textContent, '✓ Selected');
  });

  await t.test('the compare bar hides at zero, prompts at one, and offers the view at two', t2 => {
    const { document, module: Sessions } = boot(t2);
    const a = compareBtn(document, 'a');
    const b = compareBtn(document, 'b');

    Sessions.toggleCompareSelect('a', a);
    const bar = document.getElementById('compare-bar');
    assert.equal(bar.style.display, 'flex');
    assert.match(bar.textContent, /Select one more/);

    Sessions.toggleCompareSelect('b', b);
    assert.match(bar.textContent, /Compare these two/);

    Sessions.clearCompareSelection();
    assert.equal(bar.style.display, 'none');
    assert.equal(a.textContent, '⊕ Compare');
    assert.equal(b.textContent, '⊕ Compare');
  });
});

test('session notes', async t => {
  await t.test('keeps only notes with content', t2 => {
    const { module: Sessions } = boot(t2);
    Sessions.setSessionNote('crowley', 'reads the room badly');
    Sessions.setSessionNote('blavatsky', '   ');
    // Spread out of the jsdom realm — the module builds this object there, so
    // its prototype is that window's Object.prototype, not node's.
    assert.deepEqual({ ...Sessions.collectSessionNotes() }, { crowley: 'reads the room badly' });
  });

  await t.test('sweeps live textareas in case an oninput was missed', t2 => {
    const { document, module: Sessions } = boot(t2);
    const ta = document.createElement('textarea');
    ta.className = 'dossier-note';
    ta.dataset.memberId = 'blavatsky';
    ta.value = 'typed but never fired oninput';
    document.getElementById('dossier-body').appendChild(ta);

    assert.deepEqual({ ...Sessions.collectSessionNotes() }, { blavatsky: 'typed but never fired oninput' });
  });

  await t.test('a live textarea wins over a stale recorded value for the same member', t2 => {
    const { document, module: Sessions } = boot(t2);
    Sessions.setSessionNote('crowley', 'old value');
    const ta = document.createElement('textarea');
    ta.className = 'dossier-note';
    ta.dataset.memberId = 'crowley';
    ta.value = 'new value';
    document.getElementById('dossier-body').appendChild(ta);

    assert.deepEqual({ ...Sessions.collectSessionNotes() }, { crowley: 'new value' });
  });
});

test('dossier highlighting', async t => {
  function dossierEntry(document, id) {
    const el = document.createElement('div');
    el.className = 'dossier-entry';
    el.id = `dossier-${id}`;
    document.getElementById('dossier-body').appendChild(el);
    return el;
  }

  await t.test('highlights one entry at a time', t2 => {
    const { document, module: Sessions } = boot(t2);
    const a = dossierEntry(document, 'crowley');
    const b = dossierEntry(document, 'blavatsky');

    Sessions.highlightDossierEntry('crowley');
    assert.ok(a.classList.contains('highlighted'));

    Sessions.highlightDossierEntry('blavatsky');
    assert.equal(a.classList.contains('highlighted'), false, 'the previous highlight clears');
    assert.ok(b.classList.contains('highlighted'));
  });

  await t.test('ignores a missing member or a missing entry without throwing', t2 => {
    const { module: Sessions } = boot(t2);
    assert.doesNotThrow(() => Sessions.highlightDossierEntry(null));
    assert.doesNotThrow(() => Sessions.highlightDossierEntry('nobody'));
  });
});

test('dossier building', async t => {
  // #260 — a session can reference a member id later removed from roster.json.
  // The dossier endpoint 404s for it; that response is truthy, so a check
  // that only degrades on network/parse failure would let it through and
  // crash the render on `d.name`.
  await t.test('drops an entry whose member no longer exists in the roster', async t2 => {
    const { document, module: Sessions } = boot(t2, {
      fetchImpl: url =>
        url.includes('crowley')
          ? jsonOk({ id: 'crowley', name: 'Crowley' })
          : Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'not found' }) }),
    });

    await Sessions.buildDossier(['crowley', 'jack-parsons']);

    const entries = [...document.querySelectorAll('.dossier-entry')];
    assert.deepEqual(
      entries.map(e => e.id),
      ['dossier-crowley']
    );
  });

  await t.test('still degrades an entry on network failure', async t2 => {
    const { document, module: Sessions } = boot(t2, {
      fetchImpl: () => Promise.reject(new Error('offline')),
    });

    await Sessions.buildDossier(['crowley']);

    assert.equal(document.querySelectorAll('.dossier-entry').length, 0);
  });
});
