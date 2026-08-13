'use strict';

// #285 — extracted from app.js's "Speaker attribution" block. Unlike the
// #142 extractions (witness/export/sessions/casting), this one has no
// UI-feature seam of its own — it's pure text matching, the same
// script-tag/IIFE convention applied to a cluster of functions that never
// touched app.js's core state except through one narrow read (see
// isKnownSpeakerHeader below), now passed in via configure() like everywhere
// else.
//
// Members sign transcripts with a short form (surname, first name, or a
// nickname) rather than their full roster name. Short forms are derived
// automatically from each member's `name` in roster.json; a member's
// `aliases` array (also in roster.json) covers nicknames that aren't
// derivable from the name itself (e.g. "Pamela" for Coleman-Smith). This
// keeps the roster the single source of truth — adding a Wave 2 guest to
// roster.json is enough; nothing here needs hand-editing.
//
// If two members derive the same token (e.g. "Ibn" from both "Ibn Arabi"
// and "Ibn Khaldun", or "Blake" from both Blakes), that token is ambiguous
// and dropped from the index — lodge-context.md's FORMAT section instructs
// members with colliding surnames to sign in full, which the exact
// full-name match in resolveMember/isKnownSpeakerHeader still catches.
window.Speaker = (function () {
  let deps = null; // set by configure(); see app.js's speakerDeps()

  function configure(injectedDeps) {
    deps = injectedDeps;
  }

  const ALIAS_STOPWORDS = new Set(['of', 'the', 'van', 'der', 'de', 'la', 'lady', 'sir', 'dr', 'st']);

  function normalizeSpeaker(s) {
    return s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/['’]/g, '')
      .toLowerCase()
      .replace(/[\s-]+/g, ' ')
      .trim();
  }

  function buildAliasIndex(members) {
    const index = new Map(); // normalized alias -> member id, or null if ambiguous
    const register = (key, id) => {
      const k = normalizeSpeaker(key);
      if (!k) return;
      if (index.has(k) && index.get(k) !== id) index.set(k, null);
      else if (!index.has(k)) index.set(k, id);
    };
    members.forEach(m => {
      register(m.name, m.id);
      m.name
        .split(/[\s-]+/)
        .filter(tok => tok.length > 2 && !ALIAS_STOPWORDS.has(tok.toLowerCase()))
        .forEach(tok => register(tok, m.id));
      (m.aliases || []).forEach(a => register(a, m.id));
    });
    return index;
  }

  // Resolves a signed speaker string (e.g. "Warburg", "Ibn 'Arabi") to its roster member.
  function resolveMember(speaker, members) {
    const norm = normalizeSpeaker(speaker);
    const candidates = [...buildAliasIndex(members).entries()]
      .filter(([, id]) => id)
      .sort((a, b) => b[0].length - a[0].length); // prefer the more specific (longer) alias
    const hit = candidates.find(([alias]) => norm.includes(alias));
    if (hit) return members.find(m => m.id === hit[1]);
    // No alias hit — fall back to loose name-substring matching, but only when
    // exactly one member matches. A speaker string that partially overlaps two
    // members' names (e.g. bare "Blake") is ambiguous and stays unresolved
    // rather than silently picking whichever member happens to be listed first.
    const matches = members.filter(m => speaker.includes(m.name) || m.name.includes(speaker));
    return matches.length === 1 ? matches[0] : undefined;
  }

  // True if a trimmed transcript line is a recognized speaker header (full name or alias).
  // Also recognizes the active session's player-as-member identity — needed
  // for custom (non-roster) identities, which have no alias-index entry. That
  // identity is app.js's core state (currentPlayerSpeakerName), read live
  // through deps.getPlayerSpeakerName() rather than closed over directly.
  function isKnownSpeakerHeader(t, members) {
    const norm = normalizeSpeaker(t.replace(/:$/, ''));
    const playerSpeakerName = deps?.getPlayerSpeakerName();
    if (playerSpeakerName && norm === normalizeSpeaker(playerSpeakerName)) return true;
    const index = buildAliasIndex(members);
    return index.has(norm) && index.get(norm) != null;
  }

  return { configure, normalizeSpeaker, buildAliasIndex, resolveMember, isKnownSpeakerHeader };
})();
