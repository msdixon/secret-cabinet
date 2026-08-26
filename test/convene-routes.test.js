'use strict';

// #193 route-extraction — src/routes/convene.js, the highest-risk module in
// this pass: SSE streaming state and session create/mutate-in-flight (see
// the module comment on src/routes/convene.js). runRound/proposeCast are faked
// here at the pipeline.js boundary — their own internals are covered by
// test/pipeline.test.js; what these tests exercise is the SSE event
// sequence, session persistence, and error handling this module owns.
// Live-verified separately against a running server (convene, round,
// interject, branch, publish — see the PR description) before this suite
// was written, matching the standard the first #193 pass set for auth.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerConveneRoutes } = require('../src/routes/convene.js');
const record = require('../public/js/record.js');
const { turnsSoFar } = require('../src/lodge-prompts.js');

function fakeApp() {
  const routes = {};
  return {
    routes,
    post(path, handler) {
      routes[`POST ${path}`] = handler;
    },
  };
}

function fakeReq(body = {}) {
  return { body };
}

// Captures SSE events the same way EventSource would parse them client-side:
// splits on the `data: {...}\n\n` framing and JSON-parses each payload.
function fakeSSERes() {
  const res = {
    headWritten: false,
    chunks: [],
    ended: false,
    writeHead() {
      this.headWritten = true;
    },
    write(chunk) {
      this.chunks.push(chunk);
    },
    end() {
      this.ended = true;
    },
  };
  res.events = () =>
    res.chunks
      .join('')
      .split('\n\n')
      .filter(Boolean)
      .map(line => JSON.parse(line.replace(/^data: /, '')));
  return res;
}

function fakeJSONRes() {
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

function makeDeps(overrides = {}) {
  const savedSessions = new Map();
  const savedResidue = [];
  return {
    savedSessions,
    savedResidue,
    client: {},
    model: 'test-model',
    lodgeContext: 'context',
    roster: [
      { id: 'crowley', name: 'Crowley' },
      { id: 'jung', name: 'Carl Jung' },
    ],
    loadMemberFile: () => 'member text',
    loadVoiceExemplar: () => null,
    loadResidue: () => '',
    castingRoster: () => [{ id: 'crowley', name: 'Crowley', brief: 'brief' }],
    buildPassagePrompt: ({ entry, isFirst }) => `PROMPT(${isFirst}): ${entry}`,
    wordsSpentSoFar: () => 0,
    // #352: the real reduction rather than a stub — it's pure, and the
    // route's only job here is handing runRound the ledger it builds from
    // the stored `beats`, which a stub returning {} could not distinguish
    // from not calling it at all.
    turnsSoFar,
    defaultPoolSize: 2,
    deriveMeetingNote: () => null,
    playerDirectorPool: members => members,
    resolvePlayerName: (mode, id, name) => name || null,
    // #354: real resolvePlayerSpeakerId is roster-free pure logic (see
    // lodge-prompts.js); this stub mirrors its two real branches without
    // pulling in record.js, same spirit as the other stand-ins here.
    resolvePlayerSpeakerId: (mode, id) => (mode === 'member' ? id : mode === 'custom' ? 'player:custom' : null),
    buildPrecedingTurn: (speakerName, playerTurn, memberId) =>
      playerTurn ? { speakerName, memberId, text: playerTurn } : null,
    interjectSpeakerCount: 3,
    makeSessionId: entry => `session-${entry.slice(0, 5)}`,
    saveSession: session => savedSessions.set(session.id, session),
    loadSession: id => savedSessions.get(id) || null,
    saveResidueUpdates: updates => savedResidue.push(updates),
    composeSegmentText: segment =>
      segment.endedBy ? `\n${segment.text}\n\n— ${segment.label} —\n` : `\n— ${segment.label} —\n\n${segment.text}\n`,
    buildTranscriptHeader: (entry, members, date) => `HEADER(${date})\n${entry}\n`,
    isLocal: true,
    runRound: async ({ onSpeakerStart, onSpeakerEnd, onChunk, onMetric }) => {
      onChunk?.('hello ');
      onSpeakerStart?.('crowley');
      onChunk?.('world');
      onSpeakerEnd?.('crowley', 'Crowley', 'hello world');
      onMetric?.({ phase: 'speaker', memberId: 'crowley' });
      return {
        fullRoundText: 'Crowley —\nhello world',
        speakerOrder: ['crowley'],
        disposition: { crowley: 'engaged' },
        residueUpdates: { crowley: 'a note' },
        beats: [{ memberId: 'crowley', text: 'hello world' }],
        endedBy: 'budget',
        lullNote: 'The room draws breath.',
      };
    },
    proposeCast: async () => ({ cast: ['crowley'], additions: ['crowley'], regulars: [], reasoning: 'fits the room' }),
    ...overrides,
  };
}

test('registerConveneRoutes', async t => {
  await t.test('registers all five generation routes', () => {
    const app = fakeApp();
    registerConveneRoutes(app, makeDeps());
    [
      'POST /api/convene',
      'POST /api/cast',
      'POST /api/round',
      'POST /api/interject',
      'POST /api/prototype/round',
    ].forEach(key => assert.equal(typeof app.routes[key], 'function', key));
  });
});

test('POST /api/convene', async t => {
  await t.test('400s without entry or members', async () => {
    const app = fakeApp();
    registerConveneRoutes(app, makeDeps());
    const res = fakeJSONRes();
    await app.routes['POST /api/convene'](fakeReq({ entry: '' }), res);
    assert.equal(res.statusCode, 400);
  });

  await t.test('streams speaking/speakerDone/done events and persists a new session', async () => {
    const app = fakeApp();
    const deps = makeDeps();
    registerConveneRoutes(app, deps);
    const res = fakeSSERes();
    await app.routes['POST /api/convene'](fakeReq({ entry: 'A test entry', members: ['crowley', 'jung'] }), res);

    assert.equal(res.headWritten, true);
    assert.equal(res.ended, true);
    const events = res.events();
    assert.deepEqual(
      events.find(e => e.speaking),
      { speaking: 'crowley' }
    );
    assert.ok(events.find(e => e.speakerDone));
    const done = events.find(e => e.done);
    assert.equal(done.round, 1);
    assert.equal(done.label, 'The room draws breath.');
    assert.ok(done.sessionId);

    const saved = deps.savedSessions.get(done.sessionId);
    assert.equal(saved.rounds.length, 1);
    assert.equal(saved.rounds[0].text, 'Crowley —\nhello world');
    // #244: label/endedBy/beats now come straight off runRound's return
    // shape rather than a fixed round-index label.
    assert.equal(saved.rounds[0].label, 'The room draws breath.');
    assert.equal(saved.rounds[0].endedBy, 'budget');
    assert.deepEqual(saved.rounds[0].beats, [{ memberId: 'crowley', text: 'hello world' }]);
    assert.deepEqual(deps.savedResidue[0], { crowley: 'a note' });
  });

  await t.test('a runRound failure streams an error event instead of throwing', async () => {
    const app = fakeApp();
    registerConveneRoutes(
      app,
      makeDeps({
        runRound: async () => {
          throw new Error('model unavailable');
        },
      })
    );
    const res = fakeSSERes();
    await app.routes['POST /api/convene'](fakeReq({ entry: 'A test entry', members: ['crowley'] }), res);
    const events = res.events();
    assert.equal(events[0].error, 'model unavailable');
    assert.equal(res.ended, true);
  });

  await t.test('validated castMetrics from the client ride into session.generationMetrics', async () => {
    const app = fakeApp();
    const deps = makeDeps();
    registerConveneRoutes(app, deps);
    const res = fakeSSERes();
    await app.routes['POST /api/convene'](
      fakeReq({
        entry: 'A test entry',
        members: ['crowley'],
        castMetrics: [{ phase: 'casting', usage: {} }, 'not-an-object', { noPhase: true }],
      }),
      res
    );
    const done = res.events().find(e => e.done);
    const saved = deps.savedSessions.get(done.sessionId);
    // Only the well-shaped entry survives the filter, plus the one runRound's onMetric added.
    assert.equal(saved.generationMetrics.filter(m => m.phase === 'casting').length, 1);
  });
});

test('POST /api/cast', async t => {
  await t.test('400s without entry', async () => {
    const app = fakeApp();
    registerConveneRoutes(app, makeDeps());
    const res = fakeJSONRes();
    await app.routes['POST /api/cast'](fakeReq({}), res);
    assert.equal(res.statusCode, 400);
  });

  await t.test('proposes a cast and returns it with metrics, no session created', async () => {
    const app = fakeApp();
    const deps = makeDeps();
    registerConveneRoutes(app, deps);
    const res = fakeJSONRes();
    await app.routes['POST /api/cast'](fakeReq({ entry: 'A document', regulars: [] }), res);
    assert.deepEqual(res.body.cast, ['crowley']);
    assert.equal(deps.savedSessions.size, 0);
  });

  await t.test('a skipped casting metric reported through onMetric rides back in the response', async () => {
    const app = fakeApp();
    const deps = makeDeps({
      proposeCast: async ({ onMetric }) => {
        onMetric({ phase: 'casting', skipped: true, error: 'rate limited' });
        return { cast: ['crowley'], additions: [], regulars: [], reasoning: 'fits the room' };
      },
    });
    registerConveneRoutes(app, deps);
    const res = fakeJSONRes();
    await app.routes['POST /api/cast'](fakeReq({ entry: 'A document', regulars: [] }), res);
    assert.deepEqual(res.body.metrics, [{ phase: 'casting', skipped: true, error: 'rate limited' }]);
  });

  await t.test('a proposeCast failure is caught and returns 500', async () => {
    const app = fakeApp();
    registerConveneRoutes(
      app,
      makeDeps({
        proposeCast: async () => {
          throw new Error('casting broke');
        },
      })
    );
    const res = fakeJSONRes();
    await app.routes['POST /api/cast'](fakeReq({ entry: 'A document' }), res);
    assert.equal(res.statusCode, 500);
  });
});

test('POST /api/round', async t => {
  await t.test('404s for an unknown session', async () => {
    const app = fakeApp();
    registerConveneRoutes(app, makeDeps());
    const res = fakeJSONRes();
    await app.routes['POST /api/round'](fakeReq({ sessionId: 'nope' }), res);
    assert.equal(res.statusCode, 404);
  });

  await t.test('appends a new round to conversationHistory/rounds/transcriptText', async () => {
    const app = fakeApp();
    const deps = makeDeps();
    registerConveneRoutes(app, deps);
    deps.savedSessions.set('s1', {
      id: 's1',
      entry: 'entry',
      members: ['crowley', 'jung'],
      conversationHistory: [
        { role: 'user', content: 'p0' },
        { role: 'assistant', content: 'r0' },
      ],
      rounds: [{ label: 'First Movement', text: 'r0', historyLength: 2 }],
      transcriptText: 'HEADER\n',
      generationMetrics: [],
      playerTurns: [],
      disposition: {},
    });
    const res = fakeSSERes();
    await app.routes['POST /api/round'](fakeReq({ sessionId: 's1' }), res);
    const saved = deps.savedSessions.get('s1');
    assert.equal(saved.rounds.length, 2);
    assert.equal(saved.rounds[1].label, 'The room draws breath.');
    assert.equal(saved.rounds[1].endedBy, 'budget');
    assert.equal(saved.conversationHistory.length, 4);
  });

  // #352: the ledger is built at the route, from the stored record, and
  // handed to runRound — the one seam where the whole feature can go silent
  // without anything failing, since pickNextSpeaker treats an absent ledger
  // as a supported no-op rather than an error.
  await t.test('hands runRound the meeting-level turn ledger built from the stored beats', async () => {
    const app = fakeApp();
    let seen;
    const deps = makeDeps({
      runRound: async args => {
        seen = args.meetingTurns;
        return {
          fullRoundText: 'text',
          speakerOrder: [],
          disposition: {},
          residueUpdates: {},
          beats: [],
          endedBy: 'budget',
          lullNote: 'A pause.',
        };
      },
    });
    registerConveneRoutes(app, deps);
    deps.savedSessions.set('s1', {
      id: 's1',
      entry: 'entry',
      members: ['crowley', 'jung'],
      conversationHistory: [],
      rounds: [
        { text: 'r0', beats: [{ memberId: 'crowley' }, { memberId: null, text: 'a player turn' }] },
        { text: 'r1', beats: [{ memberId: 'crowley' }] },
        { text: 'r2' }, // a passage from before #244 stored beats
      ],
      transcriptText: '',
      generationMetrics: [],
      disposition: {},
    });
    await app.routes['POST /api/round'](fakeReq({ sessionId: 's1' }), fakeSSERes());
    assert.deepEqual(seen, { crowley: 2 }, 'jung never spoke, so has no key — the whole point of the ledger');
  });

  await t.test('a player turn in the request body is recorded onto session.playerTurns', async () => {
    const app = fakeApp();
    const deps = makeDeps();
    registerConveneRoutes(app, deps);
    deps.savedSessions.set('s1', {
      id: 's1',
      entry: 'entry',
      members: ['crowley', 'jung'],
      conversationHistory: [],
      rounds: [{ label: 'First Movement', text: 'r0', historyLength: 0 }],
      transcriptText: 'HEADER\n',
      generationMetrics: [],
      playerTurns: [],
      disposition: {},
    });
    await app.routes['POST /api/round'](fakeReq({ sessionId: 's1', playerTurn: 'A player line' }), fakeSSERes());
    const saved = deps.savedSessions.get('s1');
    assert.deepEqual(saved.playerTurns, [{ round: 1, speakerName: null, text: 'A player line' }]);
  });

  await t.test('a runRound failure streams an error event instead of throwing', async () => {
    const app = fakeApp();
    const deps = makeDeps({
      runRound: async () => {
        throw new Error('model unavailable');
      },
    });
    registerConveneRoutes(app, deps);
    deps.savedSessions.set('s1', {
      id: 's1',
      entry: 'entry',
      members: ['crowley', 'jung'],
      conversationHistory: [],
      rounds: [{ label: 'First Movement', text: 'r0', historyLength: 0 }],
      transcriptText: 'HEADER\n',
      generationMetrics: [],
      playerTurns: [],
      disposition: {},
    });
    const res = fakeSSERes();
    await app.routes['POST /api/round'](fakeReq({ sessionId: 's1' }), res);
    assert.equal(res.events()[0].error, 'Failed to generate round');
    assert.equal(res.ended, true);
    assert.equal(deps.savedSessions.get('s1').rounds.length, 1, 'the failed round is never appended');
  });
});

test('POST /api/interject', async t => {
  await t.test('400s without sessionId or text', async () => {
    const app = fakeApp();
    registerConveneRoutes(app, makeDeps());
    const res = fakeJSONRes();
    await app.routes['POST /api/interject'](fakeReq({ sessionId: 's1' }), res);
    assert.equal(res.statusCode, 400);
  });

  await t.test('404s for an unknown session', async () => {
    const app = fakeApp();
    registerConveneRoutes(app, makeDeps());
    const res = fakeJSONRes();
    await app.routes['POST /api/interject'](fakeReq({ sessionId: 'nope', text: 'hi' }), res);
    assert.equal(res.statusCode, 404);
  });

  await t.test('appends the interjection and response into the transcript', async () => {
    const app = fakeApp();
    const deps = makeDeps();
    registerConveneRoutes(app, deps);
    deps.savedSessions.set('s1', {
      id: 's1',
      members: ['crowley', 'jung'],
      conversationHistory: [],
      rounds: [],
      transcriptText: 'HEADER\n',
      generationMetrics: [],
      disposition: {},
    });
    const res = fakeSSERes();
    await app.routes['POST /api/interject'](fakeReq({ sessionId: 's1', text: 'What of silence?' }), res);
    const saved = deps.savedSessions.get('s1');
    assert.match(saved.transcriptText, /A Presence Passes Through/);
    assert.match(saved.transcriptText, /What of silence\?/);
  });

  // #354 item 1: an interjection used to leave no trace in session.rounds at
  // all -- prose appended straight to transcriptText and nothing else. It's
  // a real segment now, with the presence's own words as its first beat.
  await t.test('pushes a real interjection segment onto session.rounds, not just prose (#354)', async () => {
    const app = fakeApp();
    const deps = makeDeps();
    registerConveneRoutes(app, deps);
    deps.savedSessions.set('s1', {
      id: 's1',
      members: ['crowley', 'jung'],
      conversationHistory: [],
      rounds: [{ label: 'First Movement', text: 'r0', endedBy: 'lull' }],
      transcriptText: 'HEADER\n',
      generationMetrics: [],
      disposition: {},
    });
    const res = fakeSSERes();
    await app.routes['POST /api/interject'](fakeReq({ sessionId: 's1', text: 'What of silence?' }), res);
    const saved = deps.savedSessions.get('s1');
    assert.equal(saved.rounds.length, 2);
    const segment = saved.rounds[1];
    assert.equal(segment.kind, record.SEGMENT_KIND_INTERJECTION);
    assert.equal(segment.label, 'A Presence Passes Through');
    assert.equal(segment.endedBy, 'budget');
    assert.equal(segment.beats[0].memberId, record.PRESENCE_SPEAKER_ID);
    assert.equal(segment.beats[0].text, 'What of silence?');
    // The room's own reply beats (from the runRound stub) follow the
    // presence's own turn.
    assert.deepEqual(segment.beats[1], { memberId: 'crowley', text: 'hello world' });
    assert.match(segment.text, /What of silence\?/);
  });

  // #352: reads the meeting-level ledger too, built from session.rounds the
  // same way /api/round builds it.
  await t.test('reads the turn ledger, built from the stored beats, before generating its reply', async () => {
    const app = fakeApp();
    let seen;
    const deps = makeDeps({
      runRound: async args => {
        seen = args.meetingTurns;
        return { fullRoundText: 'text', speakerOrder: [], disposition: {}, residueUpdates: {} };
      },
    });
    registerConveneRoutes(app, deps);
    deps.savedSessions.set('s1', {
      id: 's1',
      members: ['crowley', 'jung'],
      conversationHistory: [],
      rounds: [{ text: 'r0', beats: [{ memberId: 'jung' }, { memberId: 'jung' }] }],
      transcriptText: '',
      generationMetrics: [],
      disposition: {},
    });
    await app.routes['POST /api/interject'](fakeReq({ sessionId: 's1', text: 'hello' }), fakeSSERes());
    assert.deepEqual(seen, { jung: 2 });
  });

  // #352 + #354 together: since #354 landed, an interjection's own turns are
  // no longer invisible to the ledger — they round-trip through the same
  // `session.rounds`/`beats` path a passage's turns always have. This is the
  // scope-note callout in the PR body made concrete: the thing it flagged as
  // a future fix already happened by the time this merged.
  await t.test(
    "a prior interjection's own beats count toward the ledger the next time it's built (#354 round-trip)",
    () => {
      const priorRounds = [
        {
          kind: record.SEGMENT_KIND_INTERJECTION,
          text: 'r0',
          beats: [
            { memberId: record.PRESENCE_SPEAKER_ID, speakerName: record.PRESENCE_SPEAKER_NAME, text: 'a question' },
            { memberId: 'crowley', text: 'an answer' },
          ],
          endedBy: 'budget',
        },
      ];
      // The presence gets a key too — turnsSoFar counts every beat with a
      // memberId, sentinel or roster — but it is inert everywhere downstream:
      // record.PRESENCE_SPEAKER_ID never appears in a director's candidate
      // pool, so neither pickNextSpeaker's under-heard boost nor the
      // director's "TURNS TAKEN TONIGHT" block (which looks up by present
      // members' own roster ids) ever reads that key.
      assert.deepEqual(turnsSoFar(priorRounds), { [record.PRESENCE_SPEAKER_ID]: 1, crowley: 1 });
    }
  );

  await t.test('a runRound failure streams an error event instead of throwing', async () => {
    const app = fakeApp();
    const deps = makeDeps({
      runRound: async () => {
        throw new Error('model unavailable');
      },
    });
    registerConveneRoutes(app, deps);
    deps.savedSessions.set('s1', {
      id: 's1',
      members: ['crowley', 'jung'],
      conversationHistory: [],
      rounds: [],
      transcriptText: 'HEADER\n',
      generationMetrics: [],
      disposition: {},
    });
    const res = fakeSSERes();
    await app.routes['POST /api/interject'](fakeReq({ sessionId: 's1', text: 'What of silence?' }), res);
    assert.equal(res.events()[0].error, 'Failed to interject');
    assert.equal(res.ended, true);
    assert.equal(deps.savedSessions.get('s1').rounds.length, 0, 'the failed interjection is never appended');
  });
});

test('POST /api/prototype/round', async t => {
  await t.test('404s when not local', async () => {
    const app = fakeApp();
    registerConveneRoutes(app, makeDeps({ isLocal: false }));
    const res = fakeJSONRes();
    await app.routes['POST /api/prototype/round'](fakeReq({ entry: 'x', members: ['crowley'] }), res);
    assert.equal(res.statusCode, 404);
  });

  await t.test('400s without entry or members', async () => {
    const app = fakeApp();
    registerConveneRoutes(app, makeDeps());
    const res = fakeJSONRes();
    await app.routes['POST /api/prototype/round'](fakeReq({ entry: '' }), res);
    assert.equal(res.statusCode, 400);
  });

  await t.test('streams the round without ever calling saveSession', async () => {
    const app = fakeApp();
    const deps = makeDeps();
    registerConveneRoutes(app, deps);
    const res = fakeSSERes();
    await app.routes['POST /api/prototype/round'](fakeReq({ entry: 'A test entry', members: ['crowley'] }), res);
    const done = res.events().find(e => e.done);
    assert.equal(done.fullRoundText, 'Crowley —\nhello world');
    assert.equal(deps.savedSessions.size, 0);
  });

  await t.test('a runRound failure streams an error event instead of throwing', async () => {
    const app = fakeApp();
    registerConveneRoutes(
      app,
      makeDeps({
        runRound: async () => {
          throw new Error('model unavailable');
        },
      })
    );
    const res = fakeSSERes();
    await app.routes['POST /api/prototype/round'](fakeReq({ entry: 'A test entry', members: ['crowley'] }), res);
    assert.equal(res.events()[0].error, 'model unavailable');
    assert.equal(res.ended, true);
  });
});
