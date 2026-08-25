'use strict';

// #268 — relationship-as-data layer for member interactions. Seed/source is
// the existing knowledge graph (#22/#84, src/graph.js) per the decision on
// the issue; this module composes the per-evening fallback for present-
// member pairs a speaker's own character file doesn't already narrate.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  relationshipsSectionOf,
  mentionsMember,
  edgesForPair,
  renderEdge,
  buildRelationshipLines,
  buildRelationshipSection,
} = require('../src/relationships.js');

const CROWLEY_FILE = `# ALEISTER CROWLEY

## HOW YOU SPEAK

Spirals.

## YOUR RELATIONSHIPS IN THIS ROOM

**Waite**: Documented mutual contempt.

**Yeats**: A peer, nearly.

## HOW YOU NEEDLE

You bait.
`;

const WAITE = { id: 'waite', name: 'Waite' };
const YEATS = { id: 'yeats', name: 'Yeats' };
const SUN_RA = { id: 'sun-ra', name: 'Sun Ra' };
const CROWLEY = { id: 'crowley', name: 'Crowley' };

test('relationshipsSectionOf', async t => {
  await t.test('extracts only the relationships section, not neighboring headings', () => {
    const section = relationshipsSectionOf(CROWLEY_FILE);
    assert.match(section, /Waite/);
    assert.match(section, /Yeats/);
    assert.doesNotMatch(section, /You bait/);
    assert.doesNotMatch(section, /HOW YOU SPEAK/);
  });

  await t.test('returns empty string when the file has no such heading', () => {
    assert.equal(relationshipsSectionOf('# NOBODY\n\nJust prose.'), '');
  });
});

test('mentionsMember', async t => {
  await t.test('matches on the display name', () => {
    const section = relationshipsSectionOf(CROWLEY_FILE);
    assert.ok(mentionsMember(section, WAITE));
    assert.ok(mentionsMember(section, YEATS));
  });

  await t.test('does not match a member the section never names', () => {
    const section = relationshipsSectionOf(CROWLEY_FILE);
    assert.ok(!mentionsMember(section, SUN_RA));
  });

  await t.test('matches on an alias when the display name is absent', () => {
    const section = 'You have known Pamela for years.';
    const pixie = { id: 'pixie', name: 'Coleman-Smith', aliases: ['Pamela'] };
    assert.ok(mentionsMember(section, pixie));
  });
});

test('edgesForPair', async t => {
  const edges = [
    { source: 'crowley', target: 'waite', type: 'rivalry', label: 'Golden Dawn schism' },
    { source: 'yeats', target: 'maud', type: 'love', label: 'Lifelong entanglement' },
  ];

  await t.test('finds an edge regardless of source/target order', () => {
    assert.equal(edgesForPair(edges, 'crowley', 'waite').length, 1);
    assert.equal(edgesForPair(edges, 'waite', 'crowley').length, 1);
  });

  await t.test('returns nothing for a pair with no edge', () => {
    assert.deepEqual(edgesForPair(edges, 'crowley', 'sun-ra'), []);
  });

  await t.test('handles an undefined edge list without throwing', () => {
    assert.deepEqual(edgesForPair(undefined, 'crowley', 'waite'), []);
  });
});

test('renderEdge', async t => {
  await t.test('renders a historical edge with its label', () => {
    const line = renderEdge(
      { source: 'crowley', target: 'sun-ra', type: 'influence', label: 'A direct line of descent' },
      'Sun Ra'
    );
    assert.match(line, /\*\*Sun Ra\*\*/);
    assert.match(line, /A direct line of descent/);
  });

  await t.test('renders a co-convened edge from weight, not label', () => {
    const line = renderEdge({ source: 'a', target: 'b', type: 'co-convened', weight: 3 }, 'Sun Ra');
    assert.match(line, /3 sessions together/);
  });

  await t.test('singularizes a co-convened edge with weight 1', () => {
    const line = renderEdge({ source: 'a', target: 'b', type: 'co-convened', weight: 1 }, 'Sun Ra');
    assert.match(line, /1 session together/);
    assert.doesNotMatch(line, /1 sessions/);
  });

  await t.test('falls back to a generic register for an unrecognized edge type', () => {
    const line = renderEdge({ source: 'a', target: 'b', type: 'mystery-type', label: 'Something odd' }, 'Sun Ra');
    assert.match(line, /a documented connection/);
  });
});

test('buildRelationshipLines', async t => {
  const edges = [{ source: 'crowley', target: 'sun-ra', type: 'influence', label: 'A direct line of descent' }];

  await t.test('skips a present member already covered by hand-authored prose', () => {
    const lines = buildRelationshipLines(CROWLEY_FILE, CROWLEY, [WAITE], edges);
    assert.deepEqual(lines, []);
  });

  await t.test('renders a line for a present member with graph data but no prose', () => {
    const lines = buildRelationshipLines(CROWLEY_FILE, CROWLEY, [SUN_RA], edges);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Sun Ra/);
  });

  await t.test('stays silent for a present member with neither prose nor graph data', () => {
    const lines = buildRelationshipLines(CROWLEY_FILE, CROWLEY, [{ id: 'jung', name: 'Jung' }], edges);
    assert.deepEqual(lines, []);
  });

  await t.test('never renders a line for the speaker themself', () => {
    const selfEdges = [{ source: 'crowley', target: 'crowley', type: 'rivalry', label: 'n/a' }];
    const lines = buildRelationshipLines(CROWLEY_FILE, CROWLEY, [CROWLEY], selfEdges);
    assert.deepEqual(lines, []);
  });

  await t.test('mixes covered and uncovered pairs correctly in one call', () => {
    const lines = buildRelationshipLines(CROWLEY_FILE, CROWLEY, [WAITE, YEATS, SUN_RA], edges);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Sun Ra/);
  });
});

test('buildRelationshipSection', async t => {
  const edges = [{ source: 'crowley', target: 'sun-ra', type: 'influence', label: 'A direct line of descent' }];

  await t.test('is empty when there is nothing to add', () => {
    assert.equal(buildRelationshipSection(CROWLEY_FILE, CROWLEY, [WAITE], edges), '');
  });

  await t.test('wraps the assembled lines in their own labeled section', () => {
    const section = buildRelationshipSection(CROWLEY_FILE, CROWLEY, [SUN_RA], edges);
    assert.match(section, /OTHERS IN THE ROOM TONIGHT, PER THE ROOM'S RECORD/);
    assert.match(section, /Sun Ra/);
  });

  await t.test('degrades gracefully when no present-member list or edges are given', () => {
    assert.equal(buildRelationshipSection(CROWLEY_FILE, CROWLEY, undefined, undefined), '');
  });
});
