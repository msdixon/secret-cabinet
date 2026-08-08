'use strict';

// #193 — graph.js (the knowledge graph, #22/#84), extracted from server.js.
//
// Reads three optional sources (a seed graph.json, a library.json, and a
// sessions/ directory of session files) and merges them into one node/edge
// set. All three inputs are optional on disk — the graph must degrade
// gracefully, not throw, when any of them is missing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildGraph } = require('../graph.js');

const ROSTER = [
  { id: 'crowley', name: 'Crowley' },
  { id: 'blavatsky', name: 'Blavatsky' },
];

function makeFixtureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'graph-test-'));
}

test('buildGraph — missing inputs', async t => {
  await t.test('produces roster-only nodes when seed/library/sessions are all absent', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const result = buildGraph(
      ROSTER,
      path.join(dir, 'graph.json'),
      path.join(dir, 'library.json'),
      path.join(dir, 'sessions'),
    );
    assert.deepEqual(result.nodes.map(n => n.id).sort(), ['blavatsky', 'crowley']);
    assert.deepEqual(result.edges, []);
    assert.ok(result.generated);
  });
});

test('buildGraph — seed edges', async t => {
  await t.test('includes historical seed edges with weight 1', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const graphFile = path.join(dir, 'graph.json');
    fs.writeFileSync(graphFile, JSON.stringify({ edges: [{ source: 'crowley', target: 'blavatsky', type: 'knew' }] }), 'utf8');

    const result = buildGraph(ROSTER, graphFile, path.join(dir, 'library.json'), path.join(dir, 'sessions'));
    assert.deepEqual(result.edges, [{ source: 'crowley', target: 'blavatsky', type: 'knew', weight: 1 }]);
  });
});

test('buildGraph — library-derived edges', async t => {
  await t.test('adds text nodes and member/theme edges from library.json', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const libraryFile = path.join(dir, 'library.json');
    fs.writeFileSync(libraryFile, JSON.stringify([
      { id: 'text1', title: 'Text One', members: ['crowley'], themes: ['schism'] },
    ]), 'utf8');

    const result = buildGraph(ROSTER, path.join(dir, 'graph.json'), libraryFile, path.join(dir, 'sessions'));
    assert.ok(result.nodes.find(n => n.id === 'text1' && n.type === 'text'));
    assert.ok(result.nodes.find(n => n.id === 'schism' && n.type === 'theme'));
    assert.ok(result.edges.some(e => e.source === 'crowley' && e.target === 'text1' && e.type === 'appears-in'));
    assert.ok(result.edges.some(e => e.source === 'text1' && e.target === 'schism' && e.type === 'touches'));
    assert.ok(result.edges.some(e => e.source === 'crowley' && e.target === 'schism' && e.type === 'associated-with'));
  });
});

test('buildGraph — session-derived edges', async t => {
  await t.test('accumulates co-convened and tagged edges with weight per repeat occurrence', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsDir);
    fs.writeFileSync(path.join(sessionsDir, 's1.json'), JSON.stringify({
      id: 's1', entry: 'The first document', members: ['crowley', 'blavatsky'], tags: ['schism'],
    }), 'utf8');
    fs.writeFileSync(path.join(sessionsDir, 's2.json'), JSON.stringify({
      id: 's2', entry: 'The second document', members: ['crowley', 'blavatsky'], tags: ['schism'],
    }), 'utf8');

    const result = buildGraph(ROSTER, path.join(dir, 'graph.json'), path.join(dir, 'library.json'), sessionsDir);
    // accumulateEdge is only called when mid < mid2 (string order), so for
    // ['crowley', 'blavatsky'] the edge is registered as blavatsky→crowley.
    const coConvened = result.edges.find(e => e.type === 'co-convened' && e.source === 'blavatsky' && e.target === 'crowley');
    assert.ok(coConvened, 'expected a co-convened edge');
    assert.equal(coConvened.weight, 2);
    assert.deepEqual(coConvened.sessions.sort(), ['s1', 's2']);

    assert.ok(result.nodes.find(n => n.id === 's1' && n.type === 'session' && n.label === 'The first document'));
  });

  await t.test('ignores .gitkeep and unparseable session files without throwing', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsDir);
    fs.writeFileSync(path.join(sessionsDir, '.gitkeep'), '', 'utf8');
    fs.writeFileSync(path.join(sessionsDir, 'broken.json'), '{not valid json', 'utf8');

    assert.doesNotThrow(() => buildGraph(ROSTER, path.join(dir, 'graph.json'), path.join(dir, 'library.json'), sessionsDir));
  });

  await t.test('a session with no tags produces no theme nodes', () => {
    const dir = makeFixtureDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsDir);
    fs.writeFileSync(path.join(sessionsDir, 's1.json'), JSON.stringify({ id: 's1', members: ['crowley'] }), 'utf8');

    const result = buildGraph(ROSTER, path.join(dir, 'graph.json'), path.join(dir, 'library.json'), sessionsDir);
    assert.equal(result.nodes.some(n => n.type === 'theme'), false);
  });
});
