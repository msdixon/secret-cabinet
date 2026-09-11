'use strict';

// #558 — cross-member visual distinctiveness audit. Distinct from #541/#546
// (likeness *accuracy* against a real photo): this is about whether members
// who have NO shared reference photo still read as visually different people
// from each other, beyond the shared style guide's engraving/sepia register.
//
// Root cause, found by comparing all 38 base portraits side-by-side: batch
// 1's "Photographed" tier prompt template (BATCH-1-PROMPTS.md) gives most
// members only attire + mood ("glasses, formal suit, thoughtful reserved
// expression") with zero physical/facial description — nothing for the model
// to differentiate on when two members share the same era/profession/attire.
// Five members converged the most severely: corbin, scholem, pauli (all
// "glasses, formal suit, [adjective] expression" with no face description),
// and frieda-harris/dion-fortune (both "refined/formal Englishwoman... period
// dress" with no distinguishing feature). Moderate clusters (abulafia/
// al-hallaj, arabi/khaldun, eckhart/llull) are deliberately deferred — see
// the follow-up issue filed alongside this fix.
//
// This is a prompt-level (text-only) fix, not the referenceImages/
// buildLikenessAnchoredBasePrompt mechanism #541/#546 used: none of these
// five has a sourced archival photo in likeness-refs/ (Pauli does, but
// Rachel explicitly rejected it as a base-portrait anchor during #546 —
// "Blavatsky and Pauli were reviewed and rejected outright" — so his fix
// here stays text-only, same as the other four). Subject clauses below are
// grounded in real documented facts (Wikipedia, Wikimedia Commons photos
// where they exist) rather than invented: Scholem and Pauli's facial
// descriptions come from directly inspecting their real photographs
// (Scholem: no glasses, widow's peak, thick swept-back hair — Wikimedia
// Commons "Gershom Scholem en 1935"; Pauli: no glasses, heavy-set/jowly,
// significantly receded hairline — the same public/portraits/likeness-refs/
// pauli.jpg already sourced for #546, read for description only, not
// attached as a referenceImages anchor). Corbin, Harris, and Fortune have no
// surviving plain photo readily available, so their differentiation instead
// comes from a concrete biographical trade-marker prop, the same structural
// device WAVE-4-PROMPTS.md already established for character-study figures
// (Böhme's awl, Paracelsus's sword hilt) — Corbin's Perso-Arabic manuscript,
// Harris's paintbrush/painted card (she personally painted all 78 Thoth
// Tarot cards), Fortune's Tree of Life diagram (author of The Mystical
// Qabalah, founder of the Society of the Inner Light).
//
// Same structure as fix-546-roster-likeness.js: generate a new base, then
// regenerate the three reactions anchored to the NEW base candidate (not yet
// promoted) so distinctiveness and cross-image consistency hold together.
// Candidates land in public/portraits/candidates/ for human review — this
// script never promotes.
//
// Usage: node scripts/fix-558-portrait-distinctiveness.js [memberId ...]
//   (no args runs all five; pass one or more of corbin/scholem/pauli/
//   frieda-harris/dion-fortune to run a subset)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generatePortraitImage, buildReactionPrompt, REACTION_TYPES } = require('../src/portrait-generation');

const ROOT = path.join(__dirname, '..');
const PORTRAITS_DIR = path.join(ROOT, 'public', 'portraits');
const CANDIDATES_DIR = path.join(PORTRAITS_DIR, 'candidates');

// Composition suffix unchanged from fix-541/546 — same register across the
// whole roster.
const COMPOSITION_SUFFIX =
  'Head-and-shoulders, period-appropriate dress, plain dark unornamented background — no scene elements, no furniture, no bookshelves, no architectural detail. Visible linework and texture (engraving/ink-wash register), not photorealistic or cartoon/flat-vector. Limited warm sepia/candlelit palette. Portrait orientation (taller than wide).';

const MEMBERS = {
  corbin: {
    subject:
      "Warm, etching-adjacent portrait of Henri Corbin, French philosopher and scholar of Islamic mysticism, mid-20th century — head-and-shoulders, formal suit, small round wire-rimmed scholar's glasses. A lean, ascetic face — deep-set eyes, a high forehead, thinning close-cropped hair — distinct from a generic Continental academic: the bearing of a man who spent decades translating Persian and Arabic mystical philosophy (Ibn Arabi, Suhrawardi) between Paris, Istanbul, and Tehran. An open manuscript page bearing visible Perso-Arabic script rests at the frame's edge, held or set beside him — a concrete trade marker unique to him in this set. Thoughtful, inward-turned expression, gaze not quite meeting the viewer's.",
  },
  scholem: {
    subject:
      "Warm, etching-adjacent portrait of Gershom Scholem, German-Israeli scholar of Kabbalah, mid-20th century — head-and-shoulders, formal suit, no glasses. A distinctive widow's peak with thick, dark wavy hair swept straight back, heavy dark eyebrows, deep-set eyes, and a long straight nose give him a gaunt, intense scholarly look, the founder of the modern academic study of Kabbalah rather than a generic bespectacled academic. Sharp, penetrating, faintly severe expression.",
  },
  pauli: {
    subject:
      "Warm, etching-adjacent portrait of Wolfgang Pauli, Austrian theoretical physicist, mid-20th century — head-and-shoulders, formal dark suit and tie, no glasses. A heavy-set, jowly face with a significantly receded hairline — only a widow's peak of dark hair remaining at the front and sides — gives him a distinctly older, fuller-featured look, not a young/slim 'genius physicist' cliché. Wry, faintly amused, knowing expression.",
  },
  'frieda-harris': {
    subject:
      "Warm, etching-adjacent portrait of Lady Frieda Harris, English artist, 1930s-40s — head-and-shoulders, a refined elderly Englishwoman in her sixties, silver-grey hair swept back, elegant period dress with a strand of pearls, poised aristocratic bearing. A paintbrush held near one shoulder, or the corner of a hand-painted tarot card visible at the frame's edge — a concrete trade marker for the woman who personally painted all 78 cards of the Thoth Tarot deck, not a generic 'lady of the era' figure. Confident, faintly knowing expression.",
  },
  'dion-fortune': {
    subject:
      "Warm, etching-adjacent portrait of Dion Fortune (Violet Mary Firth), English occultist and psychotherapist, early 20th century — head-and-shoulders, formal 1920s-30s dress. A physically imposing, robust build and a strong, direct, magnetic gaze, described by contemporaries as a commanding physical presence, not a slight or delicate figure. A diagram suggestive of the Qabalistic Tree of Life sketched or visible at the frame's edge — a concrete trade marker for the founder of the Society of the Inner Light and author of *The Mystical Qabalah*, not a generic '1920s Englishwoman' figure. Composed, serious, authoritative expression.",
  },
};

function buildBasePrompt(id) {
  return `${MEMBERS[id].subject} ${COMPOSITION_SUFFIX}`;
}

async function generateMember(apiKey, id) {
  console.log(`[${id}] Generating distinctiveness-revised base portrait...`);
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
    '\nNext: review each candidate in public/portraits/candidates/ against the rest of the roster and STYLE_GUIDE.md, then promote with:'
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
