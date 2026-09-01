'use strict';

// #435 — direct, server-callable portrait generation via the Gemini API
// (gemini-2.5-flash-image, "Nano Banana"). Express-agnostic by design, same
// convention as roster.js/pipeline.js: no module-level singletons, callers
// own the API key and pass it in.

const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';

// Spiked 2026-08-25: the existing 38 hand-generated portraits aren't
// uniformly one ratio (crowley.png is 512x466, near-square; most others are
// ~3:4 portrait), but 3:4 matches the majority and is a reasonable default —
// confirmed accepted and respected by generationConfig.imageConfig.aspectRatio
// in a real test call (864x1184 result), not assumed from docs.
const DEFAULT_ASPECT_RATIO = '3:4';

// Generates one portrait image from a ready-to-use prompt string. Returns a
// Buffer of the raw (un-resized) PNG bytes — resizing to the set's 512px
// convention happens at promotion time (scripts/promote-portrait.js), not
// here, so this stays a pure generate-and-return call.
//
// Optional `referenceImages` ([{ mimeType, data (Buffer) }]) are sent as
// inlineData parts ahead of the text prompt — gemini-2.5-flash-image treats
// leading images as subjects to keep consistent with, which anchors likeness
// and attire far more reliably than describing them in prose alone (spiked
// 2026-08-28 on #450 batch 2 after several reaction candidates drifted from
// their member's baseline despite a detailed text-only prompt).
async function generatePortraitImage({
  apiKey,
  prompt,
  model = GEMINI_IMAGE_MODEL,
  aspectRatio = DEFAULT_ASPECT_RATIO,
  referenceImages = [],
  fetchImpl = fetch,
}) {
  const imageParts = referenceImages.map(({ mimeType, data }) => ({
    inlineData: { mimeType, data: Buffer.isBuffer(data) ? data.toString('base64') : data },
  }));
  const response = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [...imageParts, { text: prompt }] }],
        generationConfig: { imageConfig: { aspectRatio } },
      }),
    }
  );

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new Error(`Gemini image generation failed: ${response.status} ${bodyText.slice(0, 300)}`);
  }

  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData?.data);
  if (!imagePart) {
    throw new Error('Gemini response had no image data');
  }

  return Buffer.from(imagePart.inlineData.data, 'base64');
}

// #450 — the #449-decided reaction taxonomy (happy/thinking/angry) and the
// prompt wording batch 3 (scripts/batch3-reaction-portraits.js) converged on
// after two earlier batches found a plain reference image pulls
// gemini-2.5-flash-image toward reproducing its own neutral expression
// unless explicitly and forcefully overridden. Kept verbatim here (not
// re-derived) so the automated new-member path in src/routes/member.js
// produces reaction candidates in the same register as the rest of the
// roster's hand-run batches, and so a future batch script can import this
// instead of re-copying the wording a fourth time.
const REACTION_TYPES = ['happy', 'thinking', 'angry'];

const REACTION_EXPRESSIONS = {
  happy:
    'Expression: a broad, unmistakable open-mouthed smile, teeth showing, cheeks pushed up high, eyes crinkled almost shut with genuine delighted laughter — an exuberant, joyful face, the opposite of a neutral or reserved expression.',
  thinking:
    'Expression: strongly inward and distracted — eyes unfocused and cast far into the middle distance (not toward the viewer at all), one eyebrow raised or brow deeply furrowed, mouth slightly open or twisted to one side as if murmuring — an obviously distracted, not-present face, the opposite of direct engagement with the viewer.',
  angry:
    'Expression: a hard, aggressive scowl — eyebrows sharply lowered and pulled together into a deep vertical crease, eyes narrowed to slits in a hard glare, mouth pulled into a tight snarl or bared teeth, jaw thrust forward — an unmistakably hostile, confrontational face.',
};

const REACTION_EXPRESSION_OVERRIDE_META =
  "This is a photo-editing task. The attached reference photo shows this person with a neutral, resting expression. Match the reference image's exact facial structure, likeness, skin tone, headwear, and attire — do not alter identity, age, or ethnicity. You must NOT reuse or approximate the reference photo's facial expression under any circumstances — that neutral expression is the one thing you must change. Use the reference ONLY to match likeness/attire/background, including eye color and darkness exactly as in the reference (do not lighten, recolor, or add any glow to the eyes). His or her expression in your output must be a completely different, strongly and unmistakably expressed emotion, described below. If your output's face looks close to the reference's expression, you have failed the task.";

const REACTION_STYLE_SUFFIX =
  "Visible linework and texture (engraving/ink-wash register), not photorealistic or cartoon/flat-vector. Limited warm sepia/candlelit palette, consistent across a set, matching the reference image's exact tone. Background matching the reference image's background exactly — flat and evenly lit, no vignette or gradient, matte and uniform edge to edge. Portrait-oriented, thumbnail resolution.";

// Builds a reaction prompt anchored entirely on a reference image (the
// member's own baseline portrait or candidate) rather than restating
// subject/attire in prose — unlike the batch scripts, which layer a hand-
// written subject clause on top of the reference for redundancy, the
// automated new-member path has no such hand-trimmed clause available, and
// the baseline prompt drafted for the neutral portrait already states its
// own "contemplative expression," which would compete with the reaction
// instruction below if reused here. The reference image + override meta is
// what actually anchors likeness (confirmed by batch 2/3's own findings), so
// omitting a redundant subject clause avoids that conflict.
function buildReactionPrompt(reaction) {
  return `${REACTION_EXPRESSION_OVERRIDE_META} ${REACTION_EXPRESSIONS[reaction]} ${REACTION_STYLE_SUFFIX}`;
}

module.exports = {
  generatePortraitImage,
  GEMINI_IMAGE_MODEL,
  DEFAULT_ASPECT_RATIO,
  REACTION_TYPES,
  buildReactionPrompt,
};
