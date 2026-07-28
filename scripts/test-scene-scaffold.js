'use strict';

// Ad hoc validation script for the Babylon.js scaffold (Phase 0 of #26).
// Requires a locally running dev server (npm run dev). Run with:
//   node scripts/test-scene-scaffold.js

const BASE = `http://localhost:${process.env.PORT || 3132}`;

async function checkVendorScript() {
  const res = await fetch(`${BASE}/vendor/babylonjs/babylon.js`);
  const ct = res.headers.get('content-type') || '';
  if (res.status !== 200) throw new Error(`expected 200 from /vendor/babylonjs/babylon.js, got ${res.status}`);
  if (!ct.includes('javascript')) throw new Error(`expected a JS content-type, got "${ct}"`);
  console.log('ok — /vendor/babylonjs/babylon.js serves 200 JS');
}

async function checkIndexWiring() {
  const res = await fetch(`${BASE}/`);
  if (res.status !== 200) throw new Error(`expected 200 from /, got ${res.status}`);
  const body = await res.text();
  if (!body.includes('id="scene-canvas"')) throw new Error('scene-canvas element missing from /');
  if (!body.includes('scene/scene.js')) throw new Error('scene/scene.js script tag missing from /');
  console.log('ok — / includes scene-canvas and scene/scene.js');
}

(async () => {
  try {
    await checkVendorScript();
    await checkIndexWiring();
    console.log('scene scaffold smoke test passed');
  } catch (e) {
    console.error('scene scaffold smoke test FAILED:', e.message);
    process.exit(1);
  }
})();
