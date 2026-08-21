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
const { labelOpensSegment } = require('../public/js/record.js');

// The elements witness.js reaches for by id. Kept in one place so the drift
// guard below and the fixture can't disagree with each other.
const WITNESS_IDS = [
  'stage-record',
  'stage-pane',
  'witness-hint',
  'witness-speed-btn',
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
      <button id="witness-speed-btn">1×</button>
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

// #287: a member's card is a short-lived stack of .room-card-entry nodes,
// not one overwritten node -- these read the *latest* entry, the one most
// assertions below actually care about, without asserting on the whole
// stack's shape.
function latestEntry(card) {
  return card.querySelector('.room-card-entries').lastElementChild;
}
function latestEntryText(card, selector = '.speech-text') {
  return latestEntry(card)?.querySelector(selector)?.textContent;
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
    // #354: same reasoning -- the real rule, not a stand-in.
    labelOpensSegment,
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

// #336: auto-advance used to pace every speech beat off a fixed WPM guess,
// even when voice was on and the actual utterance/audio ran longer than
// that guess predicted -- cutting a member off mid-sentence. When
// window.Voice.speak() hands back a promise (real speech in flight),
// advance() must wait for it instead of the WPM estimate.
test('replay: auto-advance paces off real speech duration when Voice reports it', async t => {
  // Flushes enough microtask ticks for the promise chain renderWitnessBlock
  // builds (Voice.speak()'s promise -> its own .then() -> advance()'s
  // Promise.resolve(delay).then()) to fully settle once the underlying
  // speech promise resolves.
  async function flushMicrotasks(n = 6) {
    for (let i = 0; i < n; i++) await Promise.resolve();
  }

  await t.test(
    'a beat that talks past the WPM estimate is not cut off — advance waits for Voice.speak() to resolve',
    async t2 => {
      t2.mock.timers.enable({ apis: ['setTimeout'] });
      let resolveSpeech;
      const loaded = loadPublicModule('witness.js', FIXTURE, window => {
        window.Voice = {
          speak: () =>
            new Promise(resolve => {
              resolveSpeech = resolve;
            }),
          stop: () => {},
        };
      });
      t2.after(loaded.cleanup);
      const { document, module: Witness } = loaded;

      await Witness.start({ rounds: [{ label: 'Round I', text: 'Crowley:\nOne.' }] }, makeDeps());
      Witness.advance(); // renders "One." and calls Voice.speak(), whose promise is still pending

      // "One." 's WPM estimate is far under a second, floored at
      // WITNESS_MIN_PAUSE (1200ms) -- if pacing still used that estimate,
      // this tick would already have advanced past the end.
      t2.mock.timers.tick(10000);
      assert.equal(
        document.querySelectorAll('#witness-stage .witness-end').length,
        0,
        'should still be waiting on the unresolved speech promise, not the WPM guess'
      );

      resolveSpeech();
      await flushMicrotasks();
      assert.equal(
        document.querySelectorAll('#witness-stage .witness-end').length,
        0,
        'the post-speech breath has not elapsed yet'
      );

      t2.mock.timers.tick(1200); // WITNESS_MIN_PAUSE at 1x speed
      assert.equal(
        document.querySelector('#witness-stage .witness-end')?.textContent,
        'The room falls silent.',
        'once Voice reports the beat actually finished, advance should proceed'
      );
    }
  );

  await t.test('a beat with voice off paces on the WPM estimate exactly as before', async t2 => {
    t2.mock.timers.enable({ apis: ['setTimeout'] });
    const loaded = loadPublicModule('witness.js', FIXTURE, window => {
      window.Voice = { speak: () => undefined, stop: () => {} }; // disabled/unsupported: no-op, same as no Voice at all
    });
    t2.after(loaded.cleanup);
    const { document, module: Witness } = loaded;

    await Witness.start({ rounds: [{ label: 'Round I', text: 'Crowley:\nOne.' }] }, makeDeps());
    Witness.advance(); // renders "One."
    // advance() schedules the actual setTimeout inside a Promise.resolve()
    // .then() (uniform handling for both a plain ms number and a speech
    // promise, see advance()'s own comment) -- flush that one microtask hop
    // before ticking, or the timer isn't registered yet.
    await flushMicrotasks();

    // "One." floors to WITNESS_MIN_PAUSE (1200ms) -- unchanged WPM pacing.
    t2.mock.timers.tick(1199);
    assert.equal(document.querySelectorAll('#witness-stage .witness-end').length, 0);
    t2.mock.timers.tick(1);
    assert.equal(document.querySelector('#witness-stage .witness-end')?.textContent, 'The room falls silent.');
  });

  await t.test(
    'going back while a speech promise is still pending discards it — no phantom early advance',
    async t2 => {
      t2.mock.timers.enable({ apis: ['setTimeout'] });
      let resolveSpeech;
      const loaded = loadPublicModule('witness.js', FIXTURE, window => {
        window.Voice = {
          speak: () =>
            new Promise(resolve => {
              resolveSpeech = resolve;
            }),
          stop: () => {},
        };
      });
      t2.after(loaded.cleanup);
      const { document, window, module: Witness } = loaded;

      await Witness.start({ rounds: [{ label: 'Round I', text: 'Crowley:\nOne.\n\nBlavatsky:\nTwo.' }] }, makeDeps());
      Witness.advance(); // renders "One." (Crowley), Voice.speak() pending
      window.document.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'ArrowLeft' })); // goBack()
      assert.equal(
        document.querySelectorAll('#witness-stage .transcript-entry').length,
        0,
        'goBack() should have undone the "One." render'
      );

      // "One." 's speech promise finally resolves after the user already
      // stepped back past it. Without the generation guard this would
      // schedule its own setTimeout(advance, ~1200ms) alongside goBack()'s
      // legitimate resume timer (scheduled for 2400ms) -- a phantom advance
      // 1200ms early, re-rendering "One." well before the real resume fires.
      resolveSpeech();
      await flushMicrotasks();

      t2.mock.timers.tick(1200);
      assert.equal(
        document.querySelectorAll('#witness-stage .transcript-entry').length,
        0,
        'the stale promise must not have scheduled an early phantom advance'
      );

      t2.mock.timers.tick(1200); // completes goBack()'s real 2400ms resume pause
      assert.equal(
        document.querySelectorAll('#witness-stage .transcript-entry').length,
        1,
        'the legitimate resume should still fire on its own schedule'
      );
      assert.match(document.querySelector('#witness-stage .speaker-name').textContent, /Crowley/);
    }
  );
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

  // #400: liveSpeech() used to call window.Voice.speak() synchronously and
  // discard whatever promise it returned, so nothing gated a second beat's
  // speak() call on the first beat's audio actually finishing -- voice.js's
  // own speak() interrupts whatever is still playing the instant it's
  // called again, which cut a member off mid-sentence on nearly every beat
  // once live convene started streaming beats faster than anyone could
  // actually talk. liveSpeech's speak() calls must now be serialized.
  await t.test('#400: a second live beat does not speak until the first beat is done', async t2 => {
    async function flushMicrotasks(n = 4) {
      for (let i = 0; i < n; i++) await Promise.resolve();
    }

    const calls = [];
    const resolvers = [];
    const loaded = loadPublicModule('witness.js', FIXTURE, window => {
      window.Voice = {
        speak: text => {
          calls.push(text);
          return new Promise(resolve => resolvers.push(resolve));
        },
        stop: () => {},
      };
    });
    t2.after(loaded.cleanup);
    const { module: Witness } = loaded;
    Witness.configure(makeDeps());

    Witness.liveSpeech({ speaker: 'Crowley', text: 'One.', memberId: 'crowley' });
    Witness.liveSpeech({ speaker: 'Blavatsky', text: 'Two.', memberId: 'blavatsky' });
    await flushMicrotasks();
    assert.deepEqual(calls, ['One.'], 'the second beat must not have spoken while the first is still in flight');

    resolvers[0](); // "One." finishes
    await flushMicrotasks();
    assert.deepEqual(calls, ['One.', 'Two.'], 'once the first beat resolves, the second should start speaking');
  });

  // #400: a beat still queued behind a still-playing one must not start
  // talking after the live session that queued it has already ended (stage
  // reset, or the stage collapsed to show the record) -- resetLiveSpeechQueue
  // (called from clearRoom/collapseStage) must orphan it.
  await t.test(
    '#400: resetting the stage discards a still-queued live beat rather than letting it speak later',
    async t2 => {
      async function flushMicrotasks(n = 4) {
        for (let i = 0; i < n; i++) await Promise.resolve();
      }

      const calls = [];
      const resolvers = [];
      const loaded = loadPublicModule('witness.js', FIXTURE, window => {
        window.Voice = {
          speak: text => {
            calls.push(text);
            return new Promise(resolve => resolvers.push(resolve));
          },
          stop: () => {},
        };
      });
      t2.after(loaded.cleanup);
      const { module: Witness } = loaded;
      Witness.configure(makeDeps());

      Witness.liveSpeech({ speaker: 'Crowley', text: 'One.', memberId: 'crowley' });
      Witness.liveSpeech({ speaker: 'Blavatsky', text: 'Two.', memberId: 'blavatsky' });
      await flushMicrotasks();
      assert.deepEqual(calls, ['One.']);

      Witness.resetLiveStage(); // clears the stage mid-flight, orphaning the queued "Two."
      resolvers[0](); // "One." (already superseded) finishes
      await flushMicrotasks();
      assert.deepEqual(
        calls,
        ['One.'],
        'the queued second beat must not speak into a stage that has already been reset'
      );
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
    assert.ok(latestEntry(card).classList.contains('room-card-entry-typing'));

    Witness.liveTypingSet('The book');
    Witness.liveTypingSet('The book is not the point.');
    assert.equal(latestEntryText(card, '.typing-text'), 'The book is not the point.');

    Witness.liveClearTyping();
    Witness.liveSpeech({ speaker: 'Crowley', text: 'The book is not the point.', memberId: 'crowley' });

    assert.equal(
      document.querySelectorAll('#room-speech-layer .room-speech-card').length,
      1,
      'typing and settled states share one card, not two'
    );
    card = document.querySelector('#room-speech-layer .room-speech-card');
    assert.equal(
      document.querySelectorAll('#room-speech-layer .room-card-entry').length,
      1,
      'the typing entry settles in place -- still one entry, not a second'
    );
    assert.equal(latestEntry(card).classList.contains('room-card-entry-typing'), false);
    assert.match(latestEntryText(card), /not the point/);
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
    'replay composites into the room exactly like live mirroring, and go-back removes the last entry rather than the whole card',
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
      assert.match(latestEntryText(card), /First thing/);
      assert.equal(document.querySelectorAll('#room-speech-layer .room-speech-card').length, 1);
      assert.equal(document.querySelectorAll('#room-speech-layer .room-card-entry').length, 1);

      Witness.advance(); // "Second thing." -- same card, a second entry stacked on top (#287)
      card = document.querySelector('#room-speech-layer .room-speech-card');
      assert.match(latestEntryText(card), /Second thing/);
      assert.equal(
        document.querySelectorAll('#room-speech-layer .room-speech-card').length,
        1,
        'still one card, not a second'
      );
      assert.equal(
        document.querySelectorAll('#room-speech-layer .room-card-entry').length,
        2,
        'the second beat stacks a new entry rather than overwriting the first'
      );

      // goBack() isn't part of the public API -- driven the same way the
      // left-arrow key does in the real page.
      window.document.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'ArrowLeft' }));
      card = document.querySelector('#room-speech-layer .room-speech-card');
      assert.equal(
        document.querySelectorAll('#room-speech-layer .room-card-entry').length,
        1,
        'going back should remove the entry it added, not the whole card'
      );
      assert.match(latestEntryText(card), /First thing/, 'going back should leave the card showing its prior turn');
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

test("scrollback (#287): a member's card is a short-lived stack of recent beats, not just the latest", async t => {
  await t.test('consecutive beats from the same member accumulate as separate entries, oldest first', t2 => {
    t2.mock.timers.enable({ apis: ['setTimeout'] });
    const { document, window, module: Witness } = boot(t2);
    stubScene(window, { crowley: { x: 10, y: 10, visible: true } });
    Witness.configure(makeDeps());
    Witness.enableRoom();

    Witness.liveSpeech({ speaker: 'Crowley', text: 'One.', memberId: 'crowley' });
    t2.mock.timers.tick(1200); // clear #279's per-member reading-time hold between beats
    Witness.liveSpeech({ speaker: 'Crowley', text: 'Two.', memberId: 'crowley' });
    t2.mock.timers.tick(1200);
    Witness.liveSpeech({ speaker: 'Crowley', text: 'Three.', memberId: 'crowley' });

    assert.equal(
      document.querySelectorAll('#room-speech-layer .room-speech-card').length,
      1,
      'three beats from one member still share a single card, not three'
    );
    const card = document.querySelector('#room-speech-layer .room-speech-card');
    const entries = [...document.querySelectorAll('#room-speech-layer .room-card-entry')];
    assert.equal(entries.length, 3, 'three beats should stack as three entries on that card');
    assert.deepEqual(
      entries.map(e => e.querySelector('.speech-text').textContent),
      ['One.', 'Two.', 'Three.'],
      'entries stay in speaking order, oldest first, so scrolling up reads backward through the turn'
    );
    assert.match(
      latestEntryText(card),
      /Three\./,
      'the newest beat is the one left in view without the reader having to scroll'
    );
  });

  await t.test('a typing placeholder settles into a new entry, not a rewrite of the whole stack', t2 => {
    t2.mock.timers.enable({ apis: ['setTimeout'] });
    const { document, window, module: Witness } = boot(t2);
    stubScene(window, { crowley: { x: 10, y: 10, visible: true } });
    Witness.configure(makeDeps());
    Witness.enableRoom();

    Witness.liveSpeech({ speaker: 'Crowley', text: 'One.', memberId: 'crowley' });
    t2.mock.timers.tick(1200);
    Witness.liveTypingStart('Crowley', 'crowley');
    Witness.liveTypingSet('Two');
    Witness.liveClearTyping();
    Witness.liveSpeech({ speaker: 'Crowley', text: 'Two.', memberId: 'crowley' });

    const entries = [...document.querySelectorAll('#room-speech-layer .room-card-entry')];
    assert.equal(entries.length, 2, "the settled typing beat is the stack's second entry, not a third node");
    assert.equal(entries[0].querySelector('.speech-text').textContent, 'One.');
    assert.equal(entries[1].querySelector('.speech-text').textContent, 'Two.');
  });

  await t.test('the whole stack fades together once the newest entry has had its reading time', t2 => {
    t2.mock.timers.enable({ apis: ['setTimeout'] });
    const { document, window, module: Witness } = boot(t2);
    stubScene(window, { crowley: { x: 10, y: 10, visible: true } });
    Witness.configure(makeDeps());
    Witness.enableRoom();

    Witness.liveSpeech({ speaker: 'Crowley', text: 'One.', memberId: 'crowley' });
    t2.mock.timers.tick(1200);
    Witness.liveSpeech({ speaker: 'Crowley', text: 'Two.', memberId: 'crowley' });

    // Fading resets on every new beat (scheduleCardFade), so the two-entry
    // stack should still be intact well past "One."'s own reading time.
    t2.mock.timers.tick(1200);
    assert.ok(
      document.querySelector('#room-speech-layer .room-speech-card'),
      'a new beat should reset the fade clock for the whole stack, not just its own entry'
    );

    // "Two."'s own reading time (WITNESS_MIN_PAUSE) + the fade grace marks
    // the card fading; the fade-out transition then removes it. Two ticks,
    // not one -- the second setTimeout is only scheduled once the first
    // actually fires, so mock timers need a separate tick to reach it.
    t2.mock.timers.tick(1200 + 1500);
    t2.mock.timers.tick(550);
    assert.equal(
      document.querySelectorAll('#room-speech-layer .room-speech-card').length,
      0,
      'once nothing new arrives, the whole stack -- every entry -- fades away together'
    );
  });

  await t.test(
    "a nearby card's stacking offset clears its own rendered height, not a flat guess (regression: two members' stacks bled into each other on screen)",
    t2 => {
      t2.mock.timers.enable({ apis: ['setTimeout'] });
      const { document, window, module: Witness } = boot(t2);
      stubScene(window, {
        crowley: { x: 100, y: 200, visible: true },
        blavatsky: { x: 110, y: 200, visible: true },
      });
      Witness.configure(makeDeps());
      Witness.enableRoom();

      Witness.liveSpeech({ speaker: 'Crowley', text: 'One.', memberId: 'crowley' });
      Witness.liveSpeech({ speaker: 'Blavatsky', text: 'Two.', memberId: 'blavatsky' });

      const [crowleyCard, blavatskyCard] = document.querySelectorAll('#room-speech-layer .room-speech-card');
      // jsdom never lays anything out (every rect comes back zero-height),
      // so stub a realistic stacked-card height -- taller than the old flat
      // 92px offset (style.css's CARD_STACK_OFFSET), the same as a card
      // that has accumulated a few beats really would be.
      blavatskyCard.getBoundingClientRect = () => ({
        height: 260,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        x: 0,
        y: 0,
      });

      // Trigger another reposition pass now that the stub is in place --
      // Crowley's own second beat, clear of its #279 hold, does it for both
      // cards (repositionRoomCards always repositions everything at once).
      t2.mock.timers.tick(1200);
      Witness.liveSpeech({ speaker: 'Crowley', text: 'Three.', memberId: 'crowley' });

      const crowleyTop = parseInt(crowleyCard.style.top, 10);
      const blavatskyTop = parseInt(blavatskyCard.style.top, 10);
      assert.equal(
        blavatskyTop - crowleyTop,
        260,
        "the offset should equal the nearby card's own rendered height, not the old flat 92px guess that let taller stacks overlap"
      );
    }
  );
});

test("room-mode live pacing (#279): a member's card holds long enough to read before the next mutation lands", async t => {
  await t.test(
    'a second beat from the same member is held, not shown, until the first has had its reading time',
    t2 => {
      t2.mock.timers.enable({ apis: ['setTimeout'] });
      const { document, window, module: Witness } = boot(t2);
      stubScene(window, { crowley: { x: 10, y: 10, visible: true } });
      Witness.configure(makeDeps());
      Witness.enableRoom();

      Witness.liveSpeech({ speaker: 'Crowley', text: 'One.', memberId: 'crowley' });
      let card = document.querySelector('#room-speech-layer .room-speech-card');
      assert.match(latestEntryText(card), /One\./);

      Witness.liveSpeech({ speaker: 'Crowley', text: 'Two.', memberId: 'crowley' });
      card = document.querySelector('#room-speech-layer .room-speech-card');
      assert.match(
        latestEntryText(card),
        /One\./,
        'the second beat must not clobber the first before its reading time is up'
      );
      assert.equal(
        document.querySelectorAll('#room-speech-layer .room-card-entry').length,
        1,
        'still one entry, the second beat is held, not appended'
      );

      // WITNESS_MIN_PAUSE -- the reading-time floor for a beat this short.
      t2.mock.timers.tick(1200);
      card = document.querySelector('#room-speech-layer .room-speech-card');
      assert.match(
        latestEntryText(card),
        /Two\./,
        'once the hold elapses, the deferred beat is added as the next entry'
      );
    }
  );

  await t.test(
    'a typing indicator opened right after a beat closes does not clobber the just-shown card mid-hold',
    t2 => {
      t2.mock.timers.enable({ apis: ['setTimeout'] });
      const { document, window, module: Witness } = boot(t2);
      stubScene(window, { crowley: { x: 10, y: 10, visible: true } });
      Witness.configure(makeDeps());
      Witness.enableRoom();

      Witness.liveSpeech({ speaker: 'Crowley', text: 'One.', memberId: 'crowley' });
      // app.js's startStreamEntry opens a fresh typing placeholder in the same
      // synchronous call that just closed a beat -- reproduce that here.
      Witness.liveTypingStart('Crowley', 'crowley');
      let card = document.querySelector('#room-speech-layer .room-speech-card');
      assert.equal(
        document.querySelectorAll('#room-speech-layer .room-card-entry-typing').length,
        0,
        'typing must not overwrite the settled entry before its hold clears'
      );
      assert.match(latestEntryText(card), /One\./);

      // Chunks keep streaming in while the hold is still up -- only the
      // latest text queued behind the deferred typing-start should survive.
      Witness.liveTypingSet('T');
      Witness.liveTypingSet('Two');

      t2.mock.timers.tick(1200);
      card = document.querySelector('#room-speech-layer .room-speech-card');
      assert.equal(
        document.querySelectorAll('#room-speech-layer .room-card-entry-typing').length,
        1,
        'once the hold clears, the deferred typing indicator takes over as the next entry'
      );
      assert.equal(
        latestEntryText(card, '.typing-text'),
        'Two',
        'the latest typing text queued during the hold is applied once it flushes'
      );
    }
  );

  await t.test('a fresher settled beat supersedes a still-queued typing placeholder for the same member', t2 => {
    t2.mock.timers.enable({ apis: ['setTimeout'] });
    const { document, window, module: Witness } = boot(t2);
    stubScene(window, { crowley: { x: 10, y: 10, visible: true } });
    Witness.configure(makeDeps());
    Witness.enableRoom();

    Witness.liveSpeech({ speaker: 'Crowley', text: 'One.', memberId: 'crowley' });
    Witness.liveTypingStart('Crowley', 'crowley'); // queued behind the hold
    Witness.liveSpeech({ speaker: 'Crowley', text: 'Two.', memberId: 'crowley' }); // supersedes it

    t2.mock.timers.tick(1200);
    const card = document.querySelector('#room-speech-layer .room-speech-card');
    assert.equal(
      document.querySelectorAll('#room-speech-layer .room-card-entry-typing').length,
      0,
      'the settled beat wins over the stale typing placeholder queued before it'
    );
    assert.match(latestEntryText(card), /Two\./);
  });

  await t.test('different members are never held back by each other', t2 => {
    const { document, window, module: Witness } = boot(t2);
    stubScene(window, {
      crowley: { x: 10, y: 10, visible: true },
      blavatsky: { x: 200, y: 10, visible: true },
    });
    Witness.configure(makeDeps());
    Witness.enableRoom();

    Witness.liveSpeech({ speaker: 'Crowley', text: 'One.', memberId: 'crowley' });
    Witness.liveSpeech({ speaker: 'Blavatsky', text: 'Two.', memberId: 'blavatsky' });

    const cards = [...document.querySelectorAll('#room-speech-layer .room-speech-card')];
    assert.equal(cards.length, 2, "a hold on one member must not delay another member's own card");
    assert.match(cards[0].querySelector('.speech-text').textContent, /One\./);
    assert.match(cards[1].querySelector('.speech-text').textContent, /Two\./);
  });

  await t.test('stage mode (no scene) is unpaced -- it already has scrollback, unlike the room', t2 => {
    const { document, module: Witness } = boot(t2);
    Witness.configure(makeDeps());

    Witness.liveSpeech({ speaker: 'Crowley', text: 'One.', memberId: 'crowley' });
    Witness.liveSpeech({ speaker: 'Crowley', text: 'Two.', memberId: 'crowley' });

    assert.equal(
      document.querySelectorAll('#witness-stage .transcript-entry').length,
      2,
      'both beats append immediately in the stage fallback'
    );
  });
});

test('playback speed (#288): one multiplier reaches room-mode holds, replay, and the old stage alike', async t => {
  await t.test('defaults to 1x, cycles through the preset speeds, and persists the choice', t2 => {
    const { document, window, module: Witness } = boot(t2);
    const btn = () => document.getElementById('witness-speed-btn').textContent;

    assert.equal(btn(), '1×');

    Witness.cycleSpeed();
    assert.equal(btn(), '1.5×');
    assert.equal(window.localStorage.getItem('sc-witness-speed'), '1.5');

    Witness.cycleSpeed();
    assert.equal(btn(), '2×');
    Witness.cycleSpeed();
    assert.equal(btn(), '0.75×', 'cycling past the fastest preset wraps to the slowest');
    Witness.cycleSpeed();
    assert.equal(btn(), '1×', 'and back to the default completes the cycle');
  });

  await t.test('a speed persisted from a prior session is honored on the next load', t2 => {
    const { document } = boot2WithSpeed(t2, '2');
    assert.equal(document.getElementById('witness-speed-btn').textContent, '2×');
  });

  await t.test('an invalid persisted value falls back to 1x rather than breaking pacing', t2 => {
    const { document } = boot2WithSpeed(t2, 'not-a-number');
    assert.equal(document.getElementById('witness-speed-btn').textContent, '1×');
  });

  function boot2WithSpeed(t2, storedValue) {
    const loaded = loadPublicModule('witness.js', FIXTURE, window => {
      window.localStorage.setItem('sc-witness-speed', storedValue);
    });
    t2.after(loaded.cleanup);
    return loaded;
  }

  await t.test("2x halves a room card's #279 reading hold", t2 => {
    t2.mock.timers.enable({ apis: ['setTimeout'] });
    const { document, window, module: Witness } = boot(t2);
    stubScene(window, { crowley: { x: 10, y: 10, visible: true } });
    Witness.configure(makeDeps());
    Witness.enableRoom();
    Witness.cycleSpeed(); // 1x -> 1.5x
    Witness.cycleSpeed(); // 1.5x -> 2x

    Witness.liveSpeech({ speaker: 'Crowley', text: 'One.', memberId: 'crowley' });
    Witness.liveSpeech({ speaker: 'Crowley', text: 'Two.', memberId: 'crowley' });

    // At 1x this hold is WITNESS_MIN_PAUSE (1200ms, see the #279 tests above);
    // at 2x it should flush at half that.
    t2.mock.timers.tick(600);
    const card = document.querySelector('#room-speech-layer .room-speech-card');
    assert.match(latestEntryText(card), /Two\./, 'the hold should already have cleared at twice the speed');
  });

  await t.test("0.75x slows replay's header pause proportionally", async t2 => {
    t2.mock.timers.enable({ apis: ['setTimeout'] });
    const { document, module: Witness } = boot(t2);
    Witness.cycleSpeed(); // 1x -> 1.5x
    Witness.cycleSpeed(); // 1.5x -> 2x
    Witness.cycleSpeed(); // 2x -> 0.75x

    await Witness.start({ rounds: [{ label: 'Round I', text: 'Crowley:\nA line.' }] }, makeDeps());
    // advance() has already rendered the header block synchronously and
    // scheduled the next advance after WITNESS_PAUSE_AFTER_HEADER / 0.75.
    // At full speed (1800ms) the speech block would not yet be rendered at
    // 1800ms; at 0.75x (2400ms) it should still be pending here.
    t2.mock.timers.tick(1800);
    assert.equal(
      document.querySelectorAll('#witness-stage .transcript-entry').length,
      0,
      'the slowed-down header pause should not have elapsed yet'
    );
    t2.mock.timers.tick(600); // completes the full 2400ms
    assert.equal(document.querySelectorAll('#witness-stage .transcript-entry').length, 1);
  });
});
