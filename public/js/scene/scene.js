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
  const LODGE_AMBER_DIM = '#7a5418';
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

  // #294: enclosing wall. Radius is deliberately CAMERA_DEFAULT_RADIUS + a
  // margin, not some fixed "room size" -- with beta fixed and no
  // attachControl, the camera's horizontal distance from center never
  // exceeds CAMERA_DEFAULT_RADIUS (frameCamera() only ever eases alpha/
  // radius between the default and CAMERA_SPEAKER_RADIUS, both smaller).
  // Keeping the wall outside that bound means the camera is always inside
  // the room looking toward the table, so the wall can never land between
  // camera and subject regardless of which seat's angle it swings to --
  // no per-angle occlusion checking needed. WALL_HEIGHT is independent of
  // that and just needs to clear the camera's own elevation (~4.7 at most,
  // see CAMERA_DEFAULT_RADIUS/beta) to read as a room rather than a fence.
  const WALL_RADIUS = CAMERA_DEFAULT_RADIUS + 1;
  const WALL_HEIGHT = 6;
  const FLOOR_SIZE = WALL_RADIUS * 2 + 2; // past the wall footprint, no bare-void gap at the seam
  const SCONCE_RADIUS = WALL_RADIUS - 1.5;
  const SCONCE_HEIGHT = 2.4;
  const SCONCE_COUNT = 3;

  // #304: trim/molding + furnishings, the dressing pass #294 deliberately
  // deferred. Everything below is placed by the same polar convention as
  // the sconces/seats above (angle -> x=cos*r, z=sin*r) via wallSpot(),
  // which additionally returns the Y-rotation that keeps a wall-mounted
  // mesh's local Z (its "depth"/normal axis) pointing along the radius at
  // that angle -- so a box's flat face or a plane's front sits flush
  // against the curved wall instead of at a fixed world-space angle.
  const TRIM_RADIUS = WALL_RADIUS - 0.03; // just inside the wall face, no z-fight
  const PILASTER_COUNT = 8;
  const PILASTER_RADIUS = WALL_RADIUS - 0.1;
  const PILASTER_WIDTH = 0.5;
  const PILASTER_DEPTH = 0.2;
  // Portraits/bookshelves sit in the gaps between pilasters (offset by half
  // a pilaster-spacing), echoing the mantel's own dorian-frame motif
  // (public/index.html, #295) as the issue's proposed visual throughline.
  const DRESSING_RADIUS = WALL_RADIUS - 0.11;
  const PORTRAIT_ANGLES = [0, 1, 2, 3].map(i => Math.PI / 8 + i * (Math.PI / 2));
  const BOOKSHELF_ANGLES = [0, 1].map(i => (3 * Math.PI) / 8 + i * Math.PI);
  const BOOK_COLORS = ['#5c2a1e', '#2e4a2e', '#1e2e4a', '#5c4520', '#3a2e1e'];

  // #305: shadow map resolution. 1024 is a common "small scene" default --
  // low enough that the cube-map cost (below) stays bounded, high enough
  // that the table/seat shadows on the floor don't visibly pixelate at
  // this room's scale.
  const SHADOW_MAP_SIZE = 1024;

  let sceneRef = null;
  let cameraRef = null;
  let seatMeshes = [];
  let tableMesh = null;
  const portraitTextures = {}; // memberId -> BABYLON.Texture, cached across seat reassignment

  // #294: walls + ceiling + a few sconces -- the bounded first art pass
  // named in the issue (walls, ambient lighting, enclosure). Trim/molding
  // and furnishings followed in #304 (buildWallDressing, below); dynamic
  // shadow casting followed in #305 (init(), below -- table/seats/floor
  // only, not the wall dressing here).
  function buildWalls(scene) {
    // Open cylindrical tube (no caps -- floor/ceiling cover top and bottom
    // separately). backFaceCulling off because the camera sits *inside*
    // this radius (see WALL_RADIUS above) and would otherwise be looking
    // at the mesh's outward-facing back side.
    const wall = BABYLON.MeshBuilder.CreateCylinder(
      'wall',
      {
        diameter: WALL_RADIUS * 2,
        height: WALL_HEIGHT,
        tessellation: 32,
        cap: BABYLON.Mesh.NO_CAP,
      },
      scene
    );
    wall.position.y = WALL_HEIGHT / 2;
    const wallMat = new BABYLON.StandardMaterial('wallMat', scene);
    wallMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_BORDER);
    // A small fixed emissive baseline so the wall reads as a dim paneled
    // surface even where no point light reaches it (see the hearth/sconce
    // `range` comment below for why that matters) -- without this the far
    // side of the room is literally indistinguishable from clearColor.
    wallMat.emissiveColor = new BABYLON.Color3(0.05, 0.035, 0.02);
    wallMat.specularColor = new BABYLON.Color3(0, 0, 0);
    // The cylinder's side normals point outward (away from center) by
    // construction; the camera sits inside this radius, so it's always
    // looking at the back face. backFaceCulling off alone renders that
    // face but lights it using the un-flipped outward normal, which reads
    // as facing away from every light in the room -- solid black.
    // twoSidedLighting makes Babylon flip the normal per-face to match
    // whichever side is actually being viewed.
    wallMat.backFaceCulling = false;
    wallMat.twoSidedLighting = true;
    wall.material = wallMat;

    // Flat disc closing the top -- same backface/normal situation as the
    // wall (viewed from below, its default front face points up and away
    // from the camera).
    const ceiling = BABYLON.MeshBuilder.CreateDisc('ceiling', { radius: WALL_RADIUS, tessellation: 32 }, scene);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = WALL_HEIGHT;
    const ceilingMat = new BABYLON.StandardMaterial('ceilingMat', scene);
    ceilingMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_BG);
    ceilingMat.emissiveColor = new BABYLON.Color3(0.02, 0.015, 0.01);
    ceilingMat.specularColor = new BABYLON.Color3(0, 0, 0);
    ceilingMat.backFaceCulling = false;
    ceilingMat.twoSidedLighting = true;
    ceiling.material = ceilingMat;

    // A handful of warm point-light sconces around the wall, breaking up
    // the single-hearth flatness -- lower intensity than the hearth (32)
    // since these are ambient fill, not the room's one named light source.
    // Angles start offset from the hearth's own so they don't double up.
    for (let i = 0; i < SCONCE_COUNT; i++) {
      const angle = (i / SCONCE_COUNT) * Math.PI * 2 + Math.PI / SCONCE_COUNT;
      const pos = new BABYLON.Vector3(Math.cos(angle) * SCONCE_RADIUS, SCONCE_HEIGHT, Math.sin(angle) * SCONCE_RADIUS);
      const sconce = new BABYLON.PointLight(`sconce-${i}`, pos, scene);
      sconce.diffuse = BABYLON.Color3.FromHexString(LODGE_AMBER);
      sconce.specular = BABYLON.Color3.FromHexString(LODGE_GOLD);
      sconce.intensity = 1.5;
      // Babylon point lights only fall off with distance once `range` is
      // set -- left unset, a light applies its full intensity regardless
      // of distance, which is fine in an open scene with nothing far away
      // to expose, but blows the new enclosing wall out to solid white at
      // any intensity worth calling a light (verified live: intensity 6
      // with no range turned the whole wall near-white). Six units keeps
      // the glow local to the sconce itself rather than washing the wall.
      sconce.range = 6;

      const marker = BABYLON.MeshBuilder.CreateSphere(`sconce-marker-${i}`, { diameter: 0.2 }, scene);
      marker.position = pos;
      const markerMat = new BABYLON.StandardMaterial(`sconceMarkerMat-${i}`, scene);
      markerMat.emissiveColor = BABYLON.Color3.FromHexString(LODGE_GOLD);
      markerMat.disableLighting = true;
      marker.material = markerMat;
    }
  }

  // Position + facing for a mesh mounted flush against the cylindrical wall
  // at the given angle/radius -- rotationY keeps the mesh's local Z axis
  // (front face / depth) aligned with the radius at that point, matching
  // how CreateBox/CreatePlane default-orient (depth along Z, width along X).
  function wallSpot(angle, radius) {
    return {
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius,
      rotationY: Math.PI / 2 - angle,
    };
  }

  // Thin open cylinder band (baseboard/chair-rail/crown) -- same NO_CAP +
  // twoSidedLighting treatment as the wall itself, since it's viewed from
  // inside the same radius.
  function buildTrimRing(scene, name, y, height, colorHex, emissiveScale) {
    const ring = BABYLON.MeshBuilder.CreateCylinder(
      name,
      { diameter: TRIM_RADIUS * 2, height, tessellation: 32, cap: BABYLON.Mesh.NO_CAP },
      scene
    );
    ring.position.y = y;
    const mat = new BABYLON.StandardMaterial(`${name}Mat`, scene);
    mat.diffuseColor = BABYLON.Color3.FromHexString(colorHex);
    mat.emissiveColor = BABYLON.Color3.FromHexString(colorHex).scale(emissiveScale);
    mat.specularColor = new BABYLON.Color3(0, 0, 0);
    mat.backFaceCulling = false;
    mat.twoSidedLighting = true;
    ring.material = mat;
  }

  // Vertical ribs breaking the flat paneled cylinder into bays -- the
  // portrait frames and bookshelves below sit in the gaps between them.
  function buildPilasters(scene) {
    for (let i = 0; i < PILASTER_COUNT; i++) {
      const angle = (i / PILASTER_COUNT) * Math.PI * 2;
      const spot = wallSpot(angle, PILASTER_RADIUS);
      const pilaster = BABYLON.MeshBuilder.CreateBox(
        `pilaster-${i}`,
        { width: PILASTER_WIDTH, height: WALL_HEIGHT - 0.6, depth: PILASTER_DEPTH },
        scene
      );
      pilaster.position.set(spot.x, WALL_HEIGHT / 2, spot.z);
      pilaster.rotation.y = spot.rotationY;
      const mat = new BABYLON.StandardMaterial(`pilasterMat-${i}`, scene);
      mat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_AMBER_DIM);
      mat.emissiveColor = BABYLON.Color3.FromHexString(LODGE_AMBER_DIM).scale(0.12);
      mat.specularColor = new BABYLON.Color3(0.05, 0.04, 0.02);
      pilaster.material = mat;
    }
  }

  // Gilt-frame + dark-panel pair per portrait, echoing the dorian-frame's
  // own amber/gold molding gradient (public/css/style.css's #fmG-equivalent
  // tokens) rather than a per-member image -- no ancestor art exists to
  // render here, and an empty gilt frame reads as intentional lodge
  // furnishing rather than a placeholder.
  function buildPortraitFrames(scene) {
    PORTRAIT_ANGLES.forEach((angle, i) => {
      const frameSpot = wallSpot(angle, DRESSING_RADIUS);
      const frame = BABYLON.MeshBuilder.CreatePlane(`portraitFrame-${i}`, { width: 0.85, height: 1.05 }, scene);
      frame.position.set(frameSpot.x, 3.2, frameSpot.z);
      frame.rotation.y = frameSpot.rotationY;
      const frameMat = new BABYLON.StandardMaterial(`portraitFrameMat-${i}`, scene);
      frameMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_AMBER);
      frameMat.emissiveColor = BABYLON.Color3.FromHexString(LODGE_GOLD).scale(0.2);
      frameMat.backFaceCulling = false;
      frame.material = frameMat;

      const panelSpot = wallSpot(angle, DRESSING_RADIUS - 0.02);
      const panel = BABYLON.MeshBuilder.CreatePlane(`portraitPanel-${i}`, { width: 0.65, height: 0.85 }, scene);
      panel.position.set(panelSpot.x, 3.2, panelSpot.z);
      panel.rotation.y = panelSpot.rotationY;
      const panelMat = new BABYLON.StandardMaterial(`portraitPanelMat-${i}`, scene);
      panelMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_BG);
      panelMat.emissiveColor = new BABYLON.Color3(0.03, 0.025, 0.015);
      panelMat.backFaceCulling = false;
      panel.material = panelMat;
    });
  }

  // Open-fronted case (back panel + two end panels, no solid front) with
  // shelf boards + a row of variously-colored "book" boxes on each --
  // static dressing only (not tied to the library's actual contents;
  // #304's own issue flags a books-reflect-the-corpus version as separate,
  // much larger scope if ever pursued).
  //
  // Deliberately NOT a single solid carcass box: an early version used one,
  // and its own front face (the side nearer the room, at a smaller radius
  // than the shelf boards it enclosed) occluded every board and book behind
  // it -- verified via a cropped/brightened render showing a flat dark
  // silhouette with no visible shelves. Leaving the front open is what
  // makes the books visible at all from inside the room.
  function buildBookshelves(scene) {
    const bayWidth = 1.7;
    const shelfRadius = WALL_RADIUS - 0.36; // shared by end panels, boards, and books
    const shelfHeights = [0.5, 1.5, 2.5];
    const bookCount = 6;
    BOOKSHELF_ANGLES.forEach((angle, shelfIndex) => {
      const caseMat = new BABYLON.StandardMaterial(`bookshelfCaseMat-${shelfIndex}`, scene);
      caseMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_BORDER);
      caseMat.specularColor = new BABYLON.Color3(0.05, 0.04, 0.02);

      const backSpot = wallSpot(angle, WALL_RADIUS - 0.05);
      const backPanel = BABYLON.MeshBuilder.CreateBox(
        `bookshelfBack-${shelfIndex}`,
        { width: bayWidth, height: 3.2, depth: 0.08 },
        scene
      );
      backPanel.position.set(backSpot.x, 1.7, backSpot.z);
      backPanel.rotation.y = backSpot.rotationY;
      backPanel.material = caseMat;

      const shelfSpot = wallSpot(angle, shelfRadius);
      const tangentAngle = angle + Math.PI / 2;
      [-1, 1].forEach(side => {
        const edgeOffset = side * (bayWidth / 2 - 0.06);
        const endPanel = BABYLON.MeshBuilder.CreateBox(
          `bookshelfEnd-${shelfIndex}-${side}`,
          { width: 0.12, height: 3.2, depth: 0.62 },
          scene
        );
        endPanel.position.set(
          shelfSpot.x + Math.cos(tangentAngle) * edgeOffset,
          1.7,
          shelfSpot.z + Math.sin(tangentAngle) * edgeOffset
        );
        endPanel.rotation.y = shelfSpot.rotationY;
        endPanel.material = caseMat;
      });

      shelfHeights.forEach((h, shelfLevel) => {
        const board = BABYLON.MeshBuilder.CreateBox(
          `shelfBoard-${shelfIndex}-${shelfLevel}`,
          { width: 1.4, height: 0.06, depth: 0.55 },
          scene
        );
        board.position.set(shelfSpot.x, 0.1 + h, shelfSpot.z);
        board.rotation.y = shelfSpot.rotationY;
        const boardMat = new BABYLON.StandardMaterial(`shelfBoardMat-${shelfIndex}-${shelfLevel}`, scene);
        boardMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_AMBER_DIM);
        boardMat.specularColor = new BABYLON.Color3(0, 0, 0);
        board.material = boardMat;

        for (let b = 0; b < bookCount; b++) {
          const bookWidth = 0.14 + (b % 3) * 0.03;
          const bookHeight = 0.38 + (b % 2) * 0.08;
          // Offset along the shelf's own tangential axis, not the radial
          // one -- books sit in a row along the shelf, not stacked toward
          // the room center.
          const tangentialOffset = -0.6 + b * (1.2 / (bookCount - 1));
          const bx = shelfSpot.x + Math.cos(tangentAngle) * tangentialOffset;
          const bz = shelfSpot.z + Math.sin(tangentAngle) * tangentialOffset;
          const book = BABYLON.MeshBuilder.CreateBox(
            `book-${shelfIndex}-${shelfLevel}-${b}`,
            { width: bookWidth, height: bookHeight, depth: 0.45 },
            scene
          );
          book.position.set(bx, 0.1 + h + 0.03 + bookHeight / 2, bz);
          book.rotation.y = shelfSpot.rotationY;
          const bookMat = new BABYLON.StandardMaterial(`bookMat-${shelfIndex}-${shelfLevel}-${b}`, scene);
          bookMat.diffuseColor = BABYLON.Color3.FromHexString(
            BOOK_COLORS[(shelfLevel * bookCount + b) % BOOK_COLORS.length]
          );
          bookMat.specularColor = new BABYLON.Color3(0, 0, 0);
          book.material = bookMat;
        }
      });
    });
  }

  function buildWallDressing(scene) {
    buildTrimRing(scene, 'baseboard', 0.15, 0.3, LODGE_AMBER_DIM, 0.08);
    buildTrimRing(scene, 'chairRail', 1.3, 0.14, LODGE_GOLD, 0.15);
    buildTrimRing(scene, 'crownMolding', WALL_HEIGHT - 0.25, 0.25, LODGE_AMBER_DIM, 0.08);
    buildPilasters(scene);
    buildPortraitFrames(scene);
    buildBookshelves(scene);
  }

  function buildTableAndSeats(scene) {
    const table = BABYLON.MeshBuilder.CreateCylinder(
      'table',
      {
        diameter: TABLE_RADIUS * 2,
        height: 0.4,
        tessellation: 24,
      },
      scene
    );
    table.position.y = 0.2;
    const tableMat = new BABYLON.StandardMaterial('tableMat', scene);
    tableMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_BORDER);
    tableMat.specularColor = new BABYLON.Color3(0.1, 0.08, 0.05);
    table.material = tableMat;
    tableMesh = table;

    seatMeshes = [];
    for (let i = 0; i < SEAT_COUNT; i++) {
      const angle = (i / SEAT_COUNT) * Math.PI * 2;
      const x = Math.cos(angle) * SEAT_RING_RADIUS;
      const z = Math.sin(angle) * SEAT_RING_RADIUS;

      const seat = BABYLON.MeshBuilder.CreateCylinder(
        `seat-${i}`,
        {
          diameter: 0.6,
          height: 0.6,
          tessellation: 12,
        },
        scene
      );
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
      const avatar = BABYLON.MeshBuilder.CreatePlane(
        `avatar-${i}`,
        {
          width: AVATAR_WIDTH,
          height: AVATAR_HEIGHT,
        },
        scene
      );
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
        `/portraits/${memberId}.png`,
        scene,
        false,
        false,
        BABYLON.Texture.TRILINEAR_SAMPLINGMODE,
        null,
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
      `camera-${property}`,
      camera,
      property,
      CAMERA_FPS,
      Math.round((CAMERA_FRAME_MS / 1000) * CAMERA_FPS),
      camera[property],
      toValue,
      BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT,
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
    const targetAlpha = seat
      ? cameraRef.alpha + shortestAngleDelta(cameraRef.alpha, seat.angle)
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
      worldPos,
      BABYLON.Matrix.Identity(),
      sceneRef.getTransformMatrix(),
      viewport
    );
    const visible =
      projected.z > 0 &&
      projected.z < 1 &&
      projected.x >= 0 &&
      projected.x <= rect.width &&
      projected.y >= 0 &&
      projected.y <= rect.height;
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
        'camera',
        CAMERA_DEFAULT_ALPHA,
        Math.PI / 2.5,
        CAMERA_DEFAULT_RADIUS,
        new BABYLON.Vector3(0, 1, 0),
        scene
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
      // #294: same unbounded-range problem as the sconces (see that
      // comment) -- with no range set, this light's original intensity
      // (18) applied at full, undimmed strength regardless of distance,
      // which the enclosing wall now catches and washes out to solid
      // white. Setting a range switches on real inverse-square falloff,
      // which also dims everything already lit by this light, including
      // the table/seats -- intensity raised from 18 to 32 to bring the
      // table back to close to its pre-wall brightness (verified via
      // pixel readback: table center pixel ~228,109,21 now vs. ~228,125,24
      // before, wall stays a dim ~17,13,8 instead of blown out).
      hearth.intensity = 32;
      hearth.range = 11;

      // Small emissive core so the hearth reads as a visible light source,
      // not just a lighting contribution on the floor.
      const ember = BABYLON.MeshBuilder.CreateSphere('ember', { diameter: 0.4 }, scene);
      ember.position = new BABYLON.Vector3(-5, 0.3, -5);
      const emberMat = new BABYLON.StandardMaterial('emberMat', scene);
      emberMat.emissiveColor = BABYLON.Color3.FromHexString(LODGE_GOLD);
      emberMat.disableLighting = true;
      ember.material = emberMat;

      const floor = BABYLON.MeshBuilder.CreateGround('floor', { width: FLOOR_SIZE, height: FLOOR_SIZE }, scene);
      const floorMat = new BABYLON.StandardMaterial('floorMat', scene);
      floorMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_BORDER);
      floorMat.specularColor = new BABYLON.Color3(0, 0, 0);
      floor.material = floorMat;

      buildWalls(scene);
      buildWallDressing(scene);
      buildTableAndSeats(scene);
      sceneRef = scene;

      // #305: hearth-only shadows -- the issue's own steer ("the hearth
      // alone is probably enough for the effect and cheaper than adding
      // shadow generators for every sconce too"). Babylon point lights
      // render shadows as a 6-face cube map internally (unlike a single
      // shadow map for a directional/spot light), already the most
      // expensive shadow type available; a generator per sconce would
      // triple that cost for a room this small, so the sconces stay
      // shadowless fill light only.
      const shadowGenerator = new BABYLON.ShadowGenerator(SHADOW_MAP_SIZE, hearth);
      // Plain exponential map, not the blurred variant -- blurring costs an
      // extra pass per cube face (x6), and softened edges aren't needed to
      // read as "shadow" at this room's scale and camera distance.
      shadowGenerator.useExponentialShadowMap = true;
      // Table + seat cylinders cast; avatar billboards deliberately don't
      // (issue's own steer: a flat camera-facing card would cast a
      // card-shaped shadow that reads as a rendering bug, not atmosphere).
      // Their material already uses disableLighting (#217), so they
      // couldn't receive a shadow either even if added as a receiver.
      const shadowCasters = [tableMesh, ...seatMeshes.map(seat => seat.mesh)];
      shadowCasters.forEach(mesh => shadowGenerator.addShadowCaster(mesh));
      floor.receiveShadows = true;
      tableMesh.receiveShadows = true;

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
