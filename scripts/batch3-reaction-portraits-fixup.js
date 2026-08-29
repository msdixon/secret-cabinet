'use strict';

// #450 batch 3 fixup — Rachel's review of the batch 3 candidates
// (scripts/batch3-reaction-portraits.js) caught two distinct problems:
//
// 1. Randolph's `happy` candidate grew a full beard not present in his
//    baseline or any other reaction — the same likeness-drift failure mode
//    batch 2 hit on Ibn Arabi. Fixed the same way: an explicit "match the
//    reference's clean-shaven face exactly" instruction alongside the
//    reference image.
//
// 2. Nine members' `thinking` candidates read too close to their neutral
//    baseline — gaze still toward the viewer, no real head-angle or
//    expression change: yates, william-blake, randolph, dion-fortune,
//    frieda-harris, moina-mathers, bohme, swedenborg, corbin. This is the
//    same "reference image pulls toward its own pose" failure the batch 2
//    fixup solved for *expression*, but here it was pose/gaze that collapsed
//    back toward neutral even under batch 3's already-strengthened
//    expression-override wording — confirmed by a live retry on two of them
//    (frieda-harris, dion-fortune) that still didn't move far enough.
//
//    Fix, spiked and confirmed on corbin/dion-fortune before running the
//    full set: give the model a concrete, physical thinking *pose*, not just
//    a facial expression. Two tiers, depending on whether the member's
//    baseline already shows hands in frame:
//      - Tier A (frieda-harris, dion-fortune, moina-mathers — baseline shows
//        hands crossed at the waist): a hand-to-chin/temple gesture, the
//        classic "in thought" pose. An in-register addition, not a
//        composition change, since a hand is already in frame.
//      - Tier B (yates, william-blake, randolph, bohme, swedenborg, corbin —
//        tight head-and-shoulders crop, no hands visible): a genuine
//        three-quarter head turn and off-camera gaze, leaning harder on head
//        angle than batch 3's original wording did, without introducing a
//        hand that isn't otherwise in frame.
//
// Regenerates only the specific candidates that needed it — not a full
// re-run of the batch. Storage/naming: same as ever —
// public/portraits/candidates/<id>-<reaction>.png, review before promoting
// with scripts/promote-portrait.js (these ids already have a candidate file
// from the first pass, being overwritten here).
//
// Usage: node scripts/batch3-reaction-portraits-fixup.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generatePortraitImage } = require('../src/portrait-generation');

const ROOT = path.join(__dirname, '..');
const PORTRAITS_DIR = path.join(ROOT, 'public', 'portraits');
const CANDIDATES_DIR = path.join(PORTRAITS_DIR, 'candidates');

const STYLE_SUFFIX =
  "Visible linework and texture (engraving/ink-wash register), not photorealistic or cartoon/flat-vector. Limited warm sepia/candlelit palette, consistent across a set, matching the reference image's exact tone. Background matching the reference image's background exactly — flat and evenly lit, no vignette or gradient, matte and uniform edge to edge. Portrait-oriented, thumbnail resolution.";

// --- Fix 1: Randolph's `happy` beard drift ---------------------------------

const RANDOLPH_HAPPY_META =
  "This is a photo-editing task. The attached reference photo shows this person clean-shaven, with a neutral expression. Match the reference image's exact facial structure, likeness, skin tone, and attire — do not alter identity, age, or ethnicity. Match the reference's clean-shaven face exactly: do NOT add a beard, mustache, or any facial hair not present in the reference. You must NOT reuse or approximate the reference photo's facial expression — that neutral expression is the one thing you must change. His expression in your output must be a genuine, warm, happy expression, described below, while keeping the face otherwise identical to the reference including its clean-shaven jawline.";

const RANDOLPH_SUBJECT =
  'Warm, etching-adjacent portrait of Paschal Beverly Randolph, American Rosicrucian founder and physician, mid-19th century — head-and-shoulders, formal mid-Victorian dress appropriate to a Black American professional man of the period.';

const HAPPY_REACTION =
  'Expression: a broad, unmistakable open-mouthed smile, teeth showing, cheeks pushed up high, eyes crinkled almost shut with genuine delighted laughter — an exuberant, joyful face, the opposite of a neutral or reserved expression.';

// --- Fix 2: the nine `thinking` candidates that read too close to baseline -

const THINKING_EXPRESSION_OVERRIDE_META =
  "This is a photo-editing task. The attached reference photo shows this person in a neutral, composed, camera-facing pose. Match the reference image's exact facial structure, likeness, skin tone, headwear, and attire — do not alter identity, age, or ethnicity. You must NOT reuse or approximate the reference photo's pose, expression, or gaze direction under any circumstances — that composed, camera-facing pose is the one thing you must change. Use the reference ONLY to match likeness/attire/background, including eye color and darkness exactly as in the reference. If your output's pose or expression looks close to the reference's, you have failed the task — a viewer glancing at both images side by side must immediately see a different pose, not just a subtly different face.";

// Tier A: hand-to-chin/temple gesture, for members whose baseline already
// shows hands crossed in frame.
const HAND_GESTURE_REACTION =
  "Pose and expression: a strong, unmistakable 'lost in thought' pose — head turned and tilted at a clear angle away from the camera, one hand raised out of its resting position to touch the chin, cheek, or temple with a finger or knuckle, in the classic physical gesture of someone thinking hard. Eyes cast off to the side into the middle distance, not toward the viewer. Brow faintly furrowed. This must read as visibly, unmistakably different in pose from a normal composed portrait, not just a different facial expression.";

// Tier B: head-turn + off-camera gaze, for tight head-and-shoulders crops
// with no hands in frame to work with.
const HEAD_TURN_REACTION =
  "Expression and head angle: a strong, unmistakable 'lost in thought' look — head turned and tilted at a clear angle away from the camera (a genuine three-quarter turn, not a straight-on face), eyes cast far off to the side into the middle distance, not toward the viewer at all, brow furrowed in concentration, mouth slightly open or pursed to one side as if murmuring. This must read as visibly, unmistakably different in head angle and gaze from a normal composed portrait facing the camera.";

const THINKING_FIXUPS = {
  'dion-fortune': {
    tier: 'A',
    subject: 'Warm, etching-adjacent portrait of Dion Fortune (Violet Mary Firth), English occultist, early 20th century — head-and-shoulders, formal 1920s–30s dress.',
  },
  'frieda-harris': {
    tier: 'A',
    subject: 'Warm, etching-adjacent portrait of Lady Frieda Harris, English artist, 1930s–40s — head-and-shoulders, refined older Englishwoman, elegant period dress.',
  },
  'moina-mathers': {
    tier: 'A',
    subject: 'Warm, etching-adjacent portrait of Moina Mathers, Golden Dawn co-leader and artist, Edwardian era — head-and-shoulders, formal Edwardian dress or Golden Dawn ceremonial regalia.',
  },
  yates: {
    tier: 'B',
    subject: 'Warm, etching-adjacent portrait of Frances Yates, English historian, mid-20th century — head-and-shoulders, glasses, sensible tweed or cardigan.',
  },
  'william-blake': {
    tier: 'B',
    subject:
      "Warm, etching-adjacent portrait of William Blake, English poet and engraver, Georgian era — head-and-shoulders, plain Georgian dress, wide intense visionary eyes, high forehead. No photograph exists, but a well-known contemporary painted portrait survives (Thomas Phillips, 1807) — use it as a loose likeness anchor while keeping the etching register rather than reproducing the painting directly.",
  },
  randolph: {
    tier: 'B',
    subject: RANDOLPH_SUBJECT,
  },
  bohme: {
    tier: 'B',
    subject:
      "Warm, etching-adjacent portrait of Jakob Böhme, German shoemaker and mystic, early 17th century — head-and-shoulders, plain burgher/tradesman's dress (not scholar's robes or clerical dress — he had no Latin and no theological training), a cobbler's awl or scrap of leatherwork visible at the frame's edge as a concrete trade marker.",
  },
  swedenborg: {
    tier: 'B',
    subject:
      "Warm, etching-adjacent portrait of Emanuel Swedenborg, Swedish scientist and visionary, 18th century — head-and-shoulders, formal 18th-century dress appropriate to a Swedish assessor of the Royal College of Mines (plain coat, natural or lightly-powdered white hair, no ostentation).",
  },
  corbin: {
    tier: 'B',
    subject: 'Warm, etching-adjacent portrait of Henri Corbin, French philosopher, mid-20th century — head-and-shoulders, glasses, formal suit.',
  },
};

function buildRandolphHappyPrompt() {
  return `${RANDOLPH_HAPPY_META} ${RANDOLPH_SUBJECT} ${HAPPY_REACTION} ${STYLE_SUFFIX}`;
}

function buildThinkingPrompt(memberId) {
  const { tier, subject } = THINKING_FIXUPS[memberId];
  const reaction = tier === 'A' ? HAND_GESTURE_REACTION : HEAD_TURN_REACTION;
  return `${THINKING_EXPRESSION_OVERRIDE_META} ${subject} ${reaction} ${STYLE_SUFFIX}`;
}

async function generateOne(memberId, reaction, prompt) {
  const baselinePath = path.join(PORTRAITS_DIR, `${memberId}.png`);
  const referenceImages = [{ mimeType: 'image/png', data: fs.readFileSync(baselinePath) }];
  const id = `${memberId}-${reaction}`;
  process.stdout.write(`Regenerating ${id}... `);
  try {
    const imageBuffer = await generatePortraitImage({ apiKey: process.env.GEMINI_API_KEY, prompt, referenceImages });
    const outPath = path.join(CANDIDATES_DIR, `${id}.png`);
    fs.writeFileSync(outPath, imageBuffer);
    console.log(`done (${imageBuffer.length} bytes) -> public/portraits/candidates/${id}.png`);
    return { id, ok: true };
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    return { id, ok: false, error: err.message };
  }
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY not set — cannot generate real portrait candidates.');
    process.exit(1);
  }
  fs.mkdirSync(CANDIDATES_DIR, { recursive: true });

  const results = [];
  results.push(await generateOne('randolph', 'happy', buildRandolphHappyPrompt()));
  for (const memberId of Object.keys(THINKING_FIXUPS)) {
    results.push(await generateOne(memberId, 'thinking', buildThinkingPrompt(memberId)));
  }

  console.log('\n=== SUMMARY ===');
  const okCount = results.filter(r => r.ok).length;
  console.log(`${okCount}/${results.length} candidates regenerated.`);
  for (const r of results.filter(r => !r.ok)) {
    console.log(`  FAILED: ${r.id} — ${r.error}`);
  }
  process.exit(results.every(r => r.ok) ? 0 : 1);
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
