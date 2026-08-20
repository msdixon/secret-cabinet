'use strict';

// #354: the vocabulary of the structured record — what kinds of segment a
// session holds, who can hold a turn inside one, and how complete the record
// of a given session actually is.
//
// #244 introduced `session.rounds[].beats` as the turn-level record of what
// was actually said, but four things could happen in a meeting without
// landing in it: an interjection (which never became a segment at all), a
// speaker turn that failed (silently dropped), the player's own turn (stored
// with `memberId: null`), and anything at all in a session generated before
// #244 shipped. This file is the shared half of closing those holes.
//
// Lives in public/js/ rather than src/ for the same reason beats.js does
// (see its top-of-file comment): the browser needs it too. The record's
// label-placement rule was duplicated in five places — transcript-format.js,
// reading-room.js, sessions.js twice, and witness.js — each spelled
// `!segment.endedBy`, which was true right up until interjections started
// carrying an `endedBy` of their own. public/ has no bundler, so a rule only
// src/ could require() would be invisible to the three client copies. One
// definition, loadable both ways: src/ modules require this file, and
// index.html loads it as a plain <script> exposing window.Record, the same
// dual export beats.js uses (#142's convention).
const Record = (function () {
  // ── Who can hold a turn ────────────────────────────────────────────────
  //
  // `beats[].memberId` is a roster id for a member's turn, and one of these
  // sentinels for a turn taken by someone who isn't on the roster. Consumers
  // must not assume every beat's memberId resolves against ROSTER — that is
  // exactly the assumption `memberId: null` used to force, by leaving the
  // player's own turns attributable only by display-name string.
  //
  // The player playing *as* a roster member (playerMode === 'member') is not
  // one of these: their turn carries that member's real roster id, because
  // that is who spoke in the fiction. Only the two speakers with no roster
  // entry at all need a sentinel.
  const PLAYER_SPEAKER_ID = 'player:custom'; // playerMode === 'custom' — the player under their own name
  const PRESENCE_SPEAKER_ID = 'presence:interjection'; // the observer from outside time (/api/interject)
  const PRESENCE_SPEAKER_NAME = '— a voice from elsewhere —';
  const NON_ROSTER_SPEAKER_IDS = [PLAYER_SPEAKER_ID, PRESENCE_SPEAKER_ID];

  // ── What kind of segment ───────────────────────────────────────────────
  const SEGMENT_KIND_PASSAGE = 'passage';
  const SEGMENT_KIND_INTERJECTION = 'interjection';

  // Absent `kind` means passage: every segment written before #354 was one,
  // and /api/convene and /api/round go on writing them without the field.
  function segmentKind(segment) {
    return segment && segment.kind ? segment.kind : SEGMENT_KIND_PASSAGE;
  }

  function isInterjectionSegment(segment) {
    return segmentKind(segment) === SEGMENT_KIND_INTERJECTION;
  }

  // Where the segment's `label` belongs relative to its text.
  //
  // #245 established the rule for the two segment shapes that existed then:
  // a pre-#244 round's label announces the passage about to happen and sits
  // above it; a #244 passage's label is the lull that ended it and sits
  // below. `endedBy` told them apart because only the latter had one.
  //
  // #354's interjection segments break that test — they carry an `endedBy`
  // (the room did stop reacting for some reason, and that reason is worth
  // recording) but their label is "A Presence Passes Through", an
  // announcement of the event, which belongs above it exactly like a round
  // header. Hence a named rule rather than a bare field check.
  function labelOpensSegment(segment) {
    return isInterjectionSegment(segment) || !(segment && segment.endedBy);
  }

  // The presence signs its turn with a line that already reads as a marked-off
  // header, so the ' —' suffix formatTranscriptText appends to roster speaker
  // lines would double up on it. Recognised, but formatted as-is.
  function isPresenceHeader(line) {
    return String(line || '').trim() === PRESENCE_SPEAKER_NAME;
  }

  // ── How complete is this session's record ──────────────────────────────
  //
  // #354 item 4: pre-#244 sessions are deliberately left alone — no
  // migration, readers degrade to the empty case. What they must not do is
  // silently claim a completeness they can't have, so anything presenting a
  // session as a bibliographic source says which it is.
  function recordCompleteness(session) {
    const segments = (session && session.rounds) || [];
    const withBeats = segments.filter(s => Array.isArray(s && s.beats));
    const turns = withBeats.reduce((n, s) => n + s.beats.length, 0);
    return {
      segments: segments.length,
      segmentsWithBeats: withBeats.length,
      turns,
      // An empty session is vacuously complete rather than a special case —
      // there is nothing it fails to record.
      complete: withBeats.length === segments.length,
    };
  }

  function recordCompletenessNote(session) {
    const { segments, segmentsWithBeats, turns, complete } = recordCompleteness(session);
    if (complete) {
      return `Turn-level record: complete — ${turns} turn${turns === 1 ? '' : 's'} across ${segments} segment${segments === 1 ? '' : 's'}.`;
    }
    const missing = segments - segmentsWithBeats;
    return (
      `Turn-level record: incomplete — ${missing} of ${segments} segment${segments === 1 ? '' : 's'} ` +
      `predate${missing === 1 ? 's' : ''} it and hold${missing === 1 ? 's' : ''} transcript prose only. ` +
      'Turns in those segments cannot be cited individually.'
    );
  }

  return {
    PLAYER_SPEAKER_ID,
    PRESENCE_SPEAKER_ID,
    PRESENCE_SPEAKER_NAME,
    NON_ROSTER_SPEAKER_IDS,
    SEGMENT_KIND_PASSAGE,
    SEGMENT_KIND_INTERJECTION,
    segmentKind,
    isInterjectionSegment,
    labelOpensSegment,
    isPresenceHeader,
    recordCompleteness,
    recordCompletenessNote,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Record;
} else {
  window.Record = Record;
}
