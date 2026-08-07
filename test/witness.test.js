'use strict';

// #137 — Witness mode. The seam mapping on #142 named this the natural first
// target for both extraction and tests ("the smallest, most isolated thing to
// write first tests against"), so it is where the frontend suite starts.
//
// #184 (defaults inversion, see DESIGN-184-STAGE-DEFAULT.md) reshaped this
// module significantly: the stage and the record are now two permanent
// panes rendering the same conversation, never one swapped for the other,
// so the old toggleLive()/getLiveStageEl() DOM-move tests are gone and
// replaced with tests for the new live-mirroring API (liveRoundHeader,
// liveSpeech, liveTyping*) and the collapse/reopen affordance that replaces
// the old show/hide panel.
//
// Everything here goes through the module's real public API and its real
// deps bag — start(session, deps), configure(deps) — and asserts on the DOM
// it produces. The block parser (parseWitnessBlocks) is module-private by
// design; it is exercised through start(), which is also how app.js reaches
// it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadPublicModule, assertIdsExistInIndexHtml } = require('./helpers/dom.js');

// The elements witness.js reaches for by id. Kept in one place so the drift
// guard below and the fixture can't disagree with each other.
const WITNESS_IDS = [
  'stage-record', 'stage-pane', 'witness-hint', 'witness-exit-btn',
  'witness-stage', 'witness-progress', 'stage-collapsed-bar',
  'transcript-panel', 'transcript-content',
];

const FIXTURE = `
  <div id="stage-record">
    <div id="stage-pane">
      <div id="witness-hint"></div>
      <button id="witness-exit-btn" style="display:none"></button>
      <div id="witness-stage"></div>
      <div id="witness-progress" style="display:none"></div>
    </div>
    <button id="stage-collapsed-bar"></button>
    <div id="transcript-panel">
      <div id="transcript-content"></div>
    </div>
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
  await t.test('renders a round header, then a speech bubble per speaker', async t2 => {
    const { document, module: Witness } = boot(t2);
    await Witness.start({
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

  await t.test('keeps a multi-paragraph speech as one block instead of dropping the trailing paragraph', async t2 => {
    // The blank line inside a turn is a paragraph break, not a speaker change
    // (keepSpeaker=true in flush) — the same distinction pipeline.js's
    // stripInternalBlankLines defends on the way in.
    const { document, module: Witness } = boot(t2);
    await Witness.start({
      rounds: [{ label: 'Round I', text: 'Crowley:\nFirst paragraph.\n\nSecond paragraph.' }],
    }, makeDeps());
    playToEnd(Witness, document);

    const entries = [...document.querySelectorAll('#witness-stage .transcript-entry')];
    assert.equal(entries.length, 2, 'both paragraphs should stay attributed to Crowley');
    for (const e of entries) {
      assert.match(e.querySelector('.speaker-name').textContent, /Crowley/);
    }
  });

  await t.test('renders an unattributed action line as an action, not a speech bubble', async t2 => {
    const { document, module: Witness } = boot(t2);
    await Witness.start({
      rounds: [{ label: 'Round I', text: '*The fire gutters.*\n\nCrowley:\nAs I was saying.' }],
    }, makeDeps());
    playToEnd(Witness, document);

    const stage = document.getElementById('witness-stage');
    const actions = [...stage.querySelectorAll('.action-line')];
    assert.equal(actions.length, 1);
    assert.equal(actions[0].textContent, 'The fire gutters.', 'the asterisks should be stripped');
    assert.equal(stage.querySelectorAll('.transcript-entry').length, 1);
  });

  await t.test('a speech consisting only of actions renders as action lines', async t2 => {
    const { document, module: Witness } = boot(t2);
    await Witness.start({
      rounds: [{ label: 'Round I', text: 'Crowley:\n*He says nothing at all.*' }],
    }, makeDeps());
    playToEnd(Witness, document);

    const stage = document.getElementById('witness-stage');
    assert.equal(stage.querySelectorAll('.transcript-entry').length, 0);
    assert.equal(stage.querySelector('.action-line').textContent, 'He says nothing at all.');
  });

  await t.test('drops divider lines rather than attributing them to anyone', async t2 => {
    const { document, module: Witness } = boot(t2);
    await Witness.start({
      rounds: [{ label: 'Round I', text: 'Crowley:\nA line.\n---\n—\n--' }],
    }, makeDeps());
    playToEnd(Witness, document);

    const text = document.querySelector('#witness-stage .speech-text').textContent;
    assert.equal(text.trim(), 'A line.');
  });

  await t.test('attaches a stored annotation to its speaker’s bubble', async t2 => {
    const { document, module: Witness } = boot(t2);
    await Witness.start({
      rounds: [{ label: 'Round I', text: 'Crowley:\nA claim about Dee.' }],
      annotations: { e1: { speaker: 'Crowley', note: 'Cross-check against the Sloane MSS.' } },
    }, makeDeps());
    playToEnd(Witness, document);

    const note = document.querySelector('#witness-stage .witness-annotation');
    assert.ok(note, 'annotation should render');
    assert.match(note.textContent, /Sloane MSS/);
  });

  await t.test('alternates bubble sides as the speaker changes, and holds the side when it does not', async t2 => {
    const { document, module: Witness } = boot(t2);
    await Witness.start({
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

  await t.test('uses the glyph the deps bag supplied, and escapes speaker names through it', async t2 => {
    const escaped = [];
    const { document, module: Witness } = boot(t2);
    await Witness.start({
      rounds: [{ label: 'Round I', text: 'Crowley:\nA line.' }],
    }, makeDeps({ escapeHTML: s => { escaped.push(s); return String(s); } }));
    playToEnd(Witness, document);

    assert.equal(document.querySelector('#witness-stage .speaker-glyph').textContent, '☿');
    assert.ok(escaped.includes('Crowley'), 'the speaker name should go through the injected escapeHTML');
  });

  await t.test('ignores a session with no rounds instead of opening an empty stage', async t2 => {
    const { document, module: Witness } = boot(t2);
    await Witness.start(null, makeDeps());
    await Witness.start({}, makeDeps());
    assert.equal(document.getElementById('witness-stage').innerHTML, '');
    assert.equal(document.getElementById('witness-exit-btn').style.display, 'none');
  });
});

test('replay: advancing and progress', async t => {
  await t.test('reports position and reaches a terminal state at the end', async t2 => {
    const { document, module: Witness } = boot(t2);
    await Witness.start({
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

test('replay: start syncs the record, exit stops playback and collapses the stage', async t => {
  // #184: restoreSession now fires when replay STARTS, not when it exits —
  // both panes show the same session as soon as playback begins, rather
  // than the record only catching up once the user leaves the stage.
  await t.test('start() awaits the injected restoreSession before rendering', async t2 => {
    const order = [];
    const { module: Witness } = boot(t2);
    await Witness.start(
      { id: 'sess-42', rounds: [{ label: 'Round I', text: 'Crowley:\nA line.' }] },
      makeDeps({ restoreSession: async id => { order.push(`restore:${id}`); } }),
    );
    order.push('rendered');
    assert.deepEqual(order, ['restore:sess-42', 'rendered']);
  });

  await t.test('a session with no id starts without calling restoreSession', async t2 => {
    let called = false;
    const { module: Witness } = boot(t2);
    await Witness.start(
      { rounds: [{ label: 'Round I', text: 'Crowley:\nA line.' }] },
      makeDeps({ restoreSession: () => { called = true; } }),
    );
    assert.equal(called, false);
  });

  await t.test('exit stops playback, clears the stage, and collapses it — restoreSession is not called again', async t2 => {
    const restored = [];
    const { document, window, module: Witness } = boot(t2);
    await Witness.start(
      { id: 'sess-42', rounds: [{ label: 'Round I', text: 'Crowley:\nA line.' }] },
      makeDeps({ restoreSession: id => restored.push(id) }),
    );
    assert.deepEqual(restored, ['sess-42']);

    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'Escape' }));

    assert.deepEqual(restored, ['sess-42'], 'exit must not call restoreSession a second time');
    assert.equal(document.getElementById('witness-stage').innerHTML, '');
    assert.equal(document.getElementById('witness-exit-btn').style.display, 'none');
    assert.ok(document.getElementById('stage-record').classList.contains('collapsed'), 'exit collapses the stage');
  });

  await t.test('a fresh replay reopens a collapsed stage', async t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.collapseStage();
    assert.ok(document.getElementById('stage-record').classList.contains('collapsed'));

    await Witness.start({ rounds: [{ label: 'Round I', text: 'Crowley:\nA line.' }] }, makeDeps());

    assert.equal(document.getElementById('stage-record').classList.contains('collapsed'), false);
  });
});

test('live mirroring (#184): the stage renders its own copy, independent of the record', async t => {
  await t.test('liveRoundHeader and liveSpeech render into the stage only, never touching the record', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.configure(makeDeps());

    Witness.liveRoundHeader('First Movement');
    Witness.liveSpeech({ speaker: 'Crowley', text: 'The book is not the point.', memberId: 'crowley' });

    const stage = document.getElementById('witness-stage');
    assert.equal(stage.querySelectorAll('.witness-round-header').length, 1);
    assert.match(stage.querySelector('.witness-round-label').textContent, /First Movement/);
    const entry = stage.querySelector('.transcript-entry');
    assert.match(entry.querySelector('.speaker-name').textContent, /Crowley/);
    assert.match(entry.querySelector('.speech-text').textContent, /not the point/);

    assert.equal(document.getElementById('transcript-content').children.length, 0, 'the record is app.js\'s to fill, not witness.js\'s');
  });

  await t.test('stage entries carry no entryId/dataset.speaker — annotation stays exclusively in the record', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.configure(makeDeps());
    Witness.liveSpeech({ speaker: 'Crowley', text: 'A claim.', memberId: 'crowley' });

    const entry = document.querySelector('#witness-stage .transcript-entry');
    assert.equal(entry.dataset.entryId, undefined);
    assert.equal(entry.dataset.speaker, undefined);
  });

  await t.test('liveRoundHeader shows the exit button and a live hint, and returns a removable element for error recovery', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.configure(makeDeps());

    const header = Witness.liveRoundHeader('First Movement');
    assert.equal(document.getElementById('witness-exit-btn').style.display, '');
    assert.match(document.getElementById('witness-hint').textContent, /Live/);

    // Mirrors app.js's error-recovery path: a failed round removes both the
    // record's header (h.remove()) and the stage's mirror (this return value).
    header.remove();
    assert.equal(document.querySelectorAll('#witness-stage .witness-round-header').length, 0);
  });

  await t.test('liveTypingStart/Append/liveClearTyping manage a growing placeholder, swapped by the next liveSpeech', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.configure(makeDeps());

    Witness.liveTypingStart('Crowley');
    let typing = document.querySelector('#witness-stage .transcript-typing');
    assert.ok(typing, 'a typing placeholder should appear');
    assert.match(typing.querySelector('.speaker-name').textContent, /Crowley/);

    Witness.liveTypingAppend('The book');
    Witness.liveTypingAppend(' is not the point.');
    assert.equal(document.querySelector('#witness-stage .typing-text').textContent, 'The book is not the point.');

    Witness.liveClearTyping();
    assert.equal(document.querySelectorAll('#witness-stage .transcript-typing').length, 0);

    Witness.liveSpeech({ speaker: 'Crowley', text: 'The book is not the point.', memberId: 'crowley' });
    assert.equal(document.querySelectorAll('#witness-stage .transcript-entry').length, 1);
  });

  await t.test('liveReset clears the stage and reopens it; resetLiveStage clears without forcing it open', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.configure(makeDeps());
    Witness.liveRoundHeader('Round I');
    Witness.collapseStage();
    assert.ok(document.getElementById('stage-record').classList.contains('collapsed'));

    Witness.resetLiveStage();
    assert.equal(document.getElementById('witness-stage').innerHTML, '');
    assert.ok(document.getElementById('stage-record').classList.contains('collapsed'), 'resetLiveStage must not reopen a collapsed stage');

    Witness.liveRoundHeader('Round II');
    Witness.liveReset();
    assert.equal(document.getElementById('witness-stage').innerHTML, '');
    assert.equal(document.getElementById('stage-record').classList.contains('collapsed'), false, 'liveReset reopens for a fresh convene');
  });
});

test('collapse/reopen: exitClicked dispatches to whichever mode is active, never touching the record', async t => {
  await t.test('with no replay running, exitClicked just collapses the stage', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.configure(makeDeps());
    Witness.liveRoundHeader('Round I');

    Witness.exitClicked();

    assert.ok(document.getElementById('stage-record').classList.contains('collapsed'));
    // Live mirroring is not a replay -- exitClicked() must not clear stage
    // content the way ending a replay does; the convene (and its mirrored
    // beats) keep going underneath a collapsed stage.
    assert.equal(document.querySelectorAll('#witness-stage .witness-round-header').length, 1);
  });

  await t.test('reopenStage scrolls the stage to its latest content', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.configure(makeDeps());
    Witness.collapseStage();

    Witness.reopenStage();

    assert.equal(document.getElementById('stage-record').classList.contains('collapsed'), false);
  });
});
