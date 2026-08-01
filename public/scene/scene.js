'use strict';

// Phase 0 (#26): pure atmosphere. Phase 1: a table and a fixed ring of seats
// synced to activeMembers via updateSeats() — occupied vs. empty only.
// Phase 2: occupied seats get a portrait-textured billboard card per member
// (decided 2026-07-31 in issue #26 — flat cards are the deliberate MVP, not
// a placeholder; a more sculptural avatar is the intended later direction,
// full 3D character models are long-horizon, not a near-term target).
// #28 (this file, current): setSpeaking(memberId) drives a brighter glow +
// slight scale-up on whichever seated member is currently generating —
// server-side signal added in pipeline.js's runRound (onSpeakerStart),
// carried over SSE as a `speaking` field, consumed in app.js's streamPost.
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
  const AVATAR_WIDTH = 1.0;
  const AVATAR_HEIGHT = 1.4;
  const AVATAR_Y = 1.3; // hovers above the seat marker, roughly head height

  let sceneRef = null;
  let seatMeshes = [];
  const portraitTextures = {}; // memberId -> BABYLON.Texture, cached across seat reassignment

  function buildTableAndSeats(scene) {
    const table = BABYLON.MeshBuilder.CreateCylinder('table', {
      diameter: TABLE_RADIUS * 2, height: 0.4, tessellation: 24,
    }, scene);
    table.position.y = 0.2;
    const tableMat = new BABYLON.StandardMaterial('tableMat', scene);
    tableMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_BORDER);
    tableMat.specularColor = new BABYLON.Color3(0.1, 0.08, 0.05);
    table.material = tableMat;

    seatMeshes = [];
    for (let i = 0; i < SEAT_COUNT; i++) {
      const angle = (i / SEAT_COUNT) * Math.PI * 2;
      const x = Math.cos(angle) * SEAT_RING_RADIUS;
      const z = Math.sin(angle) * SEAT_RING_RADIUS;

      const seat = BABYLON.MeshBuilder.CreateCylinder(`seat-${i}`, {
        diameter: 0.6, height: 0.6, tessellation: 12,
      }, scene);
      seat.position.x = x;
      seat.position.z = z;
      seat.position.y = 0.3;
      // Own material per seat (not shared) so #28's speaking-glow can vary
      // one seat's brightness independently of the others.
      const seatMat = new BABYLON.StandardMaterial(`seatMat-${i}`, scene);
      seatMat.specularColor = new BABYLON.Color3(0.2, 0.15, 0.08);
      seat.material = seatMat;

      // Portrait billboard, hidden until a member occupies this seat.
      // BILLBOARDMODE_Y (not full billboarding) keeps the card upright as
      // it turns to face the camera, rather than tilting with elevation.
      const avatar = BABYLON.MeshBuilder.CreatePlane(`avatar-${i}`, {
        width: AVATAR_WIDTH, height: AVATAR_HEIGHT,
      }, scene);
      avatar.position.x = x;
      avatar.position.z = z;
      avatar.position.y = AVATAR_Y;
      avatar.billboardMode = BABYLON.Mesh.BILLBOARDMODE_Y;
      avatar.isVisible = false;
      const avatarMat = new BABYLON.StandardMaterial(`avatarMat-${i}`, scene);
      avatarMat.disableLighting = true; // read the portrait at its own brightness, not scene-lit
      avatarMat.emissiveColor = new BABYLON.Color3(1, 1, 1);
      avatarMat.backFaceCulling = false;
      avatar.material = avatarMat;

      const seatEntry = { mesh: seat, seatMat, avatar, avatarMat, memberId: null };
      applySeatState(seatEntry, 'empty');
      seatMeshes.push(seatEntry);
    }
  }

  // Three states per seat: empty (no one there), occupied (present, not
  // currently generating), speaking (#28 -- brighter glow + a slight
  // scale-up, "leaning in"). Applied directly to each seat's own material
  // rather than swapping between shared material instances.
  function applySeatState(seat, state) {
    if (state === 'empty') {
      seat.seatMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_BORDER);
      seat.seatMat.emissiveColor = new BABYLON.Color3(0, 0, 0);
      seat.avatar.scaling.set(1, 1, 1);
    } else if (state === 'occupied') {
      seat.seatMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_AMBER);
      seat.seatMat.emissiveColor = BABYLON.Color3.FromHexString(LODGE_AMBER).scale(0.35);
      seat.avatar.scaling.set(1, 1, 1);
    } else if (state === 'speaking') {
      seat.seatMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_AMBER);
      seat.seatMat.emissiveColor = BABYLON.Color3.FromHexString(LODGE_GOLD).scale(0.9);
      seat.avatar.scaling.set(1.08, 1.08, 1.08);
    }
  }

  // On load failure (a member added after batch 1, with no portrait yet),
  // hide whichever seat currently holds this memberId -- the load is async
  // and updateSeats() has already made the plane visible by the time this
  // fires, so we look the seat up by memberId rather than by closure.
  function getPortraitTexture(scene, memberId) {
    if (!portraitTextures[memberId]) {
      portraitTextures[memberId] = new BABYLON.Texture(
        `/portraits/${memberId}.png`, scene, false, false,
        BABYLON.Texture.TRILINEAR_SAMPLINGMODE, null,
        () => {
          console.warn(`[scene] no portrait for ${memberId} yet`);
          const seat = seatMeshes.find(s => s.memberId === memberId);
          if (seat) seat.avatar.isVisible = false;
        }
      );
    }
    return portraitTextures[memberId];
  }

  let currentSpeakingId = null;

  // Assigns the given member ids to seats in order, up to SEAT_COUNT.
  // Extra members beyond the seat count are silently not seated at this
  // phase — same practical ceiling the member picker already warns about.
  function updateSeats(memberIds) {
    if (!sceneRef || !seatMeshes.length) return;
    const ids = memberIds || [];
    // Occupancy changed -- whatever was mid-generation before this render
    // is no longer meaningful (round ended, session switched, etc).
    currentSpeakingId = null;
    seatMeshes.forEach((seat, i) => {
      const id = ids[i] || null;
      seat.memberId = id;
      applySeatState(seat, id ? 'occupied' : 'empty');
      if (id) {
        seat.avatarMat.emissiveTexture = getPortraitTexture(sceneRef, id);
        seat.avatar.isVisible = true;
      } else {
        seat.avatar.isVisible = false;
      }
    });
  }

  // #28: brightens whichever seated member is currently generating a turn,
  // returns everyone else (including the previous speaker) to neutral.
  // memberId null/absent just clears back to neutral across the board --
  // used both when a round finishes and when a stream errors mid-generation.
  function setSpeaking(memberId) {
    if (!sceneRef || !seatMeshes.length) return;
    currentSpeakingId = memberId || null;
    seatMeshes.forEach(seat => {
      if (!seat.memberId) return; // empty seats aren't affected either way
      applySeatState(seat, seat.memberId === currentSpeakingId ? 'speaking' : 'occupied');
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

  return { init, updateSeats, setSpeaking };
})();
