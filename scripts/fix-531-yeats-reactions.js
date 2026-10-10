'use strict';

// #531 re-audit (2026-10-10) — Yeats is the one member whose promoted reaction
// set still drifts from his own baseline: yeats.png is a flat, dark-background
// portrait in a necktie, while yeats-happy/-thinking/-angry have a lighter
// vignetted background and a bow tie, and -happy also reads as an older man
// with differently styled hair. Rachel approved regenerating all three,
// anchored to the canonical baseline only — no new prop, redesign, or outside
// source (STYLE_GUIDE.md step 6). Blavatsky/Jung minor drifts and Böhme's
// cool palette were deliberately left alone at her direction.
//
// Writes candidates only; per STYLE_GUIDE.md step 5, nothing is promoted until
// a before/after review Artifact has had human sign-off.
//
// Usage: DOTENV_CONFIG_PATH=/path/to/.env node scripts/fix-531-yeats-reactions.js [happy thinking angry]

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  generatePortraitImage,
  buildReactionPrompt,
  REACTION_EXPRESSION_OVERRIDE_META,
  REACTION_STYLE_SUFFIX,
  ANGRY_EXPRESSION_SNARL,
} = require('../src/portrait-generation');

const PORTRAITS_DIR = path.join(__dirname, '..', 'public', 'portraits');
const CANDIDATES_DIR = path.join(PORTRAITS_DIR, 'candidates');

// Every clause below describes what is visible in yeats.png itself.
const LOCK =
  "Keep the reference's exact outfit: dark jacket, white high collar, and a dark necktie (a long four-in-hand necktie — NOT a bow tie). Keep the same wavy swept-back hair, same wire-rimmed round spectacles, and the same apparent age as the reference — do not age him up or restyle his hair. Match the reference's border treatment: borderless, the image runs edge-to-edge with no frame. Match the reference's exact camera distance and crop — same head-and-shoulders framing and amount of torso visible; no hand gestures or props. Match the reference's background exactly: a flat, dark, matte, uniformly toned background edge to edge — no lighter halo behind the head, no vignette, no gradient.";

// Closed-mouth anger that still reads as clearly angry: the plain ICY register came out
// closer to stern than furious, so this adds concrete facial cues that never need teeth.
const YEATS_ANGRY =
  'Expression: unmistakable, controlled fury with the mouth fully closed (no teeth visible at all, no open snarl) — brows driven sharply down and together with a deep vertical crease between them, eyes narrowed and glaring hard straight at the viewer from beneath the lowered brow, head tilted very slightly forward, nostrils flared, lips pressed tight and downturned with the jaw clenched and the muscles at the hinge of the jaw visibly tense, a hard line from nose to mouth corner — a face of cold, seething anger, clearly angry rather than merely stern.';

function buildPrompt(reaction) {
  // buildReactionPrompt = META + expression + STYLE_SUFFIX; splice LOCK in before the style suffix.
  let base = buildReactionPrompt(reaction, 'yeats');
  // Rachel's review of the first angry candidate: the default snarl showed bared teeth.
  // Yeats's anger is the closed-mouth register (#483), not the snarl.
  if (reaction === 'angry') {
    if (!base.includes(ANGRY_EXPRESSION_SNARL)) throw new Error('angry snarl text not found — update this script');
    base = base.replace(ANGRY_EXPRESSION_SNARL, YEATS_ANGRY);
  }
  if (!base.includes(REACTION_STYLE_SUFFIX) || !base.startsWith(REACTION_EXPRESSION_OVERRIDE_META)) {
    throw new Error('buildReactionPrompt layout changed — update this script');
  }
  return base.replace(REACTION_STYLE_SUFFIX, `${LOCK} ${REACTION_STYLE_SUFFIX}`);
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY not set.');
    process.exit(1);
  }
  fs.mkdirSync(CANDIDATES_DIR, { recursive: true });
  const referenceImages = [{ mimeType: 'image/png', data: fs.readFileSync(path.join(PORTRAITS_DIR, 'yeats.png')) }];
  const reactions = process.argv.slice(2).length ? process.argv.slice(2) : ['happy', 'thinking', 'angry'];
  let failed = false;
  for (const reaction of reactions) {
    const id = `yeats-${reaction}`;
    process.stdout.write(`Generating ${id}... `);
    try {
      const buf = await generatePortraitImage({ apiKey, prompt: buildPrompt(reaction), referenceImages });
      fs.writeFileSync(path.join(CANDIDATES_DIR, `${id}.png`), buf);
      console.log(`done (${buf.length} bytes)`);
    } catch (err) {
      failed = true;
      console.log(`FAILED: ${err.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

main();
