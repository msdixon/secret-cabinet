'use strict';

// #546 — roster-wide audit for the same text-only-likeness gap #541 found and
// fixed for Crowley: a base portrait generated from a text prompt alone, with
// no archival photo attached as a `referenceImages` anchor, lets the model
// fill in likeness from its own training association instead of a verified
// source. Each member here gets the identical fix #541 used, just with
// member-specific reference photos and subject text (see
// public/portraits/likeness-refs/metadata.json for per-photo provenance).
//
// Pass-1 review (2026-09-09): Rachel rejected Blavatsky and Pauli outright
// (keep their current live portraits) — removed from MEMBERS below, not
// re-run. Warburg's candidate is still pending her review.
//
// Pass-3 review (2026-09-09): Randolph approved the new likeness overall but
// flagged a too-dark complexion and too-wide/round nostrils vs. the
// reference photo — MEMBERS.randolph.subject below is the round-2 revision
// with explicit correction language for both. Sun Ra's face was approved
// again, but the round-1 "plain button shirt, no headdress" rewrite turned
// out to misdescribe the reference photo — re-inspecting it directly showed
// a dark patterned knit sweater and a small embroidered/beaded cap, not a
// bare button shirt. MEMBERS['sun-ra'].subject below is the round-2 fix.
//
// Waite, Jung, Coleman-Smith, and Lévi are deliberately excluded from this
// script — Rachel's per-member review call, not an oversight:
//   - Waite / Jung: close enough as-is, no regeneration.
//   - Coleman-Smith: face is close enough; only her attire needs correcting
//     (costume-y outfit vs. the real photo's attire) — handled in
//     scripts/fix-546-levi-pixie.js, a face-preserving/attire-only edit, not
//     this script's full anchor.
//   - Lévi: wants a lighter-touch, ~50%-blended treatment (keep more of the
//     current generated face rather than fully replacing it with the much
//     older reference photo) — also in scripts/fix-546-levi-pixie.js.
// Corbin has no known photo and isn't part of any #546 script.
//
// Same structure as fix-541-crowley-likeness.js: generate a likeness-
// anchored base, then regenerate the three reactions anchored to the NEW
// base candidate (not yet promoted) so likeness accuracy and cross-image
// consistency hold together. Candidates land in public/portraits/candidates/
// for human review — this script never promotes.
//
// Usage: node scripts/fix-546-roster-likeness.js [memberId ...]
//   (no args runs all three; pass one or more of warburg/sun-ra/randolph to
//   run a subset)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  generatePortraitImage,
  buildLikenessAnchoredBasePrompt,
  buildReactionPrompt,
  REACTION_TYPES,
} = require('../src/portrait-generation');

const ROOT = path.join(__dirname, '..');
const PORTRAITS_DIR = path.join(ROOT, 'public', 'portraits');
const CANDIDATES_DIR = path.join(PORTRAITS_DIR, 'candidates');
const LIKENESS_REFS_DIR = path.join(PORTRAITS_DIR, 'likeness-refs');

// Composition suffix unchanged from fix-541-crowley-likeness.js — same
// register across the whole roster.
const COMPOSITION_SUFFIX =
  'Head-and-shoulders, period-appropriate dress, plain dark unornamented background — no scene elements, no furniture, no bookshelves, no architectural detail. Contemplative, neutral expression. Visible linework and texture (engraving/ink-wash register), not photorealistic or cartoon/flat-vector. Limited warm sepia/candlelit palette. Portrait orientation (taller than wide).';

// Subject clauses adapted from BATCH-1-PROMPTS.md's originals: dropped "aim
// for a recognizable likeness consistent with surviving photographs" (the
// attached reference photo now does that job directly), and added the
// concrete physical detail the roster audit flagged as the specific drift
// risk for each member, same reasoning as Crowley's fix.
const MEMBERS = {
  warburg: {
    // Revised 2026-09-09 (round 2) per Rachel's pass-4 review: round 1's
    // "round wire-frame glasses" claim was wrong — re-inspected the reference
    // photo directly and Warburg is not wearing glasses in it (he's shown
    // reading, hand to forehead); the current live portrait also has no
    // glasses. The metadata.json notes for this photo made the same wrong
    // claim and have been corrected alongside this prompt. Same root-cause
    // class as the Sun Ra "buttondown" fix: prose describing an assumed
    // detail instead of what the photo actually shows.
    subject:
      'Warm, etching-adjacent portrait of Aby Warburg, German art historian, early 20th century — head-and-shoulders, formal suit, intense/haunted expression. A receding hairline and a neat mustache, no glasses — match this specific, recognizable combination from the reference photo rather than a generic early-20th-century scholar look.',
  },
  'sun-ra': {
    // Revised 2026-09-09 (round 2) per Rachel's pass-3 review: round 1's
    // "plain button shirt, no headdress" was wrong about what the reference
    // photo actually shows — re-inspected it directly and the foreground
    // Sun Ra (seated at the keyboard) wears a dark patterned/textured knit
    // sweater and a small round embroidered/beaded cap, not a headdress and
    // not a button shirt either. This version names that specific plain-but-
    // textured attire instead of either extreme (invented regalia, or an
    // overcorrected plain shirt).
    subject:
      'Warm, etching-adjacent portrait of Sun Ra, American musician and cosmic philosopher, mid-20th century — head-and-shoulders. Match the reference photo\'s actual attire closely: a dark patterned/textured knit sweater (not a plain button shirt) and a small, close-fitting round embroidered or beaded cap — plain everyday dress with real texture and pattern, not sequined robes or elaborate ceremonial regalia, and not a bare headdress-free look either. The distinctiveness should come from his face, bearing, and this specific plain cap and sweater, not from invented ceremonial clothing.',
  },
  randolph: {
    // Revised 2026-09-09 (round 2) per Rachel's pass-3 review: round 1's
    // candidate came out with a darker complexion and a wider/rounder nose
    // than the reference photo shows. Added explicit correction language for
    // both, same pattern as the rest of this file's likeness-anchor prompts.
    subject:
      'Warm, etching-adjacent portrait of Paschal Beverly Randolph, American Rosicrucian founder and physician, mid-19th century — head-and-shoulders, formal mid-Victorian dress (dark coat, cravat) appropriate to a Black American professional man of the period, direct dignified gaze. Match the reference photo\'s actual facial structure, complexion, and hair exactly — this is the only known photograph of Randolph, so it is the sole ground truth for his likeness. In particular: match the reference photo\'s lighter, medium-brown complexion (do not render him darker-skinned than the photo shows), and its narrower, slightly taller nose with less flare at the nostrils than a generic rendering would default to.',
  },
};

function buildBasePrompt(id) {
  return buildLikenessAnchoredBasePrompt(`${MEMBERS[id].subject} ${COMPOSITION_SUFFIX}`);
}

async function generateMember(apiKey, id) {
  const refPath = path.join(LIKENESS_REFS_DIR, `${id}.jpg`);
  if (!fs.existsSync(refPath)) {
    console.error(`  No likeness reference found at ${path.relative(ROOT, refPath)} — skipping ${id}`);
    return;
  }

  const referenceImages = [{ mimeType: 'image/jpeg', data: fs.readFileSync(refPath) }];

  console.log(`[${id}] Generating likeness-anchored base portrait...`);
  const baseBuffer = await generatePortraitImage({ apiKey, prompt: buildBasePrompt(id), referenceImages });
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
