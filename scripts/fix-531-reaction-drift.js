'use strict';

// #531 — targeted regeneration for reaction portraits found, on a full
// audit of all 37 reaction sets against their own baseline, to have drifted
// in outfit, border/frame, background tone, or camera distance — not just
// expression. Filed after Rachel caught Crowley's -thinking/-angry reading
// as "a completely different person" live; the audit (see PR description)
// found two more fully-drifted sets (Waite, Blavatsky) and a narrower
// recurring pattern where a member's -thinking image alone drops the
// reference's border and zooms to a tighter hand-to-chin crop the other
// three reactions don't share (frieda-harris, dion-fortune, moina-mathers,
// jung), plus one tone-only drift (bohme -thinking).
//
// This reuses src/portrait-generation.js's EXPRESSION_OVERRIDE_META and the
// concrete physically-described REACTIONS wording batch 2/3 converged on,
// but adds an explicit CONSISTENCY_SUFFIX the prior batches never needed to
// state outright — match the reference's border treatment, crop distance,
// and framing, not just its likeness/attire. That gap is exactly what let
// these sets drift while each individual generation still "looked fine" in
// isolation.
//
// Storage/naming: public/portraits/candidates/<id>-<reaction>.png, same as
// every prior batch. Per STYLE_GUIDE.md's human-validation gate, this
// script does NOT promote — it only writes candidates for review. Run
// scripts/promote-portrait.js on whichever candidates Rachel approves.
//
// Usage: node scripts/fix-531-reaction-drift.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generatePortraitImage } = require('../src/portrait-generation');

const ROOT = path.join(__dirname, '..');
const PORTRAITS_DIR = path.join(ROOT, 'public', 'portraits');
const CANDIDATES_DIR = path.join(PORTRAITS_DIR, 'candidates');

const EXPRESSION_OVERRIDE_META =
  "This is a photo-editing task. The attached reference photo shows this person with a neutral, resting expression. Match the reference image's exact facial structure, likeness, skin tone, headwear, and attire — do not alter identity, age, or ethnicity. You must NOT reuse or approximate the reference photo's facial expression under any circumstances — that neutral expression is the one thing you must change. Use the reference ONLY to match likeness/attire/background, including eye color and darkness exactly as in the reference (do not lighten, recolor, or add any glow to the eyes). His or her expression in your output must be a completely different, strongly and unmistakably expressed emotion, described below. If your output's face looks close to the reference's expression, you have failed the task.";

// New for #531 — the prior batches' prompts anchored likeness/attire/expression
// but never said anything about border, crop, or camera distance, and multiple
// members' sets drifted on exactly those axes despite passing per-image review.
const CONSISTENCY_SUFFIX =
  "Match the reference image's border treatment exactly: if the reference has a plain white or cream border framing the portrait, reproduce that same border style and thickness; if the reference is borderless (the image runs edge-to-edge with no frame), your output must be borderless too — do not add a border that is not in the reference, and do not drop one that is. Match the reference's exact camera distance and crop — same head-and-shoulders framing, same amount of shoulder/torso visible, same zoom level. Do not zoom in closer, do not change the pose or add hand gestures, props, or framing not present in the reference. Keep the exact same outfit, garment colors, and background color/tone as the reference — do not substitute a different tie, collar, or garment style.";

const STYLE_SUFFIX =
  "Visible linework and texture (engraving/ink-wash register), not photorealistic or cartoon/flat-vector. Limited warm sepia/candlelit palette, consistent across a set, matching the reference image's exact tone. Background matching the reference image's background exactly — flat and evenly lit, no vignette or gradient, matte and uniform edge to edge. Portrait-oriented, thumbnail resolution.";

// Subject clauses copied verbatim from the batch that originally generated
// each member's baseline (pilot / batch2 / batch3), so the regenerated
// reaction reads as the same established portrait.
const MEMBER_SUBJECTS = {
  crowley:
    "Warm, etching-adjacent portrait of Aleister Crowley, English ceremonial magician, Edwardian era — head-and-shoulders, shaved head, formal Edwardian dress or ceremonial magician's robe. Aim for a recognizable likeness consistent with surviving photographs.",
  waite:
    'Warm, etching-adjacent portrait of Arthur Edward Waite, English occult scholar, late-Victorian/Edwardian era — head-and-shoulders, formal dark suit and high collar, mustache, scholarly bearing. Aim for a recognizable likeness consistent with surviving photographs.',
  blavatsky:
    'Warm, etching-adjacent portrait of Helena Petrovna Blavatsky, Russian-born Theosophist, Victorian era — head-and-shoulders, imposing older woman, elaborate Victorian dress, piercing direct gaze, rings visible if hands are in frame. Aim for a recognizable likeness consistent with surviving photographs.',
  'frieda-harris':
    'Warm, etching-adjacent portrait of Lady Frieda Harris, English artist, 1930s–40s — head-and-shoulders, refined older Englishwoman, elegant period dress, poised confident bearing.',
  'dion-fortune':
    'Warm, etching-adjacent portrait of Dion Fortune (Violet Mary Firth), English occultist, early 20th century — head-and-shoulders, formal 1920s–30s dress.',
  'moina-mathers':
    'Warm, etching-adjacent portrait of Moina Mathers, Golden Dawn co-leader and artist, Edwardian era — head-and-shoulders, formal Edwardian dress or Golden Dawn ceremonial regalia.',
  jung: 'Warm, etching-adjacent portrait of Carl Gustav Jung, Swiss psychiatrist, mid-20th century — head-and-shoulders, glasses, formal suit, pipe optional.',
  bohme:
    "Warm, etching-adjacent portrait of Jakob Böhme, German shoemaker and mystic, early 17th century — head-and-shoulders, plain burgher/tradesman's dress (not scholar's robes or clerical dress — he had no Latin and no theological training), a cobbler's awl or scrap of leatherwork visible at the frame's edge as a concrete trade marker. Surviving 17th-century engraved frontispiece portraits exist from posthumous editions of his work; use them as a loose likeness anchor while keeping the set's etching register, not a direct reproduction.",
};

const REACTIONS = {
  happy:
    'Expression: a broad, unmistakable open-mouthed smile, teeth showing, cheeks pushed up high, eyes crinkled almost shut with genuine delighted laughter — an exuberant, joyful face, the opposite of a neutral or reserved expression.',
  thinking:
    'Expression: strongly inward and distracted — eyes unfocused and cast far into the middle distance (not toward the viewer at all), one eyebrow raised or brow deeply furrowed, mouth slightly open or twisted to one side as if murmuring — an obviously distracted, not-present face, the opposite of direct engagement with the viewer.',
  angry:
    'Expression: a hard, aggressive scowl — eyebrows sharply lowered and pulled together into a deep vertical crease, eyes narrowed to slits in a hard glare, mouth pulled into a tight snarl or bared teeth, jaw thrust forward — an unmistakably hostile, confrontational face.',
};

// Member -> reactions confirmed drifted by the #531 full-resolution audit.
const FIXES = {
  crowley: ['thinking', 'angry'],
  waite: ['happy', 'thinking', 'angry'],
  blavatsky: ['happy', 'thinking', 'angry'],
  'frieda-harris': ['thinking'],
  'dion-fortune': ['thinking'],
  'moina-mathers': ['thinking'],
  jung: ['thinking'],
  bohme: ['thinking'],
};

function buildPrompt(memberId, reaction) {
  return `${EXPRESSION_OVERRIDE_META} ${MEMBER_SUBJECTS[memberId]} ${REACTIONS[reaction]} ${CONSISTENCY_SUFFIX} ${STYLE_SUFFIX}`;
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY not set — cannot generate real portrait candidates.');
    process.exit(1);
  }

  fs.mkdirSync(CANDIDATES_DIR, { recursive: true });

  const results = [];
  for (const [memberId, reactions] of Object.entries(FIXES)) {
    const baselinePath = path.join(PORTRAITS_DIR, `${memberId}.png`);
    if (!fs.existsSync(baselinePath)) {
      console.log(`SKIPPING ${memberId} — no baseline portrait found at public/portraits/${memberId}.png`);
      results.push({ id: memberId, ok: false, error: 'no baseline portrait' });
      continue;
    }
    const referenceImages = [{ mimeType: 'image/png', data: fs.readFileSync(baselinePath) }];

    for (const reaction of reactions) {
      const id = `${memberId}-${reaction}`;
      const prompt = buildPrompt(memberId, reaction);
      process.stdout.write(`Generating ${id}... `);
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
  console.log(
    '\nNext: review each candidate in public/portraits/candidates/ against the baseline portrait and STYLE_GUIDE.md, then promote the good ones with:\n' +
      Object.entries(FIXES)
        .flatMap(([m, reactions]) => reactions.map(r => `  node scripts/promote-portrait.js ${m}-${r}`))
        .join('\n')
  );

  process.exit(results.every(r => r.ok) ? 0 : 1);
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
