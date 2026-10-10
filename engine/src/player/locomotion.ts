/**
 * Locomotion — momentum and inertia for a human body.
 *
 * The naive approach (`position += inputDir * speed * dt`) is what makes most
 * amateur football games feel like ice hockey: instant direction changes, no
 * weight. Three things fix that, and all three are here:
 *
 *  1. TURN-RATE LIMIT. A player has a facing (heading) and can only rotate so
 *     fast — about 4 rad/s from a standstill but under 2 rad/s flat out. To go
 *     a new way you must first turn to face it.
 *
 *  2. SPEED IS A SCALAR ALONG HEADING. Acceleration is bounded
 *     (~4-5 m/s^2) and braking is stronger than accelerating (~6.5 m/s^2),
 *     so a sprinter cannot stop on a dime.
 *
 *  3. VELOCITY LAGS HEADING. The velocity vector relaxes towards the heading
 *     at `momentumResponse` instead of snapping to it. Turning at speed
 *     therefore produces a visible outward drift — the "skid" you see when a
 *     winger cuts inside. Because `speed` is re-derived from the lagging
 *     velocity, hard turns also cost you pace, which is correct: a sharp turn
 *     at 9 m/s really does drop you to 6.
 *
 * Top speed is additionally penalised by turn intensity, so committing to a
 * sharp cut trades away acceleration out of it.
 */

import { clamp, lerp, wrapPi, angleDelta, detAtan2, detSqrt } from '../core/math.js';
import { type Vec3, v3, v3FromHeading, lerp3, headingOf, distanceXZ } from '../core/vec3.js';
import { LOCOMOTION } from '../config/tuning.js';
import type { PlayerProfile, FatigueEffect } from './attributes.js';

export interface LocomotionState {
  pos: Vec3;
  vel: Vec3;
  /** Facing, radians. 0 = +x, increasing towards +z. */
  heading: number;
  /** Speed along the heading, always >= 0. */
  speed: number;
  /** 0 (standing) to 1 (flat out). Drives stamina drain and animation. */
  effort: number;
  /** 0..1, how hard this step turned. Drives animation blending + top-speed loss. */
  turnIntensity: number;
  /** Body radius for collisions, ~0.35 m for an adult. */
  bodyRadius: number;
  /** True while the player is executing a move that overrides locomotion. */
  locked: boolean;
  lockTimer: number;
}

export interface LocomotionInput {
  /** Requested planar direction; magnitude 0..1 acts as a throttle. */
  dirX: number;
  dirZ: number;
  sprint: boolean;
}

export function createLocomotion(pos: Vec3, heading = 0): LocomotionState {
  return {
    pos: { ...pos },
    vel: v3(0, 0, 0),
    heading,
    speed: 0,
    effort: 0,
    turnIntensity: 0,
    bodyRadius: 0.35,
    locked: false,
    lockTimer: 0,
  };
}

const NO_INPUT: LocomotionInput = { dirX: 0, dirZ: 0, sprint: false };

/**
 * Advance one fixed step.
 *
 * @param extraAccelMul team-wide or skill-move multiplier on acceleration
 * @param boundsX/boundsZ half-open play area; players may drift slightly out
 */
export function stepLocomotion(
  s: LocomotionState,
  input: LocomotionInput,
  profile: PlayerProfile,
  fatigue: FatigueEffect,
  dt: number,
  extraAccelMul = 1,
): void {
  if (s.locked) {
    s.lockTimer -= dt;
    if (s.lockTimer <= 0) {
      s.locked = false;
      s.lockTimer = 0;
    }
  }

  const throttle = detSqrt(input.dirX * input.dirX + input.dirZ * input.dirZ);
  const wantsMove = throttle > 0.08;

  const topSpeed = profile.topSpeed * fatigue.speedMul;

  // --- 1. facing -----------------------------------------------------------
  let turnIntensity = 0;
  if (wantsMove) {
    const desiredHeading = detAtan2(input.dirZ, input.dirX);
    const speedFrac = clamp(s.speed / Math.max(topSpeed, 1e-6), 0, 1);
    // Turn rate falls as you speed up: you can pivot standing still, not at 9 m/s.
    const turnRate = lerp(profile.turnRateWalk, profile.turnRateSprint, speedFrac);
    const maxTurn = turnRate * dt;
    const delta = angleDelta(s.heading, desiredHeading);
    const turn = clamp(delta, -maxTurn, maxTurn);
    s.heading = wrapPi(s.heading + turn);
    turnIntensity = maxTurn > 1e-9 ? clamp(Math.abs(turn) / maxTurn, 0, 1) : 0;
  } else {
    // No input: keep facing, scrub a little of the turn memory.
    turnIntensity = 0;
  }
  s.turnIntensity = turnIntensity;

  // --- 2. target speed -----------------------------------------------------
  let targetSpeed: number;
  if (!wantsMove || s.locked) {
    targetSpeed = 0;
  } else {
    const effectiveTop = topSpeed * (1 - LOCOMOTION.turnSpeedPenalty * turnIntensity);
    if (input.sprint) {
      // Partial stick still sprints, just not flat out — analogue thumbsticks.
      targetSpeed = effectiveTop * (0.4 + 0.6 * clamp(throttle, 0, 1));
    } else {
      targetSpeed = Math.min(
        lerp(LOCOMOTION.walkSpeed, LOCOMOTION.jogSpeed, clamp(throttle, 0, 1)),
        effectiveTop,
      );
    }
  }

  // --- 3. accelerate / brake ----------------------------------------------
  const diff = targetSpeed - s.speed;
  const maxA =
    (diff > 0 ? profile.accel * fatigue.accelMul * extraAccelMul : LOCOMOTION.decelMax);
  const speedDelta = clamp(diff, -maxA * dt, maxA * dt);
  s.speed = Math.max(0, s.speed + speedDelta);

  // --- 4. turning bleeds pace ---------------------------------------------
  // Cutting hard at 9 m/s really does drop you to 6. This is applied as an
  // explicit loss on the scalar.
  //
  // NOTE: an earlier version instead re-derived `speed` from the lagging
  // velocity below. That is wrong and it was subtle: the lag shrank `speed` on
  // the very next tick, which throttled the acceleration term, which kept
  // `speed` small, so every player converged to ~3.6 m/s and never reached
  // their top speed. `speed` must stay authoritative; the lag is a visual and
  // positional effect only.
  s.speed = Math.max(0, s.speed * (1 - LOCOMOTION.turnBleedPerSecond * turnIntensity * dt));

  // --- 5. velocity lags heading (the inertia feel) -------------------------
  // The body's heading turns before its momentum does, so position drifts
  // wide through a cut. Deliberately NOT fed back into `speed` (see above).
  const desiredVel = v3FromHeading(s.heading, s.speed);
  const k = clamp(LOCOMOTION.momentumResponse * dt, 0, 1);
  s.vel = lerp3(s.vel, desiredVel, k);

  s.pos = v3(s.pos.x + s.vel.x * dt, s.pos.y, s.pos.z + s.vel.z * dt);

  s.effort = clamp(s.speed / Math.max(profile.topSpeed, 1e-6), 0, 1);
}

/** Clamp a player inside a box that extends a little beyond the touchlines. */
export function clampToPitch(s: LocomotionState, minX: number, maxX: number, minZ: number, maxZ: number): void {
  if (s.pos.x < minX) {
    s.pos.x = minX;
    if (s.vel.x < 0) s.vel.x = 0;
  } else if (s.pos.x > maxX) {
    s.pos.x = maxX;
    if (s.vel.x > 0) s.vel.x = 0;
  }
  if (s.pos.z < minZ) {
    s.pos.z = minZ;
    if (s.vel.z < 0) s.vel.z = 0;
  } else if (s.pos.z > maxZ) {
    s.pos.z = maxZ;
    if (s.vel.z > 0) s.vel.z = 0;
  }
}

/** Separate two overlapping bodies, pushing the lighter (lower strength) one more. */
export function separate(a: LocomotionState, b: LocomotionState, aWeight: number, bWeight: number): void {
  const dx = b.pos.x - a.pos.x;
  const dz = b.pos.z - a.pos.z;
  const minDist = a.bodyRadius + b.bodyRadius;
  const d2 = dx * dx + dz * dz;
  if (d2 >= minDist * minDist || d2 < 1e-9) return;

  const d = detSqrt(d2);
  const overlap = minDist - d;
  const nx = dx / d;
  const nz = dz / d;
  const total = aWeight + bWeight;
  const shareA = total > 0 ? bWeight / total : 0.5;
  const shareB = total > 0 ? aWeight / total : 0.5;

  a.pos = v3(a.pos.x - nx * overlap * shareA, a.pos.y, a.pos.z - nz * overlap * shareA);
  b.pos = v3(b.pos.x + nx * overlap * shareB, b.pos.y, b.pos.z + nz * overlap * shareB);
}

export function currentHeading(s: LocomotionState): number {
  const sp = detSqrt(s.vel.x * s.vel.x + s.vel.z * s.vel.z);
  return sp > 0.05 ? headingOf(s.vel) : s.heading;
}

export function moveToward(s: LocomotionState, target: Vec3): LocomotionInput {
  const dx = target.x - s.pos.x;
  const dz = target.z - s.pos.z;
  const d = detSqrt(dx * dx + dz * dz);
  if (d < 0.35) return NO_INPUT;
  return { dirX: dx / d, dirZ: dz / d, sprint: d > 4 };
}

export function distanceTo(s: LocomotionState, p: Vec3): number {
  return distanceXZ(s.pos, p);
}
