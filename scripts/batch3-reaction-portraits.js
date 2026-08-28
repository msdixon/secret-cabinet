'use strict';

// #450 batch 3 — generates the #449-decided reaction set (happy/thinking/angry)
// for the remaining 25 roster members past the #470 pilot (Crowley, Yeats,
// Teresa) and the #472 batch 2 cohort (Waite, Coleman-Smith, Blavatsky, Lévi,
// Ibn Arabi, Maud Gonne, Llull, Ibn Khaldun, Dee, Warburg) — closing out all
// 38/38 roster members. Rachel approved budget for this batch on 2026-08-28
// after reviewing the pilot's cost/quality via the Gemini billing dashboard.
//
// Unlike batch 2, this script does NOT do a first text-only pass and then a
// separate fixup pass — it starts from the fully-tuned approach batch 2 only
// arrived at after two rounds (see STYLE_GUIDE.md's Changelog and
// scripts/batch2-reaction-portraits-fixup.js):
//   1. Each member's own baseline portrait is attached as a `referenceImages`
//      anchor (far stronger likeness/attire anchor than prose alone).
//   2. An explicit "do not reuse the reference's neutral expression" override,
//      because a strong reference image otherwise pulls gemini-2.5-flash-image
//      toward reproducing the reference's own expression instead of the
//      requested reaction.
//   3. Concrete, physically-described reaction text (mouth/eyes/brow
//      position) rather than mood adjectives alone — what actually forces a
//      real, visible expression change against the reference's pull.
//   4. A flat-background instruction anchored to the reference's own
//      background, avoiding the inconsistent vignetting batch 2 first found.
//
// Storage/naming: public/portraits/candidates/<id>-<reaction>.png, same as
// every prior batch. Per STYLE_GUIDE.md's human-validation gate, this script
// does NOT promote — it only writes candidates for review. Run
// scripts/promote-portrait.js on whichever candidates Rachel approves.
//
// Usage: node scripts/batch3-reaction-portraits.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generatePortraitImage } = require('../src/portrait-generation');

const ROOT = path.join(__dirname, '..');
const PORTRAITS_DIR = path.join(ROOT, 'public', 'portraits');
const CANDIDATES_DIR = path.join(PORTRAITS_DIR, 'candidates');

// Same wording batch 2's fixup arrived at after Rachel's review of #472 caught
// the reference image pulling expressions toward its own neutral baseline —
// carried over verbatim rather than rediscovering the same problem here.
// Also generalizes the per-member "match the reference exactly" phrasing
// batch 2's fixup had to hand-write per member (Pixie's earrings, Dee's
// cheekbones, etc.) into one standing instruction, since this batch has no
// prior candidate to diff against and flag member-specific drift from yet.
const EXPRESSION_OVERRIDE_META =
  "This is a photo-editing task. The attached reference photo shows this person with a neutral, resting expression. Match the reference image's exact facial structure, likeness, skin tone, headwear, and attire — do not alter identity, age, or ethnicity. You must NOT reuse or approximate the reference photo's facial expression under any circumstances — that neutral expression is the one thing you must change. Use the reference ONLY to match likeness/attire/background, including eye color and darkness exactly as in the reference (do not lighten, recolor, or add any glow to the eyes). His or her expression in your output must be a completely different, strongly and unmistakably expressed emotion, described below. If your output's face looks close to the reference's expression, you have failed the task.";

const STYLE_SUFFIX =
  "Visible linework and texture (engraving/ink-wash register), not photorealistic or cartoon/flat-vector. Limited warm sepia/candlelit palette, consistent across a set, matching the reference image's exact tone. Background matching the reference image's background exactly — flat and evenly lit, no vignette or gradient, matte and uniform edge to edge. Portrait-oriented, thumbnail resolution.";

// Subject/likeness clauses drawn from BATCH-1-PROMPTS.md / WAVE-4-PROMPTS.md,
// trimmed of their baseline "expression" fragment (REACTIONS below supplies
// the expression instead) and of the shared style/composition boilerplate
// (STYLE_SUFFIX supplies that, now anchored to the reference image rather
// than restated as generic prose).
const MEMBER_SUBJECTS = {
  corbin:
    'Warm, etching-adjacent portrait of Henri Corbin, French philosopher, mid-20th century — head-and-shoulders, glasses, formal suit.',
  adorno:
    'Warm, etching-adjacent portrait of Theodor W. Adorno, German philosopher, mid-20th century — head-and-shoulders, glasses, formal suit and tie.',
  bruno:
    "Warm, etching-adjacent portrait of Giordano Bruno, Italian philosopher, late 16th century — head-and-shoulders, plain traveling scholar's robes (not a specific religious order's habit, since he left the Dominicans). No contemporary likeness survives; render as a period-appropriate character study consistent with the set's register, not a specific likeness reproduction.",
  'al-hallaj':
    "Warm, etching-adjacent portrait of Husayn ibn Mansur al-Hallaj, Persian Sufi mystic, 9th/10th century — head-and-shoulders, plain robes appropriate to an early medieval Sufi ascetic, weathered face. No photographic or contemporary likeness reference exists; render as a period-appropriate character study consistent with the set's register, favoring a secular character-study framing over reproducing existing devotional iconography.",
  abulafia:
    "Warm, etching-adjacent portrait of Abraham Abulafia, Sephardi Kabbalist, 13th century — head-and-shoulders, plain medieval Jewish scholar's dress appropriate to Aragon/Castile. No photographic or contemporary likeness reference exists; render as a period-appropriate character study consistent with the set's register, favoring a secular character-study framing over reproducing religious iconography.",
  'frieda-harris':
    'Warm, etching-adjacent portrait of Lady Frieda Harris, English artist, 1930s–40s — head-and-shoulders, refined older Englishwoman, elegant period dress, poised confident bearing.',
  'dion-fortune':
    'Warm, etching-adjacent portrait of Dion Fortune (Violet Mary Firth), English occultist, early 20th century — head-and-shoulders, formal 1920s–30s dress.',
  'william-blake':
    "Warm, etching-adjacent portrait of William Blake, English poet and engraver, Georgian era — head-and-shoulders, plain Georgian dress, wide intense visionary eyes, high forehead. No photograph exists, but a well-known contemporary painted portrait survives (Thomas Phillips, 1807) — use it as a loose likeness anchor while keeping the etching register rather than reproducing the painting directly.",
  'catherine-blake':
    "Warm, etching-adjacent portrait of Catherine Blake, English artisan and engraver, Georgian era — head-and-shoulders, plain working-class Georgian woman's dress and cap. No photographic or contemporary likeness reference exists; render as a period-appropriate character study consistent with the set's register, not a specific likeness reproduction.",
  yates:
    'Warm, etching-adjacent portrait of Frances Yates, English historian, mid-20th century — head-and-shoulders, glasses, sensible tweed or cardigan.',
  scholem:
    'Warm, etching-adjacent portrait of Gershom Scholem, German-Israeli scholar, mid-20th century — head-and-shoulders, glasses, formal suit.',
  'moina-mathers':
    'Warm, etching-adjacent portrait of Moina Mathers, Golden Dawn co-leader and artist, Edwardian era — head-and-shoulders, formal Edwardian dress or Golden Dawn ceremonial regalia.',
  randolph:
    'Warm, etching-adjacent portrait of Paschal Beverly Randolph, American Rosicrucian founder and physician, mid-19th century — head-and-shoulders, formal mid-Victorian dress appropriate to a Black American professional man of the period.',
  bamba:
    'Warm, etching-adjacent portrait of Cheikh Ahmadou Bamba Mbacké, Senegalese Sufi founder of the Muridiyya, late 19th/early 20th century — head-and-shoulders, white boubou robe, turban, calm contemplative bearing. Aim for general recognizable likeness (dress, complexion, bearing) without directly reproducing the specific composition of the one surviving reverently-regarded photograph of him.',
  'sun-ra':
    "Warm, etching-adjacent portrait of Sun Ra, American musician and cosmic philosopher, mid-20th century — head-and-shoulders, his own signature Afrofuturist/Egyptian-inspired regalia (sequined robes, elaborate headdress) rather than generic period dress — this self-created look is the correct 'period-appropriate dress' for this figure.",
  porete:
    "Warm, etching-adjacent portrait of Marguerite Porete, French mystic and Beguine, 13th century — head-and-shoulders, a younger-to-middle-aged woman (30s-40s), an informal lay veil worn loosely and asymmetrically, with visible hair escaping at the temple (undyed grayish-brown wool, not a black or dark habit-cloth). A small hand-bound book — her own Mirouer des simples âmes — held up near her chest or shoulder, actively displayed. No photographic or contemporary likeness reference exists; render as a period-appropriate character study consistent with the set's register, not a specific likeness reproduction.",
  hildegard:
    "Warm, etching-adjacent portrait of Hildegard of Bingen, German Benedictine abbess, 12th century — head-and-shoulders, visibly elderly (70s-80s, deeply lined face, heavy-lidded eyes), black Benedictine habit with a stiff, severe black wimple pinned tightly and close to the face. A plain wooden staff of monastic office rests visibly against her shoulder or is held in one hand. No photographic or contemporary likeness reference exists; render as a period-appropriate character study consistent with the set's register, favoring a secular character-study framing over reproducing existing devotional/illuminated-manuscript iconography (no halo, no visionary light-beam staging).",
  julian:
    "Warm, etching-adjacent portrait of Julian of Norwich, English anchoress, later 14th century, framed as seen through a small stone window aperture — the historical 'anchorhold squint,' the actual physical opening through which an enclosed anchoress spoke to visitors. Her face and shoulders are visible within the window's dark stone frame, partially shadowed but not obscured. She reads as elderly — 50s or 60s, weathered and deeply lined, silver or grey hair at the edges of the wimple. Dress: a coarse black or undyed wool habit, plainer and less voluminous than a formal monastic order's habit, a simple linen wimple and veil pinned close, consistent with 14th-century English anchoritic dress. Favor this secular, architectural framing over any devotional staging.",
  jung:
    'Warm, etching-adjacent portrait of Carl Gustav Jung, Swiss psychiatrist, mid-20th century — head-and-shoulders, glasses, formal suit, pipe optional.',
  pauli:
    'Warm, etching-adjacent portrait of Wolfgang Pauli, Austrian theoretical physicist, mid-20th century — head-and-shoulders, glasses, formal suit.',
  eckhart:
    "Warm, etching-adjacent portrait of Meister Eckhart, German Dominican friar and mystical theologian, early 14th century — head-and-shoulders, Dominican habit (white tunic, black scapular and cappa, hood), the bearing of a senior churchman who administered an entire province (Vicar-General of Bohemia) rather than a cloistered contemplative. No photographic or contemporary likeness reference exists; render as a period-appropriate character study consistent with the set's register, not a specific likeness reproduction.",
  bohme:
    "Warm, etching-adjacent portrait of Jakob Böhme, German shoemaker and mystic, early 17th century — head-and-shoulders, plain burgher/tradesman's dress (not scholar's robes or clerical dress — he had no Latin and no theological training), a cobbler's awl or scrap of leatherwork visible at the frame's edge as a concrete trade marker. Surviving 17th-century engraved frontispiece portraits exist from posthumous editions of his work; use them as a loose likeness anchor while keeping the set's etching register, not a direct reproduction.",
  swedenborg:
    "Warm, etching-adjacent portrait of Emanuel Swedenborg, Swedish scientist and visionary, 18th century — head-and-shoulders, formal 18th-century dress appropriate to a Swedish assessor of the Royal College of Mines (plain coat, natural or lightly-powdered white hair, no ostentation). A well-known contemporary oil portrait survives (Per Krafft the Elder); use it as a loose likeness anchor while keeping the set's etching register, not a direct reproduction.",
  paracelsus:
    "Warm, etching-adjacent portrait of Paracelsus (Theophrastus von Hohenheim), Swiss-German physician and alchemist, early 16th century — head-and-shoulders, unconventional dress for a physician of his era (plain traveling clothes rather than an academic gown, no doctoral cap). The hilt of his long sword — rumored among students to contain a store of his own medicines — visible at one shoulder as a concrete distinguishing detail. Surviving 16th-century painted and engraved portraits exist; use them as a loose likeness anchor while keeping the set's etching register, not a direct reproduction.",
  gurdjieff:
    'Warm, etching-adjacent portrait of G.I. Gurdjieff, Greek-Armenian teacher born in the Caucasus, early 20th century — head-and-shoulders, shaved/bald head, heavy dark mustache, formal early-20th-century dress, the bearing of a man running an institute rather than a monastery.',
};

// Concrete, physically-described expressions — the wording batch 2's fixup
// arrived at, which actually overrides a reference image's pull toward
// reproducing its own neutral expression. Kept verbatim for consistency
// across the whole reaction set regardless of which batch generated a given
// image.
const REACTIONS = {
  happy:
    'Expression: a broad, unmistakable open-mouthed smile, teeth showing, cheeks pushed up high, eyes crinkled almost shut with genuine delighted laughter — an exuberant, joyful face, the opposite of a neutral or reserved expression.',
  thinking:
    'Expression: strongly inward and distracted — eyes unfocused and cast far into the middle distance (not toward the viewer at all), one eyebrow raised or brow deeply furrowed, mouth slightly open or twisted to one side as if murmuring — an obviously distracted, not-present face, the opposite of direct engagement with the viewer.',
  angry:
    'Expression: a hard, aggressive scowl — eyebrows sharply lowered and pulled together into a deep vertical crease, eyes narrowed to slits in a hard glare, mouth pulled into a tight snarl or bared teeth, jaw thrust forward — an unmistakably hostile, confrontational face.',
};

const BATCH_MEMBERS = Object.keys(MEMBER_SUBJECTS);
const BATCH_REACTIONS = ['happy', 'thinking', 'angry'];

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
  for (const memberId of BATCH_MEMBERS) {
    const baselinePath = path.join(PORTRAITS_DIR, `${memberId}.png`);
    if (!fs.existsSync(baselinePath)) {
      console.log(`SKIPPING ${memberId} — no baseline portrait found at public/portraits/${memberId}.png`);
      results.push({ id: memberId, ok: false, error: 'no baseline portrait' });
      continue;
    }
    const referenceImages = [{ mimeType: 'image/png', data: fs.readFileSync(baselinePath) }];

    for (const reaction of BATCH_REACTIONS) {
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
      BATCH_MEMBERS.flatMap(m => BATCH_REACTIONS.map(r => `  node scripts/promote-portrait.js ${m}-${r}`)).join('\n')
  );

  process.exit(results.every(r => r.ok) ? 0 : 1);
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
