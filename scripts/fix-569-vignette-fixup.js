'use strict';

// #569 follow-up: al-hallaj and arabi's regenerated base portraits (from
// fix-569-portrait-distinctiveness.js) came back with a pronounced radial
// vignette — a brighter halo hugging the head/shoulders that darkens toward
// all four corners. Confirmed by side-by-side comparison against the rest of
// the roster and against this same script's other four #569 members
// (abulafia, khaldun, eckhart, llull all came back flat). The vignette
// propagated into all three reaction images for both members too, via the
// same referenceImages/match-the-background mechanism #558's vignette-fixup
// documented (fix-558-vignette-fixup.js).
//
// Notable difference from #558's case: fix-569-portrait-distinctiveness.js's
// COMPOSITION_SUFFIX already carried an anti-vignette clause from the start
// (copied verbatim from fix-558-vignette-fixup.js's fix) — unlike #558's
// first pass, which was missing the clause entirely. It still wasn't
// reliable for 2 of 6 members here, so this isn't a "clause was missing"
// bug, just generation variance the clause doesn't fully suppress. Re-reading
// the old wording, it's also arguably ambiguous about the actual failure
// shape: it bans "lightening... toward the corners," but the real defect is
// the opposite direction — a brighter halo AROUND THE SUBJECT that darkens
// OUTWARD toward the corners, i.e. a classic photographic vignette. The
// clause below restates the same ban in that explicit shape instead of
// relying on the word "vignette" alone to carry it.
//
// Same subject text as fix-569-portrait-distinctiveness.js, unchanged — this
// is a background-only regeneration, not a re-grounding.
//
// Usage: node scripts/fix-569-vignette-fixup.js [memberId ...]
//   (no args runs both; pass al-hallaj and/or arabi to run a subset)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generatePortraitImage, buildReactionPrompt, REACTION_TYPES } = require('../src/portrait-generation');

const ROOT = path.join(__dirname, '..');
const CANDIDATES_DIR = path.join(ROOT, 'public', 'portraits', 'candidates');

const COMPOSITION_SUFFIX =
  "Head-and-shoulders, period-appropriate dress, plain dark unornamented background — no scene elements, no furniture, no bookshelves, no architectural detail. The background must be a single flat, uniformly dark tone filling the frame completely, corner to corner. Do not render a vignette, radial gradient, or spotlight/halo effect of any kind — specifically, no brighter glow or lightening immediately behind or around the subject's head and shoulders that fades to a darker tone toward the corners or edges. Every region of the background, from directly behind the subject to all four corners, must be the same flat dark value; the corners must not be darker than the area around the subject. Visible linework and texture (engraving/ink-wash register), not photorealistic or cartoon/flat-vector. Limited warm sepia/candlelit palette. Portrait orientation (taller than wide).";

const MEMBERS = {
  'al-hallaj': {
    subject:
      "Warm, etching-adjacent portrait of Husayn ibn Mansur al-Hallaj, Persian Sufi mystic, 9th/10th century — head-and-shoulders, a coarse, visibly patched woolen cloak (the muraqqa/khirqa worn by wandering Sufi ascetics as a mark of voluntary poverty) rather than a plain scholar's robe, unbound tangled hair and beard consistent with an itinerant mendicant rather than a settled cleric. Direct, unflinching, ecstatic-adjacent gaze — the bearing of a man who declared 'Ana al-Haqq' ('I am the Truth') and would not recant it.",
  },
  arabi: {
    subject:
      "Warm, etching-adjacent portrait of Muhyiddin Ibn Arabi, Andalusian-then-Damascene Sufi mystic and philosopher, early 13th century — head-and-shoulders, simple turban and a plain mystic's robe (not the more formal, structured dress of a court official), an elderly, gaunt, deeply inward face — he wrote his major visionary works late in life and died at 75 in Damascus, an old man given to solitary mystical absorption rather than public life. Eyes slightly unfocused, gaze turned inward past the viewer rather than meeting it directly — mid-vision, not mid-conversation.",
  },
};

function buildBasePrompt(id) {
  return `${MEMBERS[id].subject} ${COMPOSITION_SUFFIX}`;
}

async function generateMember(apiKey, id) {
  console.log(`[${id}] Regenerating base portrait with strengthened anti-vignette background...`);
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
