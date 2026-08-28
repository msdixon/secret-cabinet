'use strict';

// #450 batch 2 — generates the #449-decided reaction set (happy/thinking/angry)
// for the next 10 roster members past the #470 pilot cohort (Crowley, Yeats,
// Teresa), through the existing #435 Gemini pipeline (src/portrait-generation.js).
// Rachel approved budget for this batch on 2026-08-28, having reviewed the
// pilot's cost/quality via the Gemini billing dashboard herself.
//
// Members: the next 10 in prompts/members/roster.json's listed order after
// skipping the 3 pilot members (waite, pixie, blavatsky, levi, arabi, maud,
// llull, khaldun, dee, warburg).
//
// Storage/naming: `public/portraits/candidates/<id>-<reaction>.png`, same as
// the pilot. scripts/promote-portrait.js needs no change to promote these.
//
// Each prompt reuses the member's own baseline BATCH-1-PROMPTS.md
// subject/likeness/attire clause verbatim (so the reaction reads as the same
// person, not a new character) and swaps only the expression/mood clause for
// the target reaction — same template STYLE_GUIDE.md's Process establishes,
// and the same REACTIONS wording the pilot script used, for consistency
// across the whole reaction set regardless of which batch generated it.
//
// Per STYLE_GUIDE.md's human-validation gate, this script does NOT promote —
// it only writes candidates for review. Run scripts/promote-portrait.js on
// whichever candidates Rachel approves.
//
// Usage: node scripts/batch2-reaction-portraits.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generatePortraitImage } = require('../src/portrait-generation');

const ROOT = path.join(__dirname, '..');
const CANDIDATES_DIR = path.join(ROOT, 'public', 'portraits', 'candidates');

const STYLE_SUFFIX =
  'Visible linework and texture (engraving/ink-wash register), not photorealistic or cartoon/flat-vector. Limited warm sepia/candlelit palette, consistent across a set. Plain dark background, no scene elements. Portrait-oriented, thumbnail resolution.';

// Subject/likeness/attire clauses copied verbatim from BATCH-1-PROMPTS.md so
// these read as the same established portrait, not a new character — only
// the expression/mood fragment (REACTIONS below) is swapped in.
const MEMBER_SUBJECTS = {
  waite:
    'Warm, etching-adjacent portrait of Arthur Edward Waite, English occult scholar, late-Victorian/Edwardian era — head-and-shoulders, formal dark suit and high collar, mustache, scholarly bearing. Aim for a recognizable likeness consistent with surviving photographs.',
  pixie:
    'Warm, etching-adjacent portrait of Pamela Colman Smith, Anglo-American artist and illustrator, Edwardian era — head-and-shoulders, short dark hair often bound in a headscarf, expressive intense eyes, bohemian artist\'s dress. Aim for a recognizable likeness consistent with surviving photographs.',
  blavatsky:
    'Warm, etching-adjacent portrait of Helena Petrovna Blavatsky, Russian-born Theosophist, Victorian era — head-and-shoulders, imposing older woman, elaborate Victorian dress, piercing direct gaze, rings visible if hands are in frame. Aim for a recognizable likeness consistent with surviving photographs.',
  levi:
    'Warm, etching-adjacent portrait of Éliphas Lévi (Alphonse Louis Constant), French occultist, mid-19th century — head-and-shoulders, beard, dark formal coat with the residual bearing of a lapsed seminarian, direct gaze. Aim for a recognizable likeness consistent with surviving photographs.',
  arabi:
    'Warm, etching-adjacent portrait of Muhyiddin Ibn Arabi, Andalusian-then-Damascene Sufi scholar, late 12th/early 13th century — head-and-shoulders, turban and scholar\'s robes appropriate to the Ayyubid-era Islamic world, composed expression. No photographic or contemporary likeness reference exists; render as a period-appropriate character study consistent with the set\'s register, not a specific likeness reproduction, favoring a secular character-study framing over reproducing existing devotional iconography.',
  maud:
    'Warm, etching-adjacent portrait of Maud Gonne, Irish revolutionary and actress, Edwardian era — head-and-shoulders, tall striking bearing, dark hair, elegant Edwardian dress, direct confident gaze. Aim for a recognizable likeness consistent with surviving photographs.',
  llull:
    'Warm, etching-adjacent portrait of Ramon Llull, Majorcan philosopher and mystic, 13th/14th century — head-and-shoulders, plain religious tertiary\'s habit (post-conversion, not courtly dress), weathered contemplative face. No photographic or contemporary likeness reference exists; render as a period-appropriate character study consistent with the set\'s register, not a specific likeness reproduction.',
  khaldun:
    'Warm, etching-adjacent portrait of Ibn Khaldun, North African/Andalusian historian and statesman, 14th century — head-and-shoulders, turban and formal robes appropriate to a Mamluk-era scholar-official, composed authoritative expression. No photographic or contemporary likeness reference exists; render as a period-appropriate character study consistent with the set\'s register, not a specific likeness reproduction.',
  dee:
    'Warm, etching-adjacent portrait of John Dee, English mathematician and astrologer, Elizabethan era — head-and-shoulders, long white beard, black skullcap, scholar\'s gown and ruff collar, penetrating gaze. No photograph exists, but a well-known contemporary painted portrait survives (Ashmolean Museum) — use it as a loose likeness anchor while keeping the etching register rather than reproducing the painting directly.',
  warburg:
    'Warm, etching-adjacent portrait of Aby Warburg, German art historian, early 20th century — head-and-shoulders, formal suit, intense/haunted expression, receding hairline. Aim for a recognizable likeness consistent with surviving photographs.',
};

// Same wording the #470 pilot used, kept identical for consistency across
// the whole reaction set regardless of which batch generated a given image.
const REACTIONS = {
  happy: 'Expression: a genuine, warm brightening — eyes lit with real pleasure, the faint start of a smile, an open and unguarded look.',
  thinking:
    'Expression: inward and considering — gaze middle-distance or slightly downcast, brow faintly furrowed in concentration, the look of someone turning an idea over rather than addressing the viewer.',
  angry:
    'Expression: controlled, real indignation — jaw set, eyes narrowed and direct, tension held rather than shouted; intensity, not cartoonish rage.',
};

const BATCH_MEMBERS = ['waite', 'pixie', 'blavatsky', 'levi', 'arabi', 'maud', 'llull', 'khaldun', 'dee', 'warburg'];
const BATCH_REACTIONS = ['happy', 'thinking', 'angry'];

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
  for (const memberId of BATCH_MEMBERS) {
    for (const reaction of BATCH_REACTIONS) {
      const id = `${memberId}-${reaction}`;
      const prompt = buildPrompt(memberId, reaction);
      process.stdout.write(`Generating ${id}... `);
      try {
        const start = Date.now();
        const imageBuffer = await generatePortraitImage({ apiKey, prompt });
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
      BATCH_MEMBERS.flatMap(m => BATCH_REACTIONS.map(r => `  node scripts/promote-portrait.js ${m}-${r}`)).join('\n')
  );

  process.exit(results.every(r => r.ok) ? 0 : 1);
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
