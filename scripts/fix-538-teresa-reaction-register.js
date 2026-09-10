'use strict';

// #538 — Teresa of Ávila's baseline portrait (public/portraits/teresa.png)
// reads in a different visual sub-register than her three reaction images:
// closed eyes, borderless (edge-to-edge), near-black background, painterly
// rendering on the baseline, vs. open eyes, plain white/cream border, warm
// background, more graphic linework on happy/thinking/angry (which agree
// with each other, so the baseline is the outlier). Found during the #531
// full-resolution audit but deliberately deferred there, since the fix isn't
// a simple regeneration-against-reference like #531's other findings — the
// baseline is also used elsewhere in the app (the default 3D-room seat
// texture, getPortraitTexture in public/js/scene/scene.js), so changing it
// has wider blast radius than a reaction-only fix.
//
// Rachel's call (issue discussion): keep the baseline as-is — it's the more
// frequently seen image — and regenerate the reaction set to match its
// register instead. This reuses fix-531-reaction-drift.js's approach
// (reference-anchored expression override + an explicit border/crop
// consistency instruction, since #531 found likeness/attire anchoring alone
// doesn't stop a set drifting on border/background/tone) but scoped to all
// three of Teresa's reactions against her actual baseline.
//
// Storage/naming: public/portraits/candidates/teresa-<reaction>.png, same as
// every prior batch. Per STYLE_GUIDE.md's human-validation gate, this
// script does NOT promote — it only writes candidates for review. Run
// scripts/promote-portrait.js on whichever candidates Rachel approves.
//
// Usage: node scripts/fix-538-teresa-reaction-register.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generatePortraitImage } = require('../src/portrait-generation');

const ROOT = path.join(__dirname, '..');
const PORTRAITS_DIR = path.join(ROOT, 'public', 'portraits');
const CANDIDATES_DIR = path.join(PORTRAITS_DIR, 'candidates');

const EXPRESSION_OVERRIDE_META =
  "This is a photo-editing task. The attached reference photo shows this person with a neutral, resting expression. Match the reference image's exact facial structure, likeness, skin tone, headwear, and attire — do not alter identity, age, or ethnicity. You must NOT reuse or approximate the reference photo's facial expression under any circumstances — that neutral, closed-eyed expression is the one thing you must change; render the eyes open as the reaction below requires. Use the reference ONLY to match likeness/attire/background, including eye color exactly as in the reference (do not lighten, recolor, or add any glow to the eyes). His or her expression in your output must be a completely different, strongly and unmistakably expressed emotion, described below. If your output's face looks close to the reference's expression, you have failed the task.";

// Same wording fix-531-reaction-drift.js added after the #531 audit found
// likeness/attire anchoring alone doesn't stop border/crop/background drift
// — this is exactly the axis Teresa's set drifted on, so it applies directly.
const CONSISTENCY_SUFFIX =
  "Match the reference image's border treatment exactly: the reference is borderless (the image runs edge-to-edge with no frame) — your output must be borderless too, with no white or cream border added. Match the reference's exact camera distance and crop — same head-and-shoulders framing, same amount of shoulder/torso visible, same zoom level. Do not zoom in closer, do not change the pose or add hand gestures, props, or framing not present in the reference. Match the reference's near-black background exactly — do not substitute a warm or lighter-toned background.";

const STYLE_SUFFIX =
  "Painterly rendering matching the reference image's register exactly — soft brushed shading and blended tone, not sharp graphic pencil/ink linework. Limited warm sepia palette, matching the reference image's exact tone. Portrait-oriented, thumbnail resolution.";

// Subject clause copied verbatim from BATCH-1-PROMPTS.md (the prompt that
// originally generated Teresa's baseline), so the regenerated reactions read
// as the same established portrait, minus the "calm contemplative
// expression" clause (which the reaction below replaces).
const SUBJECT =
  "Warm, etching-adjacent portrait of Teresa of Ávila, Spanish Carmelite mystic, 16th century — head-and-shoulders, plain brown Carmelite habit and white wimple. No photographic or contemporary likeness reference exists; render as a period-appropriate character study consistent with the set's register, not a specific likeness reproduction, favoring a secular character-study framing over reproducing existing devotional iconography (no halo, no ecstatic/visionary staging).";

// happy/angry revised to a subtler register after Rachel's review of the
// first candidates found them too broad (open-mouthed laugh, bared-teeth
// snarl) for the character — a contemplative, reserved mystic reads more
// convincingly with restrained versions of both. angry's wording mirrors
// the existing ANGRY_EXPRESSION_ICY register (src/portrait-generation.js,
// #483) already used for reserved/cerebral figures the bared-teeth default
// doesn't suit.
const REACTIONS = {
  happy:
    'Expression: a gentle, closed-mouth or softly parted smile, eyes open and warmly crinkled at the corners with quiet contentment — a restrained, inward warmth, not an exuberant open laugh or bared teeth.',
  thinking:
    'Expression: strongly inward and distracted — eyes open, unfocused and cast far into the middle distance (not toward the viewer at all), one eyebrow raised or brow deeply furrowed, mouth slightly open or twisted to one side as if murmuring — an obviously distracted, not-present face, the opposite of direct engagement with the viewer.',
  angry:
    'Expression: a controlled, icy anger — eyes open, narrowed and fixed in a cold, unblinking glare, brow drawn low and tight but without a deep aggressive crease, mouth and jaw held firmly closed (no bared teeth, no open snarl), lips pressed into a thin flat line, only the faintest hard tightening at the corners of the mouth and eyes betraying the fury underneath — a contained, quietly dangerous hostility, not a loss of composure.',
};

function buildPrompt(reaction) {
  return `${EXPRESSION_OVERRIDE_META} ${SUBJECT} ${REACTIONS[reaction]} ${CONSISTENCY_SUFFIX} ${STYLE_SUFFIX}`;
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY not set — cannot generate real portrait candidates.');
    process.exit(1);
  }

  const baselinePath = path.join(PORTRAITS_DIR, 'teresa.png');
  if (!fs.existsSync(baselinePath)) {
    console.error(`No baseline portrait found at public/portraits/teresa.png`);
    process.exit(1);
  }

  fs.mkdirSync(CANDIDATES_DIR, { recursive: true });

  const referenceImages = [{ mimeType: 'image/png', data: fs.readFileSync(baselinePath) }];

  // Optional CLI args restrict which reactions to (re)generate, e.g.
  // `node scripts/fix-538-teresa-reaction-register.js happy angry` to redo
  // just the ones that needed a second pass without re-rolling the rest.
  const requested = process.argv.slice(2);
  const reactionsToRun = requested.length > 0 ? requested : Object.keys(REACTIONS);
  for (const reaction of reactionsToRun) {
    if (!REACTIONS[reaction]) {
      console.error(`Unknown reaction "${reaction}" — expected one of: ${Object.keys(REACTIONS).join(', ')}`);
      process.exit(1);
    }
  }

  const results = [];
  for (const reaction of reactionsToRun) {
    const id = `teresa-${reaction}`;
    const prompt = buildPrompt(reaction);
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

  console.log('\n=== SUMMARY ===');
  const okCount = results.filter(r => r.ok).length;
  console.log(`${okCount}/${results.length} candidates generated.`);
  for (const r of results.filter(r => !r.ok)) {
    console.log(`  FAILED: ${r.id} — ${r.error}`);
  }
  console.log(
    '\nNext: review each candidate in public/portraits/candidates/ against public/portraits/teresa.png and STYLE_GUIDE.md, then promote the good ones with:\n' +
      reactionsToRun
        .map(r => `  node scripts/promote-portrait.js teresa-${r}`)
        .join('\n')
  );

  process.exit(results.every(r => r.ok) ? 0 : 1);
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
