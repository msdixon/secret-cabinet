'use strict';

// #450 pilot — generates the #449-decided reaction set (happy/thinking/angry)
// for a small pilot cohort, through the existing #435 Gemini pipeline
// (src/portrait-generation.js), rather than the full 38-member roster. Per
// Rachel's 2026-08-28 decision on #449: pilot a few members first, validate
// live, then batch-generate the rest as a deliberate follow-up — this script
// is the pilot half only.
//
// Storage/naming: `public/portraits/candidates/<id>-<reaction>.png`, per
// #450's own suggested convention. scripts/promote-portrait.js needs no
// change to promote these — it already treats its `<id>` argument as an
// opaque string used to build both the candidate and canonical paths, so
// `node scripts/promote-portrait.js crowley-happy` works unmodified and
// keeps the same human-review gate the default portrait already requires
// (STYLE_GUIDE.md's "human-validate before treating the style as locked").
//
// Each prompt reuses the pilot member's own baseline BATCH-1-PROMPTS.md
// subject/likeness/attire clause verbatim (so the reaction reads as the same
// person, not a new character) and swaps only the expression/mood clause for
// the target reaction — same "Subject/Style/Composition/Lighting-Mood"
// template STYLE_GUIDE.md's Process already establishes, just varying the
// one field that's supposed to vary.
//
// Usage: node scripts/pilot-reaction-portraits.js

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
const PILOT_SUBJECTS = {
  crowley:
    "Warm, etching-adjacent portrait of Aleister Crowley, English ceremonial magician, Edwardian era — head-and-shoulders, shaved head, formal Edwardian dress or ceremonial magician's robe. Aim for a recognizable likeness consistent with surviving photographs.",
  yeats:
    'Warm, etching-adjacent portrait of William Butler Yeats, Irish poet, Edwardian era — head-and-shoulders, wire-rimmed spectacles, wavy hair, formal suit and cravat. Aim for a recognizable likeness consistent with surviving photographs.',
  teresa:
    "Warm, etching-adjacent portrait of Teresa of Ávila, Spanish Carmelite mystic, 16th century — head-and-shoulders, plain brown Carmelite habit and white wimple. No photographic or contemporary likeness reference exists; render as a period-appropriate character study consistent with the set's register, not a specific likeness reproduction, favoring a secular character-study framing over reproducing existing devotional iconography (no halo, no ecstatic/visionary staging).",
};

// The one field each reaction varies, per the #449-decided starter taxonomy.
const REACTIONS = {
  happy:
    'Expression: a genuine, warm brightening — eyes lit with real pleasure, the faint start of a smile, an open and unguarded look.',
  thinking:
    'Expression: inward and considering — gaze middle-distance or slightly downcast, brow faintly furrowed in concentration, the look of someone turning an idea over rather than addressing the viewer.',
  angry:
    'Expression: controlled, real indignation — jaw set, eyes narrowed and direct, tension held rather than shouted; intensity, not cartoonish rage.',
};

const PILOT_MEMBERS = ['crowley', 'yeats', 'teresa'];
const PILOT_REACTIONS = ['happy', 'thinking', 'angry'];

function buildPrompt(memberId, reaction) {
  return `${PILOT_SUBJECTS[memberId]} ${REACTIONS[reaction]} ${STYLE_SUFFIX}`;
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY not set — cannot generate real portrait candidates.');
    process.exit(1);
  }

  fs.mkdirSync(CANDIDATES_DIR, { recursive: true });

  const results = [];
  for (const memberId of PILOT_MEMBERS) {
    for (const reaction of PILOT_REACTIONS) {
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
    '\nNext: review each candidate in public/portraits/candidates/, then promote the good ones with:\n' +
      PILOT_MEMBERS.flatMap(m => PILOT_REACTIONS.map(r => `  node scripts/promote-portrait.js ${m}-${r}`)).join('\n')
  );

  process.exit(results.every(r => r.ok) ? 0 : 1);
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
