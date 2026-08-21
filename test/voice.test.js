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
      '#373: an inline aside is syntactically identical to inline keyword text (e.g. *stabilitas loci*), which must be spoken, not silently dropped -- only whole-line action blocks are stripped now'
    );
  });

  await t.test('speak() keeps inline keyword/emphasis text, dropping only the asterisks (#373)', t2 => {
    let events;
    const loaded = loadPublicModule('voice.js', FIXTURE, window => {
      events = stubSpeech(window, [{ name: 'A', lang: 'en-US' }]);
    });
    t2.after(loaded.cleanup);
    loaded.window.Voice.setEnabled(true);
    loaded.window.Voice.speak("The room falls quiet at *stabilitas loci*, then *'asabiyya'*.", 'crowley', 1);
    assert.equal(events[1].utterance.text, "The room falls quiet at stabilitas loci, then 'asabiyya'.");
  });

  await t.test('speak() is a no-op for text that is only a whole-line action block once stripped', t2 => {
    let events;
    const loaded = loadPublicModule('voice.js', FIXTURE, window => {
      events = stubSpeech(window, [{ name: 'A', lang: 'en-US' }]);
    });
    t2.after(loaded.cleanup);
    loaded.window.Voice.setEnabled(true);
    loaded.window.Voice.speak('*paces silently, considering*', 'crowley', 1);
    assert.deepEqual(events, []);
  });

  await t.test('speak() drops a whole-line action block but keeps other lines of the same beat', t2 => {
    let events;
    const loaded = loadPublicModule('voice.js', FIXTURE, window => {
      events = stubSpeech(window, [{ name: 'A', lang: 'en-US' }]);
    });
    t2.after(loaded.cleanup);
    loaded.window.Voice.setEnabled(true);
    loaded.window.Voice.speak('*paces silently, considering*\nThe answer, I think, is no.', 'crowley', 1);
    assert.equal(events[1].utterance.text, 'The answer, I think, is no.');
  });

  await t.test('speak() is a no-op for text that is only whitespace', t2 => {
    let events;
    const loaded = loadPublicModule('voice.js', FIXTURE, window => {
      events = stubSpeech(window, [{ name: 'A', lang: 'en-US' }]);
    });
    t2.after(loaded.cleanup);
    loaded.window.Voice.setEnabled(true);
    loaded.window.Voice.speak('   ', 'crowley', 1);
    assert.deepEqual(events, []);
  });

  await t.test('a mid-sentence asterisk span keeps its words, with just the asterisks removed (#373)', t2 => {
    let events;
    const loaded = loadPublicModule('voice.js', FIXTURE, window => {
      events = stubSpeech(window, [{ name: 'A', lang: 'en-US' }]);
    });
    t2.after(loaded.cleanup);
    loaded.window.Voice.setEnabled(true);
    loaded.window.Voice.speak('The beast *pauses thoughtfully* stirs at last.', 'crowley', 1);
    assert.equal(events[1].utterance.text, 'The beast pauses thoughtfully stirs at last.');
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

  // #333 -- gender-aware voice selection for the Web Speech path.
  await t.test('speak() with a gender narrows voiceForMember to name-matching voices', t2 => {
    let events;
    const loaded = loadPublicModule('voice.js', FIXTURE, window => {
      events = stubSpeech(window, [
        { name: 'Google UK English Female', lang: 'en-GB' },
        { name: 'Google US English Male', lang: 'en-US' },
        { name: 'Samantha', lang: 'en-US' }, // known-name lookup: female
        { name: 'Daniel', lang: 'en-GB' }, // known-name lookup: male
      ]);
    });
    t2.after(loaded.cleanup);
    const { Voice } = loaded.window;
    Voice.setEnabled(true);

    const FEMALE_NAMES = new Set(['Google UK English Female', 'Samantha']);
    const MALE_NAMES = new Set(['Google US English Male', 'Daniel']);

    Voice.speak('Hello.', 'blavatsky', 1, 'female');
    assert.ok(FEMALE_NAMES.has(events[1].utterance.voice.name), 'expected a female-recognized voice');

    Voice.speak('Hello.', 'crowley', 1, 'male');
    assert.ok(MALE_NAMES.has(events[3].utterance.voice.name), 'expected a male-recognized voice');
  });

  await t.test('speak() without a gender is unaffected — same voice pool as before #333', t2 => {
    let events;
    const loaded = loadPublicModule('voice.js', FIXTURE, window => {
      events = stubSpeech(window, [
        { name: 'A', lang: 'en-US' },
        { name: 'B', lang: 'en-GB' },
      ]);
    });
    t2.after(loaded.cleanup);
    const { Voice } = loaded.window;
    Voice.setEnabled(true);

    Voice.speak('First turn.', 'crowley', 1);
    const withoutGender = events[1].utterance.voice;
    Voice.speak('Second turn.', 'crowley', 1, undefined);
    const explicitlyUndefined = events[3].utterance.voice;
    assert.equal(withoutGender, explicitlyUndefined);
  });

  await t.test('speak() falls back to the full voice list when no voice matches the given gender', t2 => {
    let events;
    const loaded = loadPublicModule('voice.js', FIXTURE, window => {
      events = stubSpeech(window, [
        { name: 'A', lang: 'en-US' }, // no recognizable gender in either name
        { name: 'B', lang: 'en-GB' },
      ]);
    });
    t2.after(loaded.cleanup);
    const { Voice } = loaded.window;
    Voice.setEnabled(true);

    assert.doesNotThrow(() => Voice.speak('Hello.', 'crowley', 1, 'female'));
    assert.ok(events[1].utterance.voice, 'expected a voice to still be assigned from the full list');
  });

  // #338 -- demeanor-aware pitch/rate bias for the Web Speech path.
  await t.test('speak() with a demeanor biases pitch/rate deterministically, without changing the chosen voice', t2 => {
    let events;
    const loaded = loadPublicModule('voice.js', FIXTURE, window => {
      events = stubSpeech(window, [
        { name: 'A', lang: 'en-US' },
        { name: 'B', lang: 'en-GB' },
      ]);
    });
    t2.after(loaded.cleanup);
    const { Voice } = loaded.window;
    Voice.setEnabled(true);

    Voice.speak('Hello.', 'crowley', 1);
    const baseline = events[1].utterance;
    Voice.speak('Hello.', 'crowley', 1, undefined, 'intense');
    const intense = events[3].utterance;
    Voice.speak('Hello.', 'crowley', 1, undefined, 'stately');
    const stately = events[5].utterance;

    assert.equal(intense.voice, baseline.voice, 'demeanor does not affect which voice is picked');
    assert.equal(stately.voice, baseline.voice);
    assert.ok(intense.pitch > baseline.pitch, 'intense reads higher than the unbiased baseline');
    assert.ok(intense.rate > baseline.rate, 'intense reads faster than the unbiased baseline');
    assert.ok(stately.pitch < baseline.pitch, 'stately reads lower than the unbiased baseline');
    assert.ok(stately.rate < baseline.rate, 'stately reads slower than the unbiased baseline');
  });

  await t.test('speak() is deterministic per member for a given demeanor', t2 => {
    let events;
    const loaded = loadPublicModule('voice.js', FIXTURE, window => {
      events = stubSpeech(window, [{ name: 'A', lang: 'en-US' }]);
    });
    t2.after(loaded.cleanup);
    const { Voice } = loaded.window;
    Voice.setEnabled(true);

    Voice.speak('First turn.', 'crowley', 1, undefined, 'intense');
    const first = events[1].utterance;
    Voice.speak('Second turn.', 'crowley', 1, undefined, 'intense');
    const second = events[3].utterance;
    assert.equal(first.pitch, second.pitch);
    assert.equal(first.rate, second.rate);
  });

  await t.test(
    "speak() with 'grounded' or no demeanor produce identical pitch/rate -- grounded is the pre-#338 baseline",
    t2 => {
      let events;
      const loaded = loadPublicModule('voice.js', FIXTURE, window => {
        events = stubSpeech(window, [{ name: 'A', lang: 'en-US' }]);
      });
      t2.after(loaded.cleanup);
      const { Voice } = loaded.window;
      Voice.setEnabled(true);

      Voice.speak('Hello.', 'crowley', 1);
      const withoutDemeanor = events[1].utterance;
      Voice.speak('Hello.', 'crowley', 1, undefined, 'grounded');
      const grounded = events[3].utterance;
      assert.equal(withoutDemeanor.pitch, grounded.pitch);
      assert.equal(withoutDemeanor.rate, grounded.rate);
    }
  );

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

  // ── ElevenLabs path (#29 second pass) ─────────────────────────────────────
  // jsdom has no `fetch` (verified: `typeof window.fetch === 'undefined'`),
  // so every test above never touches this path at all -- it's the
  // untouched Web Speech behavior the first pass shipped. These tests stub
  // `fetch`/`Audio`/`URL.createObjectURL` explicitly to exercise the new
  // path on its own, the way stubSpeech does for SpeechSynthesis.
  function stubElevenLabs(window, { configAvailable = true, speakImpl } = {}) {
    const events = [];
    window.fetch = (url, opts) => {
      if (url === '/api/voice/config') {
        events.push({ type: 'config-check' });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ available: configAvailable }) });
      }
      if (url === '/api/voice/speak') {
        events.push({ type: 'speak-request', body: JSON.parse(opts.body) });
        return speakImpl ? speakImpl() : Promise.resolve({ ok: true, blob: () => Promise.resolve('fake-blob') });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    };
    window.URL.createObjectURL = () => 'blob:fake';
    window.URL.revokeObjectURL = () => {};
    class FakeAudio {
      constructor() {
        events.push({ type: 'audio-construct' });
      }
      // #400: a plain field assignment (audio.playbackRate = x) can't be
      // intercepted without an explicit accessor -- add one so tests can
      // observe what speakViaElevenLabs sets it to.
      set playbackRate(v) {
        this._playbackRate = v;
        events.push({ type: 'playbackRate-set', value: v });
      }
      get playbackRate() {
        return this._playbackRate;
      }
      play() {
        events.push({ type: 'audio-play', src: this.src });
        return Promise.resolve();
      }
      pause() {
        events.push({ type: 'audio-pause' });
      }
      addEventListener() {}
    }
    window.Audio = FakeAudio;
    return events;
  }

  // Flushes the microtask queue enough times for a chain of resolved
  // promises (config check, then the speak request, then its .blob()) to
  // settle -- voice.js's ElevenLabs path is async throughout, unlike the
  // synchronous Web Speech path the rest of this file tests.
  async function flushMicrotasks(n = 5) {
    for (let i = 0; i < n; i++) await Promise.resolve();
  }

  await t.test('when ElevenLabs is available, speak() posts to /api/voice/speak and plays the result', async t2 => {
    let events;
    const loaded = loadPublicModule('voice.js', FIXTURE, window => {
      stubSpeech(window, [{ name: 'A', lang: 'en-US' }]); // still present, but should go unused
      // Must be stubbed before the module evaluates -- its startup
      // config-check reads window.fetch at load time, not lazily.
      events = stubElevenLabs(window);
    });
    t2.after(loaded.cleanup);
    await flushMicrotasks(); // let the module's startup config-check resolve

    loaded.window.Voice.setEnabled(true);
    loaded.window.Voice.speak('Hello, *waves* there.', 'crowley', 1);
    await flushMicrotasks();

    const speakEvent = events.find(e => e.type === 'speak-request');
    assert.ok(speakEvent, 'expected a POST to /api/voice/speak');
    assert.deepEqual(speakEvent.body, { memberId: 'crowley', text: 'Hello, waves there.' });
    assert.ok(
      events.some(e => e.type === 'audio-play'),
      'expected the resolved audio to be played'
    );
  });

  await t.test(
    'when ElevenLabs is unavailable (no server key), speak() uses the Web Speech path unchanged',
    async t2 => {
      let speechEvents;
      let elevenLabsEvents;
      const loaded = loadPublicModule('voice.js', FIXTURE, window => {
        speechEvents = stubSpeech(window, [{ name: 'A', lang: 'en-US' }]);
        elevenLabsEvents = stubElevenLabs(window, { configAvailable: false });
      });
      t2.after(loaded.cleanup);
      await flushMicrotasks();

      loaded.window.Voice.setEnabled(true);
      loaded.window.Voice.speak('Hello there.', 'crowley', 1);

      assert.deepEqual(
        elevenLabsEvents.filter(e => e.type === 'speak-request'),
        [],
        'no ElevenLabs request should be made when the server reports it unavailable'
      );
      assert.ok(
        speechEvents.some(e => e.type === 'speak'),
        'expected the Web Speech fallback to have spoken'
      );
    }
  );

  await t.test('a failed ElevenLabs request falls back to Web Speech for that beat', async t2 => {
    let speechEvents;
    const loaded = loadPublicModule('voice.js', FIXTURE, window => {
      speechEvents = stubSpeech(window, [{ name: 'A', lang: 'en-US' }]);
      stubElevenLabs(window, { speakImpl: () => Promise.reject(new Error('network down')) });
    });
    t2.after(loaded.cleanup);
    await flushMicrotasks();

    loaded.window.Voice.setEnabled(true);
    loaded.window.Voice.speak('Hello there.', 'crowley', 1);
    await flushMicrotasks();

    assert.ok(
      speechEvents.some(e => e.type === 'speak'),
      'expected the Web Speech fallback to have spoken after the ElevenLabs request failed'
    );
  });

  await t.test(
    '#338 memberDemeanor still reaches the Web Speech fallback after a failed ElevenLabs request',
    async t2 => {
      let speechEvents;
      const loaded = loadPublicModule('voice.js', FIXTURE, window => {
        speechEvents = stubSpeech(window, [{ name: 'A', lang: 'en-US' }]);
        stubElevenLabs(window, { speakImpl: () => Promise.reject(new Error('network down')) });
      });
      t2.after(loaded.cleanup);
      await flushMicrotasks();

      loaded.window.Voice.setEnabled(true);
      loaded.window.Voice.speak('Hello there.', 'crowley', 1, undefined, 'intense');
      await flushMicrotasks();

      const spoken = speechEvents.find(e => e.type === 'speak');
      assert.ok(spoken, 'expected the Web Speech fallback to have spoken');
      assert.ok(spoken.utterance.pitch > 1.0, 'expected the intense demeanor bias to still apply on the fallback path');
    }
  );

  await t.test('stop() pauses any ElevenLabs audio in flight', async t2 => {
    let events;
    const loaded = loadPublicModule('voice.js', FIXTURE, window => {
      stubSpeech(window, [{ name: 'A', lang: 'en-US' }]);
      events = stubElevenLabs(window);
    });
    t2.after(loaded.cleanup);
    await flushMicrotasks();

    loaded.window.Voice.setEnabled(true);
    loaded.window.Voice.speak('Hello there.', 'crowley', 1);
    await flushMicrotasks();
    loaded.window.Voice.stop();

    assert.ok(
      events.some(e => e.type === 'audio-pause'),
      'expected stop() to pause the playing audio'
    );
  });

  // #400: the witness-speed multiplier (speedMultiplier) used to reach only
  // speakViaWebSpeech's utterance.rate -- the ElevenLabs <audio> element has
  // its own separate playbackRate that nothing set, so the speed control
  // silently never affected the voices most sessions actually hear.
  await t.test(
    '#400: playbackRate is set from the speed multiplier, so the speed control actually affects ElevenLabs audio',
    async t2 => {
      let events;
      const loaded = loadPublicModule('voice.js', FIXTURE, window => {
        stubSpeech(window, [{ name: 'A', lang: 'en-US' }]);
        events = stubElevenLabs(window);
      });
      t2.after(loaded.cleanup);
      await flushMicrotasks();

      loaded.window.Voice.setEnabled(true);
      loaded.window.Voice.speak('Hello there.', 'crowley', 1.5);
      await flushMicrotasks();

      const rateEvent = events.find(e => e.type === 'playbackRate-set');
      assert.ok(rateEvent, 'expected audio.playbackRate to be set');
      assert.equal(rateEvent.value, 1.5);
    }
  );

  await t.test(
    '#400: an absurd speed multiplier clamps ElevenLabs playbackRate, same as the Web Speech rate',
    async t2 => {
      let events;
      const loaded = loadPublicModule('voice.js', FIXTURE, window => {
        stubSpeech(window, [{ name: 'A', lang: 'en-US' }]);
        events = stubElevenLabs(window);
      });
      t2.after(loaded.cleanup);
      await flushMicrotasks();

      loaded.window.Voice.setEnabled(true);
      loaded.window.Voice.speak('Hello there.', 'crowley', 100);
      await flushMicrotasks();

      const rateEvent = events.find(e => e.type === 'playbackRate-set');
      assert.equal(rateEvent.value, 3, 'clamped to the same sane maximum the Web Speech rate uses');
    }
  );
});
