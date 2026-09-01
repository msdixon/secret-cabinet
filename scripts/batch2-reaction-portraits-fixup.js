'use strict';

// #450 batch 2 fixup v2 — regenerates reaction candidates a second time.
//
// v1 of this script (see git history) attached each member's baseline
// portrait as a reference image to fix likeness/attire drift, and that part
// worked. But Rachel's review of the resulting PR (#472) caught a new,
// worse problem: with a strong reference image and only a mild expression
// instruction, gemini-2.5-flash-image mostly just reproduced the reference
// photo — Arabi's thinking/angry read as near-duplicates of each other,
// Dee/Llull/Pixie/Maud's three reactions were each barely distinguishable
// from their own baseline, and Khaldun's `happy` picked up an unrelated,
// unrealistic light-eyed "glow" artifact instead of an actual happy
// expression. The reference image was anchoring the *whole* face, expression
// included, not just identity/attire as intended.
//
// Fix, spiked and confirmed on Dee/Khaldun/Arabi before running the full
// batch: an explicit "do not reuse the reference's expression — that is the
// one thing you must change" instruction, combined with much more
// physically concrete (not just adjective-based) expression descriptions,
// reliably produces a real, visible expression change while still holding
// the reference-anchored likeness/attire/headwear. Also explicitly pins eye
// color/darkness to the reference to prevent the Khaldun glow artifact.
//
// Regenerates all 19 candidates that needed a reference-image pass in the
// first place (not just the ones Rachel happened to call out by name — the
// underlying prompt bug applied to the whole set that went through v1).
//
// Storage/naming: same as ever — public/portraits/candidates/<id>-<reaction>.png,
// review before promoting with scripts/promote-portrait.js --force (these
// ids already have a canonical file from the first, flawed pass).
//
// Usage: node scripts/batch2-reaction-portraits-fixup.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generatePortraitImage } = require('../src/portrait-generation');

const ROOT = path.join(__dirname, '..');
const PORTRAITS_DIR = path.join(ROOT, 'public', 'portraits');
const CANDIDATES_DIR = path.join(PORTRAITS_DIR, 'candidates');

// Forces a real expression change instead of a near-reproduction of the
// reference photo — the actual bug this v2 script exists to fix.
const EXPRESSION_OVERRIDE_META =
  "This is a photo-editing task. The attached reference photo shows this person with a neutral, resting expression. You must NOT reuse or approximate the reference photo's facial expression under any circumstances — that neutral expression is the one thing you must change. Use the reference ONLY to match this person's facial structure/likeness, headwear, attire, palette, and background, including eye color and darkness exactly as in the reference (do not lighten, recolor, or add any glow to the eyes). His or her expression in your output must be a completely different, strongly and unmistakably expressed emotion, described below. If your output's face looks close to the reference's expression, you have failed the task.";

const STYLE_SUFFIX =
  "Visible linework and texture (engraving/ink-wash register), not photorealistic or cartoon/flat-vector. Limited warm sepia/candlelit palette, consistent across a set. Plain dark background, no scene elements. Flat, evenly lit background with no vignette or gradient — matte and uniform edge to edge, matching the reference image's background exactly. Portrait-oriented, thumbnail resolution.";

// Same likeness/attire-anchoring subject clauses as the v1 fixup — those
// held up fine, only the expression handling needed fixing.
const MEMBER_SUBJECTS = {
  pixie:
    "Warm, etching-adjacent portrait of Pamela Colman Smith, Anglo-American artist and illustrator, Edwardian era — head-and-shoulders, short dark hair often bound in a headscarf, dangling earrings, layered bohemian artist's dress with visible fabric texture. Match the reference image's exact skin tone and facial features precisely — do not lighten the skin or narrow the features. Match the reference's sepia warmth exactly rather than a more intense warm tone.",
  arabi:
    "Warm, etching-adjacent portrait of Muhyiddin Ibn Arabi, Andalusian-then-Damascene Sufi scholar, late 12th/early 13th century — head-and-shoulders, turban and scholar's robes appropriate to the Ayyubid-era Islamic world. No photographic or contemporary likeness reference exists; render as a period-appropriate character study consistent with the set's register, favoring a secular character-study framing over reproducing existing devotional iconography. Match the reference image's clean-shaven, youthful face exactly — do not add a beard or age the face.",
  maud: "Warm, etching-adjacent portrait of Maud Gonne, Irish revolutionary and actress, Edwardian era — head-and-shoulders, tall striking bearing, dark hair. Match the reference image's exact hairstyle (loose, upswept wavy hair) and draped shawl/wrap attire precisely — do not substitute a different dress or hairstyle.",
  khaldun:
    "Warm, etching-adjacent portrait of Ibn Khaldun, North African/Andalusian historian and statesman, 14th century — head-and-shoulders, turban and formal robes appropriate to a Mamluk-era scholar-official. No photographic or contemporary likeness reference exists; render as a period-appropriate character study consistent with the set's register. Match the reference image's elderly, deeply lined, gaunt facial structure exactly — do not render a younger or fuller face.",
  llull:
    "Warm, etching-adjacent portrait of Ramon Llull, Majorcan philosopher and mystic, 13th/14th century — head-and-shoulders, plain religious tertiary's habit (post-conversion, not courtly dress), weathered contemplative face. No photographic or contemporary likeness reference exists; render as a period-appropriate character study consistent with the set's register. Match the reference image's headwear exactly (skullcap/tonsure beneath the hood) — do not omit it.",
  dee: "Warm, etching-adjacent portrait of John Dee, English mathematician and astrologer, Elizabethan era — head-and-shoulders, long white beard, black skullcap, scholar's gown and ruff collar. Match the reference image's sharp cheekbones, neatly pointed and well-groomed beard, plain black skullcap (not a beret or cornered cap), and structured Elizabethan ruff collar exactly.",
  warburg:
    "Warm, etching-adjacent portrait of Aby Warburg, German art historian, early 20th century — head-and-shoulders, formal suit, receding hairline. Match the reference image's exact facial structure, age, and skin tone precisely — do not age the face or add jowls.",
};

// v2: concrete, physically-described expressions rather than mood
// adjectives alone — this is what actually overrides the reference image's
// pull toward reproducing its own neutral expression.
const REACTIONS = {
  happy:
    'Expression: a broad, unmistakable open-mouthed smile, teeth showing, cheeks pushed up high, eyes crinkled almost shut with genuine delighted laughter — an exuberant, joyful face, the opposite of a neutral or reserved expression.',
  thinking:
    'Expression: strongly inward and distracted — eyes unfocused and cast far into the middle distance (not toward the viewer at all), one eyebrow raised or brow deeply furrowed, mouth slightly open or twisted to one side as if murmuring — an obviously distracted, not-present face, the opposite of direct engagement with the viewer.',
  angry:
    'Expression: a hard, aggressive scowl — eyebrows sharply lowered and pulled together into a deep vertical crease, eyes narrowed to slits in a hard glare, mouth pulled into a tight snarl or bared teeth, jaw thrust forward — an unmistakably hostile, confrontational face.',
};

const FIXUPS = {
  pixie: ['happy', 'thinking', 'angry'],
  arabi: ['happy', 'thinking', 'angry'],
  maud: ['happy', 'thinking', 'angry'],
  khaldun: ['happy', 'thinking', 'angry'],
  llull: ['happy', 'thinking', 'angry'],
  dee: ['happy', 'thinking', 'angry'],
  warburg: ['happy'],
};

function buildPrompt(memberId, reaction) {
  return `${EXPRESSION_OVERRIDE_META} ${MEMBER_SUBJECTS[memberId]} ${REACTIONS[reaction]} ${STYLE_SUFFIX}`;
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY not set — cannot generate real portrait candidates.');
    process.exit(1);
  }

  fs.mkdirSync(CANDIDATES_DIR, { recursive: true });

  const results = [];
  for (const [memberId, reactions] of Object.entries(FIXUPS)) {
    const baselinePath = path.join(PORTRAITS_DIR, `${memberId}.png`);
    const referenceImages = [{ mimeType: 'image/png', data: fs.readFileSync(baselinePath) }];

    for (const reaction of reactions) {
      const id = `${memberId}-${reaction}`;
      const prompt = buildPrompt(memberId, reaction);
      process.stdout.write(`Generating ${id} (v2, expression-override)... `);
      try {
        const start = Date.now();
        const imageBuffer = await generatePortraitImage({ apiKey, prompt, referenceImages });
        const outPath = path.join(CANDIDATES_DIR, `${id}.png`);
        fs.writeFileSync(outPath, imageBuffer);
        const ms = Date.now() - start;
        console.log(`done (${imageBuffer.length} bytes, ${ms}ms) -> public/portraits/candidates/${id}.png`);
        results.push({ id, ok: true });
      } catch (err) {
        console.log(`FAILED: ${err.message}`);
        results.push({ id, ok: false, error: err.message });
      }
    }
  }

  console.log('\n=== SUMMARY ===');
  const okCount = results.filter(r => r.ok).length;
  console.log(`${okCount}/${results.length} candidates generated.`);
  for (const r of results.filter(r => !r.ok)) {
    console.log(`  FAILED: ${r.id} — ${r.error}`);
  }

  process.exit(results.every(r => r.ok) ? 0 : 1);
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
