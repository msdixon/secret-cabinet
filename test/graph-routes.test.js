'use strict';

// #193 route-extraction — src/routes/graph.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerGraphRoutes } = require('../src/routes/graph.js');

function fakeApp() {
  const routes = {};
  return {
    routes,
    get(path, handler) {
      routes[`GET ${path}`] = handler;
    },
  };
}

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return res;
}

test('registerGraphRoutes', async t => {
  await t.test('registers GET /api/graph', () => {
    const app = fakeApp();
    registerGraphRoutes(app, {
      graph: { buildGraph: () => ({}) },
      roster: [],
      graphFile: 'g',
      libraryFile: 'l',
      sessionsDir: 's',
    });
    assert.equal(typeof app.routes['GET /api/graph'], 'function');
  });
});

test('GET /api/graph', async t => {
  await t.test('calls buildGraph with the roster and the three path deps, and returns its result', () => {
    const app = fakeApp();
    let calledWith = null;
    const graph = {
      buildGraph: (...args) => {
        calledWith = args;
        return { nodes: [1, 2], edges: [1] };
      },
    };
    registerGraphRoutes(app, {
      graph,
      roster: ['crowley'],
      graphFile: 'g.json',
      libraryFile: 'l.json',
      sessionsDir: '/sessions',
    });
    const res = fakeRes();
    app.routes['GET /api/graph'](null, res);
    assert.deepEqual(calledWith, [['crowley'], 'g.json', 'l.json', '/sessions']);
    assert.deepEqual(res.body, { nodes: [1, 2], edges: [1] });
  });

  await t.test('a thrown error is caught and returns 500', () => {
    const app = fakeApp();
    const graph = {
      buildGraph: () => {
        throw new Error('bad graph file');
      },
    };
    registerGraphRoutes(app, { graph, roster: [], graphFile: 'g', libraryFile: 'l', sessionsDir: 's' });
    const res = fakeRes();
    app.routes['GET /api/graph'](null, res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Failed to build graph' });
  });
});
