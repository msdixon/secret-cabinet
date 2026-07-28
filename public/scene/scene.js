'use strict';

// Phase 0 (#26): pure atmosphere, nothing interactive yet. No seats, no
// members — that's Phase 1, once activeMembers has a sync hook into here.
window.LodgeScene = (function () {
  const LODGE_BG = '#0e0b08';
  const LODGE_FIRE = '#d4621a';
  const LODGE_AMBER = '#c8922a';
  const LODGE_GOLD = '#e8b84b';
  const LODGE_BORDER = '#3a2e1e';

  function init(canvas) {
    try {
      const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
      const scene = new BABYLON.Scene(engine);
      scene.clearColor = BABYLON.Color4.FromHexString(LODGE_BG + 'ff');

      scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
      scene.fogColor = BABYLON.Color3.FromHexString(LODGE_BG);
      scene.fogDensity = 0.035;

      const camera = new BABYLON.ArcRotateCamera(
        'camera', -Math.PI / 2, Math.PI / 2.5, 12, new BABYLON.Vector3(0, 1, 0), scene
      );
      // Deliberately no attachControl — not interactive this phase.

      // Light *colors* need to be bright/warm regardless of the dark theme
      // tokens — those describe surface/background hues, not illumination.
      const ambient = new BABYLON.HemisphericLight('ambient', new BABYLON.Vector3(0, 1, 0), scene);
      ambient.diffuse = new BABYLON.Color3(0.55, 0.46, 0.36);
      ambient.intensity = 0.5;

      const hearth = new BABYLON.PointLight('hearth', new BABYLON.Vector3(0, 1.2, 0), scene);
      hearth.diffuse = BABYLON.Color3.FromHexString(LODGE_FIRE);
      hearth.specular = BABYLON.Color3.FromHexString(LODGE_AMBER);
      hearth.intensity = 12;

      // Small emissive core so the hearth reads as a visible light source,
      // not just a lighting contribution on the floor.
      const ember = BABYLON.MeshBuilder.CreateSphere('ember', { diameter: 0.4 }, scene);
      ember.position = new BABYLON.Vector3(0, 0.3, 0);
      const emberMat = new BABYLON.StandardMaterial('emberMat', scene);
      emberMat.emissiveColor = BABYLON.Color3.FromHexString(LODGE_GOLD);
      emberMat.disableLighting = true;
      ember.material = emberMat;

      const floor = BABYLON.MeshBuilder.CreateGround('floor', { width: 14, height: 14 }, scene);
      const floorMat = new BABYLON.StandardMaterial('floorMat', scene);
      floorMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_BORDER);
      floorMat.specularColor = new BABYLON.Color3(0, 0, 0);
      floor.material = floorMat;

      // Slow fixed rotation — reads as "alive" without being a navigation feature.
      scene.onBeforeRenderObservable.add(() => {
        camera.alpha += 0.0015 * engine.getDeltaTime();
      });

      engine.runRenderLoop(() => scene.render());

      const ro = new ResizeObserver(() => engine.resize());
      ro.observe(canvas);

      return true;
    } catch (e) {
      console.error('[scene] init failed', e);
      return false;
    }
  }

  return { init };
})();
