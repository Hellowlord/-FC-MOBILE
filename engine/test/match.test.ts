import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine, type MatchConfig } from '../src/match/engine.js';
import { DIFFICULTY } from '../src/config/tuning.js';
import { PITCH } from '../src/config/tuning.js';

function makeConfig(seed: number, halfLengthSec = 90): MatchConfig {
  return {
    seed,
    halfLengthSec,
    home: {
      name: 'Home',
      shortName: 'HOM',
      formationId: '4-3-3',
      rating: 78,
      difficulty: DIFFICULTY.pro,
      human: true,
      primaryColour: '#e03131',
      secondaryColour: '#ffffff',
    },
    away: {
      name: 'Away',
      shortName: 'AWY',
      formationId: '4-4-2',
      rating: 78,
      difficulty: DIFFICULTY.pro,
      human: false,
      primaryColour: '#1971c2',
      secondaryColour: '#ffffff',
    },
  };
}

test('both teams field eleven players', () => {
  const m = new MatchEngine(makeConfig(1));
  assert.equal(m.players.length, 22);
  assert.equal(m.players.filter((p) => p.attr.team === 0).length, 11);
  assert.equal(m.players.filter((p) => p.attr.team === 1).length, 11);
  assert.equal(m.players.filter((p) => p.role === 1).length, 2);
});

test('a full match runs without producing NaN', () => {
  const m = new MatchEngine(makeConfig(7, 60));
  for (let i = 0; i < 60 * 60 * 2 + 300; i++) m.step();

  const bad = (n: number, where: string) => {
    if (!Number.isFinite(n)) assert.fail(`non-finite ${where}: ${n}`);
  };
  bad(m.ball.pos.x, 'ball.x');
  bad(m.ball.pos.y, 'ball.y');
  bad(m.ball.pos.z, 'ball.z');
  bad(m.ball.vel.x, 'ball.vel.x');
  for (const p of m.players) {
    bad(p.loco.pos.x, `player ${p.attr.id} x`);
    bad(p.loco.pos.z, `player ${p.attr.id} z`);
    bad(p.loco.speed, `player ${p.attr.id} speed`);
    bad(p.stamina, `player ${p.attr.id} stamina`);
    assert.ok(p.stamina >= 0 && p.stamina <= 1, `stamina out of range: ${p.stamina}`);
  }
});

test('nobody wanders off the pitch', () => {
  const m = new MatchEngine(makeConfig(11, 60));
  for (let i = 0; i < 60 * 90; i++) {
    m.step();
    for (const p of m.players) {
      assert.ok(p.loco.pos.x > -4 && p.loco.pos.x < PITCH.length + 4, `x out of bounds ${p.loco.pos.x}`);
      assert.ok(p.loco.pos.z > -4 && p.loco.pos.z < PITCH.width + 4, `z out of bounds ${p.loco.pos.z}`);
    }
  }
});

test('the simulation is deterministic for a given seed', () => {
  // This is the property everything else depends on: replays, rollback
  // netcode and the Kotlin parity vectors all assume it.
  const a = new MatchEngine(makeConfig(12345, 45));
  const b = new MatchEngine(makeConfig(12345, 45));

  for (let i = 0; i < 60 * 60; i++) {
    a.step();
    b.step();
  }

  assert.deepEqual(a.score, b.score, 'scores diverged');
  assert.equal(a.ball.pos.x, b.ball.pos.x, 'ball x diverged');
  assert.equal(a.ball.pos.z, b.ball.pos.z, 'ball z diverged');
  assert.equal(a.ball.spin.y, b.ball.spin.y, 'spin diverged');
  for (let i = 0; i < a.players.length; i++) {
    const pa = a.players[i];
    const pb = b.players[i];
    assert.ok(pa !== undefined && pb !== undefined);
    assert.equal(pa.loco.pos.x, pb.loco.pos.x, `player ${pa.attr.id} x diverged`);
    assert.equal(pa.loco.pos.z, pb.loco.pos.z, `player ${pa.attr.id} z diverged`);
    assert.equal(pa.stamina, pb.stamina, `player ${pa.attr.id} stamina diverged`);
  }
});

test('a different seed produces a different match', () => {
  const a = new MatchEngine(makeConfig(1, 45));
  const b = new MatchEngine(makeConfig(2, 45));
  for (let i = 0; i < 60 * 45; i++) {
    a.step();
    b.step();
  }
  const drifted = Math.abs(a.ball.pos.x - b.ball.pos.x) + Math.abs(a.ball.pos.z - b.ball.pos.z);
  assert.ok(drifted > 0.5, `different seeds produced near-identical matches (drift ${drifted})`);
});

test('stamina drains during play', () => {
  const m = new MatchEngine(makeConfig(3, 30));
  const before = m.players.map((p) => p.stamina);
  for (let i = 0; i < 60 * 60 * 4; i++) m.step();
  const avgBefore = before.reduce((a, b) => a + b, 0) / before.length;
  const avgAfter = m.players.reduce((a, p) => a + p.stamina, 0) / m.players.length;
  assert.ok(avgAfter < avgBefore, `stamina did not drop: ${avgBefore} -> ${avgAfter}`);
});

test('the ball moves and players chase it', () => {
  // If the AI is dead, the ball sits at the centre spot forever.
  const m = new MatchEngine(makeConfig(5, 30));
  let maxDist = 0;
  for (let i = 0; i < 60 * 40; i++) {
    m.step();
    const d = Math.abs(m.ball.pos.x - PITCH.centreSpotX) + Math.abs(m.ball.pos.z - PITCH.centreSpotZ);
    if (d > maxDist) maxDist = d;
  }
  assert.ok(maxDist > 10, `ball never left the centre area (max ${maxDist})`);
});

test('a ball struck into the goal is detected as a goal', () => {
  // Deterministic, rather than "did any goal happen in N random matches", which
  // is too noisy to be a useful assertion at short match lengths.
  const m = new MatchEngine(makeConfig(21, 120));
  // Let the kickoff resolve so the restart state machine is out of the way.
  for (let i = 0; i < 200; i++) m.step();
  assert.equal(m.restart, 0, 'restart did not reach open play');

  // Clear EVERYONE out of the lane. Moving only the defenders was not enough:
  // a home player standing nearby trapped the ball on the first tick and
  // dribbled it back to midfield, so no goal could ever be scored. This test is
  // about goal detection, not about who wins the ball.
  for (const p of m.players) {
    p.loco.pos = { x: 30, y: 0, z: 5 };
    p.hasBall = false;
    p.loco.vel = { x: 0, y: 0, z: 0 };
    p.loco.speed = 0;
  }
  m.controlledId = -1;

  const before = (m.score[0] ?? 0) + (m.score[1] ?? 0);
  m.ball.pos = { x: PITCH.length - 6, y: 0.11, z: PITCH.centreSpotZ };
  m.ball.vel = { x: 24, y: 0, z: 0 };
  m.ball.spin = { x: 0, y: 0, z: 0 };
  m.ball.lastTouchTeam = 0;
  m.ball.lastTouchId = 9;

  let scored = 0;
  for (let i = 0; i < 200; i++) {
    m.step();
    scored = (m.score[0] ?? 0) + (m.score[1] ?? 0) - before;
    if (scored > 0) break;
  }
  assert.equal(scored, 1, `expected exactly one goal, got ${scored}`);
  assert.ok(
    m.drainEvents().some((e) => e.kind === 'goal'),
    'no goal event was emitted',
  );
});

test('shots, passes and restarts are all exercised by a real match', () => {
  // Smoke test that the whole pipeline runs: possession changes, passes are
  // struck, the ball goes out of play, and somebody shoots.
  let shots = 0;
  let passes = 0;
  let restarts = 0;
  for (let seed = 100; seed < 103; seed++) {
    const m = new MatchEngine(makeConfig(seed, 900));
    for (let i = 0; i < 60 * 900 * 2 + 600; i++) m.step();
    shots += (m.stats.shots[0] ?? 0) + (m.stats.shots[1] ?? 0);
    passes += (m.stats.passes[0] ?? 0) + (m.stats.passes[1] ?? 0);
    restarts += m.drainEvents().filter((e) => e.kind === 'throwin' || e.kind === 'corner').length;
  }
  assert.ok(shots > 0, 'no shots were ever taken');
  assert.ok(passes > 20, `implausibly few passes: ${passes}`);
  assert.ok(restarts > 0, 'the ball never went out of play');
});

test('events are emitted for the presentation layer', () => {
  const m = new MatchEngine(makeConfig(9, 60));
  for (let i = 0; i < 60 * 60; i++) m.step();
  const events = m.drainEvents();
  assert.ok(events.length > 0, 'no events emitted');
  assert.ok(events.every((e) => typeof e.kind === 'string' && Number.isFinite(e.tick)));
});

test('player switching keeps control on the human team', () => {
  const m = new MatchEngine(makeConfig(4, 30));
  for (let i = 0; i < 60 * 20; i++) {
    m.step();
    m.autoSwitch();
    const c = m.controlledPlayer;
    assert.ok(c !== null, 'control lost');
    assert.equal(c.attr.team, 0, 'control moved to the CPU team');
  }
});

test('a snapshot is complete enough to render from', () => {
  const m = new MatchEngine(makeConfig(6, 30));
  for (let i = 0; i < 600; i++) m.step();
  const s = m.snapshot(0.5);
  assert.equal(s.players.length, 22);
  assert.equal(s.score.length, 2);
  assert.ok(Number.isFinite(s.ball.x));
  for (const p of s.players) {
    assert.ok(Number.isFinite(p.pos.x) && Number.isFinite(p.pos.z));
    assert.ok(Number.isFinite(p.heading));
  }
});
