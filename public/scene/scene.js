'use strict';

// Phase 0 (#26): pure atmosphere. Phase 1 (this file, current): a table and
// a fixed ring of seats synced to activeMembers via updateSeats() — occupied
// vs. empty only, no per-member identity yet. Phase 2 (#26, next): occupied
// seats get a portrait-textured billboard card per member (decided
// 2026-07-31 in issue #26 — flat cards are the deliberate MVP, not a
// placeholder; a more sculptural avatar is the intended later direction,
// full 3D character models are long-horizon, not a near-term target).
window.LodgeScene = (function () {
  const LODGE_BG = '#0e0b08';
  const LODGE_FIRE = '#d4621a';
  const LODGE_AMBER = '#c8922a';
  const LODGE_GOLD = '#e8b84b';
  const LODGE_BORDER = '#3a2e1e';

  // Fixed seat count, not dynamic-per-session — matches the UI's own
  // guidance in updateMemberCount() (app.js): 4-6 recommended, 6+ "warn",
  // 8+ "over". 8 fixed seats around the table comfortably covers realistic
  // casts without needing seats-that-rearrange-by-count complexity.
  const SEAT_COUNT = 8;
  const TABLE_RADIUS = 2.6;
  const SEAT_RING_RADIUS = 4.4;

  let sceneRef = null;
  let seatMeshes = [];

  function buildTableAndSeats(scene) {
    const table = BABYLON.MeshBuilder.CreateCylinder('table', {
      diameter: TABLE_RADIUS * 2, height: 0.4, tessellation: 24,
    }, scene);
    table.position.y = 0.2;
    const tableMat = new BABYLON.StandardMaterial('tableMat', scene);
    tableMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_BORDER);
    tableMat.specularColor = new BABYLON.Color3(0.1, 0.08, 0.05);
    table.material = tableMat;

    const emptyMat = new BABYLON.StandardMaterial('seatEmptyMat', scene);
    emptyMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_BORDER);
    emptyMat.specularColor = new BABYLON.Color3(0, 0, 0);

    const occupiedMat = new BABYLON.StandardMaterial('seatOccupiedMat', scene);
    occupiedMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_AMBER);
    occupiedMat.emissiveColor = BABYLON.Color3.FromHexString(LODGE_AMBER).scale(0.35);
    occupiedMat.specularColor = new BABYLON.Color3(0.2, 0.15, 0.08);

    seatMeshes = [];
    for (let i = 0; i < SEAT_COUNT; i++) {
      const angle = (i / SEAT_COUNT) * Math.PI * 2;
      const seat = BABYLON.MeshBuilder.CreateCylinder(`seat-${i}`, {
        diameter: 0.6, height: 0.6, tessellation: 12,
      }, scene);
      seat.position.x = Math.cos(angle) * SEAT_RING_RADIUS;
      seat.position.z = Math.sin(angle) * SEAT_RING_RADIUS;
      seat.position.y = 0.3;
      seat.material = emptyMat;
      seatMeshes.push({ mesh: seat, emptyMat, occupiedMat, memberId: null });
    }
  }

  // Assigns the given member ids to seats in order, up to SEAT_COUNT.
  // Extra members beyond the seat count are silently not seated at this
  // phase — same practical ceiling the member picker already warns about.
  function updateSeats(memberIds) {
    if (!sceneRef || !seatMeshes.length) return;
    const ids = memberIds || [];
    seatMeshes.forEach((seat, i) => {
      const id = ids[i] || null;
      seat.memberId = id;
      seat.mesh.material = id ? seat.occupiedMat : seat.emptyMat;
    });
  }

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

      // Positioned off to the side, like a hearth against a room wall, not
      // at the origin — the table now occupies center stage (Phase 1).
      const hearthPos = new BABYLON.Vector3(-5, 1.2, -5);
      const hearth = new BABYLON.PointLight('hearth', hearthPos, scene);
      hearth.diffuse = BABYLON.Color3.FromHexString(LODGE_FIRE);
      hearth.specular = BABYLON.Color3.FromHexString(LODGE_AMBER);
      hearth.intensity = 18;

      // Small emissive core so the hearth reads as a visible light source,
      // not just a lighting contribution on the floor.
      const ember = BABYLON.MeshBuilder.CreateSphere('ember', { diameter: 0.4 }, scene);
      ember.position = new BABYLON.Vector3(-5, 0.3, -5);
      const emberMat = new BABYLON.StandardMaterial('emberMat', scene);
      emberMat.emissiveColor = BABYLON.Color3.FromHexString(LODGE_GOLD);
      emberMat.disableLighting = true;
      ember.material = emberMat;

      const floor = BABYLON.MeshBuilder.CreateGround('floor', { width: 14, height: 14 }, scene);
      const floorMat = new BABYLON.StandardMaterial('floorMat', scene);
      floorMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_BORDER);
      floorMat.specularColor = new BABYLON.Color3(0, 0, 0);
      floor.material = floorMat;

      buildTableAndSeats(scene);
      sceneRef = scene;

      // Slow fixed rotation — reads as "alive" without being a navigation feature.
      // Cut to a third of the original rate (was 0.0015) -- the initial speed
      // read as a spinning top rather than a slow drift.
      scene.onBeforeRenderObservable.add(() => {
        camera.alpha += 0.0005 * engine.getDeltaTime();
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

  return { init, updateSeats };
})();
