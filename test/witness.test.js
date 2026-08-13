'use strict';

// #137 — Witness mode. The seam mapping on #142 named this the natural first
// target for both extraction and tests ("the smallest, most isolated thing to
// write first tests against"), so it is where the frontend suite starts.
//
// #184 (defaults inversion, see docs/archive/DESIGN-184-STAGE-DEFAULT.md) reshaped this
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
const { splitIntoBeats } = require('../public/js/beats.js');

// The elements witness.js reaches for by id. Kept in one place so the drift
// guard below and the fixture can't disagree with each other.
const WITNESS_IDS = [
  'stage-record',
  'stage-pane',
  'witness-hint',
  'witness-exit-btn',
  'witness-stage',
  'witness-progress',
  'stage-collapsed-bar',
  'transcript-panel',
  'transcript-content',
  'record-scroll',
  'witness-room',
  'room-speech-layer',
  'room-events',
];

const FIXTURE = `
  <div id="stage-record">
    <div id="stage-pane">
      <div id="witness-hint"></div>
      <button id="witness-exit-btn" style="display:none"></button>
      <div id="witness-stage"></div>
      <div id="witness-room">
        <div id="room-speech-layer"></div>
        <div id="room-events"></div>
      </div>
      <div id="witness-progress" style="display:none"></div>
    </div>
    <button id="stage-collapsed-bar"></button>
    <div id="transcript-panel">
      <div id="record-scroll">
        <div id="transcript-content"></div>
      </div>
    </div>
  </div>
`;

// #257: stubs window.LodgeScene.getSeatScreenPosition, the only surface the
// room's card positioning reads. `positions` maps memberId -> { x, y,
// visible } (see scene.js's own getSeatScreenPosition for the real shape);
// an omitted memberId resolves to null, same as a member who isn't seated.
function stubScene(window, positions = {}) {
  window.LodgeScene = { getSeatScreenPosition: memberId => positions[memberId] || null };
}

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
    // #219: the real implementation, not a stand-in -- replay's beat
    // splitting is exactly the thing under test in the block below, so a
    // dumb stub would test nothing.
    splitIntoBeats,
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
    await Witness.start(
      {
        id: 's1',
        rounds: [
          { label: 'Round I', text: 'Crowley:\nThe book is not the point.\n\nBlavatsky:\nIt is exactly the point.' },
        ],
      },
      makeDeps()
    );
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

  // #245: same label-placement rule as the record and the reading room — a
  // post-#244 segment's label is the lull that ended it, so on replay it plays
  // after the passage, where the room actually drew breath.
  await t.test('plays a post-#244 segment label as a lull after its passage', async t2 => {
    const { document, module: Witness } = boot(t2);
    await Witness.start(
      {
        id: 's1',
        rounds: [{ label: 'The room draws breath.', text: 'Crowley:\nOne.', endedBy: 'lull' }],
      },
      makeDeps()
    );
    playToEnd(Witness, document);

    const stage = document.getElementById('witness-stage');
    assert.equal(stage.querySelectorAll('.witness-round-header').length, 0, 'no round header survives');
    const lull = stage.querySelector('.transcript-lull .lull-note');
    assert.match(lull.textContent, /The room draws breath\./);

    const order = [...stage.children];
    assert.ok(
      order.indexOf(stage.querySelector('.transcript-entry')) < order.indexOf(stage.querySelector('.transcript-lull')),
      'the passage plays before the lull that ended it'
    );
  });

  await t.test('#219: a long turn renders as multiple sequential bubbles for the same speaker, not one', async t2 => {
    const { document, module: Witness } = boot(t2);
    const w = n => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
    const sentence1 = `${w(20)}.`;
    const sentence2 = `${w(20)}.`;
    const sentence3 = `${w(10)}.`;
    // One line, no internal breaks -- three sentences totalling 50 words,
    // so the running count actually crosses BEAT_WORD_THRESHOLD (40) with
    // more content still to come, forcing a real split rather than just
    // ending exactly at the crossing point.
    const longTurn = `${sentence1} ${sentence2} ${sentence3}`;
    await Witness.start(
      {
        rounds: [{ label: 'Round I', text: `Crowley:\n${longTurn}` }],
      },
      makeDeps()
    );
    playToEnd(Witness, document);

    const entries = [...document.querySelectorAll('#witness-stage .transcript-entry')];
    assert.ok(entries.length > 1, 'a long turn should split into more than one bubble');
    entries.forEach(e => assert.match(e.querySelector('.speaker-name').textContent, /Crowley/));

    // Every beat stays on the same side -- only an actual speaker change flips it.
    const sides = entries.map(e => [...e.classList].find(c => c.startsWith('bubble-')));
    assert.ok(
      sides.every(s => s === sides[0]),
      'beats of the same turn should not alternate sides'
    );

    // No words lost, duplicated, or reordered across the split.
    const combinedText = entries.map(e => e.querySelector('.speech-text').textContent).join(' ');
    assert.deepEqual(combinedText.trim().split(/\s+/), longTurn.split(/\s+/));
  });

  await t.test('keeps a multi-paragraph speech as one block instead of dropping the trailing paragraph', async t2 => {
    // The blank line inside a turn is a paragraph break, not a speaker change
    // (keepSpeaker=true in flush) — the same distinction pipeline.js's
    // stripInternalBlankLines defends on the way in.
    const { document, module: Witness } = boot(t2);
    await Witness.start(
      {
        rounds: [{ label: 'Round I', text: 'Crowley:\nFirst paragraph.\n\nSecond paragraph.' }],
      },
      makeDeps()
    );
    playToEnd(Witness, document);

    const entries = [...document.querySelectorAll('#witness-stage .transcript-entry')];
    assert.equal(entries.length, 2, 'both paragraphs should stay attributed to Crowley');
    for (const e of entries) {
      assert.match(e.querySelector('.speaker-name').textContent, /Crowley/);
    }
  });

  await t.test('renders an unattributed action line as an action, not a speech bubble', async t2 => {
    const { document, module: Witness } = boot(t2);
    await Witness.start(
      {
        rounds: [{ label: 'Round I', text: '*The fire gutters.*\n\nCrowley:\nAs I was saying.' }],
      },
      makeDeps()
    );
    playToEnd(Witness, document);

    const stage = document.getElementById('witness-stage');
    const actions = [...stage.querySelectorAll('.action-line')];
    assert.equal(actions.length, 1);
    assert.equal(actions[0].textContent, 'The fire gutters.', 'the asterisks should be stripped');
    assert.equal(stage.querySelectorAll('.transcript-entry').length, 1);
  });

  await t.test('a speech consisting only of actions renders as action lines', async t2 => {
    const { document, module: Witness } = boot(t2);
    await Witness.start(
      {
        rounds: [{ label: 'Round I', text: 'Crowley:\n*He says nothing at all.*' }],
      },
      makeDeps()
    );
    playToEnd(Witness, document);

    const stage = document.getElementById('witness-stage');
    assert.equal(stage.querySelectorAll('.transcript-entry').length, 0);
    assert.equal(stage.querySelector('.action-line').textContent, 'He says nothing at all.');
  });

  await t.test('drops divider lines rather than attributing them to anyone', async t2 => {
    const { document, module: Witness } = boot(t2);
    await Witness.start(
      {
        rounds: [{ label: 'Round I', text: 'Crowley:\nA line.\n---\n—\n--' }],
      },
      makeDeps()
    );
    playToEnd(Witness, document);

    const text = document.querySelector('#witness-stage .speech-text').textContent;
    assert.equal(text.trim(), 'A line.');
  });

  await t.test('attaches a stored annotation to its speaker’s bubble', async t2 => {
    const { document, module: Witness } = boot(t2);
    await Witness.start(
      {
        rounds: [{ label: 'Round I', text: 'Crowley:\nA claim about Dee.' }],
        annotations: { e1: { speaker: 'Crowley', note: 'Cross-check against the Sloane MSS.' } },
      },
      makeDeps()
    );
    playToEnd(Witness, document);

    const note = document.querySelector('#witness-stage .witness-annotation');
    assert.ok(note, 'annotation should render');
    assert.match(note.textContent, /Sloane MSS/);
  });

  await t.test('alternates bubble sides as the speaker changes, and holds the side when it does not', async t2 => {
    const { document, module: Witness } = boot(t2);
    await Witness.start(
      {
        rounds: [
          {
            label: 'Round I',
            text: 'Crowley:\nOne.\n\nBlavatsky:\nTwo.\n\nBlavatsky:\nStill me.',
          },
        ],
      },
      makeDeps()
    );
    playToEnd(Witness, document);

    const sides = [...document.querySelectorAll('#witness-stage .transcript-entry')].map(e =>
      e.classList.contains('bubble-left') ? 'left' : 'right'
    );
    assert.equal(sides.length, 3);
    assert.notEqual(sides[0], sides[1], 'a new speaker should switch sides');
    assert.equal(sides[1], sides[2], 'the same speaker twice should stay put');
  });

  await t.test('uses the glyph the deps bag supplied, and escapes speaker names through it', async t2 => {
    const escaped = [];
    const { document, module: Witness } = boot(t2);
    await Witness.start(
      {
        rounds: [{ label: 'Round I', text: 'Crowley:\nA line.' }],
      },
      makeDeps({
        escapeHTML: s => {
          escaped.push(s);
          return String(s);
        },
      })
    );
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
    await Witness.start(
      {
        rounds: [{ label: 'Round I', text: 'Crowley:\nOne.\n\nBlavatsky:\nTwo.' }],
      },
      makeDeps()
    );

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
      makeDeps({
        restoreSession: async id => {
          order.push(`restore:${id}`);
        },
      })
    );
    order.push('rendered');
    assert.deepEqual(order, ['restore:sess-42', 'rendered']);
  });

  await t.test('a session with no id starts without calling restoreSession', async t2 => {
    let called = false;
    const { module: Witness } = boot(t2);
    await Witness.start(
      { rounds: [{ label: 'Round I', text: 'Crowley:\nA line.' }] },
      makeDeps({
        restoreSession: () => {
          called = true;
        },
      })
    );
    assert.equal(called, false);
  });

  await t.test(
    'exit stops playback, clears the stage, and collapses it — restoreSession is not called again',
    async t2 => {
      const restored = [];
      const { document, window, module: Witness } = boot(t2);
      await Witness.start(
        { id: 'sess-42', rounds: [{ label: 'Round I', text: 'Crowley:\nA line.' }] },
        makeDeps({ restoreSession: id => restored.push(id) })
      );
      assert.deepEqual(restored, ['sess-42']);

      window.document.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'Escape' }));

      assert.deepEqual(restored, ['sess-42'], 'exit must not call restoreSession a second time');
      assert.equal(document.getElementById('witness-stage').innerHTML, '');
      assert.equal(document.getElementById('witness-exit-btn').style.display, 'none');
      const classes = document.getElementById('stage-record').classList;
      assert.ok(classes.contains('collapsed'), 'exit collapses the stage');
      assert.equal(classes.contains('stage-only'), false, 'exiting must leave stage-only behind, not carry both');
    }
  );

  await t.test('a fresh replay reopens a collapsed stage', async t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.collapseStage();
    assert.ok(document.getElementById('stage-record').classList.contains('collapsed'));

    await Witness.start({ rounds: [{ label: 'Round I', text: 'Crowley:\nA line.' }] }, makeDeps());

    const classes = document.getElementById('stage-record').classList;
    assert.equal(classes.contains('collapsed'), false);
    assert.ok(classes.contains('stage-only'), 'starting a replay hides the record, not just un-hides the stage');
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

    assert.equal(
      document.getElementById('transcript-content').children.length,
      0,
      "the record is app.js's to fill, not witness.js's"
    );
  });

  await t.test('stage entries carry no entryId/dataset.speaker — annotation stays exclusively in the record', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.configure(makeDeps());
    Witness.liveSpeech({ speaker: 'Crowley', text: 'A claim.', memberId: 'crowley' });

    const entry = document.querySelector('#witness-stage .transcript-entry');
    assert.equal(entry.dataset.entryId, undefined);
    assert.equal(entry.dataset.speaker, undefined);
  });

  await t.test(
    'liveRoundHeader shows the exit button and a live hint, and returns a removable element for error recovery',
    t2 => {
      const { document, module: Witness } = boot(t2);
      Witness.configure(makeDeps());

      const header = Witness.liveRoundHeader('First Movement');
      assert.equal(document.getElementById('witness-exit-btn').style.display, '');
      assert.match(document.getElementById('witness-hint').textContent, /Live/);

      // Mirrors app.js's error-recovery path: a failed round removes both the
      // record's header (h.remove()) and the stage's mirror (this return value).
      header.remove();
      assert.equal(document.querySelectorAll('#witness-stage .witness-round-header').length, 0);
    }
  );

  await t.test(
    'liveTypingStart/Set/liveClearTyping manage a growing placeholder, swapped by the next liveSpeech',
    t2 => {
      const { document, module: Witness } = boot(t2);
      Witness.configure(makeDeps());

      Witness.liveTypingStart('Crowley');
      let typing = document.querySelector('#witness-stage .transcript-typing');
      assert.ok(typing, 'a typing placeholder should appear');
      assert.match(typing.querySelector('.speaker-name').textContent, /Crowley/);

      // #219: liveTypingSet replaces the whole open-beat text each call
      // (app.js recomputes it from the growing buffer via splitIntoBeats)
      // rather than appending a raw delta.
      Witness.liveTypingSet('The book');
      Witness.liveTypingSet('The book is not the point.');
      assert.equal(document.querySelector('#witness-stage .typing-text').textContent, 'The book is not the point.');

      Witness.liveClearTyping();
      assert.equal(document.querySelectorAll('#witness-stage .transcript-typing').length, 0);

      Witness.liveSpeech({ speaker: 'Crowley', text: 'The book is not the point.', memberId: 'crowley' });
      assert.equal(document.querySelectorAll('#witness-stage .transcript-entry').length, 1);
    }
  );

  await t.test('liveReset clears the stage and reopens it; resetLiveStage clears without forcing it open', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.configure(makeDeps());
    Witness.liveRoundHeader('Round I');
    Witness.collapseStage();
    let classes = document.getElementById('stage-record').classList;
    assert.ok(classes.contains('collapsed'));
    assert.equal(classes.contains('stage-only'), false);

    Witness.resetLiveStage();
    assert.equal(document.getElementById('witness-stage').innerHTML, '');
    classes = document.getElementById('stage-record').classList;
    assert.ok(classes.contains('collapsed'), 'resetLiveStage must not reopen a collapsed stage');
    assert.equal(classes.contains('stage-only'), false);

    Witness.liveRoundHeader('Round II');
    Witness.liveReset();
    assert.equal(document.getElementById('witness-stage').innerHTML, '');
    classes = document.getElementById('stage-record').classList;
    assert.equal(classes.contains('collapsed'), false, 'liveReset reopens for a fresh convene');
    assert.ok(classes.contains('stage-only'), 'a fresh convene defaults to stage-only, hiding the record');
  });
});

test('collapse/reopen: exitClicked dispatches to whichever mode is active, never touching the record', async t => {
  await t.test('with no replay running, exitClicked just collapses the stage', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.configure(makeDeps());
    Witness.liveRoundHeader('Round I');

    Witness.exitClicked();

    const classes = document.getElementById('stage-record').classList;
    assert.ok(classes.contains('collapsed'));
    assert.equal(classes.contains('stage-only'), false);
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

    const classes = document.getElementById('stage-record').classList;
    assert.equal(classes.contains('collapsed'), false);
    assert.ok(classes.contains('stage-only'));
  });

  await t.test('collapseStage and reopenStage are mutually exclusive across repeated calls', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.configure(makeDeps());
    const classes = document.getElementById('stage-record').classList;

    Witness.reopenStage();
    assert.ok(classes.contains('stage-only'));
    assert.equal(classes.contains('collapsed'), false);

    Witness.collapseStage();
    assert.ok(classes.contains('collapsed'));
    assert.equal(classes.contains('stage-only'), false);

    Witness.reopenStage();
    assert.ok(classes.contains('stage-only'));
    assert.equal(classes.contains('collapsed'), false);
  });

  await t.test("collapseStage catches up the record's scroll position, which was inert while hidden", t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.configure(makeDeps());
    const recordScroll = document.getElementById('record-scroll');
    // Simulate what a hidden (display:none) element's real layout would be
    // once revealed -- jsdom gives every element scrollHeight 0, which is
    // exactly the "still hidden" case this test needs to distinguish from.
    Object.defineProperty(recordScroll, 'scrollHeight', { value: 640, configurable: true });
    recordScroll.scrollTop = 0;

    Witness.collapseStage();

    assert.equal(recordScroll.scrollTop, 640, 'revealing the record should land on its latest content, not the top');
  });
});

test('the room (#257): dialogue composited onto the scene, replacing the #202 toggle', async t => {
  await t.test(
    'before enableRoom(), everything still renders into the text stage — the unmodified pre-#257 fallback',
    t2 => {
      const { document, module: Witness } = boot(t2);
      Witness.configure(makeDeps());
      Witness.liveSpeech({ speaker: 'Crowley', text: 'A line.', memberId: 'crowley' });

      assert.equal(document.getElementById('stage-pane').classList.contains('room-active'), false);
      assert.ok(document.querySelector('#witness-stage .transcript-entry'));
      assert.equal(document.querySelectorAll('#room-speech-layer .room-speech-card').length, 0);
    }
  );

  await t.test(
    'enableRoom() marks the stage pane active and routes live speech into a member-anchored card, not the text stage',
    t2 => {
      const { document, window, module: Witness } = boot(t2);
      stubScene(window, { crowley: { x: 120, y: 200, visible: true } });
      Witness.configure(makeDeps());
      Witness.enableRoom();

      assert.ok(document.getElementById('stage-pane').classList.contains('room-active'));

      Witness.liveSpeech({ speaker: 'Crowley', text: 'The book is not the point.', memberId: 'crowley' });

      assert.equal(
        document.getElementById('witness-stage').innerHTML,
        '',
        'room mode should not also write into the text stage'
      );
      const card = document.querySelector('#room-speech-layer .room-speech-card');
      assert.ok(card, 'a card should appear in the room layer');
      assert.match(card.querySelector('.speaker-name').textContent, /Crowley/);
      assert.match(card.querySelector('.speech-text').textContent, /not the point/);
      assert.equal(card.style.left, '120px');
      assert.equal(card.style.top, '200px');
    }
  );

  await t.test('a card projected near the top of the room is floored, not left to grow off the top edge', t2 => {
    // Cards grow upward from their anchor (translateY(-100%)) and portraits
    // sit in the upper half of the resting shot -- verified live: a
    // realistic multi-sentence beat anchored near the actual projected y
    // rendered its top lines under the toolbar above the canvas. Manual
    // browser check confirmed the floor below fixes it.
    const { document, window, module: Witness } = boot(t2);
    stubScene(window, { crowley: { x: 100, y: 20, visible: true } });
    Witness.configure(makeDeps());
    Witness.enableRoom();

    Witness.liveSpeech({ speaker: 'Crowley', text: 'Near the top.', memberId: 'crowley' });

    const card = document.querySelector('#room-speech-layer .room-speech-card');
    assert.equal(
      parseInt(card.style.top, 10) >= 150,
      true,
      'a card anchored high on screen should be floored, not left at its raw projected y'
    );
  });

  await t.test("a card hides rather than render off-canvas when the member's seat isn't currently visible", t2 => {
    const { document, window, module: Witness } = boot(t2);
    stubScene(window, { crowley: { x: 50, y: 50, visible: false } });
    Witness.configure(makeDeps());
    Witness.enableRoom();

    Witness.liveSpeech({ speaker: 'Crowley', text: 'Unseen.', memberId: 'crowley' });

    const card = document.querySelector('#room-speech-layer .room-speech-card');
    assert.equal(card.style.display, 'none');
  });

  await t.test(
    'a speaker with no seat to anchor to (e.g. an interjection) reads into the room event strip, not a card',
    t2 => {
      const { document, window, module: Witness } = boot(t2);
      stubScene(window, {});
      Witness.configure(makeDeps());
      Witness.enableRoom();

      Witness.liveSpeech({ speaker: '— a voice from elsewhere —', text: 'A knock.', memberId: null });

      assert.equal(document.querySelectorAll('#room-speech-layer .room-speech-card').length, 0);
      const entry = document.querySelector('#room-events .room-event-entry');
      assert.ok(entry);
      assert.match(entry.textContent, /A knock\./);
    }
  );

  await t.test('liveTypingStart/Set grow the same card liveSpeech later settles, never a second element', t2 => {
    const { document, window, module: Witness } = boot(t2);
    stubScene(window, { crowley: { x: 10, y: 10, visible: true } });
    Witness.configure(makeDeps());
    Witness.enableRoom();

    Witness.liveTypingStart('Crowley', 'crowley');
    let card = document.querySelector('#room-speech-layer .room-speech-card');
    assert.ok(card, 'typing should open a card');
    assert.ok(card.classList.contains('room-card-typing'));

    Witness.liveTypingSet('The book');
    Witness.liveTypingSet('The book is not the point.');
    assert.equal(card.querySelector('.typing-text').textContent, 'The book is not the point.');

    Witness.liveClearTyping();
    Witness.liveSpeech({ speaker: 'Crowley', text: 'The book is not the point.', memberId: 'crowley' });

    assert.equal(
      document.querySelectorAll('#room-speech-layer .room-speech-card').length,
      1,
      'typing and settled states share one card, not two'
    );
    card = document.querySelector('#room-speech-layer .room-speech-card');
    assert.equal(card.classList.contains('room-card-typing'), false);
    assert.match(card.querySelector('.speech-text').textContent, /not the point/);
  });

  await t.test('two seats close together on screen get stacked instead of overlapping', t2 => {
    const { document, window, module: Witness } = boot(t2);
    stubScene(window, {
      crowley: { x: 100, y: 50, visible: true },
      blavatsky: { x: 110, y: 50, visible: true },
    });
    Witness.configure(makeDeps());
    Witness.enableRoom();

    Witness.liveSpeech({ speaker: 'Crowley', text: 'One.', memberId: 'crowley' });
    Witness.liveSpeech({ speaker: 'Blavatsky', text: 'Two.', memberId: 'blavatsky' });

    const tops = [...document.querySelectorAll('#room-speech-layer .room-speech-card')].map(c =>
      parseInt(c.style.top, 10)
    );
    assert.equal(tops.length, 2);
    assert.notEqual(tops[0], tops[1], 'seats projected close together in x should not land at the same y');
  });

  await t.test(
    'round headers read into the room event strip, and liveLull still returns a real, appendable element for the Continue/Let it end controls',
    t2 => {
      const { document, window, module: Witness } = boot(t2);
      stubScene(window, {});
      Witness.configure(makeDeps());
      Witness.enableRoom();

      Witness.liveRoundHeader('First Movement');
      assert.equal(document.querySelectorAll('#room-events .witness-round-header').length, 1);
      assert.equal(document.querySelectorAll('#witness-stage .witness-round-header').length, 0);

      // app.js's awaitLull() appends a live lull's Continue/Let it end buttons
      // directly into whatever liveLull() returns -- it has to be a real node,
      // not a stand-in, wherever it's actually visible.
      const lullEl = Witness.liveLull('The room draws breath.');
      assert.ok(document.querySelectorAll('#room-events .transcript-lull').length, 1);
      const btn = document.createElement('button');
      lullEl.appendChild(btn);
      assert.equal(lullEl.querySelector('button'), btn);
    }
  );

  await t.test(
    'replay composites into the room exactly like live mirroring, and go-back restores a card to its prior turn rather than deleting it',
    async t2 => {
      const { document, window, module: Witness } = boot(t2);
      stubScene(window, { crowley: { x: 10, y: 10, visible: true } });
      Witness.enableRoom();
      await Witness.start(
        {
          rounds: [{ label: 'Round I', text: 'Crowley:\nFirst thing.\n\nCrowley:\nSecond thing.' }],
        },
        makeDeps()
      );
      // start() already rendered block 0 (the header) via its own advance().

      Witness.advance(); // "First thing."
      let card = document.querySelector('#room-speech-layer .room-speech-card');
      assert.match(card.querySelector('.speech-text').textContent, /First thing/);
      assert.equal(document.querySelectorAll('#room-speech-layer .room-speech-card').length, 1);

      Witness.advance(); // "Second thing." -- same card, overwritten in place
      card = document.querySelector('#room-speech-layer .room-speech-card');
      assert.match(card.querySelector('.speech-text').textContent, /Second thing/);
      assert.equal(
        document.querySelectorAll('#room-speech-layer .room-speech-card').length,
        1,
        'still one card, not a second'
      );

      // goBack() isn't part of the public API -- driven the same way the
      // left-arrow key does in the real page.
      window.document.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'ArrowLeft' }));
      card = document.querySelector('#room-speech-layer .room-speech-card');
      assert.match(
        card.querySelector('.speech-text').textContent,
        /First thing/,
        'going back should restore the card to its prior content, not delete it'
      );
    }
  );

  await t.test('exit clears the room the same way it clears the text stage', async t2 => {
    const { document, window, module: Witness } = boot(t2);
    stubScene(window, { crowley: { x: 10, y: 10, visible: true } });
    Witness.enableRoom();
    await Witness.start({ rounds: [{ label: 'Round I', text: 'Crowley:\nA line.' }] }, makeDeps());
    Witness.advance();
    assert.ok(document.querySelector('#room-speech-layer .room-speech-card'));

    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'Escape' }));

    assert.equal(document.getElementById('room-speech-layer').innerHTML, '');
    assert.equal(document.getElementById('room-events').innerHTML, '');
  });
});
