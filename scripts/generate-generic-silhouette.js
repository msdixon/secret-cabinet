'use strict';

// #474 — generates the one generic, non-likeness portrait asset used across
// three fallback cases in public/js/scene/scene.js: a member with no
// baseline portrait yet (empty state), a member's reaction pair that hasn't
// been generated (failed/missing state), and Amadou Bamba's reaction set
// specifically, which was deliberately held back at generation time rather
// than personified (see STYLE_GUIDE.md's 2026-08-29 changelog entry).
//
// Deliberately not a member portrait: no roster entry, no id-keyed filename,
// generated once and reused everywhere a fallback is needed rather than
// per-member. Candidate lands at public/portraits/candidates/generic-
// silhouette.png for review; promote by hand (this script does not use
// promote-portrait.js, since that script assumes an <id> already on the
// roster — see the README-equivalent note in STYLE_GUIDE.md for why
// non-roster assets like #479's Dorian Gray image are placed by hand too).
//
// Usage: node scripts/generate-generic-silhouette.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generatePortraitImage } = require('../src/portrait-generation');

const ROOT = path.join(__dirname, '..');
const CANDIDATES_DIR = path.join(ROOT, 'public', 'portraits', 'candidates');

// Same baseline register as every member portrait (STYLE_GUIDE.md), but with
// no identifying facial detail at all -- a robed, hooded figure whose face
// is a flat, solid blackened void, not a blank silhouette shape or a
// broken-image icon. First pass (kept here for the record) rendered the
// face in soft shadow with faint visible contours -- close enough to a real
// face in darkness that it read as unsettling/uncanny rather than simply
// "unspecified" (Rachel's call, 2026-08-31). Revised to an explicitly flat,
// featureless void -- no shadow gradient, no suggestion of underlying
// bone/eye-socket structure -- so it reads as "no likeness rendered" rather
// than "a face I can't quite see".
const PROMPT = `Subject: a single robed, hooded figure seen head-and-shoulders, facing forward, in the manner of an anonymous period portrait -- where the face would be is a completely flat, solid black void, with no shading, gradient, or shape suggesting any underlying facial structure (no eyes, nose, mouth, or even an implied jawline or cheekbone) -- just an even, matte black silhouette shape, like a cut-out or an unlit opening, floating within the hood. No indication of age, gender, or ethnicity. Plain draped hood and robe, no ornamentation, no visible hands or objects.
Style: warm, etching-adjacent -- not photorealistic, not cartoon/flat-vector. Visible linework and texture (engraving/ink-wash register) on the robe and hood only -- the face void itself must stay perfectly flat and featureless, with zero linework or texture inside it.
Composition: head-and-shoulders, centered, plain dark background, no scene elements.
Lighting/Mood: limited warm sepia/candlelit palette on the robe, matching the rest of the roster's portrait set, against the flat black face void. Contemplative, still, anonymous -- not eerie or ominous.
Portrait-oriented, thumbnail resolution.`;

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY not set in .env');
    process.exit(1);
  }

  console.log('Generating generic silhouette candidate...');
  const buffer = await generatePortraitImage({ apiKey, prompt: PROMPT });

  fs.mkdirSync(CANDIDATES_DIR, { recursive: true });
  const outPath = path.join(CANDIDATES_DIR, 'generic-silhouette.png');
  fs.writeFileSync(outPath, buffer);
  console.log(`Wrote candidate to ${path.relative(ROOT, outPath)}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
