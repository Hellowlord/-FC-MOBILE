import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocomotion, stepLocomotion, separate, moveToward } from '../src/player/locomotion.js';
import { profileOf, makeAttributes, fatigueEffect } from '../src/player/attributes.js';
import { v3, distanceXZ } from '../src/core/vec3.js';
import { SIM_DT } from '../src/core/fixed-step.js';
import { LOCOMOTION } from '../src/config/tuning.js';
import { wrapPi } from '../src/core/math.js';

const attr = makeAttributes(1, 'Test', 10, 'ST', 0, 75);
const profile = profileOf(attr);
const fresh = fatigueEffect(1);

function run(
  steps: number,
  input: { dirX: number; dirZ: number; sprint: boolean },
  startPos = v3(20, 0, 34),
  heading = 0,
) {
  const s = createLocomotion(startPos, heading);
  for (let i = 0; i < steps; i++) stepLocomotion(s, input, profile, fresh, SIM_DT);
  return s;
}

test('a player accelerates to a realistic top speed', () => {
  // Elite sprint speeds are ~9-10 m/s; an average pro is ~8. The sim must land
  // in that band, not at a video-gamey 20 m/s.
  const s = run(300, { dirX: 1, dirZ: 0, sprint: true });
  assert.ok(s.speed > 6.5, `top speed too low: ${s.speed}`);
  assert.ok(s.speed <= profile.topSpeed + 0.01, `exceeded top speed: ${s.speed}`);
});

test('top speed takes time to reach — there is real acceleration', () => {
  // Reaching 90% of top speed should take roughly 1.5-3 s, not 2 frames.
  const s = createLocomotion(v3(20, 0, 34), 0);
  let ticksTo90 = -1;
  for (let i = 0; i < 600; i++) {
    stepLocomotion(s, { dirX: 1, dirZ: 0, sprint: true }, profile, fresh, SIM_DT);
    if (ticksTo90 < 0 && s.speed >= profile.topSpeed * 0.9) ticksTo90 = i + 1;
  }
  const secs = (ticksTo90 / 60).toFixed(2);
  assert.ok(ticksTo90 > 40, `reached 90% top speed too fast: ${secs} s`);
  assert.ok(ticksTo90 < 200, `took too long to reach 90% top speed: ${secs} s`);
});

test('momentum: you cannot reverse direction instantly', () => {
  // Get up to a sprint going +x, then demand -x. Velocity must NOT flip sign
  // on the first frame — the body has to brake and turn first.
  const s = run(200, { dirX: 1, dirZ: 0, sprint: true });
  const speedBefore = s.speed;
  assert.ok(speedBefore > 6);

  stepLocomotion(s, { dirX: -1, dirZ: 0, sprint: true }, profile, fresh, SIM_DT);
  assert.ok(s.vel.x > 0, `velocity flipped instantly to ${s.vel.x}`);

  // It should take well over half a second to actually be travelling backwards.
  let ticks = 0;
  while (s.vel.x > 0 && ticks < 300) {
    stepLocomotion(s, { dirX: -1, dirZ: 0, sprint: true }, profile, fresh, SIM_DT);
    ticks++;
  }
  assert.ok(ticks > 30, `reversed in only ${ticks} ticks (${(ticks / 60).toFixed(2)} s)`);
});

test('turn rate falls as speed rises', () => {
  // From a standstill you can pivot; at top speed you cannot. Verify by
  // measuring how much heading changes per tick in both cases.
  const slow = createLocomotion(v3(20, 0, 34), 0);
  stepLocomotion(slow, { dirX: 1, dirZ: 0, sprint: false }, profile, fresh, SIM_DT);
  const slowTurn = slow.turnIntensity;

  const fast = run(200, { dirX: 1, dirZ: 0, sprint: true });
  const before = fast.heading;
  stepLocomotion(fast, { dirX: 0, dirZ: 1, sprint: true }, profile, fresh, SIM_DT);
  const fastTurn = Math.abs(wrapPi(fast.heading - before));

  stepLocomotion(slow, { dirX: 0, dirZ: 1, sprint: false }, profile, fresh, SIM_DT);
  const slowDelta = Math.abs(wrapPi(slow.heading - 0));

  assert.ok(slowDelta > fastTurn, `slow turn ${slowDelta} should exceed fast turn ${fastTurn}`);
  void slowTurn;
});

test('a hard turn at speed costs pace', () => {
  // Turning should bleed speed: the velocity vector lags the heading, so the
  // re-derived speed drops. This is what makes dribbling feel weighted.
  const s = run(200, { dirX: 1, dirZ: 0, sprint: true });
  const before = s.speed;
  for (let i = 0; i < 12; i++) stepLocomotion(s, { dirX: 0.2, dirZ: 1, sprint: true }, profile, fresh, SIM_DT);
  assert.ok(s.speed < before, `speed did not drop through a hard turn: ${before} -> ${s.speed}`);
});

test('walking is much slower than sprinting', () => {
  const walking = run(200, { dirX: 1, dirZ: 0, sprint: false });
  const sprinting = run(200, { dirX: 1, dirZ: 0, sprint: true });
  assert.ok(walking.speed < LOCOMOTION.jogSpeed + 0.5, `walk speed too high: ${walking.speed}`);
  assert.ok(sprinting.speed > walking.speed * 1.8, 'sprint should be clearly faster than walk');
});

test('the stick magnitude acts as an analogue throttle', () => {
  const full = run(200, { dirX: 1, dirZ: 0, sprint: true });
  const half = run(200, { dirX: 0.5, dirZ: 0, sprint: true });
  assert.ok(half.speed < full.speed, 'half stick should be slower than full stick');
  assert.ok(half.speed > 0.3 * full.speed, 'half stick should still move meaningfully');
});

test('releasing the stick brakes the player', () => {
  const s = run(200, { dirX: 1, dirZ: 0, sprint: true });
  const before = s.speed;
  for (let i = 0; i < 60; i++) stepLocomotion(s, { dirX: 0, dirZ: 0, sprint: false }, profile, fresh, SIM_DT);
  assert.ok(s.speed < before * 0.35, `player did not brake: ${before} -> ${s.speed}`);
});

test('fatigue reduces top speed', () => {
  const tired = fatigueEffect(0.15);
  const s = createLocomotion(v3(20, 0, 34), 0);
  for (let i = 0; i < 400; i++) {
    stepLocomotion(s, { dirX: 1, dirZ: 0, sprint: true }, profile, tired, SIM_DT);
  }
  const freshRun = run(400, { dirX: 1, dirZ: 0, sprint: true });
  assert.ok(s.speed < freshRun.speed * 0.95, `fatigued player was not slower: ${s.speed} vs ${freshRun.speed}`);
});

test('bodies separate instead of stacking', () => {
  const a = createLocomotion(v3(30, 0, 34), 0);
  const b = createLocomotion(v3(30.1, 0, 34), 0);
  for (let i = 0; i < 10; i++) separate(a, b, 1, 1);
  const d = distanceXZ(a.pos, b.pos);
  assert.ok(d >= a.bodyRadius + b.bodyRadius - 1e-6, `bodies still overlapping at ${d}`);
});

test('moveToward produces a usable input', () => {
  const s = createLocomotion(v3(30, 0, 34), 0);
  const input = moveToward(s, v3(50, 0, 34));
  assert.ok(input.dirX > 0.9, `expected +x direction, got ${input.dirX}`);
  assert.equal(input.sprint, true);
});

test('no input leaves the player still', () => {
  const s = run(120, { dirX: 0, dirZ: 0, sprint: false });
  assert.ok(s.speed < 1e-6, `player drifted to ${s.speed}`);
});
