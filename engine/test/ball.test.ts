import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBall, stepBall, dragCoefficient, magnusCoefficient, solveLaunchSpeed, ballSpinRpm } from '../src/physics/ball.js';
import { v3, length } from '../src/core/vec3.js';
import { BALL, TURF, AERO } from '../src/config/tuning.js';
import { SIM_DT } from '../src/core/fixed-step.js';
import { detSincos } from '../src/core/math.js';

/** Run the real integrator for n ticks and return the trajectory. */
function fly(initial: { vel: [number, number, number]; spin?: [number, number, number]; y?: number }, steps: number) {
  const ball = createBall(v3(52.5, initial.y ?? BALL.radius, 34));
  ball.vel = v3(initial.vel[0], initial.vel[1], initial.vel[2]);
  if (initial.spin !== undefined) ball.spin = v3(initial.spin[0], initial.spin[1], initial.spin[2]);
  const track: Array<{ x: number; y: number; z: number; v: number }> = [];
  for (let i = 0; i < steps; i++) {
    stepBall(ball, SIM_DT, i);
    track.push({ x: ball.pos.x, y: ball.pos.y, z: ball.pos.z, v: length(ball.vel) });
  }
  return { ball, track };
}

test('drag alone slows an airborne ball by a believable amount', () => {
  // Isolate aerodynamic drag by keeping the ball off the turf: 30 m/s from
  // 2.5 m up, measured over 0.5 s so it never touches down. Expected
  // deceleration at 30 m/s is 0.5*rho*Cd*A*v^2/m, i.e. roughly 7-12 m/s^2
  // depending on where Cd has fallen to.
  const { track } = fly({ vel: [30, 0, 0], y: 2.5 }, 30);
  const start = track[0];
  const end = track[track.length - 1];
  assert.ok(start !== undefined && end !== undefined);
  const lost = start.v - end.v;
  assert.ok(lost > 2.5 && lost < 8, `drag loss over 0.5 s was ${lost.toFixed(2)} m/s, expected ~3.5-6`);
  assert.ok(track.every((t) => t.y > BALL.radius), 'ball touched down during the drag test');
});

test('a ground pass slows from both drag and rolling resistance', () => {
  const { track } = fly({ vel: [30, 0, 0] }, 60);
  const start = track[0];
  const end = track[track.length - 1];
  assert.ok(start !== undefined && end !== undefined);
  const lost = start.v - end.v;
  assert.ok(lost > 8 && lost < 22, `combined loss over 1 s was ${lost.toFixed(2)} m/s`);
});

test('drag coefficient falls through the drag crisis', () => {
  const low = dragCoefficient(5);
  const high = dragCoefficient(35);
  assert.ok(low > high, `Cd should fall with speed, got ${low} -> ${high}`);
  assert.ok(Math.abs(low - AERO.dragCdLow) < 0.02);
  assert.ok(Math.abs(high - AERO.dragCdHigh) < 0.05);
});

test('Magnus coefficient saturates with spin factor', () => {
  assert.equal(magnusCoefficient(0), 0);
  const small = magnusCoefficient(0.05);
  const mid = magnusCoefficient(0.22);
  const big = magnusCoefficient(2.0);
  assert.ok(small < mid && mid < big, 'should increase monotonically');
  assert.ok(big < AERO.magnusMaxCl, 'should saturate below the cap');
});

test('a spinning ball curves sideways, and the sign follows the spin', () => {
  // 900 rpm is a heavily whipped free kick. Over ~1 s it should bend by
  // something you can see (well over half a metre) but not leave the pitch.
  const rpm = 900;
  const rad = (rpm * 2 * Math.PI) / 60;

  const right = fly({ vel: [22, 0, 0], spin: [0, rad, 0], y: 0.6 }, 60);
  const left = fly({ vel: [22, 0, 0], spin: [0, -rad, 0], y: 0.6 }, 60);
  const straight = fly({ vel: [22, 0, 0], spin: [0, 0, 0], y: 0.6 }, 60);

  const driftRight = right.ball.pos.z - straight.ball.pos.z;
  const driftLeft = left.ball.pos.z - straight.ball.pos.z;

  assert.ok(Math.abs(driftRight) > 0.4, `curve too small: ${driftRight}`);
  assert.ok(Math.abs(driftLeft) > 0.4, `curve too small: ${driftLeft}`);
  assert.ok(Math.sign(driftRight) !== Math.sign(driftLeft), 'spin sign did not reverse the curve');
  // Positive spin must bend towards the kicker's right, i.e. -z for a ball
  // travelling along +x (see the derivation in controller.computeStrike).
  assert.ok(driftRight < 0, `positive curve should bend towards -z, got ${driftRight}`);
});

test('no ball ever tunnels through the turf', () => {
  const cases: Array<[number, number]> = [
    [0, 30],
    [10, 25],
    [25, 18],
    [0, 45],
  ];
  for (const [vy, vx] of cases) {
    const { track } = fly({ vel: [vx, vy, 0], y: 1.2 }, 180);
    for (const t of track) {
      assert.ok(t.y >= BALL.radius - 1e-9, `ball sank to y=${t.y} with vy=${vy}`);
    }
  }
});

test('bounce restitution is in the expected band', () => {
  // Drop from 2 m. e = 0.72 means it should rebound to roughly 0.52 of the
  // drop height (e^2), which is the check that the impulse is right.
  const ball = createBall(v3(52.5, 2.0, 34));
  let apex = 0;
  let bounced = false;
  for (let i = 0; i < 240; i++) {
    stepBall(ball, SIM_DT, i);
    if (ball.grounded && !bounced) {
      bounced = true;
      apex = 0;
      continue;
    }
    if (bounced && ball.pos.y > apex) apex = ball.pos.y;
    if (bounced && apex > 0.1 && ball.grounded) break;
  }
  assert.ok(bounced, 'ball never bounced');
  const expected = (2.0 - BALL.radius) * TURF.bounceRestitution * TURF.bounceRestitution;
  assert.ok(
    Math.abs(apex - expected) < 0.12,
    `rebound apex ${apex.toFixed(3)} m, expected about ${expected.toFixed(3)} m`,
  );
});

test('rolling distance is calibrated to a real pitch', () => {
  // The calibration target: a firm 15 m/s ground pass stops after ~35-40 m.
  const { track } = fly({ vel: [15, 0, 0] }, 1200); // 20 s
  const last = track[track.length - 1];
  assert.ok(last !== undefined);
  const dist = last.x - 52.5;
  assert.ok(dist > 28 && dist < 48, `15 m/s pass rolled ${dist.toFixed(1)} m, expected ~35-40`);
});

test('rolling friction also stops a slow ball', () => {
  const { track } = fly({ vel: [3, 0, 0] }, 600);
  const last = track[track.length - 1];
  assert.ok(last !== undefined);
  assert.ok(last.v < 0.05, `slow ball still moving at ${last.v}`);
});

test('a rolling ball settles into true rolling spin', () => {
  // Measured at 1 s, while the ball is still moving: once it stops, spin is
  // bled to zero on purpose.
  const { ball } = fly({ vel: [10, 0, 0] }, 60);
  assert.ok(Math.abs(ball.vel.x) > 1, 'ball stopped too early to test rolling spin');
  // Rolling without slipping about the z axis: omega_z = -v_x / r
  const expected = -ball.vel.x / BALL.radius;
  assert.ok(Math.abs(ball.spin.z - expected) < Math.abs(expected) * 0.25, `spin.z ${ball.spin.z} vs rolling ${expected}`);
});

test('spin decays over time', () => {
  const before = ballSpinRpm(createBall(v3(0, 1, 0)));
  const { ball } = fly({ vel: [20, 0, 0], spin: [0, 60, 0], y: 1.5 }, 300);
  // Vertical-axis spin only decays in flight, so compare the vertical component.
  assert.ok(Math.abs(ball.spin.y) < 60, `vertical spin did not decay: ${ball.spin.y}`);
  assert.equal(before, 0);
});

test('solveLaunchSpeed delivers the requested distance', () => {
  // The solver drives the assisted-pass and AI shot paths. If it is off,
  // "auto power" passes land short or sail over the receiver's head.
  const targets = [8, 15, 25, 35, 45];
  for (const target of targets) {
    for (const angle of [0.1, 0.31, 0.62]) {
      const speed = solveLaunchSpeed(target, angle, BALL.radius, SIM_DT, 4, 34, 14);
      // Measure where the ball FIRST touches down, not where it ends up after
      // rolling on. The solver targets landing distance, so comparing against
      // total travel including the run-out would always fail.
      const landed = firstTouchdownDistance({ vel: [sc(angle) * speed, ss(angle) * speed, 0] });
      const reachable = solveLaunchSpeed(999, angle, BALL.radius, SIM_DT, 4, 34, 1);
      if (speed >= 33.9 && reachable <= 34) continue; // beyond max range: clamped by design
      assert.ok(
        Math.abs(landed - target) < 1.0,
        `angle ${angle}: wanted ${target} m, first touchdown at ${landed.toFixed(2)} m (speed ${speed.toFixed(2)})`,
      );
    }
  }
});

/** Planar distance from launch to the first time the ball meets the turf. */
function firstTouchdownDistance(initial: { vel: [number, number, number] }): number {
  const ball = createBall(v3(52.5, BALL.radius, 34));
  ball.vel = v3(initial.vel[0], initial.vel[1], initial.vel[2]);
  for (let i = 0; i < 600; i++) {
    stepBall(ball, SIM_DT, i);
    // lastBounceTick is stamped on the tick the turf impulse is applied, which
    // is exactly "first touchdown". Testing `vel.y <= 0` instead would wait for
    // the ball to settle, because a real bounce leaves vel.y positive.
    if (ball.lastBounceTick === i) return ball.pos.x - 52.5;
  }
  return ball.pos.x - 52.5;
}

function sc(a: number) {
  return detSincos(a).c;
}
function ss(a: number) {
  return detSincos(a).s;
}
