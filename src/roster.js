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
function assignVoiceId(memberId, pool, gender) {
  let candidates = pool;
  if (gender) {
    const matching = pool.filter(id => FALLBACK_VOICE_GENDERS[id] === gender);
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
      m.voiceId = assignVoiceId(m.id, voicePool, m.voiceGender);
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
// header. Shared by the dossier route (long form, for reading) and casting's
// member briefs (short form, for the model's judgment).
function extractSection(text, sectionName, limit = 320) {
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
  assignVoiceId,
  reloadRoster,
  loadMemberFile,
  extractSection,
  memberBrief,
  castingRoster,
};
