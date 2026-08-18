'use strict';

// #29 -- browser TTS for Witness playback. voice.js has no DOM dependency of
// its own beyond the optional toggle button (updateButton is a no-op if it's
// absent) and no deps bag (unlike witness.js's siblings): everything it
// needs is either passed as an argument or read off the platform's own
// SpeechSynthesis API, which jsdom doesn't implement -- so these tests stub
// it exactly the way witness.test.js stubs window.LodgeScene for a platform
// surface jsdom has no equivalent of.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadPublicModule } = require('./helpers/dom.js');

const FIXTURE = `<button id="witness-voice-btn"></button>`;

// Records cancel()/speak() calls in order, so tests can assert the
// cancel-before-speak invariant voice.js's own comment describes, not just
// the end state. `voices` seeds getVoices() -- left empty to simulate a
// browser with no SpeechSynthesis at all.
function stubSpeech(window, voices) {
  class FakeUtterance {
    constructor(text) {
      this.text = text;
    }
  }
  window.SpeechSynthesisUtterance = FakeUtterance;
  const events = [];
  window.speechSynthesis = {
    getVoices: () => voices,
    speak(u) {
      events.push({ type: 'speak', utterance: u });
    },
    cancel() {
      events.push({ type: 'cancel' });
    },
    addEventListener() {},
  };
  return events;
}

test('voice.js', async t => {
  await t.test('adds exactly one global to window', t2 => {
    const loaded = loadPublicModule('voice.js');
    t2.after(loaded.cleanup);
    assert.deepEqual(loaded.globalsAdded, ['Voice']);
  });

  await t.test('is loaded by index.html, before witness.js (its only caller)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const voiceIdx = html.indexOf('<script src="js/voice.js">');
    const witnessIdx = html.indexOf('<script src="js/witness.js">');
    assert.ok(voiceIdx >= 0, 'voice.js should be loaded');
    assert.ok(voiceIdx < witnessIdx, 'voice.js should load before witness.js');
  });

  await t.test('without SpeechSynthesis support: isSupported() is false and speak()/stop() are safe no-ops', t2 => {
    const loaded = loadPublicModule('voice.js', FIXTURE);
    t2.after(loaded.cleanup);
    const { Voice } = loaded.window;
    assert.equal(Voice.isSupported(), false);
    assert.doesNotThrow(() => Voice.speak('hello', 'crowley', 1));
    assert.doesNotThrow(() => Voice.stop());
    // The button should be hidden entirely rather than offered and inert.
    assert.equal(loaded.document.getElementById('witness-voice-btn').style.display, 'none');
  });

  await t.test(
    'setEnabled(true) still flips isEnabled() even without support (harmless: speak() stays a no-op)',
    t2 => {
      const loaded = loadPublicModule('voice.js', FIXTURE);
      t2.after(loaded.cleanup);
      const { Voice } = loaded.window;
      assert.equal(Voice.isEnabled(), false);
      Voice.setEnabled(true);
      assert.equal(Voice.isEnabled(), true);
    }
  );

  await t.test('with SpeechSynthesis stubbed: disabled by default, toggle() flips and persists it', t2 => {
    const loaded = loadPublicModule('voice.js', FIXTURE, window => stubSpeech(window, [{ name: 'A', lang: 'en-US' }]));
    t2.after(loaded.cleanup);
    const { Voice, document, localStorage } = loaded.window;
    assert.equal(Voice.isSupported(), true);
    assert.equal(Voice.isEnabled(), false);
    assert.equal(document.getElementById('witness-voice-btn').textContent, '🔈 Voice');

    Voice.toggle();
    assert.equal(Voice.isEnabled(), true);
    assert.equal(localStorage.getItem('sc-witness-voice-enabled'), '1');
    assert.equal(document.getElementById('witness-voice-btn').textContent, '🔊 Voice');
    assert.ok(document.getElementById('witness-voice-btn').classList.contains('voice-on'));

    Voice.toggle();
    assert.equal(Voice.isEnabled(), false);
    assert.equal(localStorage.getItem('sc-witness-voice-enabled'), '0');
  });

  await t.test('a prior enabled choice is honored on the next load', t2 => {
    const loaded = loadPublicModule('voice.js', FIXTURE, window => {
      stubSpeech(window, [{ name: 'A', lang: 'en-US' }]);
      window.localStorage.setItem('sc-witness-voice-enabled', '1');
    });
    t2.after(loaded.cleanup);
    assert.equal(loaded.window.Voice.isEnabled(), true);
  });

  await t.test('speak() while disabled does nothing', t2 => {
    const events = [];
    const loaded = loadPublicModule('voice.js', FIXTURE, window => {
      events.push(...stubSpeech(window, [{ name: 'A', lang: 'en-US' }]));
    });
    t2.after(loaded.cleanup);
    loaded.window.Voice.speak('hello', 'crowley', 1);
    assert.deepEqual(events, []);
  });

  await t.test('speak() while enabled: cancels any utterance in flight, then speaks the stripped text', t2 => {
    let events;
    const loaded = loadPublicModule('voice.js', FIXTURE, window => {
      events = stubSpeech(window, [{ name: 'A', lang: 'en-US' }]);
    });
    t2.after(loaded.cleanup);
    const { Voice } = loaded.window;
    Voice.setEnabled(true);

    Voice.speak('Hello, *waves warmly* how are you?', 'crowley', 1);

    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'cancel', 'cancel runs before the new utterance is queued');
    assert.equal(events[1].type, 'speak');
    assert.equal(
      events[1].utterance.text,
      'Hello, waves warmly how are you?',
      'action-line asterisks are stripped so they are never read aloud'
    );
  });

  await t.test('speak() is a no-op for text that is only action markup once stripped', t2 => {
    let events;
    const loaded = loadPublicModule('voice.js', FIXTURE, window => {
      events = stubSpeech(window, [{ name: 'A', lang: 'en-US' }]);
    });
    t2.after(loaded.cleanup);
    loaded.window.Voice.setEnabled(true);
    loaded.window.Voice.speak('   ', 'crowley', 1);
    assert.deepEqual(events, []);
  });

  await t.test('voice/pitch/rate assignment is deterministic per member', t2 => {
    let events;
    const loaded = loadPublicModule('voice.js', FIXTURE, window => {
      events = stubSpeech(window, [
        { name: 'A', lang: 'en-US' },
        { name: 'B', lang: 'en-GB' },
        { name: 'C', lang: 'en-AU' },
      ]);
    });
    t2.after(loaded.cleanup);
    const { Voice } = loaded.window;
    Voice.setEnabled(true);

    Voice.speak('First turn.', 'crowley', 1);
    const first = events[1].utterance;
    Voice.speak('Second turn.', 'crowley', 1);
    const second = events[3].utterance;

    assert.equal(first.voice, second.voice, 'the same member should always resolve to the same voice');
    assert.equal(first.pitch, second.pitch);
    assert.equal(first.rate, second.rate);
    assert.ok(first.pitch >= 0.8 && first.pitch < 1.2, 'pitch stays in the documented range');
  });

  await t.test('rate scales with the passed speed multiplier, clamped to stay intelligible', t2 => {
    let events;
    const loaded = loadPublicModule('voice.js', FIXTURE, window => {
      events = stubSpeech(window, [{ name: 'A', lang: 'en-US' }]);
    });
    t2.after(loaded.cleanup);
    const { Voice } = loaded.window;
    Voice.setEnabled(true);

    Voice.speak('Turn one.', 'crowley', 1);
    const slow = events[1].utterance.rate;
    Voice.speak('Turn two.', 'crowley', 100); // an absurd multiplier should clamp, not misbehave
    const fast = events[3].utterance.rate;

    assert.ok(fast > slow);
    assert.ok(fast <= 3, 'rate is clamped to a sane maximum regardless of the multiplier passed in');
  });

  await t.test('stop() cancels any utterance in flight', t2 => {
    let events;
    const loaded = loadPublicModule('voice.js', FIXTURE, window => {
      events = stubSpeech(window, [{ name: 'A', lang: 'en-US' }]);
    });
    t2.after(loaded.cleanup);
    loaded.window.Voice.stop();
    assert.deepEqual(events, [{ type: 'cancel' }]);
  });

  await t.test('setEnabled(false) also cancels any utterance in flight', t2 => {
    let events;
    const loaded = loadPublicModule('voice.js', FIXTURE, window => {
      events = stubSpeech(window, [{ name: 'A', lang: 'en-US' }]);
    });
    t2.after(loaded.cleanup);
    const { Voice } = loaded.window;
    Voice.setEnabled(true);
    Voice.speak('Talking.', 'crowley', 1);
    Voice.setEnabled(false);
    assert.equal(events[events.length - 1].type, 'cancel');
  });
});
