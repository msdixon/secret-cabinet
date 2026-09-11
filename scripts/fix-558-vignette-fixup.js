'use strict';

// #558 follow-up: Scholem and Pauli's regenerated base portraits (from
// fix-558-portrait-distinctiveness.js) came back with a pronounced radial
// vignette — a dark oval halo hugging the head/shoulders that lightens
// sharply to a bright cream tone in all four corners. Confirmed by
// side-by-side comparison against the rest of the roster (e.g. jung.png,
// corbin.png): those hold one flat, edge-to-edge dark tone with no
// brightening toward the corners. The other three #558 members (corbin,
// frieda-harris, dion-fortune) don't show this.
//
// Root cause: fix-558-portrait-distinctiveness.js's COMPOSITION_SUFFIX only
// said "plain dark unornamented background," unlike REACTION_STYLE_SUFFIX
// (src/portrait-generation.js) which already carries an explicit
// "no vignette or gradient, matte and uniform edge to edge" clause added
// back in the #450 batch-2 fix (see STYLE_GUIDE.md, 2026-08-28) after the
// same failure mode showed up there. That explicit ban never made it into
// the base-portrait prompt this #558 fix used, so it resurfaced. The
// reaction images inherited the same vignette despite REACTION_STYLE_SUFFIX's
// own ban, because they were anchored via referenceImages to the
// already-vignetted base with an instruction to match its background
// exactly — the match-reference clause outweighed the ban.
//
// Fix: regenerate base + all three reactions for scholem and pauli only,
// with an explicit anti-vignette clause appended to the base composition
// suffix (same subject/distinctiveness description, unchanged). Candidates
// land in public/portraits/candidates/ for human review — this script never
// promotes.
//
// Usage: node scripts/fix-558-vignette-fixup.js [memberId ...]
//   (no args runs both; pass scholem and/or pauli to run a subset)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generatePortraitImage, buildReactionPrompt, REACTION_TYPES } = require('../src/portrait-generation');

const ROOT = path.join(__dirname, '..');
const CANDIDATES_DIR = path.join(ROOT, 'public', 'portraits', 'candidates');

const COMPOSITION_SUFFIX =
  'Head-and-shoulders, period-appropriate dress, plain dark unornamented background — no scene elements, no furniture, no bookshelves, no architectural detail. The background must be a single flat dark tone filling the frame completely edge to edge — no vignette, no radial gradient, no lightening or spotlight halo toward the corners or edges; the corners must be exactly as dark as the area immediately around the subject. Visible linework and texture (engraving/ink-wash register), not photorealistic or cartoon/flat-vector. Limited warm sepia/candlelit palette. Portrait orientation (taller than wide).';

const MEMBERS = {
  scholem: {
    subject:
      "Warm, etching-adjacent portrait of Gershom Scholem, German-Israeli scholar of Kabbalah, mid-20th century — head-and-shoulders, formal suit, no glasses. A distinctive widow's peak with thick, dark wavy hair swept straight back, heavy dark eyebrows, deep-set eyes, and a long straight nose give him a gaunt, intense scholarly look, the founder of the modern academic study of Kabbalah rather than a generic bespectacled academic. Sharp, penetrating, faintly severe expression.",
  },
  pauli: {
    subject:
      "Warm, etching-adjacent portrait of Wolfgang Pauli, Austrian theoretical physicist, mid-20th century — head-and-shoulders, formal dark suit and tie, no glasses. A heavy-set, jowly face with a significantly receded hairline — only a widow's peak of dark hair remaining at the front and sides — gives him a distinctly older, fuller-featured look, not a young/slim 'genius physicist' cliché. Wry, faintly amused, knowing expression.",
  },
};

function buildBasePrompt(id) {
  return `${MEMBERS[id].subject} ${COMPOSITION_SUFFIX}`;
}

async function generateMember(apiKey, id) {
  console.log(`[${id}] Regenerating base portrait with anti-vignette background...`);
  const baseBuffer = await generatePortraitImage({ apiKey, prompt: buildBasePrompt(id) });
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

  console.log(
    '\nNext: review each candidate in public/portraits/candidates/ against the rest of the roster, then promote with:'
  );
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
