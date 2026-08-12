'use strict';

// #219: a turn currently renders as one bubble no matter how long it runs —
// which the issue's 2026-08-11 scoping comment diagnosed as the actual
// driver of "reads like two essays," separate from and prior to any
// prompt/tone tuning. This splits one turn's text into the sequence of
// bubbles it should render as, at natural pause points: a turn's own
// sanctioned pause (a single line break — see pipeline.js's
// stripInternalBlankLines, which guarantees a *settled* turn has no blank
// lines, only single ones) first, falling back to sentence boundaries only
// for a single line that alone overruns the threshold — most real turns are
// one continuous line with no internal breaks at all, so the sentence
// fallback is the common path in practice, not an edge case.
//
// Lives here rather than inline in pipeline.js because it has to run in the
// browser: app.js needs it live, mid-stream, to decide when to close the
// current bubble and open the next one for the same speaker, and witness.js
// needs the identical decision when replaying a stored turn's full text.
// public/ has no bundler, so a function only pipeline.js could require()
// would be invisible to either. One definition, loadable both ways:
// pipeline.js requires this file and re-exports it (so it's tested the same
// way as pipeline.js's other pure functions — see test/pipeline.test.js),
// and index.html loads it as a plain <script>, exposing window.Beats the
// same way scene.js/witness.js/export.js/sessions.js/casting.js expose
// their own single window.X (#142's convention).
const Beats = (function () {
  // Word count at which the *next* available pause point closes the
  // current beat. Low enough that even a moderate turn reliably produces
  // more than one bubble (the point of this issue), high enough that
  // ordinary short sentences don't get chopped mid-thought. A tuning
  // constant, not a derived value — expect this to move once real convenes
  // are read against it, same spirit as CROWDED_WORDS_PER_VOICE.
  const BEAT_WORD_THRESHOLD = 40;

  function countWords(text) {
    const trimmed = text.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }

  // Splits `text` — a turn's full text, whether a live buffer-so-far or
  // already settled — into an array of beat strings. A blank line is not a
  // valid boundary here (a settled turn never has one; see
  // stripInternalBlankLines) and is silently dropped, the same treatment
  // stripInternalBlankLines already gives it.
  //
  // Left-to-right and stable: once a beat closes it is never revisited or
  // rewritten by more text arriving after it, only the trailing (still
  // open) beat grows — which is what lets app.js call this on every
  // streamed chunk and treat every beat but the last as settled.
  function splitIntoBeats(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return [];

    const lines = trimmed
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    const beats = [];
    let current = '';
    let currentWords = 0;

    const closeBeat = () => {
      if (current) beats.push(current);
      current = '';
      currentWords = 0;
    };

    const appendToBeat = (segment, separator) => {
      current = current ? `${current}${separator}${segment}` : segment;
      currentWords += countWords(segment);
    };

    lines.forEach(line => {
      if (currentWords >= BEAT_WORD_THRESHOLD) closeBeat();

      const words = countWords(line);
      if (words <= BEAT_WORD_THRESHOLD) {
        appendToBeat(line, '\n');
        return;
      }

      // This single line alone overruns the threshold — no pause arrives
      // soon enough on its own, so fall back to sentence boundaries within
      // it rather than let one dense paragraph become one giant bubble.
      const sentences = (line.match(/[^.!?]+(?:[.!?]+|$)/g) || [line]).map(s => s.trim()).filter(Boolean);
      sentences.forEach((sentence, i) => {
        if (currentWords >= BEAT_WORD_THRESHOLD) closeBeat();
        appendToBeat(sentence, i === 0 ? '\n' : ' ');
      });
    });
    closeBeat();

    return beats;
  }

  return { splitIntoBeats, BEAT_WORD_THRESHOLD };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Beats;
} else {
  window.Beats = Beats;
}
