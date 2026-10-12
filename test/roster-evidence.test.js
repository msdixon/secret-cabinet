'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePortraitTiers,
  stripFrontmatter,
  aggregateSessions,
  aggregateLibrary,
  aggregateGoldenSet,
  buildEvidence,
  buildReport,
} = require('../scripts/roster-evidence');

const roster = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Beta' },
  { id: 'c', name: 'Gamma' },
];

const library = [
  { id: 'a-one', author: 'a', license: 'public-domain', translated: false, members: ['a', 'b'], file: 'a-one.md' },
  { id: 'a-two', author: 'a', license: 'fair-use', translated: true, members: ['a'], file: 'a-two.md' },
  { id: 'x-one', author: 'b', license: 'public-domain', translated: false, members: ['b', 'c'], file: 'x-one.md' },
];

const sessions = [
  {
    id: 's1',
    date: '2026-09-01',
    members: ['a', 'b', 'zz'],
    playerMode: 'member',
    playerMemberId: 'b',
    generationMetrics: [{ phase: 'casting' }, { phase: 'casting', skipped: true }, { phase: 'director' }],
    rounds: [
      {
        beats: [
          { memberId: 'a', text: 'hi', citations: [{}, {}] },
          { memberId: 'a', text: '', passed: true },
          { memberId: 'b', text: 'side', thread: 'edge' },
          { memberId: 'c', text: 'x', failed: true },
        ],
      },
    ],
    citationFlags: [
      { memberId: 'a', verdict: 'verified' },
      { memberId: 'a', verdict: 'uncertain' },
    ],
  },
  { id: 's2-branch-1', date: '2026-09-05', members: ['a'], rounds: [{ text: 'old, no beats' }] },
];

test('aggregateSessions counts seats, speaking, passes, threads, citations and verdicts', () => {
  const { session, byMember } = aggregateSessions(sessions, ['a', 'b', 'c']);
  assert.equal(session.scanned, 2);
  assert.equal(session.withBeats, 1);
  assert.equal(session.branches, 1);
  assert.equal(session.withCastingCall, 1);
  assert.equal(session.castingCalls, 2);
  assert.equal(session.castingFallbacks, 1);
  assert.equal(session.unknownMemberRefs, 1);
  assert.equal(session.earliest, '2026-09-01');
  assert.equal(session.latest, '2026-09-05');
  const a = byMember.get('a');
  assert.equal(a.sessionsSeated, 2);
  assert.equal(a.sessionsSpoke, 1);
  assert.equal(a.turns, 1);
  assert.equal(a.passes, 1);
  assert.equal(a.citations, 2);
  assert.deepEqual(a.verdicts, { verified: 1, unverified: 0, uncertain: 1 });
  const b = byMember.get('b');
  assert.equal(b.threadTurns, 1);
  assert.equal(b.sessionsPlayerSeat, 1);
  // failed beats are not turns
  assert.equal(byMember.get('c').turns, 0);
});

test('empty sample yields zeros, not errors', () => {
  const { session, byMember } = aggregateSessions([], ['a']);
  assert.equal(session.scanned, 0);
  assert.equal(byMember.get('a').turns, 0);
});

test('aggregateLibrary separates authorship from association and counts words', () => {
  const lib = aggregateLibrary(
    library,
    ['a', 'b', 'c'],
    e => `---\ntitle: t\n---\none two three ${e.id === 'a-one' ? 'four' : ''}`
  );
  const a = lib.get('a');
  assert.deepEqual(a.authored, ['a-one', 'a-two']);
  assert.equal(a.translated, 1);
  assert.deepEqual(a.licenses, { 'public-domain': 1, 'fair-use': 1 });
  assert.equal(a.words, 4 + 3);
  assert.equal(lib.get('b').associatedOnly, 1);
  assert.equal(lib.get('c').authored.length, 0);
  assert.equal(lib.get('c').associatedOnly, 1);
});

test('aggregateGoldenSet attributes items to the entry author', () => {
  const g = aggregateGoldenSet(
    [
      { libraryEntryId: 'a-one', expectedVerdict: 'verified' },
      { libraryEntryId: 'a-two', expectedVerdict: 'unverified' },
      { libraryEntryId: 'x-one', expectedVerdict: 'verified' },
    ],
    library,
    ['a', 'b', 'c']
  );
  assert.deepEqual(g.get('a'), { items: 2, verified: 1, unverified: 1, uncertain: 0 });
  assert.equal(g.get('b').items, 1);
  assert.equal(g.get('c').items, 0);
});

test('parsePortraitTiers reads tier labels from prompt headings', () => {
  const md = '## Alpha (`a`) — 1900–1950 — Photographed\n\n## Beta (`b`) — c. 1200 — Character study (no likeness)\n';
  const t = parsePortraitTiers([md]);
  assert.equal(t.get('a'), 'Photographed');
  assert.equal(t.get('b'), 'Character study');
});

test('stripFrontmatter removes only the leading block', () => {
  assert.equal(stripFrontmatter('---\na: 1\n---\nbody\n---\nkept'), 'body\n---\nkept');
});

test('report states the sample and gaps, and carries no ranking or recommendation language', () => {
  const data = buildEvidence({
    roster,
    sessions,
    library,
    goldenSet: [],
    starters: [{ cast: ['a', 'b'] }],
    tiers: new Map([['a', 'Photographed']]),
    readExcerpt: () => 'x',
  });
  assert.equal(data.members.length, 3);
  assert.equal(data.members[0].starterCasts, 1);
  const report = buildReport(data);
  assert.match(report, /Sessions scanned: 2/);
  assert.match(report, /Casting source is not recoverable per member/);
  assert.match(report, /Alpha/);
  assert.doesNotMatch(
    report,
    /(?<!no )\b(recommend(ed|ation)?|worth cutting|weakest|strongest|sensitivity|representation risk)\b/i
  );
});

test('report with zero sessions says the usage columns are empty rather than zero-by-evidence', () => {
  const data = buildEvidence({ roster, sessions: [], library, readExcerpt: () => '' });
  assert.match(buildReport(data), /empty, not zero-by-evidence/);
});
