'use strict';

// #546 — Lévi and Coleman-Smith ("pixie") both need a different correction
// axis than the full likeness anchor scripts/fix-546-roster-likeness.js uses
// for the rest of the roster. Rachel's pass-1 review call for each:
//
//   - Lévi: the current generated base already reads as a recognizable,
//     established character, but is decades younger and less gaunt/bald
//     than the one known 1874 photograph of him late in life. A full anchor
//     (like Blavatsky/Warburg/Pauli/Randolph) would replace him outright
//     with a very old, white-bearded man — Rachel's call was a ~50% blend
//     instead: move toward the reference's documented age/beard/balding
//     without fully discarding the current face, partly to keep some age
//     diversity across the roster's generated portraits.
//   - Coleman-Smith: the opposite problem. Her face is close enough to keep
//     as-is, but her current attire (a patterned folk vest, elaborate scarf)
//     reads as costume next to the real 1912 photograph's plainer attire
//     (satin dress, layered beaded necklaces, simple headwrap). This is an
//     attire-only edit that must NOT touch her face/identity.
//
// Both are implemented as photo-editing tasks with TWO reference images
// attached (the member's own current live base portrait, then the archival
// photo) rather than the single-reference full anchor the other script uses
// — the model is instructed exactly what to take from each. Same downstream
// structure as fix-546-roster-likeness.js: base candidate, then three
// reactions anchored to the new base. Candidates land in
// public/portraits/candidates/ for human review — this script never
// promotes.
//
// Usage: node scripts/fix-546-levi-pixie.js [memberId ...]
//   (no args runs both; pass one or more of levi/pixie to run a subset)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  generatePortraitImage,
  buildReactionPrompt,
  REACTION_TYPES,
} = require('../src/portrait-generation');

const ROOT = path.join(__dirname, '..');
const PORTRAITS_DIR = path.join(ROOT, 'public', 'portraits');
const CANDIDATES_DIR = path.join(PORTRAITS_DIR, 'candidates');
const LIKENESS_REFS_DIR = path.join(PORTRAITS_DIR, 'likeness-refs');

const STYLE_SUFFIX =
  'Visible linework and texture (engraving/ink-wash register), not photorealistic or cartoon/flat-vector. Limited warm sepia/candlelit palette matching the first reference image\'s exact tone. Plain dark unornamented background matching the first reference image — no scene elements, no vignette. Head-and-shoulders, portrait orientation, thumbnail resolution.';

const MEMBERS = {
  levi: {
    buildBasePrompt: () =>
      `This is a photo-editing task blending two reference images of the same established character, Éliphas Lévi. The FIRST attached image is his current portrait in this set. The SECOND is a genuine 1874 archival photograph of the real Lévi late in life. Blend the two evenly, roughly 50/50 — do not simply reproduce either image. Move the face meaningfully toward the second image's documented age, its fuller and whiter beard, and its receding/balding hairline, while still keeping visible continuity with the first image's face (bone structure, general vitality) so the result reads as the same character grown older, not an unrelated old man. Formal dark coat and cravat, contemplative gaze. ${STYLE_SUFFIX}`,
  },
  pixie: {
    buildBasePrompt: () =>
      `This is a photo-editing task. The FIRST attached reference image is Pamela Colman Smith's current portrait in this set — her face, skin tone, age, and identity in your output must match this first image exactly; do not alter her face at all. The SECOND attached image is a genuine circa-1912 photograph of the real Pamela Colman Smith, showing her actual attire: a dark satin dress with gathered sleeves, several strands of large beads layered at the neck, drop earrings, and a soft fabric wrap bound simply over her hair. Replace ONLY her clothing, headwear, and jewelry with attire in that same plain, real register as the second image — not the more patterned, folk-costume-like vest and scarf of the first image. Keep her face and the first image's framing and style untouched. ${STYLE_SUFFIX}`,
  },
};

async function generateMember(apiKey, id) {
  const currentPath = path.join(PORTRAITS_DIR, `${id}.png`);
  const refPath = path.join(LIKENESS_REFS_DIR, `${id}.jpg`);
  if (!fs.existsSync(currentPath) || !fs.existsSync(refPath)) {
    console.error(`  Missing current portrait or reference photo for ${id} — skipping`);
    return;
  }

  const referenceImages = [
    { mimeType: 'image/png', data: fs.readFileSync(currentPath) },
    { mimeType: 'image/jpeg', data: fs.readFileSync(refPath) },
  ];

  console.log(`[${id}] Generating blended base portrait...`);
  const baseBuffer = await generatePortraitImage({
    apiKey,
    prompt: MEMBERS[id].buildBasePrompt(),
    referenceImages,
  });
  fs.writeFileSync(path.join(CANDIDATES_DIR, `${id}.png`), baseBuffer);
  console.log(`[${id}]   done (${baseBuffer.length} bytes) -> public/portraits/candidates/${id}.png`);

  const baseReferenceImages = [{ mimeType: 'image/png', data: baseBuffer }];
  for (const reaction of REACTION_TYPES) {
    const candidateId = `${id}-${reaction}`;
    process.stdout.write(`[${id}] Generating ${reaction}... `);
    const buffer = await generatePortraitImage({
      apiKey,
      prompt: buildReactionPrompt(reaction, id),
      referenceImages: baseReferenceImages,
    });
    fs.writeFileSync(path.join(CANDIDATES_DIR, `${candidateId}.png`), buffer);
    console.log(`done (${buffer.length} bytes) -> public/portraits/candidates/${candidateId}.png`);
  }
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY not set — cannot generate real portrait candidates.');
    process.exit(1);
  }

  const requested = process.argv.slice(2);
  const ids = requested.length > 0 ? requested : Object.keys(MEMBERS);
  for (const id of ids) {
    if (!MEMBERS[id]) {
      console.error(`Unknown member id: ${id} (expected one of ${Object.keys(MEMBERS).join(', ')})`);
      process.exit(1);
    }
  }

  fs.mkdirSync(CANDIDATES_DIR, { recursive: true });

  for (const id of ids) {
    await generateMember(apiKey, id);
  }

  console.log('\nNext: review each candidate in public/portraits/candidates/ against its reference photo and STYLE_GUIDE.md, then promote with:');
  for (const id of ids) {
    console.log(`  node scripts/promote-portrait.js ${id} --force`);
    for (const reaction of REACTION_TYPES) {
      console.log(`  node scripts/promote-portrait.js ${id}-${reaction} --force`);
    }
  }
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
