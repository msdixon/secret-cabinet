'use strict';

// #193 seam-map, module 6 of 8 — the archival library.
//
// Owns library.json's index, the per-entry .md files, and the archive image
// metadata. File paths are passed in explicitly rather than read from
// module-level constants, following roster.js's convention — citations.js
// and the library/graph routes all call into this before it exists, so it
// has to carry no server.js-specific state of its own.

const fs = require('fs');
const path = require('path');

function loadLibraryIndex(libraryFile) {
  if (!fs.existsSync(libraryFile)) return [];
  return JSON.parse(fs.readFileSync(libraryFile, 'utf8'));
}

// Archival images (#30) keyed by library entry id — see public/archive/metadata.json.
// Kept separate from library.json/frontmatter since not every entry has an image yet.
function loadArchiveImageIndex(archiveImageFile) {
  if (!fs.existsSync(archiveImageFile)) return {};
  return JSON.parse(fs.readFileSync(archiveImageFile, 'utf8')).entries || {};
}

// `citation`/`source_url` live only in each entry's .md frontmatter, not in
// library.json's index — this reads them out. Shared by the internal
// citation-grounding lookup below and GET /api/library/:id (#84).
// #356: a citation string that itself quotes a work's title (e.g. Adorno's
// "Types and Syndromes") is valid double-quoted YAML with backslash-escaped
// inner quotes — `\"Types and Syndromes,\"` — which the regex capture below
// passes through verbatim rather than as YAML. Left un-decoded, those
// literal backslashes surfaced in every citation-bearing render (the
// bibliography's Library appendix showed it on nearly every third entry).
const unescapeYamlDoubleQuoted = s => (s || '').replace(/\\"/g, '"').replace(/\\\\/g, '\\');

function parseLibraryFrontmatter(raw) {
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
  const citation = unescapeYamlDoubleQuoted(frontmatter.match(/^citation:\s*"?(.*?)"?$/m)?.[1]) || null;
  const source_url = unescapeYamlDoubleQuoted(frontmatter.match(/^source_url:\s*"?(.*?)"?$/m)?.[1]) || null;
  return { citation, source_url };
}

// #187 — the library entry a member actually *wrote*, for injection into
// their speaker prompt as a voice-register exemplar. Internal-only; not
// exposed as a route.
//
// Keyed on `author`, deliberately not on `members`. `members` is an
// association list — it includes everyone an entry concerns, so Waite's 1911
// preface lists Pamela Colman Smith and Jung's 1916 text lists Corbin.
// Matching on it would hand a member someone else's prose under the heading
// "how you actually write", which is a fabrication of voice; `author` is the
// one member whose hand the text is in. A member with no authored entry
// returns null and their prompt is built exactly as it was before #187.
//
// If an author has more than one entry, the first in library.json order is
// the primary exemplar — deterministic, and a curator wanting a specific one
// as primary should order the file accordingly. Any others are read by
// loadSecondaryVoiceExemplars below, not by this function.
function loadVoiceExemplar(libraryDir, libraryFile, memberId) {
  if (!memberId) return null;
  const entry = loadLibraryIndex(libraryFile).find(e => e.author === memberId);
  if (!entry) return null;
  return entryToExemplar(libraryDir, entry);
}

function entryToExemplar(libraryDir, entry) {
  const filePath = path.join(libraryDir, entry.file);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  const text = raw.replace(/^---[\s\S]*?---\n/, '').trim();
  if (!text) return null;
  return {
    id: entry.id,
    title: entry.title,
    source: entry.source,
    date: entry.date,
    translated: !!entry.translated,
    text,
  };
}

// #370 wave 2 — once #35a's depth round gave some members a second authored
// entry (a different-genre text: a letter, a diary, an epistle, alongside
// the original formal preface/treatise), the single-exemplar model above
// stopped being able to show it: loadVoiceExemplar only ever surfaces the
// first author match. This reads every *other* entry authored by memberId,
// in library.json order, so the speaker prompt (see pipeline-speaker.js's
// buildVoiceExemplarSection) can inject them as smaller, supplementary
// "tone-tuning" passages alongside the primary exemplar — evidence in a
// different register, weighted lighter, not a replacement for it. Empty
// array for a member with zero or one authored entries, which is still most
// of the roster; nothing about loadVoiceExemplar's contract changes.
function loadSecondaryVoiceExemplars(libraryDir, libraryFile, memberId) {
  if (!memberId) return [];
  const matches = loadLibraryIndex(libraryFile).filter(e => e.author === memberId);
  return matches
    .slice(1)
    .map(entry => entryToExemplar(libraryDir, entry))
    .filter(Boolean);
}

// Internal-only: read the `citation`/`source_url` frontmatter fields (plus
// the full excerpt body, for #153 part 1's text-grounded re-check) that
// loadLibraryIndex()/library.json don't carry, for cross-referencing a
// verified citation to its grounding source. Not exposed via a public route.
function loadLibraryCitationLookup(libraryDir, libraryFile) {
  const lookup = {};
  for (const entry of loadLibraryIndex(libraryFile)) {
    const filePath = path.join(libraryDir, entry.file);
    if (!fs.existsSync(filePath)) continue;
    const raw = fs.readFileSync(filePath, 'utf8');
    const { citation, source_url } = parseLibraryFrontmatter(raw);
    const text = raw.replace(/^---[\s\S]*?---\n/, '').trim();
    lookup[entry.id] = { title: entry.title, source: entry.source, citation, source_url, text };
  }
  return lookup;
}

module.exports = {
  loadLibraryIndex,
  loadArchiveImageIndex,
  parseLibraryFrontmatter,
  loadVoiceExemplar,
  loadSecondaryVoiceExemplars,
  loadLibraryCitationLookup,
};
