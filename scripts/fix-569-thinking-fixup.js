'use strict';

// #569 follow-up: the plain `thinking` reaction from
// fix-569-portrait-distinctiveness.js (and, for al-hallaj/arabi, the
// subsequent fix-569-vignette-fixup.js regeneration) read too close to each
// member's neutral base for three of the six #569 members — the same
// recurring failure #558 hit and fixed in fix-558-thinking-fixup.js:
// `REACTION_EXPRESSIONS.thinking`'s eyes-averted/brow-furrowed wording alone
// isn't always enough and needs a concrete physical pose layered on top.
// Reapplying that same pattern here rather than guessing at new wording.
//
// abulafia, khaldun, and llull's `thinking` candidates already showed a
// genuine head-turn/averted gaze on the first pass and are not touched here.
//
// Regenerates ONLY the `thinking` candidate for each of these three #569
// members, anchored to the base candidate already sitting in
// public/portraits/candidates/ (does not touch base/happy/angry).
//
// Usage: node scripts/fix-569-thinking-fixup.js [memberId ...]

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

// al-hallaj and eckhart have a hand already occupied in the base (cloak
// gathered at the chest, manuscript held up) so get a head-turn + averted
// gaze rather than a hand-to-chin gesture that would ask the hand to
// relocate. arabi's base is already inward/unfocused by design, so his pose
// pushes further into an actual head-turn + downcast eyes rather than
// relying on the base's already-inward gaze to read as a distinct reaction.
const THINKING_POSE = {
  'al-hallaj':
    'A genuine head-turn to one side, eyes cast into the middle distance, away from the viewer, brow drawn in concentration — visibly turned inward, not posed toward camera.',
  arabi:
    'A more pronounced head-turn to one side than his usual bearing, eyes cast downward and away from the viewer, brow slightly drawn — visibly absorbed in thought, not merely his usual distant gaze repeated.',
  eckhart:
    'The head rotated a full three-quarters to one side, face turned well away from the viewer toward the manuscript page — not a near-frontal face with only the eyes diverted, an actual rotation of the head and hood on the neck — eyes lowered onto the page, brow drawn, visibly re-reading or puzzling over a passage.',
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
