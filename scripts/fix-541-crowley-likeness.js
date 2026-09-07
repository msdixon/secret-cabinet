'use strict';

// #541 — Crowley's base portrait was generated from a text prompt alone,
// with no archival photo attached as a `referenceImages` anchor, so the
// model filled in likeness from its own training association for "Aleister
// Crowley" rather than a verified source. Rachel's read on the result: too
// young and slim in the face, over-romanticizing the popular occult-glamour
// image of him rather than the heavier, jowlier "Great Beast" prime
// (1920s-30s Abbey of Thelema era) his actual surviving photographs show.
//
// This regenerates his base portrait anchored to a real reference photo —
// public/portraits/likeness-refs/crowley.jpg (circa 1925, plain studio
// photograph, Wikimedia Commons, public domain; see that directory's
// metadata.json for full provenance) — via buildLikenessAnchoredBasePrompt
// (src/portrait-generation.js), the same referenceImages mechanism the
// reaction portraits already use, just anchoring physical accuracy instead
// of overriding expression.
//
// Once the base is regenerated, his three reaction portraits are also
// regenerated anchored to the NEW base candidate (not yet promoted) so
// likeness accuracy and cross-image consistency both hold at once, same
// reasoning as #531's own fix. Reuses buildReactionPrompt from
// src/portrait-generation.js unchanged.
//
// Storage/naming: all four candidates land at
// public/portraits/candidates/crowley*.png, same convention as every prior
// batch. Per STYLE_GUIDE.md's human-validation gate, this script does NOT
// promote — it only writes candidates for review. Run
// scripts/promote-portrait.js on whichever candidates are approved.
//
// Usage: node scripts/fix-541-crowley-likeness.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generatePortraitImage, buildLikenessAnchoredBasePrompt, buildReactionPrompt, REACTION_TYPES } = require('../src/portrait-generation');

const ROOT = path.join(__dirname, '..');
const PORTRAITS_DIR = path.join(ROOT, 'public', 'portraits');
const CANDIDATES_DIR = path.join(PORTRAITS_DIR, 'candidates');
const LIKENESS_REF_PATH = path.join(PORTRAITS_DIR, 'likeness-refs', 'crowley.jpg');

// Subject/composition clause, adapted from the one fix-531-reaction-drift.js
// used for Crowley's reactions -- dropped the old "aim for a recognizable
// likeness consistent with surviving photographs" line, since a real
// reference photo now does that job directly, and added the concrete
// physical detail Rachel's critique named so the model doesn't average it
// away even with the reference attached.
const SUBJECT =
  "Warm, etching-adjacent portrait of Aleister Crowley, English ceremonial magician, in his heavier, more physically imposing prime (1920s-30s, the Abbey of Thelema era) — head-and-shoulders, shaved head, formal dress or ceremonial magician's robe. A fuller, jowlier face and heavier build than a young man's, matching the reference photo's actual physical proportions.";

const COMPOSITION_SUFFIX =
  'Head-and-shoulders, period-appropriate dress, plain dark unornamented background — no scene elements, no furniture, no bookshelves, no architectural detail. Contemplative, neutral expression. Visible linework and texture (engraving/ink-wash register), not photorealistic or cartoon/flat-vector. Limited warm sepia/candlelit palette. Portrait orientation (taller than wide).';

function buildBasePrompt() {
  return buildLikenessAnchoredBasePrompt(`${SUBJECT} ${COMPOSITION_SUFFIX}`);
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY not set — cannot generate real portrait candidates.');
    process.exit(1);
  }
  if (!fs.existsSync(LIKENESS_REF_PATH)) {
    console.error(`No likeness reference found at ${path.relative(ROOT, LIKENESS_REF_PATH)}`);
    process.exit(1);
  }

  fs.mkdirSync(CANDIDATES_DIR, { recursive: true });

  const referenceImages = [{ mimeType: 'image/jpeg', data: fs.readFileSync(LIKENESS_REF_PATH) }];

  console.log('Generating likeness-anchored base portrait...');
  const baseBuffer = await generatePortraitImage({ apiKey, prompt: buildBasePrompt(), referenceImages });
  fs.writeFileSync(path.join(CANDIDATES_DIR, 'crowley.png'), baseBuffer);
  console.log(`  done (${baseBuffer.length} bytes) -> public/portraits/candidates/crowley.png`);

  const baseReferenceImages = [{ mimeType: 'image/png', data: baseBuffer }];
  for (const reaction of REACTION_TYPES) {
    const id = `crowley-${reaction}`;
    process.stdout.write(`Generating ${id}... `);
    const buffer = await generatePortraitImage({
      apiKey,
      prompt: buildReactionPrompt(reaction, 'crowley'),
      referenceImages: baseReferenceImages,
    });
    fs.writeFileSync(path.join(CANDIDATES_DIR, `${id}.png`), buffer);
    console.log(`done (${buffer.length} bytes) -> public/portraits/candidates/${id}.png`);
  }

  console.log(
    '\nNext: review each candidate in public/portraits/candidates/ against the reference photo and STYLE_GUIDE.md, then promote with:\n' +
      '  node scripts/promote-portrait.js crowley --force\n' +
      '  node scripts/promote-portrait.js crowley-happy --force\n' +
      '  node scripts/promote-portrait.js crowley-thinking --force\n' +
      '  node scripts/promote-portrait.js crowley-angry --force'
  );
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
