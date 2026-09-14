'use strict';

// #569 — the three moderate-severity clusters #558 identified but deferred
// (see that issue's changelog entry, STYLE_GUIDE.md, 2026-09-10): abulafia/
// al-hallaj, arabi/khaldun, eckhart/llull. Same root cause as #558 — BATCH-
// 1-PROMPTS.md's "Character study" tier template gives most of these six
// members only attire + a mood adjective ("turban and formal robes...
// composed expression") with no physical/facial or biographical detail to
// differentiate on, so members sharing an era/profession/attire converge.
//
// Scoping pass (done before writing this script, not just asserted): pulled
// all 38 base portraits and looked at these six side-by-side plus their
// immediate roster neighbors. arabi/khaldun was the clearest case — same
// turban wrap, same pose, same shoulder drape, near-identical structure.
// abulafia/al-hallaj already read somewhat apart (skullcap+hood-up vs.
// loose hair+hood-down) but still share the generic "old bearded ascetic in
// a dark robe" register the fix below sharpens into two actually-different
// biographical registers. eckhart/llull share a tonsure+clean-shaven+hood
// silhouette the fix below breaks with a concrete unique prop each. Bruno
// was checked too (the issue names him only as color for why Eckhart's
// register reads generic) but already has a cap+beard silhouette distinct
// from both Eckhart and Llull — left untouched, not part of this fix.
//
// Same device WAVE-4-PROMPTS.md established for character-study figures
// with no photographic likeness (Böhme's awl, Paracelsus's sword hilt): one
// concrete prop or physical detail grounded in real, documented biography,
// not invented —
//   - abulafia: a Hebrew-letter-permutation scroll, for the founder of
//     "prophetic" Kabbalah's signature meditative technique (Chokhmat
//     ha-Tzeruf).
//   - al-hallaj: the patched wool ascetic's cloak (khirqa/muraqqa) Sufi
//     mendicants wore as a mark of voluntary poverty, replacing the plain
//     generic robe — distinct register from abulafia's seated scholar.
//   - arabi: rendered elderly and inwardly absorbed (he wrote his major
//     visionary works and died at 75 in Damascus) rather than the young,
//     outward-facing figure in the current portrait — a wandering mystic's
//     register.
//   - khaldun: a seal-ring/sealed scroll of appointment, for the career
//     statesman who served as Grand Qadi of Cairo and personally negotiated
//     with Tamerlane outside besieged Damascus in 1401 — a worldly
//     official's register, the deliberate opposite of arabi's.
//   - eckhart: an open manuscript page in Middle High German (not Latin) —
//     he broke scholastic convention by preaching/writing in the vernacular,
//     the same "lacks a concrete detail" gap the issue named explicitly.
//   - llull: a diagram of his own "Ars Magna" combinatorial wheel —
//     concentric lettered circles, the device he actually invented and is
//     uniquely known for, a stronger anchor than eckhart's manuscript.
//
// Composition suffix carries #558's own anti-vignette correction
// (fix-558-vignette-fixup.js) from the start, rather than repeating that
// regression here.
//
// Same structure as fix-558-portrait-distinctiveness.js: generate a new
// base, then regenerate the three reactions anchored to the NEW base
// candidate (not yet promoted). Candidates land in
// public/portraits/candidates/ for human review — this script never
// promotes.
//
// Usage: node scripts/fix-569-portrait-distinctiveness.js [memberId ...]
//   (no args runs all six; pass one or more of abulafia/al-hallaj/arabi/
//   khaldun/eckhart/llull to run a subset)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generatePortraitImage, buildReactionPrompt, REACTION_TYPES } = require('../src/portrait-generation');

const ROOT = path.join(__dirname, '..');
const PORTRAITS_DIR = path.join(ROOT, 'public', 'portraits');
const CANDIDATES_DIR = path.join(PORTRAITS_DIR, 'candidates');

// Same anti-vignette wording #558's vignette follow-up corrected into the
// base prompt — carried forward here from the start.
const COMPOSITION_SUFFIX =
  'Head-and-shoulders, period-appropriate dress, plain dark unornamented background — no scene elements, no furniture, no bookshelves, no architectural detail. The background must be a single flat dark tone filling the frame completely edge to edge — no vignette, no radial gradient, no lightening or spotlight halo toward the corners or edges; the corners must be exactly as dark as the area immediately around the subject. Visible linework and texture (engraving/ink-wash register), not photorealistic or cartoon/flat-vector. Limited warm sepia/candlelit palette. Portrait orientation (taller than wide).';

const MEMBERS = {
  abulafia: {
    subject:
      "Warm, etching-adjacent portrait of Abraham Abulafia, Sephardi Kabbalist, 13th century — head-and-shoulders, plain dark robe and skullcap appropriate to a medieval Jewish scholar of Aragon/Castile, an elderly, deeply lined, ascetic face. A parchment scroll inscribed with a circular arrangement of Hebrew letters held or visible at the frame's edge — a concrete trade marker for the founder of 'prophetic' Kabbalah's signature technique of Hebrew letter permutation (Chokhmat ha-Tzeruf), not a generic old scholar. Intense, inward, unflinching expression.",
  },
  'al-hallaj': {
    subject:
      "Warm, etching-adjacent portrait of Husayn ibn Mansur al-Hallaj, Persian Sufi mystic, 9th/10th century — head-and-shoulders, a coarse, visibly patched woolen cloak (the muraqqa/khirqa worn by wandering Sufi ascetics as a mark of voluntary poverty) rather than a plain scholar's robe, unbound tangled hair and beard consistent with an itinerant mendicant rather than a settled cleric. Direct, unflinching, ecstatic-adjacent gaze — the bearing of a man who declared 'Ana al-Haqq' ('I am the Truth') and would not recant it.",
  },
  arabi: {
    subject:
      "Warm, etching-adjacent portrait of Muhyiddin Ibn Arabi, Andalusian-then-Damascene Sufi mystic and philosopher, early 13th century — head-and-shoulders, simple turban and a plain mystic's robe (not the more formal, structured dress of a court official), an elderly, gaunt, deeply inward face — he wrote his major visionary works late in life and died at 75 in Damascus, an old man given to solitary mystical absorption rather than public life. Eyes slightly unfocused, gaze turned inward past the viewer rather than meeting it directly — mid-vision, not mid-conversation.",
  },
  khaldun: {
    subject:
      "Warm, etching-adjacent portrait of Ibn Khaldun, North African/Andalusian historian and statesman, 14th century — head-and-shoulders, the more formal, structured turban and richly bordered robes of a Mamluk-era chief judge (he served as Grand Qadi of the Maliki school in Cairo), a heavy official seal-ring or a sealed scroll of appointment visible at the frame's edge — a concrete trade marker for a career statesman and diplomat who personally negotiated with Tamerlane outside besieged Damascus in 1401, not a generic robed scholar. Composed, shrewd, worldly expression, direct engagement with the viewer rather than inward absorption.",
  },
  eckhart: {
    subject:
      "Warm, etching-adjacent portrait of Meister Eckhart, German Dominican friar and mystical theologian, early 14th century — head-and-shoulders, Dominican habit (white tunic, black scapular and cappa, hood), the bearing of a senior churchman who administered an entire province (Vicar-General of Bohemia) rather than a cloistered contemplative. An open manuscript page bearing visible Middle High German script (not Latin) held or visible at the frame's edge — a concrete trade marker for a scholastic theologian who broke convention by preaching and writing in vernacular German rather than the Latin of his order. Composed, level, unflinching gaze, appropriate to a man who defended his propositions before an inquisition rather than recanting.",
  },
  llull: {
    subject:
      "Warm, etching-adjacent portrait of Ramon Llull, Majorcan philosopher and mystic, 13th/14th century — head-and-shoulders, plain religious tertiary's habit (post-conversion, not courtly dress), weathered elderly face. A diagram of his own combinatorial 'Ars Magna' — concentric wheels marked with lettered divisions — sketched or visible at the frame's edge, a concrete trade marker unique to him among the set, the device he actually invented to mechanically generate theological and philosophical propositions. Contemplative, faintly evangelistic expression, the bearing of a man who tried repeatedly to carry this system in person to the Islamic world.",
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
