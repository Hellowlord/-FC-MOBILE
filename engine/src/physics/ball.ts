/**
 * BallPhysics — the flight model.
 *
 * Forces, in order of magnitude at match speeds:
 *   gravity   m*g                        ~4.2 N        always
 *   drag      0.5*rho*Cd*A*|v|^2         ~5.2 N @30m/s opposes motion
 *   Magnus    0.5*rho*Cl*A*|v|^2         ~3.6 N @30m/s perpendicular, spin-driven
 *
 * The ball's mass is 0.43 kg, so those are accelerations of ~10, ~12 and
 * ~8 m/s^2 — all the same order as gravity. That is exactly why you cannot
 * fake a football with a simple gravity-only arc: a struck ball decelerates
 * hard and bends noticeably, and players feel the difference immediately.
 *
 * Integration is semi-implicit (symplectic) Euler at a fixed 1/60 s step:
 * forces -> acceleration -> velocity -> position, in that order. It is stable
 * at this step size, cheap, and — importantly — trivially portable.
 */

import { detSqrt, detSincos, clamp, lerp, invLerp, PI } from '../core/math.js';
import { type Vec3, v3, add, scale, cross, length, lengthSq } from '../core/vec3.js';
import { AERO, BALL, TURF } from '../config/tuning.js';

export interface BallState {
  pos: Vec3;
  vel: Vec3;
  /** Angular velocity, rad/s, right-hand rule. */
  spin: Vec3;
  /** True while the ball is in contact with the turf. */
  grounded: boolean;
  /** Set on the tick the ball last struck the turf; drives bounce VFX/SFX. */
  lastBounceTick: number;
  /** Speed at last impact, for bounce SFX intensity. */
  lastImpactSpeed: number;
  /** Last player to touch it, for offside / own-goal attribution. */
  lastTouchId: number;
  lastTouchTeam: number;
}

export function createBall(pos: Vec3): BallState {
  return {
    pos: { ...pos },
    vel: v3(0, 0, 0),
    spin: v3(0, 0, 0),
    grounded: pos.y <= BALL.radius + 1e-4,
    lastBounceTick: -1000,
    lastImpactSpeed: 0,
    lastTouchId: -1,
    lastTouchTeam: -1,
  };
}

/**
 * Speed-dependent drag coefficient.
 *
 * A football passes through the drag crisis around 18 m/s: the boundary layer
 * goes turbulent, the wake narrows and Cd drops sharply. Using a single
 * constant makes low balls float too long and high balls die too fast.
 */
export function dragCoefficient(speed: number): number {
  const t = invLerp(AERO.dragCrisisSpeed * 0.55, AERO.dragCrisisSpeed * 1.5, speed);
  return lerp(AERO.dragCdLow, AERO.dragCdHigh, t);
}

/**
 * Magnus lift coefficient from the spin factor S = r*|omega|/|v|.
 * Saturating curve: matches wind-tunnel data on footballs.
 */
export function magnusCoefficient(spinFactor: number): number {
  if (spinFactor <= 0) return 0;
  return AERO.magnusMaxCl * (spinFactor / (spinFactor + AERO.magnusHalfSaturationS));
}

/** Total acceleration acting on the ball, excluding contact forces. */
export function ballAcceleration(ball: BallState): Vec3 {
  const v = ball.vel;
  const speed = length(v);
  const invMass = 1 / BALL.mass;
  const qA = 0.5 * AERO.airDensity * BALL.crossSectionArea;

  let ax = 0;
  let ay = -TURF.gravity;
  let az = 0;

  if (speed > 1e-6) {
    // Drag: 0.5*rho*Cd*A*|v|^2 along -v_hat  ==  0.5*rho*Cd*A*|v| * (-v)
    const cd = dragCoefficient(speed);
    const dragK = qA * cd * speed * invMass;
    ax -= v.x * dragK;
    ay -= v.y * dragK;
    az -= v.z * dragK;

    // Magnus: 0.5*rho*Cl*A*|v|^2 along normalize(omega x v)
    const omegaMag = length(ball.spin);
    if (omegaMag > 1e-4) {
      const spinFactor = (BALL.radius * omegaMag) / speed;
      const cl = magnusCoefficient(spinFactor);
      if (cl > 0) {
        const axis = cross(ball.spin, v);
        const axisLen = length(axis);
        if (axisLen > 1e-6) {
          const k = (qA * cl * speed * speed * invMass) / axisLen;
          ax += axis.x * k;
          ay += axis.y * k;
          az += axis.z * k;
        }
      }
    }
  }

  return v3(ax, ay, az);
}

/**
 * Advance the ball one fixed step.
 *
 * @param tick current simulation tick, used to timestamp bounces
 * @returns true if the ball struck the turf on this step
 */
export function stepBall(ball: BallState, dt: number, tick: number): boolean {
  const a = ballAcceleration(ball);

  // Semi-implicit Euler: velocity first, then position with the NEW velocity.
  ball.vel = v3(ball.vel.x + a.x * dt, ball.vel.y + a.y * dt, ball.vel.z + a.z * dt);
  ball.pos = add(ball.pos, scale(ball.vel, dt));

  // Spin bleeds away; see AERO.spinDecayPerStep for why this is a literal.
  ball.spin = scale(ball.spin, AERO.spinDecayPerStep);

  const bounced = resolveGround(ball, tick);
  if (ball.grounded) applyRollingResistance(ball, dt);

  return bounced;
}

/** Turf collision: restitution, Coulomb friction and slip -> spin conversion. */
function resolveGround(ball: BallState, tick: number): boolean {
  if (ball.pos.y > BALL.radius) {
    ball.grounded = false;
    return false;
  }

  ball.pos.y = BALL.radius;
  ball.grounded = true;

  const impact = -ball.vel.y;
  if (impact <= 0) {
    // Resting or skimming: kill any residual sink, do not bounce.
    if (ball.vel.y < 0) ball.vel.y = 0;
    return false;
  }

  const settling = impact < TURF.settleSpeed;
  const e = settling ? TURF.bounceRestitutionFloor : TURF.bounceRestitution;
  ball.lastBounceTick = tick;
  ball.lastImpactSpeed = impact;

  if (settling) {
    ball.vel.y = 0;
    // IMPORTANT: no friction impulse here. A resting or skimming ball is not
    // bouncing, so there is no normal impulse to scale a friction impulse
    // against. Applying one anyway (an earlier version did) charged the ball
    // for friction 60 times a second and cut roll distance roughly in half.
    // Ground deceleration while resting is handled by applyRollingResistance.
    // Return false: this is not a bounce. Returning true here emitted a bounce
    // event 60 times a second (~320,000 per match) and would have spammed the
    // SFX layer identically.
    return false;
  }

  ball.vel.y = impact * e;

  // Tangential friction, limited by the normal impulse: |Jt| <= mu * |Jn|.
  // Dividing both by mass turns that into a velocity budget.
  const tangent = v3(ball.vel.x, 0, ball.vel.z);
  const tangentSpeed = length(tangent);
  if (tangentSpeed > 1e-6) {
    const budget = TURF.groundFriction * (1 + e) * impact;
    const reduction = Math.min(tangentSpeed, budget);
    const k = (tangentSpeed - reduction) / tangentSpeed;
    ball.vel.x *= k;
    ball.vel.z *= k;

    // Surface slip drives spin towards rolling. Slip speed at the contact
    // point is v_t + (omega x r_contact)_t; we relax spin towards the
    // no-slip value rather than snapping, which reproduces the visible
    // "skid then grip" of a driven pass on wet grass.
    const noSlipSpinZ = -ball.vel.x / BALL.radius;
    const noSlipSpinX = ball.vel.z / BALL.radius;
    const blend = TURF.spinFromBounce;
    ball.spin = v3(
      lerp(ball.spin.x, noSlipSpinX, blend),
      ball.spin.y,
      lerp(ball.spin.z, noSlipSpinZ, blend),
    );
  }

  return true;
}

/**
 * Rolling resistance on grass.
 *
 * Calibrated so a firm 15 m/s ground pass stops after ~35-40 m, which is what
 * you see on a well-watered professional pitch. See TURF for the derivation.
 *
 * Also relaxes the ball's spin towards true rolling, so a knuckling strike
 * visibly stops bending once it drops and runs.
 */
function applyRollingResistance(ball: BallState, dt: number): void {
  const speed = detSqrt(ball.vel.x * ball.vel.x + ball.vel.z * ball.vel.z);
  if (speed < 1e-4) {
    ball.vel.x = 0;
    ball.vel.z = 0;
    // A stationary ball cannot keep spinning on grass: bleed the residual spin
    // out instead of leaving it frozen (which also stopped the curve term from
    // ever reaching zero for a ball that had been knocked still).
    const settleSpin = clamp(6.0 * dt, 0, 1);
    ball.spin = scale(ball.spin, 1 - settleSpin);
    return;
  }

  const decel = TURF.rollDecelConst + TURF.rollDecelPerSpeed * speed;
  const next = Math.max(0, speed - decel * dt);
  const k = next / speed;
  ball.vel.x *= k;
  ball.vel.z *= k;

  // Relax towards rolling-without-slipping.
  const rollZ = -ball.vel.x / BALL.radius;
  const rollX = ball.vel.z / BALL.radius;
  const relax = clamp(4.0 * dt, 0, 1);
  ball.spin = v3(
    lerp(ball.spin.x, rollX, relax),
    ball.spin.y * (1 - relax * 0.5), // vertical (curve) spin is not sustained on the ground
    lerp(ball.spin.z, rollZ, relax),
  );
}

/**
 * Predict where a struck ball lands.
 *
 * Used by the kick solver to find the speed that carries a pass or shot to its
 * target given a launch angle. It runs the SAME integrator as the live
 * simulation, so a pass can never be "solved" to a speed the physics would
 * then fail to deliver — a classic bug when games use a closed-form vacuum
 * arc for aiming and a drag model for flight.
 *
 * @returns planar distance travelled when the ball next returns to turf height.
 */
export function predictFlightDistance(
  launchSpeed: number,
  launchAngleRad: number,
  dirXZ: { x: number; z: number },
  startHeight: number,
  dt: number,
  maxSteps = 300,
): number {
  const sc = detSincos(launchAngleRad);
  const c = sc.c;
  const s = sc.s;
  const probe = createBall(v3(0, Math.max(startHeight, BALL.radius), 0));
  probe.vel = v3(dirXZ.x * c * launchSpeed, s * launchSpeed, dirXZ.z * c * launchSpeed);

  const startX = probe.pos.x;
  const startZ = probe.pos.z;

  for (let i = 0; i < maxSteps; i++) {
    const a = ballAcceleration(probe);
    probe.vel = v3(probe.vel.x + a.x * dt, probe.vel.y + a.y * dt, probe.vel.z + a.z * dt);
    probe.pos = add(probe.pos, scale(probe.vel, dt));
    probe.spin = scale(probe.spin, AERO.spinDecayPerStep);

    if (probe.pos.y <= BALL.radius && probe.vel.y < 0 && i > 1) {
      const dx = probe.pos.x - startX;
      const dz = probe.pos.z - startZ;
      return detSqrt(dx * dx + dz * dz);
    }
  }
  const dx = probe.pos.x - startX;
  const dz = probe.pos.z - startZ;
  return detSqrt(dx * dx + dz * dz);
}

/**
 * Bisection solve for the launch speed that reaches `targetDistance` at the
 * given launch angle. Distance is monotonically increasing in launch speed, so
 * bisection converges fast; KICK.solverIterations gives sub-centimetre error.
 */
export function solveLaunchSpeed(
  targetDistance: number,
  launchAngleRad: number,
  startHeight: number,
  dt: number,
  minSpeed: number,
  maxSpeed: number,
  iterations: number,
): number {
  const dir = { x: 1, z: 0 }; // unit direction; distance is rotation-invariant

  // Clamp the bracket so we never chase an unreachable target.
  if (predictFlightDistance(maxSpeed, launchAngleRad, dir, startHeight, dt) < targetDistance) {
    return maxSpeed;
  }
  if (predictFlightDistance(minSpeed, launchAngleRad, dir, startHeight, dt) > targetDistance) {
    return minSpeed;
  }

  let lo = minSpeed;
  let hi = maxSpeed;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) * 0.5;
    const d = predictFlightDistance(mid, launchAngleRad, dir, startHeight, dt);
    if (d < targetDistance) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/**
 * Predict the ball's height after it has travelled `targetDistance` in the
 * pitch plane.
 *
 * Runs the same integrator as the live simulation and `predictFlightDistance`,
 * so a shot cannot be aimed with one model and flown with another.
 *
 * @returns height in metres, or -1 if the ball hits the turf first.
 */
export function predictHeightAtDistance(
  launchSpeed: number,
  launchAngleRad: number,
  dirXZ: { x: number; z: number },
  startHeight: number,
  dt: number,
  targetDistance: number,
  maxSteps = 300,
): number {
  const sc = detSincos(launchAngleRad);
  const probe = createBall(v3(0, Math.max(startHeight, BALL.radius), 0));
  probe.vel = v3(dirXZ.x * sc.c * launchSpeed, sc.s * launchSpeed, dirXZ.z * sc.c * launchSpeed);

  for (let i = 0; i < maxSteps; i++) {
    const a = ballAcceleration(probe);
    probe.vel = v3(probe.vel.x + a.x * dt, probe.vel.y + a.y * dt, probe.vel.z + a.z * dt);
    probe.pos = add(probe.pos, scale(probe.vel, dt));
    probe.spin = scale(probe.spin, AERO.spinDecayPerStep);

    const travelled = detSqrt(probe.pos.x * probe.pos.x + probe.pos.z * probe.pos.z);
    if (travelled >= targetDistance) return probe.pos.y;
    if (probe.pos.y <= BALL.radius && probe.vel.y < 0 && i > 1) return -1;
  }
  return probe.pos.y;
}

/**
 * Bisection solve for the launch angle that arrives at `targetHeight` after
 * `targetDistance`.
 *
 * Shots used to take a single fixed angle per kick kind. That is wrong by
 * construction: an 18 degree strike from 12 m arrives at roughly 3.5 m, over a
 * 2.44 m bar, while the same angle from 25 m is a perfectly good shot. Measured
 * over 8 matches, 65% of shots that reached the goal plane went over the bar at
 * a median distance of 12.2 m. Height at a fixed distance rises monotonically
 * with launch angle, so bisection converges from both ends.
 */
export function solveLaunchAngle(
  targetDistance: number,
  targetHeight: number,
  launchSpeed: number,
  startHeight: number,
  dt: number,
  minAngle: number,
  maxAngle: number,
  iterations: number,
): number {
  const dir = { x: 1, z: 0 }; // unit direction; the problem is rotation-invariant

  const heightAt = (angle: number) =>
    predictHeightAtDistance(launchSpeed, angle, dir, startHeight, dt, targetDistance);

  // A flat strike that still arrives above the target: nothing to solve.
  if (heightAt(minAngle) >= targetHeight) return minAngle;
  // Even the steepest allowed angle cannot lift it there (usually too far, or
  // the ball grounds out first): take the steepest and let it drop.
  if (heightAt(maxAngle) <= targetHeight) return maxAngle;

  let lo = minAngle;
  let hi = maxAngle;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) * 0.5;
    if (heightAt(mid) < targetHeight) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/** Convenience: kinetic energy, for impact VFX and keeper-catch decisions. */
export function ballKineticEnergy(ball: BallState): number {
  return 0.5 * BALL.mass * lengthSq(ball.vel);
}

/** Convenience: horizontal speed only. */
export function ballSpeedXZ(ball: BallState): number {
  return detSqrt(ball.vel.x * ball.vel.x + ball.vel.z * ball.vel.z);
}

/** Spin in revolutions per minute, the unit commentators use. */
export function ballSpinRpm(ball: BallState): number {
  return (length(ball.spin) * 60) / (2 * PI);
}

