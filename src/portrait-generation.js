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

module.exports = { generatePortraitImage, GEMINI_IMAGE_MODEL, DEFAULT_ASPECT_RATIO };
