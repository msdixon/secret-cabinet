'use strict';

// #193 seam-map, module 1 of 8 — the lodge roster.
//
// Express-agnostic by design, following pipeline.js's convention: no
// module-level ROSTER singleton, no req/res. Callers own the roster array
// and the file paths; every function here takes what it needs as a
// parameter instead of reaching for a shared global.

const fs = require('fs');
const path = require('path');

// Small pool of neutral symbols for members without a hand-picked glyph (the
// original 12 carry meaningful ones set by hand in roster.json). Cycles once
// exhausted — see #80.
const FALLBACK_GLYPHS = [
  '☉',
  '♀',
  '♂',
  '♄',
  '♅',
  '♆',
  '♇',
  '☄',
  '★',
  '☆',
  '✪',
  '✴',
  '✷',
  '✹',
  '✵',
  '❋',
  '◆',
  '◇',
  '▲',
  '▽',
  '⬟',
  '⬢',
  '⌖',
  '✻',
];

// Deterministic-ish: picks the first pool symbol not already in use by the
// roster, so glyphs stay distinct as long as the pool has room; cycles by
// roster size once it doesn't.
function assignGlyph(roster) {
  const used = new Set(roster.map(m => m.glyph).filter(Boolean));
  const free = FALLBACK_GLYPHS.find(g => !used.has(g));
  return free || FALLBACK_GLYPHS[roster.length % FALLBACK_GLYPHS.length];
}

// #29 (ElevenLabs pass) — the default `voicePool` a caller can hand
// reloadRoster() below to backfill a `voiceId` per member. Verified live
// against GET /v1/voices on 2026-08-19 -- this is the account's actual
// premade-voice library, not a guess: an earlier draft of this pool used the
// historically-standard legacy voice IDs (Rachel/Domi/Antoni/etc.), and only
// 2 of those 9 turned out to still exist here. Override via the
// ELEVENLABS_VOICE_POOL env var (see server.js) if this account's library
// changes, or hand-edit a member's voiceId in roster.json for one-offs.
const FALLBACK_VOICE_IDS = [
  'CwhRBWXzGAHq8TQ4Fs17', // Roger — laid-back, casual, resonant
  'EXAVITQu4vr4xnSDxMaL', // Sarah — mature, reassuring, confident
  'FGY2WhTYpPnrIDTdsKH5', // Laura — enthusiast, quirky attitude
  'IKne3meq5aSn9XLyUdCD', // Charlie — deep, confident, energetic
  'JBFqnCBsd6RMkjVDRZzb', // George — warm, captivating storyteller
  'N2lVS1w4EtoT3dr4eOWO', // Callum — husky trickster
  'SAz9YHcvj6GT2YYXdXww', // River — relaxed, neutral, informative
  'SOYHLrjzK2X1ezoPC6cr', // Harry — fierce warrior
  'TX3LPaxmHKxFdv7VOQHJ', // Liam — energetic, social media creator
  'Xb7hH8MSUJpSbSDYk0k2', // Alice — clear, engaging educator
  'XrExE9yKIg1WjnnlVkGX', // Matilda — knowledgeable, professional
  'bIHbv24MWmeRgasZH58o', // Will — relaxed optimist
  'cgSgspJ2msm6clMCkdW9', // Jessica — playful, bright, warm
  'cjVigY5qzO86Huf0OWal', // Eric — smooth, trustworthy
  'hpp4J3VqNfWAUOO0d1Us', // Bella — professional, bright, warm
  'iP95p4xoKVk53GoZ742B', // Chris — charming, down-to-earth
  'nPczCjzI2devNBz1zQrb', // Brian — deep, resonant and comforting
  'onwK4e9ZLuTAKqWW03F9', // Daniel — steady broadcaster
  'pFZP5JQG7iQjIQuC4Bku', // Lily — velvety actress
  'pNInz6obpgDQGcFmaJgB', // Adam — dominant, firm
  'pqHfZKP75CvOlQylNhV4', // Bill — wise, mature, balanced
  // #350 — the above 21 are ElevenLabs' premade-voice library (see the
  // FALLBACK_VOICE_ACCENTS comment below for why that pool turned out to be
  // almost entirely American/British and needed widening). These 14 are
  // pulled from the broader searchable shared-voice library instead
  // (GET /v1/shared-voices?accent=<x>), each verified live on 2026-08-21 by
  // an actual /v1/text-to-speech call against this account's API key — a
  // shared-library voice_id works there directly, with no separate
  // "add to my voices" step required first. Picked for real gender/accent
  // metadata plus a demeanor read off the voice's own name, same convention
  // as the 21 above.
  'GROMoQXjD2D16z0prfB1', // Elias — warm, smooth, natural (german)
  'A9evEp8yGjv4c3WsIKuY', // Ralf Eisend — deep and gravely (german)
  'zlatCM6nK59gyedHFFxn', // Christian Plasa — wise and commanding (german)
  'BIvP0GN1cAtSRTxNHnWS', // Ellen — serious, direct and confident (german)
  'xTZlmU8dKXdyk4XGYGFg', // Antoine — articulate, calm and bright (french)
  'bObiIpcSB2feMOHORpee', // Antonin — warm, unsettling, elegant (french)
  'dTmTLshIypwp08eftJH6', // Sylvie — classy (french)
  'qQFoiN2eQXULODjD1SwL', // Emanuele Matte — clear and serious (italian)
  'goT3UYdM9bhm0n2lmKQx', // Edward — British, dark, seductive, low (british)
  'exsUS4vynmxd379XN4yO', // Blondie — conversational (british)
  'qwaVDEGNsBllYcZO1ZOJ', // Patrick — engaging and warm (irish)
  'C92s6vssSLlabgIln1iY', // Michelle — direct and natural (irish)
  '8HSRAwEWAAa6wv9cdi5S', // Dasha — warm, serious, and smooth (russian)
  'n3yMmKmTfVCEM13Kk2lp', // Silvara — cheerful, friendly, and light (spanish)
];

// #333 — the gender each FALLBACK_VOICE_IDS entry is voiced as (per
// ElevenLabs' own premade-voice library, matching the name in that array's
// comments), so assignVoiceId below can filter to gender-appropriate voices
// before hashing rather than hashing across all 21 regardless of who's
// speaking. 'neutral' (River) is never hand-assigned to a roster member
// today, but stays available for a future member whose gender isn't a
// simple binary read of the historical record.
const FALLBACK_VOICE_GENDERS = {
  CwhRBWXzGAHq8TQ4Fs17: 'male', // Roger
  EXAVITQu4vr4xnSDxMaL: 'female', // Sarah
  FGY2WhTYpPnrIDTdsKH5: 'female', // Laura
  IKne3meq5aSn9XLyUdCD: 'male', // Charlie
  JBFqnCBsd6RMkjVDRZzb: 'male', // George
  N2lVS1w4EtoT3dr4eOWO: 'male', // Callum
  SAz9YHcvj6GT2YYXdXww: 'neutral', // River
  SOYHLrjzK2X1ezoPC6cr: 'male', // Harry
  TX3LPaxmHKxFdv7VOQHJ: 'male', // Liam
  Xb7hH8MSUJpSbSDYk0k2: 'female', // Alice
  XrExE9yKIg1WjnnlVkGX: 'female', // Matilda
  bIHbv24MWmeRgasZH58o: 'male', // Will
  cgSgspJ2msm6clMCkdW9: 'female', // Jessica
  cjVigY5qzO86Huf0OWal: 'male', // Eric
  hpp4J3VqNfWAUOO0d1Us: 'female', // Bella
  iP95p4xoKVk53GoZ742B: 'male', // Chris
  nPczCjzI2devNBz1zQrb: 'male', // Brian
  onwK4e9ZLuTAKqWW03F9: 'male', // Daniel
  pFZP5JQG7iQjIQuC4Bku: 'female', // Lily
  pNInz6obpgDQGcFmaJgB: 'male', // Adam
  pqHfZKP75CvOlQylNhV4: 'male', // Bill
  // #350 additions — see FALLBACK_VOICE_IDS's own comment for where these came from.
  GROMoQXjD2D16z0prfB1: 'male', // Elias
  A9evEp8yGjv4c3WsIKuY: 'male', // Ralf Eisend
  zlatCM6nK59gyedHFFxn: 'male', // Christian Plasa
  BIvP0GN1cAtSRTxNHnWS: 'female', // Ellen
  xTZlmU8dKXdyk4XGYGFg: 'male', // Antoine
  bObiIpcSB2feMOHORpee: 'male', // Antonin
  dTmTLshIypwp08eftJH6: 'female', // Sylvie
  qQFoiN2eQXULODjD1SwL: 'male', // Emanuele Matte
  goT3UYdM9bhm0n2lmKQx: 'male', // Edward
  exsUS4vynmxd379XN4yO: 'female', // Blondie
  qwaVDEGNsBllYcZO1ZOJ: 'male', // Patrick
  C92s6vssSLlabgIln1iY: 'female', // Michelle
  '8HSRAwEWAAa6wv9cdi5S': 'female', // Dasha
  n3yMmKmTfVCEM13Kk2lp: 'female', // Silvara
};

// #338 — a small 3-bucket demeanor each FALLBACK_VOICE_IDS entry reads as,
// read directly off that array's own adjective comments rather than
// re-deriving new labels: 'grounded' (laid-back/casual/relaxed/playful),
// 'stately' (mature/reassuring/professional/dignified), 'intense'
// (fierce/dominant/high-energy). Layered on top of FALLBACK_VOICE_GENDERS
// in assignVoiceId below, the same filter-then-hash shape.
const FALLBACK_VOICE_DEMEANORS = {
  CwhRBWXzGAHq8TQ4Fs17: 'grounded', // Roger
  EXAVITQu4vr4xnSDxMaL: 'stately', // Sarah
  FGY2WhTYpPnrIDTdsKH5: 'grounded', // Laura
  IKne3meq5aSn9XLyUdCD: 'intense', // Charlie
  JBFqnCBsd6RMkjVDRZzb: 'stately', // George
  N2lVS1w4EtoT3dr4eOWO: 'grounded', // Callum
  SAz9YHcvj6GT2YYXdXww: 'grounded', // River
  SOYHLrjzK2X1ezoPC6cr: 'intense', // Harry
  TX3LPaxmHKxFdv7VOQHJ: 'intense', // Liam
  Xb7hH8MSUJpSbSDYk0k2: 'stately', // Alice
  XrExE9yKIg1WjnnlVkGX: 'stately', // Matilda
  bIHbv24MWmeRgasZH58o: 'grounded', // Will
  cgSgspJ2msm6clMCkdW9: 'grounded', // Jessica
  cjVigY5qzO86Huf0OWal: 'stately', // Eric
  hpp4J3VqNfWAUOO0d1Us: 'stately', // Bella
  iP95p4xoKVk53GoZ742B: 'grounded', // Chris
  nPczCjzI2devNBz1zQrb: 'stately', // Brian
  onwK4e9ZLuTAKqWW03F9: 'stately', // Daniel
  pFZP5JQG7iQjIQuC4Bku: 'stately', // Lily
  pNInz6obpgDQGcFmaJgB: 'intense', // Adam
  pqHfZKP75CvOlQylNhV4: 'stately', // Bill
  // #350 additions — read off the same name-adjective convention.
  GROMoQXjD2D16z0prfB1: 'grounded', // Elias — warm, smooth, natural
  A9evEp8yGjv4c3WsIKuY: 'stately', // Ralf Eisend — deep and gravely
  zlatCM6nK59gyedHFFxn: 'intense', // Christian Plasa — wise and commanding
  BIvP0GN1cAtSRTxNHnWS: 'stately', // Ellen — serious, direct and confident
  xTZlmU8dKXdyk4XGYGFg: 'stately', // Antoine — articulate, calm and bright
  bObiIpcSB2feMOHORpee: 'intense', // Antonin — warm, unsettling, elegant
  dTmTLshIypwp08eftJH6: 'stately', // Sylvie — classy
  qQFoiN2eQXULODjD1SwL: 'intense', // Emanuele Matte — clear and serious
  goT3UYdM9bhm0n2lmKQx: 'intense', // Edward — dark, seductive, low
  exsUS4vynmxd379XN4yO: 'grounded', // Blondie — conversational, casual
  qwaVDEGNsBllYcZO1ZOJ: 'stately', // Patrick — engaging and warm
  C92s6vssSLlabgIln1iY: 'intense', // Michelle — direct and natural
  '8HSRAwEWAAa6wv9cdi5S': 'stately', // Dasha — warm, serious, and smooth
  n3yMmKmTfVCEM13Kk2lp: 'grounded', // Silvara — cheerful, friendly, and light
};

// #350 — the accent each FALLBACK_VOICE_IDS entry carries, per ElevenLabs'
// own voice metadata (the `accent` label on GET /v1/voices for the original
// 21, and on GET /v1/shared-voices for the 14 added alongside this field —
// verified live on 2026-08-21, not guessed). Split out from #338's demeanor:
// Crowley (an English occultist) could land on a voice that reads as
// generically confident-American, which is more jarring than a slightly-off
// demeanor — so assignVoiceId below applies this filter *before* demeanor,
// not after. Layered the same filter-then-hash way as gender and demeanor:
// falls back to the wider candidate set when nothing narrower matches.
//
// The original 21-voice premade pool turned out to be 16 american, 4
// british, 1 australian — no German/French/Italian/Irish/Russian/Spanish
// voices at all, so a member tagged with one of those accents would have
// silently fallen back to "no accent" every time on that pool alone. That's
// the reason FALLBACK_VOICE_IDS grew rather than just adding this dict on
// top of the original 21.
const FALLBACK_VOICE_ACCENTS = {
  CwhRBWXzGAHq8TQ4Fs17: 'american', // Roger
  EXAVITQu4vr4xnSDxMaL: 'american', // Sarah
  FGY2WhTYpPnrIDTdsKH5: 'american', // Laura
  IKne3meq5aSn9XLyUdCD: 'australian', // Charlie
  JBFqnCBsd6RMkjVDRZzb: 'british', // George
  N2lVS1w4EtoT3dr4eOWO: 'american', // Callum
  SAz9YHcvj6GT2YYXdXww: 'american', // River
  SOYHLrjzK2X1ezoPC6cr: 'american', // Harry
  TX3LPaxmHKxFdv7VOQHJ: 'american', // Liam
  Xb7hH8MSUJpSbSDYk0k2: 'british', // Alice
  XrExE9yKIg1WjnnlVkGX: 'american', // Matilda
  bIHbv24MWmeRgasZH58o: 'american', // Will
  cgSgspJ2msm6clMCkdW9: 'american', // Jessica
  cjVigY5qzO86Huf0OWal: 'american', // Eric
  hpp4J3VqNfWAUOO0d1Us: 'american', // Bella
  iP95p4xoKVk53GoZ742B: 'american', // Chris
  nPczCjzI2devNBz1zQrb: 'american', // Brian
  onwK4e9ZLuTAKqWW03F9: 'british', // Daniel
  pFZP5JQG7iQjIQuC4Bku: 'british', // Lily
  pNInz6obpgDQGcFmaJgB: 'american', // Adam
  pqHfZKP75CvOlQylNhV4: 'american', // Bill
  GROMoQXjD2D16z0prfB1: 'german', // Elias
  A9evEp8yGjv4c3WsIKuY: 'german', // Ralf Eisend
  zlatCM6nK59gyedHFFxn: 'german', // Christian Plasa
  BIvP0GN1cAtSRTxNHnWS: 'german', // Ellen
  xTZlmU8dKXdyk4XGYGFg: 'french', // Antoine
  bObiIpcSB2feMOHORpee: 'french', // Antonin
  dTmTLshIypwp08eftJH6: 'french', // Sylvie
  qQFoiN2eQXULODjD1SwL: 'italian', // Emanuele Matte
  goT3UYdM9bhm0n2lmKQx: 'british', // Edward
  exsUS4vynmxd379XN4yO: 'british', // Blondie
  qwaVDEGNsBllYcZO1ZOJ: 'irish', // Patrick
  C92s6vssSLlabgIln1iY: 'irish', // Michelle
  '8HSRAwEWAAa6wv9cdi5S': 'russian', // Dasha
  n3yMmKmTfVCEM13Kk2lp: 'spanish', // Silvara
};

// Hashes memberId into a pool index — same FNV-1a scheme voice.js's
// client-side hash uses for the Web Speech fallback (#29 first pass), so the
// same member lands on the same pool voice regardless of when this runs or
// what order the roster is in. Order-independent on purpose, unlike
// assignGlyph's "first free slot": a voice pool this small (far fewer voices
// than members) is going to collide members onto the same voice no matter
// what, but a hash means adding or removing an unrelated member never
// reshuffles anyone else's already-assigned voice.
function hashMemberId(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h >>> 0;
}

// #333 — narrows `pool` to voices FALLBACK_VOICE_GENDERS tags as matching
// `gender` before hashing, so a member reads as historically appropriate
// instead of landing on any of the 21 regardless of who they are. Falls
// back to the full pool when `gender` is omitted, or when nothing in the
// pool is tagged with it -- e.g. a custom ELEVENLABS_VOICE_POOL override
// (server.js), whose IDs FALLBACK_VOICE_GENDERS knows nothing about. That
// fallback keeps assignVoiceId total: it always returns a pool member
// rather than risking an empty-array modulo.
//
// #350 — `accent`, when given, narrows the gender-filtered candidates
// against FALLBACK_VOICE_ACCENTS before demeanor gets a turn, same
// filter-then-hash shape and same fallback rule as gender and demeanor:
// nothing in the gender-narrowed set carrying that accent leaves candidates
// at the gender-narrowed set rather than resetting wider or throwing.
// Deliberately sequenced *before* demeanor (gender -> accent -> demeanor),
// not after: Rachel's call is that a wrong accent reads as more jarring than
// a slightly-off demeanor, so when the pool can't satisfy both after
// gender-narrowing, accent should win the tiebreak. A member with no
// voiceAccent set (ambiguous historical record — see roster.json) skips
// this stage entirely and is narrowed by gender+demeanor only, same as
// before #350; that means they can still hash into any accent the pool
// happens to hold, which is unchanged from pre-#350 behavior for anyone
// whose accent isn't hand-tagged.
//
// #338 — `demeanor`, when given, narrows the accent-filtered candidates
// again against FALLBACK_VOICE_DEMEANORS, same shape and same fallback
// rule: if nothing in the narrowed set carries that demeanor (e.g. no
// 'intense' voice happens to be tagged 'female' in the current pool),
// candidates stays at the narrower set rather than resetting to the full
// pool or throwing. Demeanor is applied *after* gender and accent, not
// instead of either, so a member's voice never trades a correct gender or
// accent for a matching demeanor.
function assignVoiceId(memberId, pool, gender, accent, demeanor) {
  let candidates = pool;
  if (gender) {
    const matching = candidates.filter(id => FALLBACK_VOICE_GENDERS[id] === gender);
    if (matching.length) candidates = matching;
  }
  if (accent) {
    const matching = candidates.filter(id => FALLBACK_VOICE_ACCENTS[id] === accent);
    if (matching.length) candidates = matching;
  }
  if (demeanor) {
    const matching = candidates.filter(id => FALLBACK_VOICE_DEMEANORS[id] === demeanor);
    if (matching.length) candidates = matching;
  }
  return candidates[hashMemberId(memberId) % candidates.length];
}

// Reads and validates roster.json against the members directory on disk,
// backfilling glyphs and dropping entries whose character file is gone.
// Rewrites rosterFile only if something actually changed. Returns the
// cleaned-up roster array — callers own storing it.
//
// `voicePool`, if given a non-empty array, also backfills a `voiceId` for
// any member missing one (see assignVoiceId above). Left undefined by
// default so an install with no ElevenLabs key configured never gets
// roster.json mutated with voice IDs nothing will ever call — server.js only
// passes a pool once ELEVENLABS_API_KEY is actually set.
function reloadRoster(rosterFile, membersDir, voicePool) {
  const all = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
  // Filter out any entry whose character file no longer exists on disk
  const roster = all.filter(m => !m.file || fs.existsSync(path.join(membersDir, m.file)));
  // Backfill glyphs (and, if a voicePool was given, voice IDs) for any
  // member who doesn't have one yet (e.g. members added to roster.json
  // before the field existed, or by hand without one)
  let backfilled = false;
  for (const m of roster) {
    if (!m.glyph) {
      m.glyph = assignGlyph(roster);
      backfilled = true;
    }
    if (voicePool && voicePool.length && !m.voiceId) {
      m.voiceId = assignVoiceId(m.id, voicePool, m.voiceGender, m.voiceAccent, m.voiceDemeanor);
      backfilled = true;
    }
  }
  // Rewrite roster.json if entries were removed or fields were backfilled
  if (roster.length < all.length || backfilled) {
    fs.writeFileSync(rosterFile, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  }
  return roster;
}

function loadMemberFile(membersDir, filename) {
  if (!filename) return '';
  const p = path.join(membersDir, filename);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

// Extract the first substantive paragraph after a character file's section
// header. Shared by the dossier route (long form, for reading — no limit, the
// full paragraph) and casting's member briefs (short form, for the model's
// judgment — callers pass an explicit limit). #374 — the dossier route used
// to inherit this default (320), hard-slicing the reading-room bio/voice text
// mid-sentence with no indication more existed.
function extractSection(text, sectionName, limit = Infinity) {
  const re = new RegExp(`## ${sectionName}[\\s\\S]*?\\n\\n([^#\\n][\\s\\S]*?)(?:\\n\\n---|\n\n##|$)`);
  const m = text.match(re);
  if (!m) return null;
  const para = m[1]
    .split(/\n\n/)[0]
    .trim()
    .replace(/\*([^*]+)\*/g, '$1') // strip asterisk emphasis
    .replace(/\n/g, ' ')
    .slice(0, limit);
  return para || null;
}

// One-line sketch per member, for #185's casting call — the model needs to
// know who these people *are* to say which of them a document would draw, and
// roster.json carries only names and glyphs. Shorter than the dossier's
// version on purpose: this one is paid for 30-odd times in a single prompt.
// Cached because it re-reads and re-parses every character file; callers
// should clear the passed-in cache whenever the roster is reloaded, which is
// the only point at which those files can change.
function memberBrief(membersDir, briefCache, member) {
  if (briefCache.has(member.id)) return briefCache.get(member.id);
  const text = loadMemberFile(membersDir, member.file);
  const brief = text ? extractSection(text, 'WHO YOU ARE', 200) : null;
  briefCache.set(member.id, brief);
  return brief;
}

function castingRoster(membersDir, briefCache, roster) {
  return roster.map(m => ({ id: m.id, name: m.name, brief: memberBrief(membersDir, briefCache, m) }));
}

module.exports = {
  FALLBACK_GLYPHS,
  assignGlyph,
  FALLBACK_VOICE_IDS,
  FALLBACK_VOICE_GENDERS,
  FALLBACK_VOICE_DEMEANORS,
  FALLBACK_VOICE_ACCENTS,
  assignVoiceId,
  reloadRoster,
  loadMemberFile,
  extractSection,
  memberBrief,
  castingRoster,
};
