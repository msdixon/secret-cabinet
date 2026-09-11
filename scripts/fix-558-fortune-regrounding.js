'use strict';

// #558 follow-up: on human review, Dion Fortune's prop-based #558 fix (a
// Tree-of-Life diagram at the frame's edge, from fix-558-portrait-distinctiveness.js)
// read as a hokey add-on rather than a real distinguishing detail. Unlike Corbin
// and Frieda Harris — whose prop-based fixes were also rejected on review and
// reverted outright, since neither has a usable photo — Fortune has a real,
// identifiable photograph: Wikidata Q260670's P18 image, a plain circa-1920s-30s
// studio portrait (Wikimedia Commons, "Violet Mary Firthova (1890 1946).jpg",
// public domain — anonymous photographer, copyright expired).
//
// The photo shows a center-parted, wavy bob-length hairstyle worn close to the
// head, straight/heavy eyebrows, a direct and level gaze, and — notably — a
// dark high-necked jumper worn over a white shirt collar and dark necktie: a
// tailored, androgynous look distinct from the "refined 1920s-30s Englishwoman"
// register the original prompt used, and distinct from every other member's
// attire in the set. This is the concrete grounded detail; the diagram prop is
// dropped.
//
// Same approach as Scholem's #558 fix and this same issue's Pauli entry: the
// photo is read and described here for grounding only, NOT passed as a
// `referenceImages` anchor for base-portrait generation (Rachel's explicit
// rejection of that approach during #546's review) — so this member has no
// entry in public/portraits/likeness-refs/metadata.json, same as Scholem.
//
// Also folds in the anti-vignette clause from the start (see
// fix-558-vignette-fixup.js) rather than risking the same failure resurfacing.
//
// Candidates land in public/portraits/candidates/ for human review — this
// script never promotes.
//
// Usage: node scripts/fix-558-fortune-regrounding.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generatePortraitImage, buildReactionPrompt, REACTION_TYPES } = require('../src/portrait-generation');

const ROOT = path.join(__dirname, '..');
const CANDIDATES_DIR = path.join(ROOT, 'public', 'portraits', 'candidates');
const MEMBER_ID = 'dion-fortune';

const COMPOSITION_SUFFIX =
  'Head-and-shoulders, period-appropriate dress, plain dark unornamented background — no scene elements, no furniture, no bookshelves, no architectural detail. The background must be a single flat dark tone filling the frame completely edge to edge — no vignette, no radial gradient, no lightening or spotlight halo toward the corners or edges; the corners must be exactly as dark as the area immediately around the subject. Visible linework and texture (engraving/ink-wash register), not photorealistic or cartoon/flat-vector. Limited warm sepia/candlelit palette. Portrait orientation (taller than wide).';

const SUBJECT =
  "Warm, etching-adjacent portrait of Dion Fortune (Violet Mary Firth), English occultist and psychotherapist, early 20th century — head-and-shoulders. A center-parted, wavy bob-length hairstyle worn close to the head and ears, straight heavy eyebrows, and a direct, level, unsmiling gaze meeting the viewer. A dark high-necked jumper worn over a plain white shirt collar and dark necktie — a tailored, faintly androgynous look, not a soft or lace-trimmed 'refined Englishwoman' dress. Composed, serious, authoritative expression.";

function buildBasePrompt() {
  return `${SUBJECT} ${COMPOSITION_SUFFIX}`;
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY not set — cannot generate real portrait candidates.');
    process.exit(1);
  }

  fs.mkdirSync(CANDIDATES_DIR, { recursive: true });

  console.log(`[${MEMBER_ID}] Regenerating base portrait, grounded in Wikidata Q260670's reference photo...`);
  const baseBuffer = await generatePortraitImage({ apiKey, prompt: buildBasePrompt() });
  fs.writeFileSync(path.join(CANDIDATES_DIR, `${MEMBER_ID}.png`), baseBuffer);
  console.log(`[${MEMBER_ID}]   done (${baseBuffer.length} bytes) -> public/portraits/candidates/${MEMBER_ID}.png`);

  const baseReferenceImages = [{ mimeType: 'image/png', data: baseBuffer }];
  for (const reaction of REACTION_TYPES) {
    const candidateId = `${MEMBER_ID}-${reaction}`;
    process.stdout.write(`[${MEMBER_ID}] Generating ${reaction}... `);
    const buffer = await generatePortraitImage({
      apiKey,
      prompt: buildReactionPrompt(reaction, MEMBER_ID),
      referenceImages: baseReferenceImages,
    });
    fs.writeFileSync(path.join(CANDIDATES_DIR, `${candidateId}.png`), buffer);
    console.log(`done (${buffer.length} bytes) -> public/portraits/candidates/${candidateId}.png`);
  }

  console.log(
    '\nNext: review each candidate in public/portraits/candidates/ against the reference photo and the rest of the roster, then promote with:'
  );
  console.log(`  node scripts/promote-portrait.js ${MEMBER_ID} --force`);
  for (const reaction of REACTION_TYPES) {
    console.log(`  node scripts/promote-portrait.js ${MEMBER_ID}-${reaction} --force`);
  }
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
