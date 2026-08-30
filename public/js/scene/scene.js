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
  const CAMERA_DEFAULT_BETA = Math.PI / 2.5;
  const CAMERA_DEFAULT_RADIUS = 12;
  const CAMERA_SPEAKER_RADIUS = 9;
  const CAMERA_FRAME_MS = 900;
  const CAMERA_FPS = 60;
  // #34: inspect-mode framing -- close and near-overhead, a step past the
  // speaker radius rather than a variation on it, since it's the scene's
  // only other scripted camera move (see openDocumentInspect() below).
  const CAMERA_INSPECT_BETA = Math.PI / 2.15;
  const CAMERA_INSPECT_RADIUS = 3;

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
  // #424: sconces up from 3 to 6, given real backplate+cup fixture geometry
  // (previously just a bare 0.2-diameter marker sphere, easy to read as a
  // stray glow rather than a wall fixture), and brighter/wider-reaching --
  // Rachel's own framing was "the room is too dark, even during a session,"
  // i.e. with the hearth banked partway down (see FIRE_LEVEL_MIN) rather
  // than fresh-lit. SCONCE_RADIUS now sits flush against the wall like the
  // rest of the #304 dressing (wallSpot() convention) instead of floating
  // 1.5 units inside it; SCONCE_BULB_RADIUS is where the cup/light actually
  // sits, protruding into the room off that backplate.
  const SCONCE_RADIUS = WALL_RADIUS - 0.15;
  const SCONCE_BULB_RADIUS = WALL_RADIUS - 0.45;
  const SCONCE_HEIGHT = 2.6;
  const SCONCE_COUNT = 6;
  // Same range-vs-intensity trade the hearth comment above describes, just
  // scaled down: range wide enough that six fixtures' pools of light
  // visibly overlap and lift the room rather than reading as six isolated
  // dots, intensity raised enough to be felt at that range without any
  // single sconce blowing out its own stretch of wall (verified live).
  const SCONCE_INTENSITY = 2.6;
  const SCONCE_RANGE = 8.5;

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

  // #357: the hearth — the room's most-invoked object, and until now its
  // thinnest. The fire is named ~14 times across the runtime prose
  // (`prompts/lodge-context.md`'s opening description and format example,
  // one of the three stock lull notes in `src/pipeline-lull.js`, and 8
  // persona files) and was rendered as a single 0.4-diameter emissive
  // sphere beside a floating PointLight. This builds it as an actual
  // fireplace, on the same polar wallSpot() convention as the rest of the
  // #304 dressing.
  //
  // HEARTH_ANGLE is chosen for what the *resting* camera sees, not
  // arbitrarily: CAMERA_DEFAULT_ALPHA is -PI/2, so the camera sits at -Z
  // looking toward +Z and wall angles near +PI/2 are centre-frame while
  // everything near -PI/2 is behind the lens. The old hearth light's own
  // angle was 5PI/4 (atan2(-5,-5)) — squarely behind the camera, which is
  // why the fire has only ever been visible in the empty state as an
  // unexplained blown-out pool of light off the left edge. 5PI/8 lands
  // 22.5 degrees left of centre: comfortably in frame at any plausible
  // canvas aspect (the default camera's own horizontal half-FOV, driven by
  // its vertical 0.8rad fov and this canvas's ~2.7:1 aspect, is already
  // ~48 degrees — verified live via Vector3.Project landing well inside
  // the canvas bounds, and #358 only widens that further), while staying
  // off the table's own axis. It's one of the #304 mid-bay slots, so it
  // sits between pilasters like every other piece of dressing — the
  // portrait that used to hang there moved out (see PORTRAIT_ANGLES).
  const HEARTH_ANGLE = (5 * Math.PI) / 8;
  const HEARTH_WIDTH = 3.2;
  const HEARTH_DEPTH = 0.9; // how far the chimney breast projects into the room
  const FIREBOX_WIDTH = 1.9;
  const FIREBOX_TOP = 1.95;
  const MANTEL_Y = 2.58;
  const HEARTH_BACK_RADIUS = WALL_RADIUS - 0.16; // back panel, just inside the wall face
  const HEARTH_BREAST_RADIUS = HEARTH_BACK_RADIUS - 0.07 - HEARTH_DEPTH / 2;
  const FIREBOX_RADIUS = HEARTH_BACK_RADIUS - 0.4; // where the fire itself sits

  // The single most delicate number in this file. #294 found that a Babylon
  // point light with no `range` applies full intensity at any distance, and
  // fixed it by giving the hearth `range: 11` and raising intensity to 32 to
  // win the table's brightness back. That worked only because the light was
  // floating mid-room, 5.9 units clear of the nearest wall — a light with
  // those numbers placed where a fireplace actually goes blows its own
  // surround to solid white. (Babylon's StandardMaterial falloff is linear:
  // attenuation = max(0, 1 - distance/range), so intensity 32 at range 11
  // still delivers ~30 at point-blank.) The fix is the opposite trade: a
  // much longer range and a much lower intensity, which flattens the curve
  // enough that the firebox interior a foot away and the table twelve units
  // away can both be exposed correctly. Verified live by pixel readback —
  // see this pass's STATUS.md entry for the measured values.
  const HEARTH_RANGE = 30;
  const HEARTH_INTENSITY_BANKED = 3.4;
  const HEARTH_INTENSITY_LIT = 7.6;
  // A second, deliberately short-range light just outside the opening: the
  // main light sits *inside* the firebox, so the surround's room-facing
  // faces are turned away from it and would otherwise render as an unlit
  // silhouette. Short range keeps it off the wall to either side.
  const FIRE_GLOW_RANGE = 4.5;
  const FIRE_GLOW_INTENSITY_BANKED = 1.1;
  const FIRE_GLOW_INTENSITY_LIT = 2.8;

  const FLAME_COUNT = 5;
  const FLAME_HOT = '#ffcf72';
  const FLAME_MID = '#ff8c2b';
  const EMBER_HOT = '#ff6a1a';
  const EMBER_LOW = '#5c1a06';
  const SOOT = '#0a0806';

  // How the fire reads the meeting. The prose already has it lit, stirred
  // and waning; the app already knows how far into the evening it is
  // (passages elapsed), so this costs no model call — it reads state that
  // exists. Bottoming out at 0.3 rather than 0 because a fire that goes
  // fully out is a different, sadder room than the one the prose describes:
  // members keep reaching for it right through a long meeting.
  const FIRE_BANK_PER_PASSAGE = 0.11;
  const FIRE_LEVEL_MIN = 0.3;
  // A stir is a flare, not a reset — it lifts the fire most of the way back
  // for a few seconds and settles again.
  const FIRE_STIR_BOOST = 0.55;
  const FIRE_STIR_MS = 6000;

  let sceneRef = null;
  let cameraRef = null;
  let seatMeshes = [];
  let tableMesh = null;
  const portraitTextures = {}; // memberId -> BABYLON.Texture, cached across seat reassignment
  // #452: "<memberId>-<reaction>" -> BABYLON.Texture, entered only once that
  // image's load has actually succeeded (see applyReactionTexture below for
  // why the failure path is handled differently than portraitTextures' own).
  const reactionTextures = {};
  // "<memberId>-<reaction>" keys already confirmed 404 -- checked before
  // requesting the same URL twice. With only 13/38 members carrying any
  // reaction set as of #470/#472, most disposition updates land here, and
  // there's no reason to re-hit the network for a pair already known absent.
  const missingReactionKeys = new Set();

  // #357: fire state. fireLevel is the value actually applied to lights/
  // flames each frame, eased toward fireTargetLevel rather than snapping --
  // a passage ending should read as the fire settling, not cutting. Reset
  // to full on every init() (a fresh room starts with a fresh fire);
  // setPassageCount()/stirFire() (the exposed API, called from app.js as
  // the meeting progresses) move fireTargetLevel from there.
  let fireLight = null;
  let fireGlowLight = null;
  let flameMeshes = [];
  let emberMat = null;
  let fireLevel = 1;
  let fireTargetLevel = 1;
  let fireBaseLevel = 1;
  let fireStirTimer = null;
  let reducedMotion = false;

  function prefersReducedMotion() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // How far into the meeting banks the fire down. Passage count, not word
  // count -- `wordsSpentSoFar` drives arc progression server-side but isn't
  // sent to the client, while segmentCount already is (app.js tracks it for
  // branch points and replay). One passage per stock-lull-note-shaped pause
  // is close enough to the prose's own sense of "the evening wearing on."
  function passageFireLevel(passageCount) {
    return Math.max(FIRE_LEVEL_MIN, 1 - passageCount * FIRE_BANK_PER_PASSAGE);
  }

  // Reads current passage count -> where the fire should settle. Doesn't
  // interrupt an in-flight stir (stirFire's own timer restores fireBaseLevel
  // when it expires) so a lull note that both stirs the fire and reports a
  // new passage count doesn't fight itself.
  function setPassageCount(passageCount) {
    if (!sceneRef) return;
    fireBaseLevel = passageFireLevel(passageCount);
    if (!fireStirTimer) fireTargetLevel = fireBaseLevel;
  }

  // #245's lull notes already say "someone stirs the fire" as one of three
  // stock options; this is what makes that sentence true. A flare toward
  // (not all the way to) full, held for FIRE_STIR_MS, then eased back to
  // wherever the passage count says the fire actually is.
  function stirFire() {
    if (!sceneRef) return;
    fireTargetLevel = Math.min(1, fireBaseLevel + FIRE_STIR_BOOST);
    if (fireStirTimer) clearTimeout(fireStirTimer);
    fireStirTimer = setTimeout(() => {
      fireStirTimer = null;
      fireTargetLevel = fireBaseLevel;
    }, FIRE_STIR_MS);
  }

  // Runs once per frame from the render loop, ahead of scene.render(). The
  // level ease (fireLevel -> fireTargetLevel) is large-scale, deliberate
  // motion driven by meeting state, not decorative animation, so it runs
  // regardless of prefers-reduced-motion -- only the per-flame flicker
  // below is gated on that, per Principle 4 and the precedent #218 set for
  // the graph's own force simulation.
  function updateFire() {
    if (!fireLight) return;
    fireLevel += (fireTargetLevel - fireLevel) * 0.01;

    fireLight.intensity = HEARTH_INTENSITY_BANKED + (HEARTH_INTENSITY_LIT - HEARTH_INTENSITY_BANKED) * fireLevel;
    fireGlowLight.intensity =
      FIRE_GLOW_INTENSITY_BANKED + (FIRE_GLOW_INTENSITY_LIT - FIRE_GLOW_INTENSITY_BANKED) * fireLevel;
    if (emberMat) {
      emberMat.emissiveColor = BABYLON.Color3.Lerp(
        BABYLON.Color3.FromHexString(EMBER_LOW),
        BABYLON.Color3.FromHexString(EMBER_HOT),
        fireLevel
      );
    }

    const t = performance.now() / 1000;
    flameMeshes.forEach(f => {
      const flicker = reducedMotion
        ? 1
        : 0.82 + 0.14 * Math.sin(t * 6.3 + f.phase) + 0.06 * Math.sin(t * 13.1 + f.phase * 2);
      const h = Math.max(0.05, f.baseHeight * (0.5 + 0.5 * fireLevel) * flicker);
      f.mesh.scaling.y = h / f.baseHeight;
      f.mesh.position.y = f.baseY + h / 2;
      f.mesh.material.emissiveColor = f.baseColor.scale(reducedMotion ? 1 : 0.88 + 0.12 * flicker);
    });
  }

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

    // A ring of warm point-light sconces around the wall, breaking up the
    // single-hearth flatness -- lower intensity than the hearth (32) since
    // these are ambient fill, not the room's one named light source. Angles
    // start offset from the hearth's own so they don't double up. Each gets
    // a small wall-mounted backplate + cup (#424) rather than a bare marker
    // sphere, so it reads as a fixture rather than a floating glow -- same
    // wallSpot() flush-mount convention as the rest of the #304 dressing.
    for (let i = 0; i < SCONCE_COUNT; i++) {
      const angle = (i / SCONCE_COUNT) * Math.PI * 2 + Math.PI / SCONCE_COUNT;
      const backSpot = wallSpot(angle, SCONCE_RADIUS);
      const bulbSpot = wallSpot(angle, SCONCE_BULB_RADIUS);

      const backplate = BABYLON.MeshBuilder.CreateBox(
        `sconceBack-${i}`,
        { width: 0.3, height: 0.5, depth: 0.06 },
        scene
      );
      backplate.position.set(backSpot.x, SCONCE_HEIGHT, backSpot.z);
      backplate.rotation.y = backSpot.rotationY;
      const backMat = new BABYLON.StandardMaterial(`sconceBackMat-${i}`, scene);
      backMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_AMBER_DIM);
      backMat.emissiveColor = BABYLON.Color3.FromHexString(LODGE_AMBER_DIM).scale(0.1);
      backMat.specularColor = new BABYLON.Color3(0.05, 0.04, 0.02);
      backplate.material = backMat;

      const cup = BABYLON.MeshBuilder.CreateSphere(`sconceCup-${i}`, { diameter: 0.24 }, scene);
      cup.position.set(bulbSpot.x, SCONCE_HEIGHT, bulbSpot.z);
      const cupMat = new BABYLON.StandardMaterial(`sconceCupMat-${i}`, scene);
      cupMat.emissiveColor = BABYLON.Color3.FromHexString(LODGE_GOLD);
      cupMat.disableLighting = true;
      cup.material = cupMat;

      const sconce = new BABYLON.PointLight(`sconce-${i}`, new BABYLON.Vector3(bulbSpot.x, SCONCE_HEIGHT, bulbSpot.z), scene);
      sconce.diffuse = BABYLON.Color3.FromHexString(LODGE_AMBER);
      sconce.specular = BABYLON.Color3.FromHexString(LODGE_GOLD);
      sconce.intensity = SCONCE_INTENSITY;
      // Babylon point lights only fall off with distance once `range` is
      // set -- left unset, a light applies its full intensity regardless
      // of distance, which blows the enclosing wall out to solid white at
      // any intensity worth calling a light (verified live pre-#424:
      // intensity 6 with no range turned the whole wall near-white).
      sconce.range = SCONCE_RANGE;
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

  // #479: the one bay that hangs an actual image -- the rest stay the empty
  // gilt-frame-over-dark-panel furnishing described below. PORTRAIT_ANGLES[0]
  // and [2] are the two bays immediately flanking the hearth (each PI/2 --
  // one pilaster-bay -- from HEARTH_ANGLE; [3] is the far side of the room,
  // PI away). Picking [0] as "near the fireplace" is an arbitrary tiebreak
  // between two equally-adjacent bays. The image itself
  // (public/portraits/decor/dorian-gray.png) is static room decor only --
  // generated against STYLE_GUIDE.md's baseline register, not a roster
  // member portrait, and deliberately kept out of public/portraits/'s
  // top-level (member-id-keyed) namespace so no roster/reaction-portrait
  // code path could ever pick it up by id.
  const DORIAN_FRAME_INDEX = 0;
  let dorianPortraitTexture = null;
  function getDorianPortraitTexture(scene) {
    if (!dorianPortraitTexture) {
      // Same invertY workaround as getPortraitTexture above: the Texture
      // constructor's own invertY flag has no visible effect, so the V axis
      // is flipped via vScale/vOffset instead.
      const tex = new BABYLON.Texture(
        '/portraits/decor/dorian-gray.png',
        scene,
        false,
        false,
        BABYLON.Texture.TRILINEAR_SAMPLINGMODE
      );
      tex.vScale = -1;
      tex.vOffset = 1;
      dorianPortraitTexture = tex;
    }
    return dorianPortraitTexture;
  }

  // Gilt-frame + dark-panel pair per portrait, echoing the dorian-frame's
  // own amber/gold molding gradient (public/css/style.css's #fmG-equivalent
  // tokens) rather than a per-member image -- no ancestor art exists to
  // render here, and an empty gilt frame reads as intentional lodge
  // furnishing rather than a placeholder. DORIAN_FRAME_INDEX above is the
  // sole exception (#479).
  //
  // #357: skips the bay at HEARTH_ANGLE -- that's PORTRAIT_ANGLES[1]
  // exactly (both PI/8 + PI/2), since the hearth took over that mid-bay
  // slot. Filtering rather than renumbering keeps every other frame's
  // angle and mesh name (`portraitFrame-2`, etc.) unchanged.
  function buildPortraitFrames(scene) {
    PORTRAIT_ANGLES.forEach((angle, i) => {
      if (Math.abs(angle - HEARTH_ANGLE) < 0.001) return;
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
      if (i === DORIAN_FRAME_INDEX) {
        // emissiveTexture, not diffuseTexture: with disableLighting true the
        // diffuse channel never contributes (same #217 reasoning as the
        // member avatar billboards above), so emissiveTexture is what
        // actually renders the image instead of a black panel.
        panelMat.emissiveTexture = getDorianPortraitTexture(scene);
        panelMat.disableLighting = true;
        panelMat.emissiveColor = new BABYLON.Color3(0, 0, 0);
      } else {
        panelMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_BG);
        panelMat.emissiveColor = new BABYLON.Color3(0.03, 0.025, 0.015);
      }
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

  // #34: "the document as object" -- the source provocation rendered as a
  // physical artifact on the table rather than only living in a textarea.
  // Scoped deliberately narrow, same discipline #357/#304 took for their own
  // first passes: a static open-book model, a click-to-inspect camera move,
  // and a DOM reading panel (app.js) for the text itself. Deliberately NOT
  // built here, left for a later pass if pursued: per-passage highlighting
  // synced to #355's per-beat citation capture, and any attempt to render
  // readable text as an in-scene texture -- the DOM panel is the "zoom into
  // a passage" affordance instead, reusing the #257 DOM-over-canvas pattern
  // rather than adding a text-rendering pipeline. "Members gesture toward it
  // during generation" (the issue's own phrase) has no character rig to
  // animate -- avatars are flat billboards (#26 phase 2) -- so it's
  // approximated the way the fire's own "banking" already is: a state read,
  // not a literal animation. See updateDocumentAttention() below.
  //
  // DOCUMENT_Z sits near the table's camera-facing edge (negative Z, same
  // side HEARTH_ANGLE's own comment identifies as what the resting camera
  // actually sees) so the book reads as presented to the room without
  // occluding the center candle.
  const DOCUMENT_X = 0;
  const DOCUMENT_Y = 0.4; // table top surface (table height 0.4, centered at y=0.2)
  const DOCUMENT_Z = -(TABLE_RADIUS - 0.85);
  const DOCUMENT_PAGE_WIDTH = 0.42;
  const DOCUMENT_PAGE_DEPTH = 0.56;
  const DOCUMENT_TILT = 0.22; // radians -- a shallow "open on a stand" angle, not a hinge simulation
  const DOCUMENT_COVER_COLOR = '#4a1e14';
  const DOCUMENT_PAGE_COLOR = '#e8ddb8';
  const DOCUMENT_GLOW_DORMANT = 0.05;
  const DOCUMENT_GLOW_ATTENDED = 0.26; // while someone is speaking -- see updateDocumentAttention()

  let documentMeshes = [];
  let documentPageMats = [];
  let documentVisible = false;
  let documentInspecting = false;
  let onDocumentInspectChange = null;
  // #34 follow-up: kept alongside documentVisible so citeFromBeat() below
  // has the actual provocation text to check a live citation against,
  // without re-reading window.Export.getEntry() itself -- scene.js stays
  // ignorant of where the text comes from, same as documentVisible already is.
  let documentTextRaw = '';
  let citationHighlightTimer = null;
  let onDocumentCitationChange = null;

  // The book itself -- a base plinth, a spine, and two pages tilted up from
  // it, the same primitives-only economy the candle above uses rather than
  // anything sculpted. Pages get their own material (not shared) so
  // updateDocumentAttention() can brighten them without touching the base/
  // spine. Hidden until setDocumentText() finds an actual document to show.
  function buildDocumentObject(scene) {
    const baseMat = new BABYLON.StandardMaterial('documentBaseMat', scene);
    baseMat.diffuseColor = BABYLON.Color3.FromHexString(DOCUMENT_COVER_COLOR);
    baseMat.specularColor = new BABYLON.Color3(0.05, 0.04, 0.02);

    const base = BABYLON.MeshBuilder.CreateBox(
      'documentBase',
      { width: DOCUMENT_PAGE_WIDTH * 2 * 0.92, height: 0.03, depth: DOCUMENT_PAGE_DEPTH + 0.06 },
      scene
    );
    base.position.set(DOCUMENT_X, DOCUMENT_Y + 0.015, DOCUMENT_Z);
    base.material = baseMat;

    const spine = BABYLON.MeshBuilder.CreateBox(
      'documentSpine',
      { width: 0.05, height: 0.05, depth: DOCUMENT_PAGE_DEPTH },
      scene
    );
    spine.position.set(DOCUMENT_X, DOCUMENT_Y + 0.045, DOCUMENT_Z);
    spine.material = baseMat;

    documentMeshes = [base, spine];
    documentPageMats = [];

    [-1, 1].forEach(side => {
      const pageMat = new BABYLON.StandardMaterial(`documentPageMat-${side}`, scene);
      pageMat.diffuseColor = BABYLON.Color3.FromHexString(DOCUMENT_PAGE_COLOR);
      pageMat.emissiveColor = BABYLON.Color3.FromHexString(DOCUMENT_PAGE_COLOR).scale(DOCUMENT_GLOW_DORMANT);
      pageMat.specularColor = new BABYLON.Color3(0.08, 0.07, 0.05);
      pageMat.backFaceCulling = false;

      const page = BABYLON.MeshBuilder.CreateBox(
        `documentPage-${side}`,
        { width: DOCUMENT_PAGE_WIDTH, height: 0.015, depth: DOCUMENT_PAGE_DEPTH },
        scene
      );
      // Approximates a hinge at the spine (x=0) by lifting the outer edge
      // rather than actually pivoting a rotated mesh around it -- the tilt
      // is shallow enough that the difference isn't visible at this
      // camera's distance, and it avoids the setPivotPoint bookkeeping a
      // true hinge would need for two lines of geometry.
      const lift = Math.sin(DOCUMENT_TILT) * (DOCUMENT_PAGE_WIDTH / 2);
      page.position.set(
        DOCUMENT_X + side * (DOCUMENT_PAGE_WIDTH / 2) * Math.cos(DOCUMENT_TILT),
        DOCUMENT_Y + 0.05 + lift / 2,
        DOCUMENT_Z
      );
      page.rotation.z = -side * DOCUMENT_TILT;
      page.material = pageMat;

      documentMeshes.push(page);
      documentPageMats.push(pageMat);
    });

    documentMeshes.forEach(m => (m.isVisible = false));
  }

  // Called from app.js's updateStepper(), which already computes this exact
  // "is there a provocation" condition for the pre-convene stepper -- this
  // rides that existing signal instead of adding a second source of truth
  // for whether a document exists. Any change here closes an open inspect
  // view rather than risk it going stale (a new document loaded mid-read,
  // or the entry cleared out from under it).
  function setDocumentText(text) {
    if (!sceneRef || !documentMeshes.length) return;
    documentVisible = !!(text && text.trim());
    documentTextRaw = documentVisible ? text : '';
    documentMeshes.forEach(m => (m.isVisible = documentVisible));
    if (documentInspecting) closeDocumentInspect();
    // A new/cleared document invalidates any in-flight citation highlight —
    // same reasoning as the inspect-panel close just above.
    clearDocumentCitation();
  }

  // Reuses applySeatState's own eased-tween helper (animateSeatProp) and
  // easing/timing -- it's a generic Color3/Vector3 tween despite the
  // seat-focused name, and the "someone is leaning in" glow read is the same
  // signal (setSpeaking's currentSpeakingId) the seat states already use.
  function updateDocumentAttention(active) {
    if (!sceneRef || !documentPageMats.length) return;
    const scale = active ? DOCUMENT_GLOW_ATTENDED : DOCUMENT_GLOW_DORMANT;
    documentPageMats.forEach((mat, i) => {
      animateSeatProp(
        mat,
        'emissiveColor',
        BABYLON.Color3.FromHexString(DOCUMENT_PAGE_COLOR).scale(scale),
        `documentGlow-${i}`
      );
    });
  }

  // #34 follow-up (the issue's deferred "per-passage highlighting synced to
  // citations" half): the book has no text-rendering pipeline (still out of
  // scope, per this file's own #34 comment above) so there's no literal
  // passage to light up on the mesh itself -- this is a brighter, distinct
  // pulse above the ambient "someone is speaking" glow updateDocumentAttention
  // already drives, reserved for the moment a beat's own citation turns out
  // to quote the document rather than some other real work. app.js's
  // onDocumentCitationChange callback is where the literal passage
  // highlighting happens, in the DOM reading panel it already owns (#257's
  // split: scene.js is 3D/camera, app.js is DOM) -- this function only
  // decides *whether* one of the beat's citations matches, and hands the
  // matched quote across.
  //
  // Matching is a normalize-then-substring check, same shape as app.js's own
  // applyCitationFlags (matching a citation quote against rendered transcript
  // text) applied here against the document instead: strip markdown emphasis
  // asterisks, fold curly quotes to straight ones, lowercase. Deliberately
  // NOT whitespace-collapsed here (unlike applyCitationFlags) — app.js's
  // handleDocumentCitationChange needs char-for-char positions in the
  // original document text to wrap a <mark> around, and collapsing runs of
  // whitespace would shift those positions out from under it. A document
  // with irregular internal whitespace at exactly the cited span is a named,
  // accepted gap (no highlight fires) rather than solved — most citations of
  // the document don't hit that edge, and a missed highlight is a quiet
  // no-op, not a visible bug.
  const CITATION_HIGHLIGHT_MS = 9000; // fixed, generous read time for a ~10-25 word quote -- a state cue, not a literal timer synced to anything
  const DOCUMENT_GLOW_CITED = 0.55;

  function normalizeForCitationMatch(s) {
    return s
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .toLowerCase();
  }

  function findCitedQuote(citations) {
    if (!documentVisible || !documentTextRaw || !Array.isArray(citations)) return null;
    const haystack = normalizeForCitationMatch(documentTextRaw);
    const match = citations.find(c => {
      const needle = normalizeForCitationMatch((c.quote || '').replace(/\*/g, '').trim());
      return needle && haystack.includes(needle);
    });
    return match ? match.quote : null;
  }

  // Called from app.js on the live `citation` SSE event (one per beat that
  // cited anything) — most calls find no match (citing some other real work
  // is the common case, per the citations tool's own schema) and are a
  // silent no-op.
  function citeFromBeat(citations) {
    const quote = findCitedQuote(citations);
    if (!quote) return;

    if (citationHighlightTimer) clearTimeout(citationHighlightTimer);
    documentPageMats.forEach((mat, i) => {
      animateSeatProp(
        mat,
        'emissiveColor',
        BABYLON.Color3.FromHexString(DOCUMENT_PAGE_COLOR).scale(DOCUMENT_GLOW_CITED),
        `documentGlow-${i}`
      );
    });
    onDocumentCitationChange?.(quote);

    citationHighlightTimer = setTimeout(() => {
      citationHighlightTimer = null;
      updateDocumentAttention(!!currentSpeakingId);
      onDocumentCitationChange?.(null);
    }, CITATION_HIGHLIGHT_MS);
  }

  function clearDocumentCitation() {
    if (!citationHighlightTimer) return;
    clearTimeout(citationHighlightTimer);
    citationHighlightTimer = null;
    onDocumentCitationChange?.(null);
  }

  // #34: click-to-inspect. The scene has no camera controls (init()'s own
  // "Deliberately no attachControl" note) -- this is the second scripted
  // camera move alongside frameCamera's speaker framing, not a new
  // interactive-camera feature. onDocumentInspectChange (set via init()'s
  // options bag) is how app.js's DOM reading panel stays in sync with open/
  // close -- scene.js owns click detection and the camera move, app.js owns
  // rendering the actual document text into the panel.
  function openDocumentInspect() {
    if (!cameraRef || !documentVisible || documentInspecting) return;
    documentInspecting = true;
    animateCameraProp(cameraRef, 'alpha', cameraRef.alpha + shortestAngleDelta(cameraRef.alpha, CAMERA_DEFAULT_ALPHA));
    animateCameraProp(cameraRef, 'beta', CAMERA_INSPECT_BETA);
    animateCameraProp(cameraRef, 'radius', CAMERA_INSPECT_RADIUS);
    animateCameraProp(cameraRef, 'target', new BABYLON.Vector3(DOCUMENT_X, DOCUMENT_Y, DOCUMENT_Z));
    onDocumentInspectChange?.(true);
  }

  // Exposed directly (see the returned API below) so the DOM panel's close
  // button and an Escape-key listener (both in app.js) can end inspect mode
  // without going through the canvas click path at all.
  function closeDocumentInspect() {
    if (!cameraRef || !documentInspecting) return;
    documentInspecting = false;
    animateCameraProp(cameraRef, 'alpha', cameraRef.alpha + shortestAngleDelta(cameraRef.alpha, CAMERA_DEFAULT_ALPHA));
    animateCameraProp(cameraRef, 'beta', CAMERA_DEFAULT_BETA);
    animateCameraProp(cameraRef, 'radius', currentSpeakingId ? CAMERA_SPEAKER_RADIUS : CAMERA_DEFAULT_RADIUS);
    animateCameraProp(cameraRef, 'target', new BABYLON.Vector3(0, 1, 0));
    onDocumentInspectChange?.(false);
  }

  function toggleDocumentInspect() {
    if (documentInspecting) closeDocumentInspect();
    else openDocumentInspect();
  }

  // #357: the fireplace -- surround geometry, the fire itself, and the two
  // PointLights that replace the old floating 'hearth' + 'ember' sphere
  // (see HEARTH_RANGE's comment above for why those old numbers can't just
  // move here unchanged). No CSG boolean subtract is used to cut a literal
  // hole -- same approach buildBookshelves' own comment describes avoiding
  // a solid-box occlusion problem with: layered open geometry (a recessed
  // soot-dark back panel framed by jambs/lintel that sit proud of the
  // breast) reads as an opening without one. Sets the fireLight/
  // fireGlowLight/flameMeshes/emberMat module vars that updateFire() (and
  // the shadow generator, in init()) address afterward.
  function buildHearth(scene) {
    const tangentAngle = HEARTH_ANGLE + Math.PI / 2;
    const breastFrontRadius = HEARTH_BREAST_RADIUS - HEARTH_DEPTH / 2;
    const breastHeight = WALL_HEIGHT - 0.6;
    const jambWidth = 0.22;
    const lintelHeight = 0.18;
    // Half-width of the opening the rest of the breast has to leave clear --
    // jambs sit right at this offset, cheeks start just past it.
    const openingHalfWidth = FIREBOX_WIDTH / 2 + jambWidth;
    const openingTop = FIREBOX_TOP + lintelHeight;

    const breastMat = new BABYLON.StandardMaterial('hearthBreastMat', scene);
    breastMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_BORDER);
    breastMat.emissiveColor = BABYLON.Color3.FromHexString(LODGE_AMBER_DIM).scale(0.06);
    breastMat.specularColor = new BABYLON.Color3(0.04, 0.03, 0.02);

    // Chimney breast -- the projecting mass everything else mounts to, same
    // box-set-into-the-wall placement as buildBookshelves' back panel. Built
    // as two side cheeks + a header over the opening, NOT one solid box: an
    // early version was a single box spanning the full width/height, and
    // its own front face -- being solid -- occluded the firebox, jambs, and
    // flame recessed behind it entirely (the camera saw only the breast's
    // flat face; verified via scene.pick() at the fire's own screen
    // position hitting 'hearthBreast', not the flame). Same problem
    // buildBookshelves' own comment describes for a solid carcass, same
    // fix: leave the opening's footprint clear rather than try to cut it.
    const cheekWidth = (HEARTH_WIDTH - openingHalfWidth * 2) / 2;
    [-1, 1].forEach(side => {
      const spot = wallSpot(HEARTH_ANGLE, HEARTH_BREAST_RADIUS);
      const offset = side * (openingHalfWidth + cheekWidth / 2);
      const cheek = BABYLON.MeshBuilder.CreateBox(
        `hearthCheek-${side}`,
        { width: cheekWidth, height: breastHeight, depth: HEARTH_DEPTH },
        scene
      );
      cheek.position.set(
        spot.x + Math.cos(tangentAngle) * offset,
        breastHeight / 2,
        spot.z + Math.sin(tangentAngle) * offset
      );
      cheek.rotation.y = spot.rotationY;
      cheek.material = breastMat;
    });
    const headerSpot = wallSpot(HEARTH_ANGLE, HEARTH_BREAST_RADIUS);
    const headerHeight = breastHeight - openingTop;
    const header = BABYLON.MeshBuilder.CreateBox(
      'hearthHeader',
      { width: HEARTH_WIDTH, height: headerHeight, depth: HEARTH_DEPTH },
      scene
    );
    header.position.set(headerSpot.x, openingTop + headerHeight / 2, headerSpot.z);
    header.rotation.y = headerSpot.rotationY;
    header.material = breastMat;

    // Firebox back panel -- soot-dark, sitting in the depth the breast's
    // cheeks/header now leave open. This, not a cut hole, is what reads as
    // "an opening" once the jambs/lintel frame it and the fire lights it
    // from in front.
    const sootSpot = wallSpot(HEARTH_ANGLE, FIREBOX_RADIUS);
    const sootPanel = BABYLON.MeshBuilder.CreatePlane(
      'hearthSoot',
      { width: FIREBOX_WIDTH, height: FIREBOX_TOP },
      scene
    );
    sootPanel.position.set(sootSpot.x, FIREBOX_TOP / 2, sootSpot.z);
    sootPanel.rotation.y = sootSpot.rotationY;
    const sootMat = new BABYLON.StandardMaterial('hearthSootMat', scene);
    sootMat.diffuseColor = BABYLON.Color3.FromHexString(SOOT);
    sootMat.emissiveColor = BABYLON.Color3.FromHexString(SOOT).scale(0.3);
    sootMat.specularColor = new BABYLON.Color3(0, 0, 0);
    sootMat.backFaceCulling = false;
    sootPanel.material = sootMat;

    // Jambs + lintel -- the frame around the opening, sitting just proud of
    // the breast's own front face (not coplanar with it) so they read as
    // applied trim and don't z-fight.
    const jambRadius = breastFrontRadius - 0.02;
    const jambMat = new BABYLON.StandardMaterial('hearthJambMat', scene);
    jambMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_AMBER_DIM);
    jambMat.emissiveColor = BABYLON.Color3.FromHexString(LODGE_AMBER_DIM).scale(0.1);
    jambMat.specularColor = new BABYLON.Color3(0.05, 0.04, 0.02);

    [-1, 1].forEach(side => {
      const spot = wallSpot(HEARTH_ANGLE, jambRadius);
      const offset = side * (FIREBOX_WIDTH / 2 + jambWidth / 2);
      const jamb = BABYLON.MeshBuilder.CreateBox(
        `hearthJamb-${side}`,
        { width: jambWidth, height: FIREBOX_TOP, depth: 0.3 },
        scene
      );
      jamb.position.set(
        spot.x + Math.cos(tangentAngle) * offset,
        FIREBOX_TOP / 2,
        spot.z + Math.sin(tangentAngle) * offset
      );
      jamb.rotation.y = spot.rotationY;
      jamb.material = jambMat;
    });

    const lintelSpot = wallSpot(HEARTH_ANGLE, jambRadius);
    const lintel = BABYLON.MeshBuilder.CreateBox(
      'hearthLintel',
      { width: FIREBOX_WIDTH + jambWidth * 2, height: lintelHeight, depth: 0.3 },
      scene
    );
    lintel.position.set(lintelSpot.x, FIREBOX_TOP + lintelHeight / 2, lintelSpot.z);
    lintel.rotation.y = lintelSpot.rotationY;
    lintel.material = jambMat;

    // Mantel shelf -- the dorian-frame echo the issue asks for, projecting
    // further into the room than the jambs for a real overhang silhouette.
    const mantelRadius = jambRadius - 0.25;
    const mantelSpot = wallSpot(HEARTH_ANGLE, mantelRadius);
    const mantel = BABYLON.MeshBuilder.CreateBox(
      'hearthMantel',
      { width: HEARTH_WIDTH, height: 0.14, depth: HEARTH_DEPTH + 0.4 },
      scene
    );
    mantel.position.set(mantelSpot.x, MANTEL_Y, mantelSpot.z);
    mantel.rotation.y = mantelSpot.rotationY;
    const mantelMat = new BABYLON.StandardMaterial('hearthMantelMat', scene);
    mantelMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_GOLD);
    mantelMat.emissiveColor = BABYLON.Color3.FromHexString(LODGE_GOLD).scale(0.18);
    mantelMat.specularColor = new BABYLON.Color3(0.1, 0.08, 0.04);
    mantel.material = mantelMat;

    // Hearth stone -- a low slab flush with the floor, projecting past the
    // jambs into the room, the one piece of the surround that isn't
    // wall-mounted -- what the fire itself sits on.
    const stoneRadius = jambRadius + 0.3;
    const stoneSpot = wallSpot(HEARTH_ANGLE, stoneRadius);
    const stone = BABYLON.MeshBuilder.CreateBox(
      'hearthStone',
      { width: HEARTH_WIDTH - 0.4, height: 0.08, depth: 0.9 },
      scene
    );
    stone.position.set(stoneSpot.x, 0.04, stoneSpot.z);
    stone.rotation.y = stoneSpot.rotationY;
    const stoneMat = new BABYLON.StandardMaterial('hearthStoneMat', scene);
    stoneMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_BORDER);
    stoneMat.specularColor = new BABYLON.Color3(0.06, 0.05, 0.03);
    stone.material = stoneMat;

    // The fire itself -- tapered emissive cones for flame (updateFire()
    // drives their height/brightness every frame), an ember bed glowing
    // beneath them. Built just in front of the soot panel, inside the jamb
    // opening.
    const fireSpot = wallSpot(HEARTH_ANGLE, FIREBOX_RADIUS - 0.15);
    flameMeshes = [];
    for (let i = 0; i < FLAME_COUNT; i++) {
      const spread = -0.55 + i * (1.1 / (FLAME_COUNT - 1));
      const baseHeight = 0.5 + (i % 2) * 0.18;
      const baseY = 0.1;
      const cone = BABYLON.MeshBuilder.CreateCylinder(
        `flame-${i}`,
        {
          diameterBottom: 0.24 - Math.abs(spread) * 0.08,
          diameterTop: 0.02,
          height: baseHeight,
          tessellation: 8,
        },
        scene
      );
      cone.position.set(
        fireSpot.x + Math.cos(tangentAngle) * spread,
        baseY + baseHeight / 2,
        fireSpot.z + Math.sin(tangentAngle) * spread
      );
      cone.rotation.y = fireSpot.rotationY;
      const baseColor = BABYLON.Color3.FromHexString(i % 2 === 0 ? FLAME_HOT : FLAME_MID);
      const mat = new BABYLON.StandardMaterial(`flameMat-${i}`, scene);
      mat.emissiveColor = baseColor;
      mat.disableLighting = true;
      mat.backFaceCulling = false;
      mat.alpha = 0.92;
      cone.material = mat;
      flameMeshes.push({ mesh: cone, baseHeight, baseY, phase: i * 1.7, baseColor });
    }

    emberMat = new BABYLON.StandardMaterial('emberBedMat', scene);
    emberMat.emissiveColor = BABYLON.Color3.FromHexString(EMBER_HOT);
    emberMat.disableLighting = true;
    const emberBed = BABYLON.MeshBuilder.CreateBox(
      'emberBed',
      { width: FIREBOX_WIDTH - 0.3, height: 0.08, depth: 0.4 },
      scene
    );
    emberBed.position.set(fireSpot.x, 0.08, fireSpot.z);
    emberBed.rotation.y = fireSpot.rotationY;
    emberBed.material = emberMat;

    // The two lights. fireLight sits inside the firebox and does the
    // room's actual illumination (replaces the old floating 'hearth'
    // PointLight); fireGlowLight is the short-range fill that keeps the
    // jambs/mantel lit from the front -- see FIRE_GLOW_RANGE's comment
    // above for why a second light is needed at all.
    fireLight = new BABYLON.PointLight('fireLight', new BABYLON.Vector3(fireSpot.x, 0.5, fireSpot.z), scene);
    fireLight.diffuse = BABYLON.Color3.FromHexString(LODGE_FIRE);
    fireLight.specular = BABYLON.Color3.FromHexString(LODGE_AMBER);
    fireLight.range = HEARTH_RANGE;
    fireLight.intensity = HEARTH_INTENSITY_LIT;

    const glowSpot = wallSpot(HEARTH_ANGLE, FIREBOX_RADIUS - 0.6);
    fireGlowLight = new BABYLON.PointLight('fireGlowLight', new BABYLON.Vector3(glowSpot.x, 0.9, glowSpot.z), scene);
    fireGlowLight.diffuse = BABYLON.Color3.FromHexString(LODGE_GOLD);
    fireGlowLight.specular = BABYLON.Color3.FromHexString(LODGE_GOLD);
    fireGlowLight.range = FIRE_GLOW_RANGE;
    fireGlowLight.intensity = FIRE_GLOW_INTENSITY_LIT;
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

    // #424 stretch: a single candle at the table's center. Static, not
    // wired into fireLevel/updateFire() -- a hand-lit candle on the table
    // isn't the hearth banking down over the course of a meeting, it just
    // sits there lit. Short PointLight range so it reads as an intimate
    // accent at the table itself rather than competing with the sconces/
    // hearth as a fourth room-scale source.
    const candleBody = BABYLON.MeshBuilder.CreateCylinder(
      'candleBody',
      { diameterTop: 0.09, diameterBottom: 0.1, height: 0.35, tessellation: 12 },
      scene
    );
    candleBody.position.set(0, 0.4 + 0.175, 0);
    const candleBodyMat = new BABYLON.StandardMaterial('candleBodyMat', scene);
    candleBodyMat.diffuseColor = BABYLON.Color3.FromHexString('#d9cba8');
    candleBodyMat.specularColor = new BABYLON.Color3(0.05, 0.05, 0.04);
    candleBody.material = candleBodyMat;

    const candleFlame = BABYLON.MeshBuilder.CreateCylinder(
      'candleFlame',
      { diameterTop: 0.01, diameterBottom: 0.06, height: 0.14, tessellation: 8 },
      scene
    );
    candleFlame.position.set(0, 0.4 + 0.35 + 0.07, 0);
    const candleFlameMat = new BABYLON.StandardMaterial('candleFlameMat', scene);
    candleFlameMat.emissiveColor = BABYLON.Color3.FromHexString(FLAME_HOT);
    candleFlameMat.disableLighting = true;
    candleFlameMat.backFaceCulling = false;
    candleFlame.material = candleFlameMat;

    const candleLight = new BABYLON.PointLight('candleLight', new BABYLON.Vector3(0, 0.9, 0), scene);
    candleLight.diffuse = BABYLON.Color3.FromHexString(LODGE_GOLD);
    candleLight.specular = BABYLON.Color3.FromHexString(LODGE_GOLD);
    candleLight.intensity = 1.4;
    candleLight.range = 4.5;

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

  // #360: six states per seat, up from three -- empty (no one there),
  // occupied (present, but no pool/disposition signal yet -- before the
  // first passage's director consult), listening (present, not in the
  // director's current candidate pool), thinking (present and in the pool --
  // a candidate to speak next, "leaning in"), waiting (their own last
  // disposition update named someone they want to respond to -- surfaces
  // waitingOnMemberId, #203's own signal, that the pipeline already computed
  // and previously discarded), speaking (#28 -- the brightest glow and most
  // pronounced scale-up). Table-driven, not an if/else cascade, so every
  // transition -- not just speaking's original one -- runs through the same
  // eased animation below instead of the flicker a direct material mutation
  // would produce now that there are six states instead of three to jump
  // between.
  const SEAT_STATE_SPECS = {
    empty: { diffuse: LODGE_BORDER, emissive: null, emissiveScale: 0, scale: 1 },
    occupied: { diffuse: LODGE_AMBER, emissive: LODGE_AMBER, emissiveScale: 0.35, scale: 1 },
    listening: { diffuse: LODGE_AMBER, emissive: LODGE_AMBER_DIM, emissiveScale: 0.3, scale: 1 },
    thinking: { diffuse: LODGE_AMBER, emissive: LODGE_AMBER, emissiveScale: 0.55, scale: 1.03 },
    waiting: { diffuse: LODGE_AMBER, emissive: LODGE_GOLD, emissiveScale: 0.65, scale: 1.05 },
    speaking: { diffuse: LODGE_AMBER, emissive: LODGE_GOLD, emissiveScale: 0.9, scale: 1.08 },
  };
  const SEAT_STATE_MS = 500;
  const SEAT_STATE_FPS = 60;

  // Built lazily, same reason as getCameraEasing below (BABYLON isn't
  // guaranteed loaded yet at module-init time).
  let seatStateEasing = null;
  function getSeatStateEasing() {
    if (!seatStateEasing) {
      seatStateEasing = new BABYLON.CubicEase();
      seatStateEasing.setEasingMode(BABYLON.EasingFunction.EASINGMODE_EASEINOUT);
    }
    return seatStateEasing;
  }

  // Same CreateAndStartAnimation + stopAnimation pattern as
  // animateCameraProp (#232) below, generalized to whichever property/target
  // a seat state touches (Color3 on the seat material, Vector3 scaling on
  // the avatar plane -- CreateAndStartAnimation infers the animation type
  // from the current value either way). Two cases fall back to setting the
  // value directly instead of tweening: reduced motion (Principle 4,
  // precedent #218 -- same treatment the fire's own flicker gets), and no
  // scene yet at all -- buildTableAndSeats() calls applySeatState() to set
  // each seat's initial 'empty' look before sceneRef is assigned (see
  // init()), so an animation would have nothing to run against.
  function animateSeatProp(target, property, toValue, name) {
    if (!sceneRef || reducedMotion) {
      target[property] = toValue;
      return;
    }
    sceneRef.stopAnimation(target, name);
    BABYLON.Animation.CreateAndStartAnimation(
      name,
      target,
      property,
      SEAT_STATE_FPS,
      Math.round((SEAT_STATE_MS / 1000) * SEAT_STATE_FPS),
      target[property],
      toValue,
      BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT,
      getSeatStateEasing()
    );
  }

  function applySeatState(seat, state) {
    const spec = SEAT_STATE_SPECS[state];
    if (!spec) return;
    const emissiveColor = spec.emissive
      ? BABYLON.Color3.FromHexString(spec.emissive).scale(spec.emissiveScale)
      : new BABYLON.Color3(0, 0, 0);
    animateSeatProp(seat.seatMat, 'diffuseColor', BABYLON.Color3.FromHexString(spec.diffuse), 'diffuseColor');
    animateSeatProp(seat.seatMat, 'emissiveColor', emissiveColor, 'emissiveColor');
    animateSeatProp(seat.avatar, 'scaling', new BABYLON.Vector3(spec.scale, spec.scale, spec.scale), 'scaling');
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
    // #34: while the user has the document open, a speaker-framing swing
    // (or the reset one on updateSeats) would fight the inspect camera move
    // -- leave the framing alone until they close it explicitly.
    if (!cameraRef || documentInspecting) return;
    const seat = memberId && seatMeshes.find(s => s.memberId === memberId);
    const targetAlpha = seat
      ? cameraRef.alpha + shortestAngleDelta(cameraRef.alpha, seat.angle)
      : cameraRef.alpha + shortestAngleDelta(cameraRef.alpha, CAMERA_DEFAULT_ALPHA);
    const targetRadius = seat ? CAMERA_SPEAKER_RADIUS : CAMERA_DEFAULT_RADIUS;
    animateCameraProp(cameraRef, 'alpha', targetAlpha);
    animateCameraProp(cameraRef, 'radius', targetRadius);
  }

  let currentSpeakingId = null;
  // #360: the director's current candidate pool (null until the first
  // passage's consult resolves -- distinguishes "no signal yet" from "an
  // empty pool"), and every present member whose own last disposition update
  // named someone they want to respond to. Both come in over SSE
  // (app.js's setPool/setDisposition below) and drive seatStateFor()
  // alongside currentSpeakingId.
  let currentPoolIds = null;
  const waitingMemberIds = new Set();
  // #451: each present member's most recent #449 reaction tag
  // (happy/thinking/angry/none), keyed by memberId. Lifetime deliberately
  // mirrors waitingMemberIds above rather than a timed decay or a
  // turn-scoped flash: a reaction is how a member reads *right now*, which
  // stays true regardless of how many other members speak in between, until
  // this member's own next disposition update either confirms or replaces
  // it -- exactly the same "sticky until this member is heard from again"
  // lifetime the server already gives waitingOnMemberId, and the disposition
  // SSE event already carries both together. Read via getReaction() by
  // applyReactionTexture (#452) to pick which portrait texture a seat
  // shows.
  const memberReactions = new Map();

  // speaking (currentSpeakingId) takes priority over waiting, which takes
  // priority over pool membership -- a member who's actually mid-turn or who
  // explicitly wants back in reads as more "active" than merely being a
  // candidate the director could call on.
  function seatStateFor(memberId) {
    if (memberId === currentSpeakingId) return 'speaking';
    if (waitingMemberIds.has(memberId)) return 'waiting';
    if (currentPoolIds) return currentPoolIds.has(memberId) ? 'thinking' : 'listening';
    return 'occupied';
  }

  function refreshSeatStates() {
    seatMeshes.forEach(seat => {
      if (!seat.memberId) return; // empty seats aren't affected either way
      applySeatState(seat, seatStateFor(seat.memberId));
    });
  }

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
    // #360: same reasoning -- a stale pool/waiting signal would describe
    // people who may no longer even be seated.
    currentPoolIds = null;
    waitingMemberIds.clear();
    // #451: same reasoning -- a stale reaction would describe an expression
    // struck for a beat that's no longer part of the current occupancy.
    memberReactions.clear();
    // #34: same reasoning -- a new roster likely means a new (or cleared)
    // provocation too, so an open reading view shouldn't survive it.
    if (documentInspecting) closeDocumentInspect();
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

  // #360: the director's candidate pool for the current (or just-refreshed)
  // passage -- present members not in it read as "listening" rather than
  // the generic "occupied". ids is a plain array off the wire (app.js), not
  // yet a Set.
  function setPool(ids) {
    if (!sceneRef || !seatMeshes.length) return;
    currentPoolIds = new Set(ids || []);
    refreshSeatStates();
  }

  // #452: resolves which texture a seated member's billboard should show
  // for their current reaction, and applies it directly to that seat's
  // material. Falls back to the member's default portrait both for 'none'
  // and for any member/reaction pair that hasn't been generated yet (25/38
  // members as of #470/#472) -- never hides the seat the way
  // getPortraitTexture's own failure path does, since a reaction not
  // landing shouldn't read as the member themselves going missing.
  //
  // Unlike getPortraitTexture, this does NOT optimistically assign a
  // not-yet-loaded texture and let onError correct it afterward: with most
  // member/reaction pairs currently absent, that would flash a blank
  // texture on nearly every disposition update before falling back, which
  // reads as a bug rather than a transition. Instead the seat keeps
  // whatever it's already showing until the reaction image is confirmed to
  // exist via BABYLON.Texture's onLoad callback, then swaps -- a hard cut,
  // not a cross-fade, matching the rest of this file's animation
  // vocabulary: animateSeatProp's CreateAndStartAnimation tweens Color3/
  // Vector3 properties (diffuseColor, scaling), and Babylon has no built-in
  // way to interpolate between two Texture objects. A real cross-fade would
  // need a second overlapping plane with its own alpha tween -- a
  // meaningfully bigger feature than this issue asks for.
  function applyReactionTexture(seat, memberId, reaction) {
    const defaultTex = getPortraitTexture(sceneRef, memberId);
    const key = reaction && reaction !== 'none' ? `${memberId}-${reaction}` : null;
    if (!key || missingReactionKeys.has(key)) {
      seat.avatarMat.emissiveTexture = defaultTex;
      return;
    }
    if (reactionTextures[key]) {
      seat.avatarMat.emissiveTexture = reactionTextures[key];
      return;
    }
    // Not yet known either way -- show the default while we find out, and
    // swap over asynchronously only on a confirmed successful load.
    seat.avatarMat.emissiveTexture = defaultTex;
    const tex = new BABYLON.Texture(
      `/portraits/${key}.png`,
      sceneRef,
      false,
      false,
      BABYLON.Texture.TRILINEAR_SAMPLINGMODE,
      () => {
        reactionTextures[key] = tex;
        // The load is async -- by the time it resolves, this seat may have
        // been reassigned to someone else, or this member may have moved on
        // to a different reaction. Only apply if both still match.
        const current = seatMeshes.find(s => s.memberId === memberId);
        if (current && getReaction(memberId) === reaction) {
          current.avatarMat.emissiveTexture = tex;
        }
      },
      () => {
        missingReactionKeys.add(key);
      }
    );
    // Same V-axis flip as getPortraitTexture, and for the same reason (see
    // that function's comment) -- these are the same portrait pipeline's
    // images, just a different suffix.
    tex.vScale = -1;
    tex.vOffset = 1;
  }

  // #360/#451/#452: waitingOnMemberId and #449's reaction tag from a beat's
  // disposition update -- both sticky per member until their own next
  // disposition update says otherwise, same lifetime the server-side
  // disposition object itself has (see memberReactions above for why that's
  // the right lifetime for reaction specifically). Empty seats can't reach
  // this (memberId always comes from a real beat), so no seat.memberId guard
  // is needed here the way the others have.
  function setDisposition(memberId, waitingOnMemberId, reaction) {
    if (!sceneRef || !seatMeshes.length || !memberId) return;
    if (waitingOnMemberId) waitingMemberIds.add(memberId);
    else waitingMemberIds.delete(memberId);
    if (reaction) memberReactions.set(memberId, reaction);
    refreshSeatStates();
    const seat = seatMeshes.find(s => s.memberId === memberId);
    if (seat) applyReactionTexture(seat, memberId, getReaction(memberId));
  }

  // #451: current reaction tag for a member, 'none' if they have none yet
  // recorded (never seated, or their only disposition update so far tagged
  // 'none'). Exists so #452 has a read hook into memberReactions without
  // reaching into module-private state, and so this issue's own live
  // verification has something to assert against besides raw SSE frames.
  function getReaction(memberId) {
    return memberReactions.get(memberId) || 'none';
  }

  // #28: brightens whichever seated member is currently generating a turn,
  // returns everyone else to whatever seatStateFor() says they should read
  // as now that speaking has been ceded (waiting/thinking/listening/
  // occupied, not always neutral). memberId null/absent just clears back to
  // that same non-speaking read across the board -- used both when a round
  // finishes and when a stream errors mid-generation.
  function setSpeaking(memberId) {
    if (!sceneRef || !seatMeshes.length) return;
    currentSpeakingId = memberId || null;
    refreshSeatStates();
    updateDocumentAttention(!!currentSpeakingId);
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

  function init(canvas, options = {}) {
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
        CAMERA_DEFAULT_BETA,
        CAMERA_DEFAULT_RADIUS,
        new BABYLON.Vector3(0, 1, 0),
        scene
      );
      // Deliberately no attachControl — not interactive this phase. (#34's
      // click-to-inspect is a scripted camera move triggered by a canvas
      // click handler, not camera-drag input, so this still holds.)
      cameraRef = camera;
      onDocumentInspectChange = options.onDocumentInspect || null;
      onDocumentCitationChange = options.onDocumentCitation || null;

      // Light *colors* need to be bright/warm regardless of the dark theme
      // tokens — those describe surface/background hues, not illumination.
      const ambient = new BABYLON.HemisphericLight('ambient', new BABYLON.Vector3(0, 1, 0), scene);
      ambient.diffuse = new BABYLON.Color3(0.55, 0.46, 0.36);
      // #424: 0.5 -> 0.62. Point lights (sconces/hearth) are the room's
      // real light sources and stay untouched here; this is only the
      // shadowless base fill everything else sits on, so a modest bump
      // lifts the room generally (Rachel: "too dark, even during a
      // session") without competing with either.
      ambient.intensity = 0.62;

      const floor = BABYLON.MeshBuilder.CreateGround('floor', { width: FLOOR_SIZE, height: FLOOR_SIZE }, scene);
      const floorMat = new BABYLON.StandardMaterial('floorMat', scene);
      floorMat.diffuseColor = BABYLON.Color3.FromHexString(LODGE_BORDER);
      floorMat.specularColor = new BABYLON.Color3(0, 0, 0);
      floor.material = floorMat;

      buildWalls(scene);
      buildWallDressing(scene);
      buildHearth(scene);
      buildTableAndSeats(scene);
      buildDocumentObject(scene);
      sceneRef = scene;

      // #34: fresh per init, same reasoning as the fire-state reset just
      // below -- a newly opened room isn't mid-read of a previous instance's
      // document.
      documentVisible = false;
      documentInspecting = false;
      documentTextRaw = '';
      if (citationHighlightTimer) clearTimeout(citationHighlightTimer);
      citationHighlightTimer = null;

      // #34: click-to-inspect the document object. A native canvas click
      // listener + scene.pick(), not Babylon's ActionManager -- ActionManager
      // would need registering per mesh (base/spine/2 pages) for what's
      // really one hit-test. stopPropagation matters here specifically: the
      // whole `.witness-room` div has its own onclick (Witness.advance(),
      // #257) that a canvas click would otherwise bubble into, silently
      // skipping ahead in the transcript at the same moment the reading
      // panel opens.
      canvas.addEventListener('click', e => {
        if (!documentVisible) return;
        const pick = scene.pick(scene.pointerX, scene.pointerY);
        if (pick.hit && pick.pickedMesh && documentMeshes.includes(pick.pickedMesh)) {
          e.stopPropagation();
          toggleDocumentInspect();
        }
      });

      // #357: fresh fire state per init -- a newly opened room starts lit,
      // not mid-way through wherever a previous scene instance left off.
      reducedMotion = prefersReducedMotion();
      fireLevel = 1;
      fireTargetLevel = 1;
      fireBaseLevel = 1;
      if (fireStirTimer) clearTimeout(fireStirTimer);
      fireStirTimer = null;

      // #305: hearth-only shadows -- the issue's own steer ("the hearth
      // alone is probably enough for the effect and cheaper than adding
      // shadow generators for every sconce too"). Babylon point lights
      // render shadows as a 6-face cube map internally (unlike a single
      // shadow map for a directional/spot light), already the most
      // expensive shadow type available; a generator per sconce would
      // triple that cost for a room this small, so the sconces stay
      // shadowless fill light only. #357 moved the hearth from a floating
      // PointLight to fireLight, seated inside the new firebox geometry --
      // same shadow-caster role, new source position.
      const shadowGenerator = new BABYLON.ShadowGenerator(SHADOW_MAP_SIZE, fireLight);
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
      engine.runRenderLoop(() => {
        updateFire();
        scene.render();
      });

      const ro = new ResizeObserver(() => engine.resize());
      ro.observe(canvas);

      return true;
    } catch (e) {
      console.error('[scene] init failed', e);
      return false;
    }
  }

  return {
    init,
    updateSeats,
    setSpeaking,
    setPool,
    setDisposition,
    getReaction,
    getSeatScreenPosition,
    setPassageCount,
    stirFire,
    setDocumentText,
    closeDocumentInspect,
    citeFromBeat,
  };
})();
