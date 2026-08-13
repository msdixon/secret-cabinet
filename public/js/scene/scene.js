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
// #232: the same setSpeaking(memberId) call is also live mode's only signal
// of who's talking, so it doubles as the camera-framing trigger below —
// no separate "are we live" flag needed.
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

  // #232: camera framing. Default is the room's original resting shot;
  // SPEAKER_RADIUS pulls in closer once someone's talking, echoing the
  // seat glow's own "leaning in" read. CAMERA_FRAME_MS matches a natural
  // turn-taking glance, not a slow cinematic pan.
  const CAMERA_DEFAULT_ALPHA = -Math.PI / 2;
  const CAMERA_DEFAULT_RADIUS = 12;
  const CAMERA_SPEAKER_RADIUS = 9;
  const CAMERA_FRAME_MS = 900;
  const CAMERA_FPS = 60;

  let sceneRef = null;
  let cameraRef = null;
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
      // Black, not white: StandardMaterial adds emissiveColor + emissiveTexture
      // rather than multiplying them, so a white emissiveColor clamps every
      // portrait to solid white regardless of its actual pixels (#217). Black
      // leaves the texture as the only emissive contribution.
      avatarMat.emissiveColor = new BABYLON.Color3(0, 0, 0);
      avatarMat.backFaceCulling = false;
      avatar.material = avatarMat;

      const seatEntry = { mesh: seat, seatMat, avatar, avatarMat, memberId: null, angle };
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
      const tex = new BABYLON.Texture(
        `/portraits/${memberId}.png`, scene, false, false,
        BABYLON.Texture.TRILINEAR_SAMPLINGMODE, null,
        () => {
          console.warn(`[scene] no portrait for ${memberId} yet`);
          const seat = seatMeshes.find(s => s.memberId === memberId);
          if (seat) seat.avatar.isVisible = false;
        }
      );
      // The Texture constructor's invertY flag is supposed to flip this, but
      // it has no visible effect here -- Babylon's engine-level GPU texture
      // cache appears to key on URL alone and reuse an already-uploaded
      // texture regardless of invertY on a new Texture() instance. Flipping
      // the V axis in the UV transform instead (vScale/vOffset) works
      // reliably because it's applied at sample time, not upload time.
      // Verified live via canvas pixel readback (#231).
      tex.vScale = -1;
      tex.vOffset = 1;
      portraitTextures[memberId] = tex;
    }
    return portraitTextures[memberId];
  }

  // Shortest angular delta from `from` to `to`, wrapped to (-PI, PI] --
  // camera.alpha is unbounded (same as the old auto-rotate's `+=`), so the
  // animation target is `from + delta`, never a raw `to`, to guarantee the
  // camera swings the short way instead of possibly the long way round.
  function shortestAngleDelta(from, to) {
    let delta = (to - from) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    return delta;
  }

  // Built lazily (not at module load) -- BABYLON isn't guaranteed loaded
  // yet when this IIFE first runs (see test/module-convention.test.js,
  // which loads every public/ module in isolation to pin exactly that).
  let cameraEasing = null;
  function getCameraEasing() {
    if (!cameraEasing) {
      cameraEasing = new BABYLON.CubicEase();
      cameraEasing.setEasingMode(BABYLON.EasingFunction.EASINGMODE_EASEINOUT);
    }
    return cameraEasing;
  }

  function animateCameraProp(camera, property, toValue) {
    if (!sceneRef) return;
    sceneRef.stopAnimation(camera, `camera-${property}`);
    BABYLON.Animation.CreateAndStartAnimation(
      `camera-${property}`, camera, property, CAMERA_FPS,
      Math.round((CAMERA_FRAME_MS / 1000) * CAMERA_FPS),
      camera[property], toValue, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT,
      getCameraEasing()
    );
  }

  // #232: swings the camera toward whichever seat is speaking (angle = 0
  // pulls the camera to the same ray as that seat, so it sits between the
  // camera and the table center — foregrounded and close, per the shared
  // trig basis with buildTableAndSeats' own seat placement) and pulls in
  // closer. Clearing to no speaker eases back to the room's resting shot,
  // rather than freezing wherever the last speaker left it.
  function frameCamera(memberId) {
    if (!cameraRef) return;
    const seat = memberId && seatMeshes.find(s => s.memberId === memberId);
    const targetAlpha = seat ? cameraRef.alpha + shortestAngleDelta(cameraRef.alpha, seat.angle)
      : cameraRef.alpha + shortestAngleDelta(cameraRef.alpha, CAMERA_DEFAULT_ALPHA);
    const targetRadius = seat ? CAMERA_SPEAKER_RADIUS : CAMERA_DEFAULT_RADIUS;
    animateCameraProp(cameraRef, 'alpha', targetAlpha);
    animateCameraProp(cameraRef, 'radius', targetRadius);
  }

  let currentSpeakingId = null;

  // Assigns the given member ids to seats in order, up to SEAT_COUNT.
  // Extra members beyond the seat count are silently not seated at this
  // phase — same practical ceiling the member picker already warns about.
  function updateSeats(memberIds) {
    if (!sceneRef || !seatMeshes.length) return;
    const ids = memberIds || [];
    // Occupancy changed -- whatever was mid-generation before this render
    // is no longer meaningful (round ended, session switched, etc), so the
    // camera (#232) eases back to the resting shot along with the seats.
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
    frameCamera(null);
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
    frameCamera(currentSpeakingId);
  }

  // #257: projects a seated member's portrait to a screen-space point so
  // witness.js can anchor a DOM speech card to it -- the standard
  // "world-space UI" pattern for layering DOM over a WebGL canvas. Returns
  // null when the member isn't seated at all (no scene, or not in
  // seatMeshes); returns { x, y, visible: false } when they're seated but the
  // camera's current framing (#232) puts them behind the camera or outside
  // the canvas bounds -- witness.js hides the card rather than pin it
  // off-canvas, one of #257's two named rough edges.
  //
  // Uses the canvas's CSS pixel rect (getBoundingClientRect), not the
  // engine's render-target resolution (getRenderWidth/Height) -- those
  // differ under devicePixelRatio scaling, and the DOM card layer positions
  // in CSS pixels, not hardware pixels.
  function getSeatScreenPosition(memberId) {
    if (!sceneRef || !cameraRef) return null;
    const seat = seatMeshes.find(s => s.memberId === memberId);
    if (!seat) return null;
    const canvas = sceneRef.getEngine().getRenderingCanvas();
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const viewport = cameraRef.viewport.toGlobal(rect.width, rect.height);
    const worldPos = seat.avatar.position.add(new BABYLON.Vector3(0, AVATAR_HEIGHT / 2, 0));
    const projected = BABYLON.Vector3.Project(
      worldPos, BABYLON.Matrix.Identity(), sceneRef.getTransformMatrix(), viewport
    );
    const visible = projected.z > 0 && projected.z < 1 &&
      projected.x >= 0 && projected.x <= rect.width &&
      projected.y >= 0 && projected.y <= rect.height;
    return { x: projected.x, y: projected.y, visible };
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
        'camera', CAMERA_DEFAULT_ALPHA, Math.PI / 2.5, CAMERA_DEFAULT_RADIUS,
        new BABYLON.Vector3(0, 1, 0), scene
      );
      // Deliberately no attachControl — not interactive this phase.
      cameraRef = camera;

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

      // #232: no continuous auto-rotate — the camera holds the resting shot
      // and only moves when frameCamera() (via setSpeaking) swings it to
      // whoever's talking, easing back here once no one is.
      engine.runRenderLoop(() => scene.render());

      const ro = new ResizeObserver(() => engine.resize());
      ro.observe(canvas);

      return true;
    } catch (e) {
      console.error('[scene] init failed', e);
      return false;
    }
  }

  return { init, updateSeats, setSpeaking, getSeatScreenPosition };
})();
