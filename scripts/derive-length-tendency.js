'use strict';

// #512 phase 1 — derives LENGTH_TENDENCY_OVERRIDES in tuning.js from each
// member's own #187 voice exemplar instead of hand-tagging it. Decided
// 2026-09-03 (see the issue's most recent comment): a static, computed-once
// derivation from the existing #187 exemplar text, not the adaptive
// observed-turn-length approach (that's #542, deliberately deferred).
//
// Metric: average words per sentence in the member's primary authored
// exemplar (src/library.js's loadVoiceExemplar — the full text, not the
// runtime VOICE_EXEMPLAR_WORD_BUDGET-trimmed slice). Sentence length is the
// most direct textual proxy for "expansive vs. terse" register the #187 text
// actually offers, and it's cheap: no parsing beyond splitting on terminal
// punctuation.
//
// Bucketing: quartile-based, not a fixed absolute cutoff. The bottom quartile
// of the roster's average-sentence-length distribution is 'terse', the top
// quartile is 'expansive', the interquartile middle half stays 'medium' —
// the same three-bucket shape LENGTH_WEIGHT already expects, but the
// boundary is relative to the roster's own spread rather than a guessed
// number, so it re-centers correctly if #35a keeps growing the library. A
// fixed z-score cutoff was tried first and rejected: two members
// (swedenborg, gurdjieff) have exemplars that are almost entirely one very
// long sentence, which blows out the mean/stdev enough to pull the cutoffs
// off-center. Quartiles-by-rank aren't affected by how extreme the extremes
// are, only by how many members sit past the boundary.
//
// Run manually whenever the library changes (a #35a addition, a #370
// second-entry swap that changes which entry is primary):
//   node scripts/derive-length-tendency.js
// Rewrites the object literal between the DERIVED-LENGTH-TENDENCY markers in
// src/tuning.js in place; everything else in the file is untouched. Safe to
// re-run — it's idempotent for an unchanged library.

const fs = require('fs');
const path = require('path');
const { loadVoiceExemplar } = require('../src/library');

const ROOT = path.join(__dirname, '..');
const ROSTER_FILE = path.join(ROOT, 'prompts/members/roster.json');
const LIBRARY_DIR = path.join(ROOT, 'prompts/library');
const LIBRARY_FILE = path.join(LIBRARY_DIR, 'library.json');
const TUNING_FILE = path.join(ROOT, 'src/tuning.js');

const START_MARKER = '// DERIVED-LENGTH-TENDENCY:START';
const END_MARKER = '// DERIVED-LENGTH-TENDENCY:END';

// Not a linguistically rigorous sentence boundary detector — just a
// terminal-punctuation-plus-capital/quote heuristic, consistent enough to
// compare authors against each other on the same yardstick.
function averageWordsPerSentence(text) {
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z"'])/)
    .map(s => s.trim())
    .filter(Boolean);
  const words = text.split(/\s+/).filter(Boolean);
  return words.length / Math.max(1, sentences.length);
}

// Standard linear-interpolation percentile (numpy's default 'linear'
// method) over an already-sorted-ascending array.
function percentile(sortedValues, p) {
  const idx = p * (sortedValues.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (idx - lo) * (sortedValues[hi] - sortedValues[lo]);
}

function deriveTendencies() {
  const roster = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));
  const rows = [];
  for (const member of roster) {
    const exemplar = loadVoiceExemplar(LIBRARY_DIR, LIBRARY_FILE, member.id);
    if (!exemplar) continue; // no authored entry yet — stays 'medium' via lengthTendencyOf's fallback
    rows.push({ id: member.id, avg: averageWordsPerSentence(exemplar.text) });
  }

  const sorted = [...rows].sort((a, b) => a.avg - b.avg).map(r => r.avg);
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);

  const tendencies = {};
  for (const { id, avg } of rows) {
    if (avg < q1) tendencies[id] = 'terse';
    else if (avg > q3) tendencies[id] = 'expansive';
    // else: medium, left out of the sparse override map
  }
  return { tendencies, rows, q1, q3 };
}

function formatOverridesBlock(tendencies) {
  const ids = Object.keys(tendencies).sort();
  const lines = ids.map(id => `  '${id}': '${tendencies[id]}',`);
  return [START_MARKER, `const LENGTH_TENDENCY_OVERRIDES = {`, ...lines, `};`, END_MARKER].join('\n');
}

function writeIntoTuning(tendencies) {
  const original = fs.readFileSync(TUNING_FILE, 'utf8');
  const startAt = original.indexOf(START_MARKER);
  const endAt = original.indexOf(END_MARKER);
  if (startAt === -1 || endAt === -1) {
    throw new Error(`Couldn't find both "${START_MARKER}" and "${END_MARKER}" markers in ${TUNING_FILE}`);
  }
  const block = formatOverridesBlock(tendencies);
  const updated = original.slice(0, startAt) + block + original.slice(endAt + END_MARKER.length);
  fs.writeFileSync(TUNING_FILE, updated);
}

function main() {
  const { tendencies, rows, q1, q3 } = deriveTendencies();
  rows.sort((a, b) => a.avg - b.avg);
  console.log(`avg words/sentence — q1=${q1.toFixed(1)} q3=${q3.toFixed(1)}\n`);
  for (const { id, avg } of rows) {
    const label = tendencies[id] || 'medium';
    console.log(`${id.padEnd(20)} ${avg.toFixed(1).padStart(6)}  ${label}`);
  }
  const counts = { terse: 0, medium: 0, expansive: 0 };
  for (const { id } of rows) counts[tendencies[id] || 'medium']++;
  console.log(`\nterse=${counts.terse} medium=${counts.medium} expansive=${counts.expansive}`);

  writeIntoTuning(tendencies);
  console.log(`\nWrote ${Object.keys(tendencies).length} overrides into ${path.relative(ROOT, TUNING_FILE)}`);
}

if (require.main === module) main();

module.exports = { averageWordsPerSentence, percentile, deriveTendencies };
