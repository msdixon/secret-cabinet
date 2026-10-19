'use strict';

// Shared fixtures for the multi-member runRound tests (splinter, confessional).

const LODGE = 'THE LODGE CONTEXT';

// Temporarily replaces the global Math.random with a scripted sequence,
// falling back to 0.5 once the script runs out — pickNextSpeaker and
// shouldSplinter both default to Math.random and runRound doesn't expose
// either as an injectable rng, so this is the only way to make a
// multi-member runRound integration test deterministic. Every other
// runRound fixture in this file sidesteps the question with a one-member
// roster (SINGLE_MEMBER_ROSTER); a splinter needs two.
function withScriptedRandom(values, fn) {
  const original = Math.random;
  let i = 0;
  Math.random = () => (i < values.length ? values[i++] : 0.5);
  return fn().finally(() => {
    Math.random = original;
  });
}

const SPLINTER_ROSTER = [
  { id: 'crowley', name: 'Crowley', file: 'crowley.md' },
  { id: 'scholem', name: 'Scholem', file: 'scholem.md' },
];
const loadSplinterMemberFile = () => 'A character file.';

module.exports = { LODGE, SPLINTER_ROSTER, loadSplinterMemberFile, withScriptedRandom };
