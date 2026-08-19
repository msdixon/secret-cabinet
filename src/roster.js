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

// #29 (ElevenLabs pass) — long-standing ElevenLabs premade voice IDs, used
// only as the default `voicePool` a caller can hand reloadRoster() below to
// backfill a `voiceId` per member. Unlike FALLBACK_GLYPHS these aren't
// guaranteed to exist in every account's Voice Library (ElevenLabs has
// reshuffled its default voice set over time) — verify against the target
// account before relying on them, and override via the ELEVENLABS_VOICE_POOL
// env var (see server.js) or by hand-editing a member's voiceId in
// roster.json if any of these turn out stale.
const FALLBACK_VOICE_IDS = [
  '21m00Tcm4TlvDq8ikWAM', // Rachel
  'AZnzlk1XvdvUeBnXmlld', // Domi
  'EXAVITQu4vr4xnSDxMaL', // Bella
  'ErXwobaYiN019PkySvjV', // Antoni
  'MF3mGyEYCl7XYWbV9V6O', // Elli
  'TxGEqnHWrfWFTfGW9XjX', // Josh
  'VR6AewLTigWG4xSOukaG', // Arnold
  'pNInz6obpgDQGcFmaJgB', // Adam
  'yoZ06aMxZJJ28mfd3POQ', // Sam
];

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

function assignVoiceId(memberId, pool) {
  return pool[hashMemberId(memberId) % pool.length];
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
      m.voiceId = assignVoiceId(m.id, voicePool);
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
  assignVoiceId,
  reloadRoster,
  loadMemberFile,
  extractSection,
  memberBrief,
  castingRoster,
};
