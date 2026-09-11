'use strict';

// #558 follow-up: the plain `thinking` reaction from
// fix-558-portrait-distinctiveness.js read too close to each member's
// neutral base for all five regenerated members — the same recurring
// failure STYLE_GUIDE.md's #450 batch-3 changelog entry already documented
// for three of these exact members (corbin, frieda-harris, dion-fortune)
// against their OLD base portraits: `REACTION_EXPRESSIONS.thinking`'s
// eyes-averted/brow-furrowed wording alone isn't always enough, and needs a
// concrete physical pose layered on top. That fix was a one-off in a fixup
// script back then too, never folded into the shared
// `REACTION_EXPRESSIONS.thinking` text in src/portrait-generation.js, so it
// didn't carry over to these brand-new base portraits. Reapplying the same
// pattern here rather than guessing at new wording.
//
// Regenerates ONLY the `thinking` candidate for each of the five #558
// members, anchored to the base candidate already sitting in
// public/portraits/candidates/ (does not touch base/happy/angry).
//
// Usage: node scripts/fix-558-thinking-fixup.js [memberId ...]

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  generatePortraitImage,
  REACTION_EXPRESSION_OVERRIDE_META,
  REACTION_STYLE_SUFFIX,
} = require('../src/portrait-generation');

const ROOT = path.join(__dirname, '..');
const CANDIDATES_DIR = path.join(ROOT, 'public', 'portraits', 'candidates');

// Members with a hand already visible/occupied in the base (holding a
// manuscript, paintbrush) get a head-turn + averted gaze instead of a
// hand-to-chin gesture, since their hand is already doing something else in
// frame and shouldn't be asked to relocate to the chin.
const THINKING_POSE = {
  corbin:
    'A genuine head-turn to one side, eyes cast down and away toward the manuscript rather than at the viewer, brow drawn — visibly re-reading or puzzling over a passage, not posed toward camera.',
  scholem:
    'A genuine head-turn to one side and eyes cast into the middle distance, away from the viewer, brow tightly furrowed — visibly working through a difficult thought, not posed toward camera.',
  pauli:
    'A genuine head-turn to one side and eyes cast into the middle distance, away from the viewer, one eyebrow raised skeptically — visibly turning an idea over, not posed toward camera.',
  'frieda-harris':
    'A genuine head-turn to one side, gaze lifted and cast into the middle distance away from the viewer and away from the card in her hand, as if considering the next brushstroke rather than looking at either the viewer or her work — not posed toward camera.',
  'dion-fortune':
    'A genuine head-turn to one side, eyes cast into the middle distance, away from the viewer, brow drawn in concentration — visibly turned inward, not posed toward camera.',
};

function buildThinkingFixupPrompt(id) {
  return `${REACTION_EXPRESSION_OVERRIDE_META} Expression and pose: ${THINKING_POSE[id]} ${REACTION_STYLE_SUFFIX}`;
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY not set — cannot generate real portrait candidates.');
    process.exit(1);
  }

  const requested = process.argv.slice(2);
  const ids = requested.length > 0 ? requested : Object.keys(THINKING_POSE);
  for (const id of ids) {
    if (!THINKING_POSE[id]) {
      console.error(`Unknown member id: ${id} (expected one of ${Object.keys(THINKING_POSE).join(', ')})`);
      process.exit(1);
    }
  }

  for (const id of ids) {
    const basePath = path.join(CANDIDATES_DIR, `${id}.png`);
    if (!fs.existsSync(basePath)) {
      console.error(`  No base candidate found at ${path.relative(ROOT, basePath)} — skipping ${id}`);
      continue;
    }
    const referenceImages = [{ mimeType: 'image/png', data: fs.readFileSync(basePath) }];
    process.stdout.write(`[${id}] Regenerating thinking with explicit pose... `);
    const buffer = await generatePortraitImage({ apiKey, prompt: buildThinkingFixupPrompt(id), referenceImages });
    fs.writeFileSync(path.join(CANDIDATES_DIR, `${id}-thinking.png`), buffer);
    console.log(`done (${buffer.length} bytes) -> public/portraits/candidates/${id}-thinking.png`);
  }
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
