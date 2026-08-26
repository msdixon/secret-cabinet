'use strict';

// #430 — evaluation harness for citation-grounding *accuracy*, distinct from
// #141's eval-harness.js (turn-distribution/scheduling): that harness is a
// free deterministic simulation because scheduling mechanics can be replayed
// against a seeded RNG. Accuracy can't be checked that way — it needs a
// known-correct answer to grade against. This runs a small curated golden
// set of citations (real library-grounded ones, plus deliberately inverted
// or unsettled ones) through the real `groundAgainstLibraryText`
// (src/citations.js) — the same function server.js's /verify-citations route
// and pipeline-disposition.js's piggyback both rely on — and scores
// predicted verdict against the golden set's known-correct one.
//
// Supersedes scripts/test-library-grounding.js (#153's original ad hoc
// check): that script duplicated groundAgainstLibraryText inline against a
// single library entry, three cases, and a stale hardcoded model id. This
// calls the real, currently-shipping function, against MODEL, across a
// curated 18-item set spanning 6 library entries and all three verdicts.
//
// Costs a real, billed API call (unlike #141's free simulation) — gated to
// docs/MODEL-REVIEW.md's existing quarterly cadence (item 3), not run
// per-commit or in CI. Run manually as part of that review:
//   node scripts/eval-citation-grounding.js
// or against a candidate model before switching MODEL in server.js:
//   MODEL=claude-opus-5 node scripts/eval-citation-grounding.js
//
// The scoring/report logic below is pure and unit-tested offline against a
// fake client (test/eval-citation-grounding.test.js), same convention as
// test/citations.test.js — only the CLI entry point below needs a real
// ANTHROPIC_API_KEY.

const fs = require('fs');
const path = require('path');
const { loadLibraryCitationLookup } = require('../src/library');
const { groundAgainstLibraryText } = require('../src/citations');

const ROOT = path.join(__dirname, '..');
const GOLDEN_SET_FILE = path.join(__dirname, 'citation-grounding-golden-set.json');
const LIBRARY_DIR = path.join(ROOT, 'prompts', 'library');
const LIBRARY_FILE = path.join(LIBRARY_DIR, 'library.json');
const OUTPUT_FILE = path.join(ROOT, 'CITATION-GROUNDING-EVAL-REPORT.md');
const VERDICTS = ['verified', 'unverified', 'uncertain'];

function loadGoldenSet(file = GOLDEN_SET_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// groundAgainstLibraryText's citation shape is {libraryMatch, work, quote} —
// index-correspondence between this array and the golden set is what ties a
// returned verdict back to its expected one (same convention the function's
// own Map-of-index return already uses).
function buildCitationsFromGoldenSet(goldenSet) {
  return goldenSet.map(item => ({ libraryMatch: item.libraryEntryId, work: item.work, quote: item.quote }));
}

// Confusion matrix keyed `${expected}->${predicted}`, plus the flat mismatch
// list a human reviewer actually needs — this is what makes MODEL-REVIEW.md
// item 3's "check a handful of verdicts by hand" pointed at specific known
// answers instead of an unguided sample.
function scoreVerdicts(goldenSet, verdictsByIndex) {
  const confusion = {};
  VERDICTS.forEach(e => VERDICTS.forEach(p => (confusion[`${e}->${p}`] = 0)));
  const mismatches = [];
  let correct = 0;
  let missing = 0;

  goldenSet.forEach((item, index) => {
    const result = verdictsByIndex.get(index);
    const predicted = result?.verdict;
    if (!predicted) {
      missing++;
      mismatches.push({ ...item, predicted: null, modelNote: null });
      return;
    }
    confusion[`${item.expectedVerdict}->${predicted}`] = (confusion[`${item.expectedVerdict}->${predicted}`] || 0) + 1;
    if (predicted === item.expectedVerdict) {
      correct++;
    } else {
      mismatches.push({ ...item, predicted, modelNote: result.note });
    }
  });

  return {
    total: goldenSet.length,
    correct,
    missing,
    accuracy: goldenSet.length ? correct / goldenSet.length : 0,
    confusion,
    mismatches,
  };
}

function pct(n) {
  return (n * 100).toFixed(1) + '%';
}

function buildReport({ model, goldenSet, scoring }) {
  const lines = [
    '# Citation-Grounding Accuracy Eval Report',
    '',
    `[#430](https://github.com/msdixon/secret-cabinet/issues/430) golden-set accuracy check for \`groundAgainstLibraryText\` (\`src/citations.js\`) — distinct from [#141](https://github.com/msdixon/secret-cabinet/issues/141)'s free scheduling simulation. Model under test: \`${model}\`. ${goldenSet.length} golden-set item(s), ${scoring.correct} correct (${pct(scoring.accuracy)})${scoring.missing ? `, ${scoring.missing} missing a verdict entirely` : ''}.`,
    '',
    '## Confusion matrix (rows = expected, columns = predicted)',
    '',
    '| Expected \\ Predicted | verified | unverified | uncertain |',
    '|---|---|---|---|',
    ...VERDICTS.map(e => `| ${e} | ${VERDICTS.map(p => scoring.confusion[`${e}->${p}`] || 0).join(' | ')} |`),
    '',
  ];

  if (!scoring.mismatches.length) {
    lines.push('_No mismatches — every golden-set item scored as expected._', '');
  } else {
    lines.push('## Mismatches — review these by hand', '');
    scoring.mismatches.forEach(m => {
      lines.push(
        `### \`${m.id}\` (${m.libraryEntryId})`,
        '',
        `- Expected: **${m.expectedVerdict}** — got: **${m.predicted || 'MISSING'}**`,
        `- Quote: "${m.quote}"`,
        `- Why this is in the golden set: ${m.why}`,
        ...(m.modelNote ? [`- Model's note: ${m.modelNote}`] : []),
        ''
      );
    });
  }

  lines.push(
    '---',
    '',
    "_Gated to docs/MODEL-REVIEW.md's quarterly cadence (item 3) — this makes a real, billed API call, so it isn't run per-commit or in CI. Re-run with a candidate model (`MODEL=<candidate> node scripts/eval-citation-grounding.js`) before switching `MODEL` in `server.js`, and compare against this report's accuracy/confusion matrix rather than re-eyeballing a handful of verdicts from scratch each time._"
  );

  return lines.join('\n');
}

async function runEval({ client, model, goldenSet, libraryLookup, onMetric }) {
  const citations = buildCitationsFromGoldenSet(goldenSet);
  const verdictsByIndex = await groundAgainstLibraryText(client, model, citations, libraryLookup, onMetric);
  return scoreVerdicts(goldenSet, verdictsByIndex);
}

module.exports = {
  GOLDEN_SET_FILE,
  loadGoldenSet,
  buildCitationsFromGoldenSet,
  scoreVerdicts,
  buildReport,
  runEval,
};

if (require.main === module) {
  (async () => {
    // Same worktree .env walk-up as server.js's loadEnv() — worktrees keep
    // .env at the main project root, not inside the worktree directory.
    (function loadEnv() {
      let dir = __dirname;
      for (;;) {
        const candidate = path.join(dir, '.env');
        if (fs.existsSync(candidate)) {
          require('dotenv').config({ path: candidate });
          return;
        }
        const parent = path.dirname(dir);
        if (parent === dir) return;
        dir = parent;
      }
    })();

    if (!process.env.ANTHROPIC_API_KEY) {
      console.error(
        'ANTHROPIC_API_KEY is required — this eval makes a real, billed API call, unlike scripts/eval-harness.js.'
      );
      process.exitCode = 1;
      return;
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const model = process.env.MODEL || 'claude-sonnet-5';

    const goldenSet = loadGoldenSet();
    const libraryLookup = loadLibraryCitationLookup(LIBRARY_DIR, LIBRARY_FILE);

    const scoring = await runEval({ client, model, goldenSet, libraryLookup });
    const report = buildReport({ model, goldenSet, scoring });
    fs.writeFileSync(OUTPUT_FILE, report, 'utf8');

    console.log(`${scoring.correct}/${scoring.total} correct (${pct(scoring.accuracy)}). Wrote ${OUTPUT_FILE}.`);
    if (scoring.mismatches.length) {
      console.log(`${scoring.mismatches.length} mismatch(es) — see the report for details.`);
    }
  })().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
