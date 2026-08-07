'use strict';

// #137 — Witness mode. The seam mapping on #142 named this the natural first
// target for both extraction and tests ("the smallest, most isolated thing to
// write first tests against"), so it is where the frontend suite starts.
//
// Everything here goes through the module's real public API and its real
// deps bag — start(session, deps) — and asserts on the DOM it produces. The
// block parser (parseWitnessBlocks) is module-private by design; it is
// exercised through start(), which is also how app.js reaches it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadPublicModule, assertIdsExistInIndexHtml } = require('./helpers/dom.js');

// The elements witness.js reaches for by id. Kept in one place so the drift
// guard below and the fixture can't disagree with each other.
const WITNESS_IDS = [
  'witness-panel', 'witness-stage', 'witness-hint', 'witness-progress',
  'witness-live-toggle', 'transcript-panel', 'transcript-content',
];

const FIXTURE = `
  <div id="transcript-panel">
    <button id="witness-live-toggle">◎ Witness</button>
    <div id="transcript-content"></div>
  </div>
  <div id="witness-panel" style="display:none">
    <div id="witness-hint"></div>
    <div id="witness-progress"></div>
    <div id="witness-stage"></div>
  </div>
`;

const MEMBERS = [
  { id: 'crowley', name: 'Crowley', glyph: '☿' },
  { id: 'blavatsky', name: 'Blavatsky', glyph: '✹' },
];

// Stand-ins for the core app.js helpers witness.js is handed. Deliberately
// dumb: the point is to observe what Witness does with them, not to re-test
// app.js's escaping.
function makeDeps(overrides = {}) {
  return {
    members: MEMBERS,
    resolveMember: (name, members) => members.find(m => m.name === name) || null,
    isKnownSpeakerHeader: (line, members) => members.some(m => line.replace(/:$/, '') === m.name),
    escapeHTML: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    renderActions: s => String(s),
    ...overrides,
  };
}

function boot(t) {
  const loaded = loadPublicModule('witness.js', FIXTURE);
  // start() schedules an auto-advance timer; closing the window cancels it so
  // nothing outlives the test.
  t.after(loaded.cleanup);
  return loaded;
}

// start() renders one block and schedules the rest on a reading-speed timer.
// Tests drive playback by hand rather than waiting on wall-clock delays of up
// to WITNESS_MAX_PAUSE — advance() is the same entry point the space bar and
// the auto-advance timer both use.
function playToEnd(Witness, document) {
  for (let i = 0; i < 200; i++) {
    if (document.querySelector('#witness-stage .witness-end')) return;
    Witness.advance();
  }
  throw new Error('playback did not reach the end after 200 advances');
}

test('the Witness fixture matches the ids index.html actually ships', () => {
  assertIdsExistInIndexHtml(WITNESS_IDS);
});

test('replay: parsing a stored session into playback blocks', async t => {
  await t.test('renders a round header, then a speech bubble per speaker', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.start({
      id: 's1',
      rounds: [{ label: 'Round I', text: 'Crowley:\nThe book is not the point.\n\nBlavatsky:\nIt is exactly the point.' }],
    }, makeDeps());
    playToEnd(Witness, document);

    const stage = document.getElementById('witness-stage');
    assert.equal(stage.querySelectorAll('.witness-round-header').length, 1);
    assert.match(stage.querySelector('.witness-round-label').textContent, /Round I/);

    const entries = [...stage.querySelectorAll('.transcript-entry')];
    assert.equal(entries.length, 2);
    assert.match(entries[0].querySelector('.speaker-name').textContent, /Crowley/);
    assert.match(entries[0].querySelector('.speech-text').textContent, /not the point/);
    assert.match(entries[1].querySelector('.speaker-name').textContent, /Blavatsky/);
  });

  await t.test('keeps a multi-paragraph speech as one block instead of dropping the trailing paragraph', t2 => {
    // The blank line inside a turn is a paragraph break, not a speaker change
    // (keepSpeaker=true in flush) — the same distinction pipeline.js's
    // stripInternalBlankLines defends on the way in.
    const { document, module: Witness } = boot(t2);
    Witness.start({
      rounds: [{ label: 'Round I', text: 'Crowley:\nFirst paragraph.\n\nSecond paragraph.' }],
    }, makeDeps());
    playToEnd(Witness, document);

    const entries = [...document.querySelectorAll('#witness-stage .transcript-entry')];
    assert.equal(entries.length, 2, 'both paragraphs should stay attributed to Crowley');
    for (const e of entries) {
      assert.match(e.querySelector('.speaker-name').textContent, /Crowley/);
    }
  });

  await t.test('renders an unattributed action line as an action, not a speech bubble', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.start({
      rounds: [{ label: 'Round I', text: '*The fire gutters.*\n\nCrowley:\nAs I was saying.' }],
    }, makeDeps());
    playToEnd(Witness, document);

    const stage = document.getElementById('witness-stage');
    const actions = [...stage.querySelectorAll('.action-line')];
    assert.equal(actions.length, 1);
    assert.equal(actions[0].textContent, 'The fire gutters.', 'the asterisks should be stripped');
    assert.equal(stage.querySelectorAll('.transcript-entry').length, 1);
  });

  await t.test('a speech consisting only of actions renders as action lines', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.start({
      rounds: [{ label: 'Round I', text: 'Crowley:\n*He says nothing at all.*' }],
    }, makeDeps());
    playToEnd(Witness, document);

    const stage = document.getElementById('witness-stage');
    assert.equal(stage.querySelectorAll('.transcript-entry').length, 0);
    assert.equal(stage.querySelector('.action-line').textContent, 'He says nothing at all.');
  });

  await t.test('drops divider lines rather than attributing them to anyone', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.start({
      rounds: [{ label: 'Round I', text: 'Crowley:\nA line.\n---\n—\n--' }],
    }, makeDeps());
    playToEnd(Witness, document);

    const text = document.querySelector('#witness-stage .speech-text').textContent;
    assert.equal(text.trim(), 'A line.');
  });

  await t.test('attaches a stored annotation to its speaker’s bubble', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.start({
      rounds: [{ label: 'Round I', text: 'Crowley:\nA claim about Dee.' }],
      annotations: { e1: { speaker: 'Crowley', note: 'Cross-check against the Sloane MSS.' } },
    }, makeDeps());
    playToEnd(Witness, document);

    const note = document.querySelector('#witness-stage .witness-annotation');
    assert.ok(note, 'annotation should render');
    assert.match(note.textContent, /Sloane MSS/);
  });

  await t.test('alternates bubble sides as the speaker changes, and holds the side when it does not', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.start({
      rounds: [{
        label: 'Round I',
        text: 'Crowley:\nOne.\n\nBlavatsky:\nTwo.\n\nBlavatsky:\nStill me.',
      }],
    }, makeDeps());
    playToEnd(Witness, document);

    const sides = [...document.querySelectorAll('#witness-stage .transcript-entry')]
      .map(e => (e.classList.contains('bubble-left') ? 'left' : 'right'));
    assert.equal(sides.length, 3);
    assert.notEqual(sides[0], sides[1], 'a new speaker should switch sides');
    assert.equal(sides[1], sides[2], 'the same speaker twice should stay put');
  });

  await t.test('uses the glyph the deps bag supplied, and escapes speaker names through it', t2 => {
    const escaped = [];
    const { document, module: Witness } = boot(t2);
    Witness.start({
      rounds: [{ label: 'Round I', text: 'Crowley:\nA line.' }],
    }, makeDeps({ escapeHTML: s => { escaped.push(s); return String(s); } }));
    playToEnd(Witness, document);

    assert.equal(document.querySelector('#witness-stage .speaker-glyph').textContent, '☿');
    assert.ok(escaped.includes('Crowley'), 'the speaker name should go through the injected escapeHTML');
  });

  await t.test('ignores a session with no rounds instead of opening an empty panel', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.start(null, makeDeps());
    Witness.start({}, makeDeps());
    assert.equal(document.getElementById('witness-panel').style.display, 'none');
  });
});

test('replay: advancing and progress', async t => {
  await t.test('reports position and reaches a terminal state at the end', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.start({
      rounds: [{ label: 'Round I', text: 'Crowley:\nOne.\n\nBlavatsky:\nTwo.' }],
    }, makeDeps());

    // start() renders block 1 of 3 (header, speech, speech).
    assert.match(document.getElementById('witness-hint').textContent, /^1 \/ 3/);
    Witness.advance();
    Witness.advance();
    assert.match(document.getElementById('witness-hint').textContent, /^3 \/ 3/);
    assert.equal(document.getElementById('witness-progress').style.width, '100%');

    Witness.advance(); // one past the end
    assert.equal(document.querySelector('#witness-stage .witness-end').textContent, 'The room falls silent.');
    assert.match(document.getElementById('witness-hint').textContent, /Exit to leave/);
  });

  await t.test('advance() is inert when no replay is running', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.advance();
    assert.equal(document.getElementById('witness-stage').innerHTML, '');
  });
});

test('replay: exit hands the session back to app.js', async t => {
  await t.test('calls the injected restoreSession with the session that was being witnessed', t2 => {
    const restored = [];
    const { document, window, module: Witness } = boot(t2);
    Witness.start(
      { id: 'sess-42', rounds: [{ label: 'Round I', text: 'Crowley:\nA line.' }] },
      makeDeps({ restoreSession: id => restored.push(id) }),
    );

    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'Escape' }));
    assert.deepEqual(restored, ['sess-42']);
    assert.equal(document.getElementById('witness-panel').style.display, 'none');
    assert.equal(document.getElementById('witness-stage').innerHTML, '');
  });

  await t.test('exiting twice does not restore twice', t2 => {
    const restored = [];
    const { module: Witness } = boot(t2);
    Witness.start(
      { id: 'sess-42', rounds: [{ label: 'Round I', text: 'Crowley:\nA line.' }] },
      makeDeps({ restoreSession: id => restored.push(id) }),
    );

    Witness.exitClicked();
    Witness.exitClicked();
    assert.deepEqual(restored, ['sess-42']);
  });

  await t.test('a session with no id exits cleanly without calling restoreSession', t2 => {
    let called = false;
    const { module: Witness } = boot(t2);
    Witness.start(
      { rounds: [{ label: 'Round I', text: 'Crowley:\nA line.' }] },
      makeDeps({ restoreSession: () => { called = true; } }),
    );
    Witness.exitClicked();
    assert.equal(called, false);
  });
});

test('live mode', async t => {
  await t.test('routes new entries to the reading panel until live is toggled on', t2 => {
    const { module: Witness } = boot(t2);
    assert.equal(Witness.getLiveStageEl().id, 'transcript-content');
    Witness.toggleLive();
    assert.equal(Witness.getLiveStageEl().id, 'witness-stage');
    Witness.toggleLive();
    assert.equal(Witness.getLiveStageEl().id, 'transcript-content');
  });

  await t.test('moves rendered entries between panels rather than cloning them', t2 => {
    // A clone would leave two nodes sharing one entryId, and app.js's global
    // .transcript-entry queries (saveAnnotation, buildAnnotatedTranscript)
    // would then double up on save. Toggling any number of times must leave
    // exactly one DOM copy of each entry.
    const { document, module: Witness } = boot(t2);
    const reading = document.getElementById('transcript-content');
    reading.innerHTML = '<div class="transcript-entry" data-entry-id="e1"></div>'
      + '<div class="transcript-entry" data-entry-id="e2"></div>';

    Witness.toggleLive();
    Witness.toggleLive();
    Witness.toggleLive();

    assert.equal(document.querySelectorAll('.transcript-entry').length, 2, 'no duplicates anywhere in the document');
    assert.equal(document.querySelectorAll('#witness-stage .transcript-entry').length, 2);
    assert.equal(document.querySelectorAll('#transcript-content .transcript-entry').length, 0);
    assert.deepEqual(
      [...document.querySelectorAll('.transcript-entry')].map(e => e.dataset.entryId),
      ['e1', 'e2'],
      'order should survive the move',
    );
  });

  await t.test('swaps the visible panel and relabels the toggle', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.toggleLive();
    assert.equal(document.getElementById('transcript-panel').style.display, 'none');
    assert.equal(document.getElementById('witness-panel').style.display, 'block');
    assert.match(document.getElementById('witness-hint').textContent, /Live/);
    assert.match(document.getElementById('witness-live-toggle').textContent, /Reading view/);

    Witness.toggleLive();
    assert.equal(document.getElementById('witness-panel').style.display, 'none');
    assert.match(document.getElementById('witness-live-toggle').textContent, /Witness/);
  });

  await t.test('the shared Exit button leaves live mode instead of ending a replay', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.toggleLive();
    Witness.exitClicked();
    assert.equal(document.getElementById('witness-panel').style.display, 'none');
    assert.equal(Witness.getLiveStageEl().id, 'transcript-content');
  });

  await t.test('forceLiveOff clears the stage so a restored session cannot inherit stale nodes', t2 => {
    // restoreSession() resets app.js's _entryCounter, so a node left over from
    // a previous session could collide on entryId with a freshly restored one.
    const { document, module: Witness } = boot(t2);
    Witness.toggleLive();
    document.getElementById('witness-stage').innerHTML = '<div class="transcript-entry" data-entry-id="e1"></div>';

    Witness.forceLiveOff();

    assert.equal(document.getElementById('witness-stage').innerHTML, '');
    assert.equal(document.getElementById('witness-panel').style.display, 'none');
    assert.equal(document.getElementById('transcript-panel').style.display, '');
    assert.equal(Witness.getLiveStageEl().id, 'transcript-content', 'live mode must be off, not merely hidden');
  });

  await t.test('starting a replay forces live mode off — stored history is never "the room speaking now"', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.toggleLive();
    assert.equal(Witness.getLiveStageEl().id, 'witness-stage');

    Witness.start({ rounds: [{ label: 'Round I', text: 'Crowley:\nA line.' }] }, makeDeps());

    assert.equal(Witness.getLiveStageEl().id, 'transcript-content');
    assert.equal(document.getElementById('transcript-panel').style.display, '');
  });
});
