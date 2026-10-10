'use strict';

// #650 step 1 — per-member evidence table (usage + groundability) for the
// roster-trim scoping task. Facts only: this script deliberately computes no
// score, rank, or recommendation, and says nothing about representation —
// that judgment is the project owner's (#650 step 2).
//
// Sits beside scripts/rollup-metrics.js and reuses its loadSessions source
// (build-citation-manifest.js). Read-only; costs nothing (no API calls).
//   node scripts/roster-evidence.js [sessionsDir]
// Default sessionsDir matches rollup-metrics.js: RAILWAY_VOLUME_MOUNT_PATH or
// the repo's own (usually empty) sessions/. The checked-in report is only as
// good as the directory it was generated from — its header states the sample.
const fs = require('fs');
const path = require('path');
const { loadSessions } = require('./build-citation-manifest');

const ROOT = path.join(__dirname, '..');
const OUTPUT_FILE = path.join(ROOT, 'ROSTER-EVIDENCE-REPORT.md');

// Recorded sourcing/portrait difficulties, each pointing at the issue or doc
// that recorded it. Transcribed from those sources, not assessed here — add a
// line only with a citation.
const RECORDED_DIFFICULTIES = {
  corbin: [
    '[#574](https://github.com/msdixon/secret-cabinet/issues/574) (open): #558 regeneration rejected on review and reverted; no photographic grounding found',
    '[#558](https://github.com/msdixon/secret-cabinet/issues/558): in the five-member distinctiveness batch',
  ],
  'frieda-harris': [
    '[#574](https://github.com/msdixon/secret-cabinet/issues/574) (open): #558 regeneration rejected on review and reverted; no archival photo confirmed',
    '[#558](https://github.com/msdixon/secret-cabinet/issues/558): in the five-member distinctiveness batch',
  ],
  scholem: ['[#558](https://github.com/msdixon/secret-cabinet/issues/558): regrounded from a photo (fixed)'],
  pauli: ['[#558](https://github.com/msdixon/secret-cabinet/issues/558): regrounded from a photo (fixed)'],
  'dion-fortune': [
    '[#558](https://github.com/msdixon/secret-cabinet/issues/558): regrounded from a public-domain photo (fixed)',
  ],
  abulafia: [
    '[#569](https://github.com/msdixon/secret-cabinet/issues/569) (open): deferred distinctiveness cluster with Al-Hallaj',
  ],
  'al-hallaj': [
    '[#569](https://github.com/msdixon/secret-cabinet/issues/569) (open): deferred distinctiveness cluster with Abulafia',
  ],
  arabi: [
    '[#569](https://github.com/msdixon/secret-cabinet/issues/569) (open): deferred distinctiveness cluster with Ibn Khaldun',
  ],
  khaldun: [
    '[#569](https://github.com/msdixon/secret-cabinet/issues/569) (open): deferred distinctiveness cluster with Ibn Arabi',
  ],
  eckhart: [
    '[#569](https://github.com/msdixon/secret-cabinet/issues/569) (open): deferred distinctiveness cluster with Bruno (and Llull to a lesser extent)',
  ],
  bruno: [
    '[#569](https://github.com/msdixon/secret-cabinet/issues/569) (open): deferred distinctiveness cluster with Eckhart',
  ],
  llull: [
    '[#569](https://github.com/msdixon/secret-cabinet/issues/569) (open): named "to a lesser extent" in the Eckhart/Bruno cluster',
  ],
  bamba: [
    '[#474](https://github.com/msdixon/secret-cabinet/issues/474) (closed): reaction set held back at generation time (STYLE_GUIDE.md, 2026-08-29); routed to the generic silhouette',
  ],
  teresa: [
    '[#538](https://github.com/msdixon/secret-cabinet/issues/538) (closed): baseline portrait in a different visual sub-register than her reaction set',
  ],
};

// "## Name (`id`) — dates — Photographed|Character study ..." in the portrait
// prompt files is the project's own tier label (STYLE_GUIDE.md, "Known-vs-
// unknown likeness"). Returns Map(id -> tier string).
function parsePortraitTiers(markdownFiles) {
  const tiers = new Map();
  markdownFiles.forEach(text => {
    for (const m of text.matchAll(/^## .*?\(`([^`]+)`\)\s+—\s+[^—\n]+—\s+(Photographed|Character study)/gm)) {
      tiers.set(m[1], m[2]);
    }
  });
  return tiers;
}

function stripFrontmatter(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

function wordCount(text) {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

function emptyUsage() {
  return {
    sessionsSeated: 0,
    sessionsSpoke: 0,
    sessionsPlayerSeat: 0,
    turns: 0,
    passes: 0,
    threadTurns: 0,
    citations: 0,
    verdicts: { verified: 0, unverified: 0, uncertain: 0 },
  };
}

// Per-member usage from saved sessions, plus session-level casting facts.
// What a session file records: `members` (the seated set), `rounds[].beats[]`
// (who spoke, `passed`, `thread` for splinter side-conversations, raw
// `citations`), `playerMemberId`, `generationMetrics` (a `casting` entry per
// /api/cast call; `director` entries). It does NOT record whether a seat came
// from the casting proposal, a pinned regular, or a hand pick, nor which
// members the director chose per passage — so selection-vs-manual rate is not
// recoverable per member from sessions on disk. Reported as a gap, not guessed.
function aggregateSessions(sessions, rosterIds) {
  const known = new Set(rosterIds);
  const byMember = new Map(rosterIds.map(id => [id, emptyUsage()]));
  const session = {
    scanned: sessions.length,
    withBeats: 0,
    branches: 0,
    withCastingCall: 0,
    castingCalls: 0,
    castingFallbacks: 0,
    directorCalls: 0,
    directorFallbacks: 0,
    unknownMemberRefs: 0,
    earliest: null,
    latest: null,
  };

  sessions.forEach(s => {
    if (s.date) {
      if (!session.earliest || s.date < session.earliest) session.earliest = s.date;
      if (!session.latest || s.date > session.latest) session.latest = s.date;
    }
    if (s.parentId || s.branchRound != null || /-branch-/.test(s.id || '')) session.branches++;

    const metrics = s.generationMetrics || [];
    const casting = metrics.filter(m => m.phase === 'casting');
    if (casting.length) session.withCastingCall++;
    session.castingCalls += casting.length;
    session.castingFallbacks += casting.filter(m => m.skipped).length;
    const director = metrics.filter(m => m.phase === 'director');
    session.directorCalls += director.length;
    session.directorFallbacks += director.filter(m => m.skipped).length;

    const seated = new Set();
    (s.members || []).forEach(id => {
      if (known.has(id)) seated.add(id);
      else session.unknownMemberRefs++;
    });
    seated.forEach(id => byMember.get(id).sessionsSeated++);
    if (s.playerMode === 'member' && known.has(s.playerMemberId)) byMember.get(s.playerMemberId).sessionsPlayerSeat++;

    const spoke = new Set();
    let hadBeats = false;
    (s.rounds || []).forEach(seg => {
      (seg.beats || []).forEach(beat => {
        hadBeats = true;
        if (beat.failed || !known.has(beat.memberId)) return;
        const u = byMember.get(beat.memberId);
        if (beat.passed) u.passes++;
        else {
          u.turns++;
          spoke.add(beat.memberId);
        }
        if (beat.thread) u.threadTurns++;
        (beat.citations || []).forEach(() => u.citations++);
      });
    });
    if (hadBeats) session.withBeats++;
    spoke.forEach(id => byMember.get(id).sessionsSpoke++);

    // Verdicts only exist once Verify Citations has run (citationFlags).
    if (Array.isArray(s.citationFlags)) {
      s.citationFlags.forEach(c => {
        if (known.has(c.memberId) && byMember.get(c.memberId).verdicts[c.verdict] != null) {
          byMember.get(c.memberId).verdicts[c.verdict]++;
        }
      });
    }
  });

  return { session, byMember };
}

// Library coverage keyed by author id (the exemplar rule: one member's own
// hand) and, separately, by association in `members`.
function aggregateLibrary(library, rosterIds, readExcerpt) {
  const byMember = new Map(
    rosterIds.map(id => [id, { authored: [], associatedOnly: 0, licenses: {}, translated: 0, words: 0 }])
  );
  library.forEach(entry => {
    const words = readExcerpt ? wordCount(stripFrontmatter(readExcerpt(entry) || '')) : 0;
    const a = byMember.get(entry.author);
    if (a) {
      a.authored.push(entry.id);
      a.licenses[entry.license] = (a.licenses[entry.license] || 0) + 1;
      if (entry.translated) a.translated++;
      a.words += words;
    }
    (entry.members || []).forEach(id => {
      if (id !== entry.author && byMember.has(id)) byMember.get(id).associatedOnly++;
    });
  });
  return byMember;
}

// Golden-set items (#430) per author, via the library entry each item grades.
function aggregateGoldenSet(goldenSet, library, rosterIds) {
  const authorOf = new Map(library.map(e => [e.id, e.author]));
  const byMember = new Map(rosterIds.map(id => [id, { items: 0, verified: 0, unverified: 0, uncertain: 0 }]));
  goldenSet.forEach(item => {
    const t = byMember.get(authorOf.get(item.libraryEntryId));
    if (!t) return;
    t.items++;
    if (t[item.expectedVerdict] != null) t[item.expectedVerdict]++;
  });
  return byMember;
}

function starterAppearances(starters, rosterIds) {
  const byMember = new Map(rosterIds.map(id => [id, 0]));
  (starters || []).forEach(s =>
    (s.cast || []).forEach(id => byMember.has(id) && byMember.set(id, byMember.get(id) + 1))
  );
  return byMember;
}

function buildEvidence({
  roster,
  sessions,
  library,
  goldenSet = [],
  starters = [],
  tiers = new Map(),
  likenessRefs = new Set(),
  reactionSets = new Set(),
  readExcerpt = null,
}) {
  const ids = roster.map(m => m.id);
  const usage = aggregateSessions(sessions, ids);
  const lib = aggregateLibrary(library, ids, readExcerpt);
  const golden = aggregateGoldenSet(goldenSet, library, ids);
  const starts = starterAppearances(starters, ids);
  const members = roster.map((m, i) => ({
    order: i + 1,
    id: m.id,
    name: m.name,
    usage: usage.byMember.get(m.id),
    library: lib.get(m.id),
    golden: golden.get(m.id),
    starterCasts: starts.get(m.id),
    portrait: {
      tier: tiers.get(m.id) || null,
      likenessRef: likenessRefs.has(m.id),
      reactionSet: reactionSets.has(m.id),
    },
    difficulties: RECORDED_DIFFICULTIES[m.id] || [],
  }));
  return { members, session: usage.session, goldenTotal: goldenSet.length, libraryTotal: library.length };
}

function buildReport(data, { sessionsDir = 'sessions/', rosterNote = '' } = {}) {
  const s = data.session;
  const lines = [
    '# Roster Evidence Report',
    '',
    '[#650](https://github.com/msdixon/secret-cabinet/issues/650) step 1: per-member usage and groundability facts for the ' +
      `${data.members.length}-member roster. **Facts only** — no ranking, no recommendation, no representation assessment (that is step 2, the project owner's). ` +
      'Members appear in `docs/MANIFEST.md` order.',
    '',
    '## Sample and caveats — read first',
    '',
    `- **Sessions scanned: ${s.scanned}** (from \`${sessionsDir}\`)` +
      (s.scanned
        ? `, dated ${s.earliest || '?'} to ${s.latest || '?'}; ${s.withBeats} with per-beat records; ${s.branches} look like branches (counted as separate sessions, so branched sittings are counted more than once).`
        : '.'),
    ...(s.scanned === 0
      ? [
          '- **Every usage column below is therefore empty, not zero-by-evidence.** `sessions/` is gitignored and per-user (#595); this report was generated where it holds none. Regenerate against real data with `RAILWAY_VOLUME_MOUNT_PATH=<volume> node scripts/roster-evidence.js` or `node scripts/roster-evidence.js <dir-of-session-json>`, run by someone entitled to read those sessions (owners can share a sitting with the keeper, #625).',
        ]
      : []),
    '- Sessions before [#244](https://github.com/msdixon/secret-cabinet/issues/244) (2026-08-11) have no per-beat records, so their members show as seated but never as speaking.',
    `- **Casting source is not recoverable per member.** A saved session records who was seated, not whether each seat came from the casting proposal, a pinned regular, a starter's cast, or a hand pick; nor which members the director chose per passage. Session-level casting facts that *are* recorded: ${s.withCastingCall} session(s) made at least one casting call (${s.castingCalls} call(s), ${s.castingFallbacks} fell back to the deterministic first-N pick); ${s.directorCalls} director call(s), ${s.directorFallbacks} fell back. Whether the proposal was accepted is not stored. Answering "director/casting selection rate vs. manual seating" per member would need a new field written at convene time (a code change, out of scope here).`,
    '- Citation verdict columns exist only for sessions where Verify Citations has been run (`citationFlags`).',
    `- Live citation-grounding accuracy (\`scripts/eval-citation-grounding.js\`) is a billed API call, gated to docs/MODEL-REVIEW.md's quarterly cadence, and its report is gitignored — none was run for this report. The "golden-set items" column shows only how many of the ${data.goldenTotal} curated items grade that member's own library entries.`,
    ...(s.unknownMemberRefs
      ? [`- ${s.unknownMemberRefs} seated-member reference(s) in sessions named ids no longer on the roster; ignored.`]
      : []),
    ...(rosterNote ? [rosterNote] : []),
    '',
    '## (a) Usage across sessions',
    '',
    '| # | Member | Sessions seated | Sessions spoke | Turns | Passes | Side-conv. turns | Played by user | Raw citations | Verdicts (verified / unverified / uncertain) | In starter casts |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...data.members.map(m => {
      const u = m.usage;
      const v = u.verdicts;
      return `| ${m.order} | ${m.name} | ${u.sessionsSeated} | ${u.sessionsSpoke} | ${u.turns} | ${u.passes} | ${u.threadTurns} | ${u.sessionsPlayerSeat} | ${u.citations} | ${v.verified} / ${v.unverified} / ${v.uncertain} | ${m.starterCasts} |`;
    }),
    '',
    '## (b) Library excerpt coverage and (c) grounding eval coverage',
    '',
    '`Authored` = entries in `prompts/library/library.json` whose `author` is this member (the voice-exemplar rule). `Assoc.` = entries that name them in `members` without being the author. Words are excerpt text with frontmatter removed.',
    '',
    '| # | Member | Authored entries | Assoc. only | Licenses | Translated | Excerpt words | Golden-set items (v/u/unc) |',
    '|---|---|---|---|---|---|---|---|',
    ...data.members.map(m => {
      const l = m.library;
      const lic =
        Object.entries(l.licenses)
          .map(([k, n]) => `${k}×${n}`)
          .join(', ') || '—';
      const g = m.golden;
      return `| ${m.order} | ${m.name} | ${l.authored.length} | ${l.associatedOnly} | ${lic} | ${l.translated} | ${l.words} | ${g.items} (${g.verified}/${g.unverified}/${g.uncertain}) |`;
    }),
    '',
    '## (d) Portrait facts and recorded sourcing/portrait difficulties',
    '',
    'Tier is the project\'s own label from `public/portraits/*-PROMPTS.md` (see STYLE_GUIDE.md, "Known-vs-unknown likeness"). Likeness reference = a file in `public/portraits/likeness-refs/` (#541/#546). Difficulties are only what an issue or doc already records, with the link; absence means nothing recorded, not nothing wrong.',
    '',
    '| # | Member | Tier | Likeness ref | Reaction set | Recorded difficulties |',
    '|---|---|---|---|---|---|',
    ...data.members.map(m => {
      const p = m.portrait;
      return `| ${m.order} | ${m.name} | ${p.tier || '—'} | ${p.likenessRef ? 'yes' : 'no'} | ${p.reactionSet ? 'yes' : 'no'} | ${m.difficulties.join('<br>') || '—'} |`;
    }),
    '',
    '---',
    '',
    `_Generated by scripts/roster-evidence.js from ${s.scanned} session(s), ${data.libraryTotal} library entries and ${data.goldenTotal} golden-set items. Read-only; changes no member, character file, portrait or MANIFEST row._`,
    '',
  ];
  return lines.join('\n');
}

module.exports = {
  RECORDED_DIFFICULTIES,
  parsePortraitTiers,
  stripFrontmatter,
  aggregateSessions,
  aggregateLibrary,
  aggregateGoldenSet,
  buildEvidence,
  buildReport,
};

if (require.main === module) {
  const sessionsDir = process.argv[2] || path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || ROOT, 'sessions');
  const readJson = f => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  const portraits = path.join(ROOT, 'public', 'portraits');
  const libDir = path.join(ROOT, 'prompts', 'library');
  const promptFiles = ['BATCH-1-PROMPTS.md', 'WAVE-4-PROMPTS.md', 'PENDING-PROMPTS.md']
    .map(f => path.join(portraits, f))
    .filter(f => fs.existsSync(f))
    .map(f => fs.readFileSync(f, 'utf8'));
  const refsFile = path.join(portraits, 'likeness-refs');
  const likenessRefs = new Set(
    fs.existsSync(refsFile)
      ? fs
          .readdirSync(refsFile)
          .filter(f => f.endsWith('.jpg'))
          .map(f => f.replace(/\.jpg$/, ''))
      : []
  );
  const reactionSets = new Set(
    fs
      .readdirSync(portraits)
      .filter(f => f.endsWith('-happy.png'))
      .map(f => f.replace(/-happy\.png$/, ''))
  );
  const startersFile = path.join(libDir, 'starters.json');
  const data = buildEvidence({
    roster: readJson('prompts/members/roster.json'),
    sessions: loadSessions(sessionsDir),
    library: readJson('prompts/library/library.json'),
    goldenSet: readJson('scripts/citation-grounding-golden-set.json'),
    starters: fs.existsSync(startersFile) ? readJson('prompts/library/starters.json').starters : [],
    tiers: parsePortraitTiers(promptFiles),
    likenessRefs,
    reactionSets,
    readExcerpt: entry => fs.readFileSync(path.join(libDir, entry.file), 'utf8'),
  });
  const shown = path.relative(ROOT, sessionsDir) || sessionsDir;
  fs.writeFileSync(
    OUTPUT_FILE,
    buildReport(data, { sessionsDir: shown.startsWith('..') ? 'a custom sessions directory' : shown + '/' }),
    'utf8'
  );
  console.log(`Wrote ${OUTPUT_FILE} (${data.session.scanned} sessions scanned, from ${sessionsDir}).`);
}
