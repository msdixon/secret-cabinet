'use strict';

// #141 first cut — a lightweight evaluation harness for conversation
// *quality*, scoped down (per the 2026-08-20 /cabinet-review comment on the
// issue) to what's actually decidable without settling what good dialogue
// is: turn distribution. "Is everyone in the room actually in the room" is
// a Principle 2 (Voice) question, not a taste one.
//
// Three pieces, matching the issue's scope exactly — nothing beyond it:
//
//   1. Turn distribution per meeting, from real sessions on disk —
//      turnsSoFar's own ledger (lodge-prompts.js, #352) reduced over
//      session.rounds[].beats (#244), against session.members (who was
//      actually seated) so a seated member with zero turns is visible
//      rather than absent.
//   2. Beats per passage, and why the passage ended — session.rounds[].beats
//      and .endedBy (#244) are already persisted; this just counts them.
//   3. A replayable simulation of the real pickNextSpeaker/isPoolExhausted
//      (pipeline-speaker.js) against the real tuning.js constants, with a
//      seeded RNG — the same harness shape #352 and #353 built inline in
//      test/pipeline.test.js to catch two real scheduling bugs, generalized
//      into something re-runnable after a tuning.js edit instead of only
//      living as a pinned regression assertion.
//
// Deliberately not attempted here (per the issue's own "later rungs" list):
// register drift, citation density, repetition across sessions.
//
// Same ad hoc script style as scripts/rollup-metrics.js and
// scripts/build-citation-manifest.js (no test framework/scripts runner
// exists in this repo) — read-only, no new persistence. Run with:
//   node scripts/eval-harness.js
const fs = require('fs');
const path = require('path');
const { loadSessions } = require('./build-citation-manifest');
const record = require('../public/js/record.js');
const { turnsSoFar } = require('../src/lodge-prompts');
const { pickNextSpeaker, isPoolExhausted } = require('../src/pipeline-speaker');
const {
  BREATH_BUDGET_WORDS,
  MIN_WORDS_FOR_ANOTHER_BEAT,
  MAX_TOTAL_BEATS,
  RECONSULT_BUDGET_FRACTION,
  WORDS_PER_BEAT_ESTIMATE,
  POOL_SLACK,
  DEFAULT_POOL_SIZE,
} = require('../src/tuning');

const ROOT = path.join(__dirname, '..');
const OUTPUT_FILE = path.join(ROOT, 'EVAL-HARNESS-REPORT.md');
const ROSTER_FILE = path.join(ROOT, 'prompts', 'members', 'roster.json');

// Best-effort id -> display name, for the report only — every computation
// below works on ids alone. A missing or malformed roster.json degrades to
// showing raw ids, same "never let a report-formatting concern fail the
// underlying measurement" pattern as pipeline.js's own loadX try/catches.
function loadRosterNames() {
  try {
    const roster = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));
    return new Map(roster.map(m => [m.id, m.name]));
  } catch {
    return new Map();
  }
}

// ─── 1. Turn distribution per meeting (real sessions) ──────────────────────

// `session.members` is presentMemberIds — who was actually seated, the same
// source public/js/metrics.js's #361 fix reads to seed a zero row for a
// member no metric ever mentions. Without it, a member with zero turns is
// simply absent from turnsSoFar's ledger rather than visibly zero.
function turnDistributionForSession(session) {
  const presentIds = Array.isArray(session.members) ? session.members : [];
  const ledger = turnsSoFar(session.rounds || []);
  const zeroTurnIds = presentIds.filter(id => !ledger[id]);
  return { presentIds, ledger, zeroTurnIds };
}

// Aggregates across every session with a seated roster and at least one
// round — a session with neither contributes nothing but is still counted
// in sessionsScanned, same "scanned but doesn't contribute" convention
// rollup-metrics.js's rollup() uses for a session with no generationMetrics.
function aggregateTurnDistribution(sessions) {
  let meetingsScanned = 0;
  let seatsScanned = 0;
  let seatsWithZeroTurns = 0;
  const perMember = new Map(); // memberId -> { seatedMeetings, turns, zeroTurnMeetings }

  sessions.forEach(session => {
    const presentIds = Array.isArray(session.members) ? session.members : [];
    if (!presentIds.length || !Array.isArray(session.rounds) || !session.rounds.length) return;
    meetingsScanned++;
    const { ledger, zeroTurnIds } = turnDistributionForSession(session);
    seatsScanned += presentIds.length;
    seatsWithZeroTurns += zeroTurnIds.length;
    presentIds.forEach(id => {
      if (!perMember.has(id)) perMember.set(id, { seatedMeetings: 0, turns: 0, zeroTurnMeetings: 0 });
      const row = perMember.get(id);
      row.seatedMeetings++;
      row.turns += ledger[id] || 0;
      if (!ledger[id]) row.zeroTurnMeetings++;
    });
  });

  return {
    meetingsScanned,
    seatsScanned,
    seatsWithZeroTurns,
    zeroTurnShare: seatsScanned ? seatsWithZeroTurns / seatsScanned : 0,
    perMember: [...perMember.entries()]
      .map(([memberId, row]) => ({
        memberId,
        ...row,
        avgTurns: row.turns / row.seatedMeetings,
        zeroTurnShare: row.zeroTurnMeetings / row.seatedMeetings,
      }))
      .sort((a, b) => b.zeroTurnShare - a.zeroTurnShare || a.avgTurns - b.avgTurns),
  };
}

// ─── 2. Beats per passage, and why it ended (real sessions) ────────────────

// An interjection (#354) carries `beats`/`endedBy` too, but it's a
// different sort of segment, not a passage — see convene.js's own comment
// on why `kind` marks it rather than a fourth endedBy value. Counted
// separately here rather than folded in, so its always-`budget` endedBy
// (the presence never winds down) doesn't skew the passage-ending
// breakdown. `beats: null` marks a pre-#244 segment that predates the field
// entirely — excluded from the beats-per-passage average rather than
// silently counted as zero.
function passageStatsForSession(session) {
  return (session.rounds || []).map((segment, index) => ({
    index,
    kind: record.isInterjectionSegment(segment) ? 'interjection' : 'passage',
    beats: Array.isArray(segment.beats) ? segment.beats.length : null,
    endedBy: segment.endedBy || null,
  }));
}

function aggregatePassageStats(sessions) {
  const passages = [];
  sessions.forEach(session => {
    passageStatsForSession(session).forEach(p => {
      if (p.kind === 'passage' && p.beats != null) passages.push(p);
    });
  });

  const endedByCounts = {};
  let totalBeats = 0;
  passages.forEach(p => {
    const key = p.endedBy || 'unknown';
    endedByCounts[key] = (endedByCounts[key] || 0) + 1;
    totalBeats += p.beats;
  });

  return {
    passagesScanned: passages.length,
    avgBeatsPerPassage: passages.length ? totalBeats / passages.length : 0,
    endedByCounts,
    endedByShare: Object.fromEntries(
      Object.entries(endedByCounts).map(([k, v]) => [k, passages.length ? v / passages.length : 0])
    ),
  };
}

// ─── 3. Replayable pickNextSpeaker simulation (seeded, no API calls) ───────

// Same small LCG #352/#353's inline test harnesses use — deterministic
// across runs so a before/after tuning.js comparison isn't a flake
// generator, and portable enough to paste into a one-off REPL check.
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Real beat lengths vary around a mean, not always land on it — #353's own
// simulation is what established this matters: a fixed per-beat word cost
// can never produce the spread that decides whether a budget-based
// reconsult trigger is ever crossed. Same Irwin-Hall-ish spread, roughly
// [0.3x, 1.7x] of the mean, as that test used.
function beatWords(rng, mean = WORDS_PER_BEAT_ESTIMATE) {
  const u = (rng() + rng() + rng()) / 3;
  return Math.max(30, Math.round(mean * (0.3 + u * 1.4)));
}

// Simulates one passage's local beat-picking loop — everything runRound
// (pipeline.js) does *between* director consults — against the real
// pickNextSpeaker/isPoolExhausted and the real tuning.js budget/reconsult
// arithmetic. The director's own re-consult (selectSpeakers) is an API call
// and is not simulated: `rankPool(seatIds, count)` stands in for it,
// defaulting to "same priority order, resized to the new target count" —
// the same worst-case simplification #352's and #353's own harnesses
// documented (a real director re-ranking would only help; this measures the
// floor). Pass a different `rankPool` to explore how sensitive the result
// is to the director's ranking behavior itself.
//
// `endedBy` is deliberately not part of the return value: 'lull' is the
// director's own judgment call (also an API call, also not simulated), so
// the only end-cause this loop can actually produce is budget exhaustion.
// `reconsulted` — whether the mid-passage trigger fired at all — is the
// simulation's analogue of item 2's endedBy breakdown instead.
function simulatePassage({ seatIds, meetingTurns, rng, rankPool = (ids, count) => ids.slice(0, count) }) {
  const budgetCapacity = Math.max(1, Math.ceil(BREATH_BUDGET_WORDS / WORDS_PER_BEAT_ESTIMATE));
  let pool = rankPool(seatIds, Math.min(seatIds.length, budgetCapacity + POOL_SLACK));
  let spokenCounts = new Map();
  let lastSpeakerId = null;
  let remainingBudget = BREATH_BUDGET_WORDS;
  let budgetAtLastConsult = remainingBudget;
  let beats = 0;
  let reconsults = 0;
  const beatsList = [];

  while (remainingBudget >= MIN_WORDS_FOR_ANOTHER_BEAT && beats < MAX_TOTAL_BEATS) {
    const budgetSpentSinceConsult = budgetAtLastConsult - remainingBudget;
    if (
      isPoolExhausted(pool, spokenCounts) ||
      budgetSpentSinceConsult >= BREATH_BUDGET_WORDS * RECONSULT_BUDGET_FRACTION
    ) {
      reconsults++;
      const nextCount = Math.max(1, Math.min(seatIds.length, Math.ceil(remainingBudget / WORDS_PER_BEAT_ESTIMATE)));
      pool = rankPool(seatIds, Math.min(seatIds.length, nextCount + POOL_SLACK));
      spokenCounts = new Map();
      budgetAtLastConsult = remainingBudget;
      if (!pool.length) break;
    }

    const memberId = pickNextSpeaker({ pool, spokenCounts, lastSpeakerId, remainingBudget, meetingTurns, rng });
    if (!memberId) break;

    beatsList.push({ memberId, text: 'a turn' }); // the shape turnsSoFar reduces over
    if (meetingTurns) meetingTurns[memberId] = (meetingTurns[memberId] || 0) + 1;
    spokenCounts.set(memberId, (spokenCounts.get(memberId) || 0) + 1);
    lastSpeakerId = memberId;
    beats++;
    remainingBudget -= beatWords(rng);
  }

  return { beats: beatsList, reconsulted: reconsults > 0 };
}

// Runs a whole meeting's worth of passages, threading the meeting-level
// turnsSoFar ledger across passage boundaries exactly as convene.js does
// (`meetingTurns: turnsSoFar(session.rounds)`, recomputed from the growing
// record each passage) — then repeats for `meetings` independent meetings
// and aggregates, same shape as #352's pipeline.test.js harness. Defaults
// (DEFAULT_POOL_SIZE + POOL_SLACK seats, 5 passages) describe a typical
// convene; override to explore other shapes.
function simulateMeetings({
  seatCount = DEFAULT_POOL_SIZE + POOL_SLACK,
  passagesPerMeeting = 5,
  meetings = 2000,
  seed = 20260825,
  rankPool,
} = {}) {
  const rng = seededRng(seed);
  const seatIds = Array.from({ length: seatCount }, (_, i) => `seat-${i}`);
  const perSeat = seatIds.map(() => ({ turns: 0, zeroTurnMeetings: 0 }));
  let seatsWithZeroTurns = 0;
  let totalBeats = 0;
  let totalPassages = 0;
  let reconsultedPassages = 0;

  for (let m = 0; m < meetings; m++) {
    const rounds = [];
    let meetingTurns = {};
    for (let p = 0; p < passagesPerMeeting; p++) {
      const result = simulatePassage({ seatIds, meetingTurns, rng, rankPool });
      rounds.push({ beats: result.beats });
      totalBeats += result.beats.length;
      totalPassages++;
      if (result.reconsulted) reconsultedPassages++;
      meetingTurns = turnsSoFar(rounds); // rebuilt from the record, same as convene.js does each passage
    }
    const ledger = turnsSoFar(rounds);
    seatIds.forEach((id, i) => {
      perSeat[i].turns += ledger[id] || 0;
      if (!ledger[id]) {
        perSeat[i].zeroTurnMeetings++;
        seatsWithZeroTurns++;
      }
    });
  }

  return {
    meetings,
    seatsScanned: seatIds.length * meetings,
    seatsWithZeroTurns,
    zeroTurnShare: seatsWithZeroTurns / (seatIds.length * meetings),
    perSeat: perSeat.map((row, rank) => ({
      seatId: seatIds[rank],
      rank,
      avgTurns: row.turns / meetings,
      zeroTurnShare: row.zeroTurnMeetings / meetings,
    })),
    avgBeatsPerPassage: totalBeats / totalPassages,
    reconsultRate: reconsultedPassages / totalPassages,
  };
}

// ─── Report rendering ───────────────────────────────────────────────────────

function pct(n) {
  return (n * 100).toFixed(1) + '%';
}

function num(n) {
  return Number.isFinite(n) ? n.toFixed(2) : '—';
}

function buildReport({ sessions, turnData, passageData, simData, rosterNames }) {
  const lines = [
    '# Evaluation Harness Report',
    '',
    `[#141](https://github.com/msdixon/secret-cabinet/issues/141) first cut — turn distribution, not taste. Generated from ${sessions.length} session(s) on disk (${turnData.meetingsScanned} with a seated roster and at least one passage), plus a seeded simulation that spends no API calls.`,
    '',
    '## 1. Turn distribution per meeting (real sessions)',
    '',
  ];

  if (!turnData.meetingsScanned) {
    lines.push('_No sessions with both a seated roster and recorded passages were found — nothing to report._', '');
  } else {
    lines.push(
      `Across ${turnData.meetingsScanned} meeting(s), ${turnData.seatsWithZeroTurns} of ${turnData.seatsScanned} seated-member-meetings (${pct(turnData.zeroTurnShare)}) got zero turns.`,
      '',
      '| Member | Seated meetings | Avg turns/meeting | Zero-turn meetings | Zero-turn share |',
      '|---|---|---|---|---|',
      ...turnData.perMember.map(
        r =>
          `| ${rosterNames.get(r.memberId) || r.memberId} | ${r.seatedMeetings} | ${num(r.avgTurns)} | ${r.zeroTurnMeetings} | ${pct(r.zeroTurnShare)} |`
      ),
      ''
    );
  }

  lines.push('## 2. Beats per passage, and why it ended (real sessions)', '');
  if (!passageData.passagesScanned) {
    lines.push('_No passages with a recorded `beats` field were found (predates #244, or no sessions on disk)._', '');
  } else {
    lines.push(
      `${passageData.passagesScanned} passage(s) scanned, averaging ${num(passageData.avgBeatsPerPassage)} beats each.`,
      '',
      '| Ended by | Passages | Share |',
      '|---|---|---|',
      ...Object.entries(passageData.endedByCounts)
        .sort(([, a], [, b]) => b - a)
        .map(([k, v]) => `| ${k} | ${v} | ${pct(passageData.endedByShare[k])} |`),
      ''
    );
  }

  lines.push(
    '## 3. Replayable pickNextSpeaker simulation (seeded, no API calls)',
    '',
    `${simData.meetings.toLocaleString('en-US')} simulated meetings, ${simData.perSeat.length}-seat pool, 5 passages/meeting, seed 20260825 — real \`pickNextSpeaker\`/\`isPoolExhausted\` and the current \`tuning.js\` constants, director re-consult approximated by re-ranking the same seat order (see the function comment for why).`,
    '',
    `Zero-turn share: ${pct(simData.zeroTurnShare)}. Avg beats/passage: ${num(simData.avgBeatsPerPassage)}. Mid-passage re-consult fired in ${pct(simData.reconsultRate)} of passages.`,
    '',
    '| Seat (priority rank) | Avg turns/meeting | Zero-turn share |',
    '|---|---|---|',
    ...simData.perSeat.map(r => `| ${r.rank} | ${num(r.avgTurns)} | ${pct(r.zeroTurnShare)} |`),
    '',
    '---',
    '',
    "_Re-run after editing tuning.js (`node scripts/eval-harness.js`) to see a scheduling/tuning change's effect on this table without spending real API calls. `simulateMeetings`/`simulatePassage` are also exported for use from a one-off script or a test — see test/eval-harness.test.js._"
  );

  return lines.join('\n');
}

module.exports = {
  turnDistributionForSession,
  aggregateTurnDistribution,
  passageStatsForSession,
  aggregatePassageStats,
  seededRng,
  beatWords,
  simulatePassage,
  simulateMeetings,
  buildReport,
};

if (require.main === module) {
  const sessionsDir = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || ROOT, 'sessions');
  const sessions = loadSessions(sessionsDir);
  const turnData = aggregateTurnDistribution(sessions);
  const passageData = aggregatePassageStats(sessions);
  const simData = simulateMeetings();
  const rosterNames = loadRosterNames();
  const report = buildReport({ sessions, turnData, passageData, simData, rosterNames });
  fs.writeFileSync(OUTPUT_FILE, report, 'utf8');
  console.log(`Wrote ${OUTPUT_FILE} (${sessions.length} sessions scanned, from ${sessionsDir}).`);
}
