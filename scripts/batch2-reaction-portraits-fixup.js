'use strict';

// #450 batch 2 fixup — regenerates reaction candidates that drifted from
// their member's baseline portrait on the first batch2 pass, per Rachel's
// 2026-08-28 review: Pixie (lost ethnic ambiguity/earrings/layered dress,
// over-warmed), Arabi (grew a beard and aged — wrong likeness), Maud (lost
// her distinctive draped shawl/upswept hair, reads as different women per
// reaction), Khaldun (reads notably younger than his deeply lined baseline),
// Llull (lost his skullcap), Dee (lost his sharp cheekbones/pointed groomed
// beard/black skullcap/structured ruff), and Warburg's `happy` reaction only
// (deracialized, aged, jowly — thinking/angry were fine and already
// promoted).
//
// Unlike the first batch2 pass and the #470 pilot, this run passes each
// member's own baseline portrait to Gemini as a reference image (see the
// referenceImages param added to src/portrait-generation.js) rather than
// relying on prose description alone — plain text re-description already
// failed once for these members, and gemini-2.5-flash-image treats a leading
// reference image as a subject to stay consistent with, which is a much
// stronger anchor for likeness/attire/headwear than more adjectives.
//
// Also folds in Rachel's vignette note: every prompt now explicitly asks for
// a flat, unvignetted background matching the reference, rather than leaving
// that to chance and fixing it after the fact.
//
// Storage/naming: same as every prior batch — writes to
// public/portraits/candidates/<id>-<reaction>.png, promote with
// scripts/promote-portrait.js after review.
//
// Usage: node scripts/batch2-reaction-portraits-fixup.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generatePortraitImage } = require('../src/portrait-generation');

const ROOT = path.join(__dirname, '..');
const PORTRAITS_DIR = path.join(ROOT, 'public', 'portraits');
const CANDIDATES_DIR = path.join(PORTRAITS_DIR, 'candidates');

const STYLE_SUFFIX =
  'Visible linework and texture (engraving/ink-wash register), not photorealistic or cartoon/flat-vector. Limited warm sepia/candlelit palette, consistent across a set. Plain dark background, no scene elements. Flat, evenly lit background with no vignette or gradient — matte and uniform edge to edge, matching the reference image\'s background exactly. Portrait-oriented, thumbnail resolution.';

// Base subject clauses (BATCH-1-PROMPTS.md), each with one added sentence
// pinning down the specific attribute that drifted on the first pass. A
// reference image of the member's own baseline portrait is also attached to
// every call below, so these sentences reinforce rather than solely carry
// the fix.
const MEMBER_SUBJECTS = {
  pixie:
    'Warm, etching-adjacent portrait of Pamela Colman Smith, Anglo-American artist and illustrator, Edwardian era — head-and-shoulders, short dark hair often bound in a headscarf, expressive intense eyes, bohemian artist\'s dress. Aim for a recognizable likeness consistent with surviving photographs. Match the reference image\'s exact skin tone and facial features precisely — do not lighten the skin or narrow the features. Keep the dangling earrings and the layered dress with visible fabric texture from the reference. Match the reference\'s sepia warmth exactly rather than a more intense warm tone.',
  arabi:
    'Warm, etching-adjacent portrait of Muhyiddin Ibn Arabi, Andalusian-then-Damascene Sufi scholar, late 12th/early 13th century — head-and-shoulders, turban and scholar\'s robes appropriate to the Ayyubid-era Islamic world, composed expression. No photographic or contemporary likeness reference exists; render as a period-appropriate character study consistent with the set\'s register, not a specific likeness reproduction, favoring a secular character-study framing over reproducing existing devotional iconography. Match the reference image\'s clean-shaven, youthful face exactly — do not add a beard or age the face.',
  maud:
    'Warm, etching-adjacent portrait of Maud Gonne, Irish revolutionary and actress, Edwardian era — head-and-shoulders, tall striking bearing, dark hair, elegant Edwardian dress, direct confident gaze. Aim for a recognizable likeness consistent with surviving photographs. Match the reference image\'s exact hairstyle (loose, upswept wavy hair) and draped shawl/wrap attire precisely — do not substitute a different dress or hairstyle.',
  khaldun:
    'Warm, etching-adjacent portrait of Ibn Khaldun, North African/Andalusian historian and statesman, 14th century — head-and-shoulders, turban and formal robes appropriate to a Mamluk-era scholar-official, composed authoritative expression. No photographic or contemporary likeness reference exists; render as a period-appropriate character study consistent with the set\'s register, not a specific likeness reproduction. Match the reference image\'s elderly, deeply lined, gaunt facial structure exactly — do not render a younger or fuller face.',
  llull:
    'Warm, etching-adjacent portrait of Ramon Llull, Majorcan philosopher and mystic, 13th/14th century — head-and-shoulders, plain religious tertiary\'s habit (post-conversion, not courtly dress), weathered contemplative face. No photographic or contemporary likeness reference exists; render as a period-appropriate character study consistent with the set\'s register, not a specific likeness reproduction. Match the reference image\'s headwear exactly (skullcap/tonsure beneath the hood) — do not omit it.',
  dee:
    'Warm, etching-adjacent portrait of John Dee, English mathematician and astrologer, Elizabethan era — head-and-shoulders, long white beard, black skullcap, scholar\'s gown and ruff collar, penetrating gaze. No photograph exists, but a well-known contemporary painted portrait survives (Ashmolean Museum) — use it as a loose likeness anchor while keeping the etching register rather than reproducing the painting directly. Match the reference image\'s sharp cheekbones, neatly pointed and well-groomed beard, plain black skullcap (not a beret or cornered cap), and structured Elizabethan ruff collar exactly.',
  warburg:
    'Warm, etching-adjacent portrait of Aby Warburg, German art historian, early 20th century — head-and-shoulders, formal suit, intense/haunted expression, receding hairline. Aim for a recognizable likeness consistent with surviving photographs. Match the reference image\'s exact facial structure, age, and skin tone precisely — do not age the face or add jowls.',
};

const REACTIONS = {
  happy: 'Expression: a genuine, warm brightening — eyes lit with real pleasure, the faint start of a smile, an open and unguarded look.',
  thinking:
    'Expression: inward and considering — gaze middle-distance or slightly downcast, brow faintly furrowed in concentration, the look of someone turning an idea over rather than addressing the viewer.',
  angry:
    'Expression: controlled, real indignation — jaw set, eyes narrowed and direct, tension held rather than shouted; intensity, not cartoonish rage.',
};

// member -> reactions to regenerate. Warburg only needs `happy` re-run;
// thinking/angry were fine and are already promoted.
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
  return `${MEMBER_SUBJECTS[memberId]} ${REACTIONS[reaction]} ${STYLE_SUFFIX}`;
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
      process.stdout.write(`Generating ${id} (with baseline reference)... `);
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
