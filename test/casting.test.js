'use strict';

// #185 — casting.js's two mechanisms, through the deps-bag seam (#142/#137).
//
// The interesting behaviour here is mostly about *restraint*: a proposal must
// apply nothing until accepted, the auto path must not fire twice for the
// same document or at all once the user has hand-cast, and regulars must
// survive a page load. Each of those is a rule the browser breaks silently —
// a second call is invisible on the bill until the month is out, and a
// proposal that quietly reseats the room just looks like the grid glitched.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadPublicModule, assertIdsExistInIndexHtml } = require('./helpers/dom.js');

const FIXTURE = `
  <div id="cast-proposal" style="display:none;">
    <span id="cast-proposal-title"></span>
    <div id="cast-proposal-names"></div>
    <div id="cast-proposal-reason"></div>
    <div id="cast-proposal-actions"></div>
  </div>
  <div id="members-cast-hint" style="display:none;"></div>
`;

const MEMBERS = [
  { id: 'crowley', name: 'Crowley' },
  { id: 'yeats', name: 'Yeats' },
  { id: 'blavatsky', name: 'Blavatsky' },
  { id: 'jung', name: 'Jung' },
];

const DEFAULT_RESPONSE = {
  ok: true,
  json: { cast: ['crowley', 'jung'], additions: ['crowley', 'jung'], regulars: [], reasoning: 'Both would want at this.', source: 'director' },
};

// Boots casting.js against a fake core and a stubbed fetch, and hands back the
// seams a test asserts on: what the room now holds, how many calls were made,
// and what each one asked for. `regulars` is written before the module loads,
// because that is when a real page's stored pins would already be there.
function boot(t, { activeMembers = new Set(), members = MEMBERS, entry = 'a document', regulars = null, respond } = {}) {
  const loaded = loadPublicModule('casting.js', FIXTURE, (window) => {
    if (regulars) window.localStorage.setItem('sc-regulars', JSON.stringify(regulars));
  });
  t.after(loaded.cleanup);

  const calls = [];
  loaded.window.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    const r = respond ? respond(calls.length) : DEFAULT_RESPONSE;
    return { ok: r.ok, json: async () => r.json };
  };

  let renders = 0;
  const statuses = [];
  loaded.module.configure({
    getCore: () => ({ activeMembers, MEMBERS: members }),
    getEntry: () => entry,
    renderMembers: () => { renders++; },
    setStatus: (msg) => statuses.push(msg),
  });

  return { ...loaded, activeMembers, calls, statuses, renderCount: () => renders };
}

test('casting.js — regulars', async t => {
  await t.test('the ids this fixture stubs still exist in index.html', () => {
    assertIdsExistInIndexHtml([
      'cast-proposal', 'cast-proposal-title', 'cast-proposal-names',
      'cast-proposal-reason', 'cast-proposal-actions', 'members-cast-hint',
    ]);
  });

  await t.test('pinning seats the member immediately and persists the pin', t2 => {
    const b = boot(t2);
    b.module.toggleRegular('yeats');
    assert.deepEqual([...b.module.getRegulars()], ['yeats']);
    assert.equal(b.module.isRegular('yeats'), true);
    assert.ok(b.activeMembers.has('yeats'), 'always-invited is a strange promise to make and not keep now');
    assert.deepEqual(JSON.parse(b.window.localStorage.getItem('sc-regulars')), ['yeats']);
  });

  await t.test('unpinning releases the seat as well as the pin', t2 => {
    const b = boot(t2);
    b.module.toggleRegular('yeats');
    b.module.toggleRegular('yeats');
    assert.deepEqual([...b.module.getRegulars()], []);
    assert.equal(b.activeMembers.has('yeats'), false);
  });

  await t.test('stored regulars are seated at startup', t2 => {
    const b = boot(t2, { regulars: ['yeats', 'crowley'] });
    b.module.seatRegulars();
    assert.deepEqual([...b.activeMembers].sort(), ['crowley', 'yeats']);
  });

  await t.test('a regular who has left the roster is dropped, not carried forever', t2 => {
    const b = boot(t2, { regulars: ['yeats', 'someone-deleted'] });
    b.module.seatRegulars();
    assert.deepEqual([...b.module.getRegulars()], ['yeats']);
    assert.deepEqual(JSON.parse(b.window.localStorage.getItem('sc-regulars')), ['yeats']);
    assert.equal(b.activeMembers.has('someone-deleted'), false);
  });

  await t.test('a corrupted stored value costs the pins, not the page', t2 => {
    const loaded = loadPublicModule('casting.js', FIXTURE, (window) => {
      window.localStorage.setItem('sc-regulars', '{not json');
    });
    t2.after(loaded.cleanup);
    assert.deepEqual([...loaded.module.getRegulars()], []);
  });
});

test('casting.js — the proposal', async t => {
  await t.test('sends the document and the regulars, and applies nothing on its own', async t2 => {
    const b = boot(t2, { regulars: ['yeats'] });
    b.module.seatRegulars();
    const before = [...b.activeMembers];
    await b.module.requestProposal();

    assert.equal(b.calls.length, 1);
    assert.equal(b.calls[0].url, '/api/cast');
    assert.deepEqual(b.calls[0].body, { entry: 'a document', regulars: ['yeats'] });
    assert.deepEqual([...b.activeMembers], before, 'a proposal must not reseat the room by itself');
  });

  await t.test('accepting replaces the room with exactly the proposed cast', async t2 => {
    const b = boot(t2, { activeMembers: new Set(['blavatsky']) });
    await b.module.requestProposal();
    b.module.acceptProposal();
    assert.deepEqual([...b.activeMembers].sort(), ['crowley', 'jung']);
    assert.equal(b.document.getElementById('cast-proposal').style.display, 'none');
  });

  await t.test('dismissing leaves the room untouched', async t2 => {
    const b = boot(t2, { activeMembers: new Set(['blavatsky']) });
    await b.module.requestProposal();
    b.module.dismissProposal();
    assert.deepEqual([...b.activeMembers], ['blavatsky']);
    assert.equal(b.document.getElementById('cast-proposal').style.display, 'none');
  });

  await t.test('the auto path does not fire twice for the same document', async t2 => {
    const b = boot(t2);
    await b.module.requestProposal({ auto: true });
    await b.module.requestProposal({ auto: true });
    assert.equal(b.calls.length, 1, 'one cheap call per document is the whole budget');
  });

  await t.test('a new document reopens the budget', async t2 => {
    let entry = 'the first document';
    const loaded = loadPublicModule('casting.js', FIXTURE);
    t2.after(loaded.cleanup);
    const calls = [];
    loaded.window.fetch = async (url, opts) => {
      calls.push(JSON.parse(opts.body).entry);
      return { ok: true, json: async () => DEFAULT_RESPONSE.json };
    };
    loaded.module.configure({
      getCore: () => ({ activeMembers: new Set(), MEMBERS }),
      getEntry: () => entry,
      renderMembers: () => {},
      setStatus: () => {},
    });
    await loaded.module.requestProposal({ auto: true });
    entry = 'a different document entirely';
    await loaded.module.requestProposal({ auto: true });
    assert.deepEqual(calls, ['the first document', 'a different document entirely']);
  });

  await t.test('the explicit ask overrides the once-per-document rule', async t2 => {
    const b = boot(t2);
    await b.module.requestProposal({ auto: true });
    await b.module.requestProposal();
    assert.equal(b.calls.length, 2);
  });

  await t.test('the auto path yields once the user has hand-cast', async t2 => {
    const b = boot(t2);
    b.module.noteHandCast();
    await b.module.requestProposal({ auto: true });
    assert.equal(b.calls.length, 0, 'nothing should overwrite a deliberate choice');
    await b.module.requestProposal();
    assert.equal(b.calls.length, 1, 'but asking outright still works');
  });

  await t.test('no document, no call — and an unasked-for attempt stays silent', async t2 => {
    const b = boot(t2, { entry: '' });
    await b.module.requestProposal({ auto: true });
    assert.equal(b.calls.length, 0);
    assert.deepEqual(b.statuses, []);

    await b.module.requestProposal();
    assert.equal(b.calls.length, 0);
    assert.equal(b.statuses.length, 1, 'but an explicit ask deserves an answer');
  });

  await t.test('a failed proposal shows nothing, says why, and stays retryable', async t2 => {
    const b = boot(t2, {
      respond: (n) => n === 1
        ? { ok: false, json: { error: 'the fire is low' } }
        : DEFAULT_RESPONSE,
    });
    await b.module.requestProposal();
    assert.equal(b.document.getElementById('cast-proposal').style.display, 'none');
    assert.match(b.statuses.at(-1), /the fire is low/);

    // A failure must not burn the document's one auto call.
    await b.module.requestProposal({ auto: true });
    assert.equal(b.calls.length, 2);
    assert.equal(b.document.getElementById('cast-proposal').style.display, 'block');
  });
});

test('casting.js — render', async t => {
  await t.test('shows the cold-open hint only when the room is genuinely empty', t2 => {
    const b = boot(t2);
    b.module.render();
    assert.equal(b.document.getElementById('members-cast-hint').style.display, 'block');

    b.activeMembers.add('yeats');
    b.module.render();
    assert.equal(b.document.getElementById('members-cast-hint').style.display, 'none');
  });

  await t.test('marks regulars in the proposal as already coming, not as the model\'s choices', async t2 => {
    const b = boot(t2, {
      respond: () => ({ ok: true, json: { cast: ['yeats', 'jung'], additions: ['jung'], regulars: ['yeats'], reasoning: 'Jung would dispute it.', source: 'director' } }),
    });
    await b.module.requestProposal();
    const names = [...b.document.getElementById('cast-proposal-names').children];
    assert.deepEqual(names.map(n => n.textContent), ['Yeats', 'Jung']);
    assert.equal(names[0].className, 'cast-proposal-name regular');
    assert.equal(names[1].className, 'cast-proposal-name');
    assert.equal(b.document.getElementById('cast-proposal-reason').textContent, 'Jung would dispute it.');
  });

  await t.test('a regulars-only proposal explains itself instead of showing a blank rationale', async t2 => {
    const b = boot(t2, {
      respond: () => ({ ok: true, json: { cast: ['yeats'], additions: [], regulars: ['yeats'], reasoning: null, source: 'regulars' } }),
    });
    await b.module.requestProposal();
    assert.match(b.document.getElementById('cast-proposal-reason').textContent, /regulars already fill the room/);
  });

  await t.test('escapes member names rather than trusting the user-authored roster', async t2 => {
    const b = boot(t2, {
      members: [{ id: 'crowley', name: '<img src=x onerror=alert(1)>' }],
      respond: () => ({ ok: true, json: { cast: ['crowley'], additions: ['crowley'], regulars: [], reasoning: 'r', source: 'director' } }),
    });
    await b.module.requestProposal();
    const el = b.document.getElementById('cast-proposal-names');
    assert.equal(el.querySelector('img'), null, 'a roster name must not become markup');
    assert.equal(el.textContent, '<img src=x onerror=alert(1)>');
  });
});

test('casting.js — reads core state through the deps bag, never off the window', t => {
  const loaded = loadPublicModule('casting.js', FIXTURE);
  t.after(loaded.cleanup);

  // Decoys, in the shape app.js's own globals take. If casting.js reached for
  // a bare global instead of deps.getCore(), it would find these.
  loaded.window.activeMembers = new Set(['decoy']);
  loaded.window.MEMBERS = [{ id: 'decoy', name: 'Decoy' }];

  const activeMembers = new Set();
  loaded.module.configure({
    getCore: () => ({ activeMembers, MEMBERS }),
    getEntry: () => 'doc',
    renderMembers: () => {},
    setStatus: () => {},
  });

  loaded.module.toggleRegular('yeats');
  assert.deepEqual([...activeMembers], ['yeats']);
  assert.deepEqual([...loaded.window.activeMembers], ['decoy'], 'the decoy must be untouched');
});
