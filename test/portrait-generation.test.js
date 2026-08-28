'use strict';

// #435 — src/portrait-generation.js under test.

const test = require('node:test');
const assert = require('node:assert/strict');

const { generatePortraitImage, GEMINI_IMAGE_MODEL, DEFAULT_ASPECT_RATIO } = require('../src/portrait-generation.js');

function fakeFetch({ ok = true, status = 200, json = {}, text = '' } = {}) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok,
      status,
      json: async () => json,
      text: async () => text,
    };
  };
  impl.calls = calls;
  return impl;
}

test('generatePortraitImage', async t => {
  await t.test('POSTs to the Gemini generateContent endpoint with the prompt and aspect ratio', async () => {
    const fetchImpl = fakeFetch({
      json: { candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from('hi').toString('base64') } }] } }] },
    });
    await generatePortraitImage({ apiKey: 'key123', prompt: 'a test prompt', fetchImpl });

    assert.equal(fetchImpl.calls.length, 1);
    const { url, opts } = fetchImpl.calls[0];
    assert.ok(url.startsWith(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=key123`));
    assert.equal(opts.method, 'POST');
    const body = JSON.parse(opts.body);
    assert.equal(body.contents[0].parts[0].text, 'a test prompt');
    assert.equal(body.generationConfig.imageConfig.aspectRatio, DEFAULT_ASPECT_RATIO);
  });

  await t.test('honors a custom model/aspectRatio when passed', async () => {
    const fetchImpl = fakeFetch({
      json: { candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from('hi').toString('base64') } }] } }] },
    });
    await generatePortraitImage({ apiKey: 'k', prompt: 'p', model: 'other-model', aspectRatio: '1:1', fetchImpl });

    const { url, opts } = fetchImpl.calls[0];
    assert.ok(url.includes('other-model:generateContent'));
    assert.equal(JSON.parse(opts.body).generationConfig.imageConfig.aspectRatio, '1:1');
  });

  await t.test('decodes the base64 inlineData into a Buffer', async () => {
    const raw = 'not actually a png, just test bytes';
    const fetchImpl = fakeFetch({
      json: {
        candidates: [
          { content: { parts: [{ text: 'here you go' }, { inlineData: { mimeType: 'image/png', data: Buffer.from(raw).toString('base64') } }] } },
        ],
      },
    });
    const result = await generatePortraitImage({ apiKey: 'k', prompt: 'p', fetchImpl });
    assert.ok(Buffer.isBuffer(result));
    assert.equal(result.toString(), raw);
  });

  await t.test('throws with the status and body when the request fails', async () => {
    const fetchImpl = fakeFetch({ ok: false, status: 429, text: 'quota exceeded' });
    await assert.rejects(
      () => generatePortraitImage({ apiKey: 'k', prompt: 'p', fetchImpl }),
      /Gemini image generation failed: 429 quota exceeded/
    );
  });

  await t.test('sends reference images as leading inlineData parts ahead of the text prompt', async () => {
    const fetchImpl = fakeFetch({
      json: { candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from('hi').toString('base64') } }] } }] },
    });
    await generatePortraitImage({
      apiKey: 'k',
      prompt: 'a test prompt',
      referenceImages: [{ mimeType: 'image/png', data: Buffer.from('ref-bytes') }],
      fetchImpl,
    });

    const body = JSON.parse(fetchImpl.calls[0].opts.body);
    assert.equal(body.contents[0].parts.length, 2);
    assert.equal(body.contents[0].parts[0].inlineData.mimeType, 'image/png');
    assert.equal(body.contents[0].parts[0].inlineData.data, Buffer.from('ref-bytes').toString('base64'));
    assert.equal(body.contents[0].parts[1].text, 'a test prompt');
  });

  await t.test('throws when the response has no image data', async () => {
    const fetchImpl = fakeFetch({
      json: { candidates: [{ content: { parts: [{ text: 'no image, just talk' }] } }] },
    });
    await assert.rejects(() => generatePortraitImage({ apiKey: 'k', prompt: 'p', fetchImpl }), /no image data/);
  });
});
