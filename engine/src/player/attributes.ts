/**
 * PlayerAttributes — the rating card, and how ratings map onto SI units.
 *
 * Ratings are the familiar 0-99 scale. Crucially, the mapping to real units
 * lives in ONE place: nothing else in the codebase may turn a rating into a
 * speed or an acceleration. That keeps the sim tunable from a spreadsheet and
 * makes it obvious what a 94 pace actually buys you (roughly +1.2 m/s of top
 * speed over a 70).
 */

import { clamp, lerp, invLerp, remap } from '../core/math.js';
import { LOCOMOTION, STAMINA, KICK } from '../config/tuning.js';

export type Position =
  | 'GK'
  | 'LB'
  | 'CB'
  | 'RB'
  | 'LWB'
  | 'RWB'
  | 'CDM'
  | 'CM'
  | 'CAM'
  | 'LM'
  | 'RM'
  | 'LW'
  | 'RW'
  | 'ST';

export interface PlayerAttributes {
  id: number;
  name: string;
  shirtNumber: number;
  position: Position;
  team: number;

  // Physical
  pace: number; // top speed
  acceleration: number; // how fast top speed is reached
  stamina: number; // how slowly fatigue accumulates
  strength: number; // shielding, winning shoulder challenges
  agility: number; // turn rate
  balance: number; // resistance to being knocked off the ball

  // Technical
  ballControl: number; // first touch
  dribbling: number; // close control while moving
  shortPassing: number;
  longPassing: number;
  shotPower: number;
  finishing: number;
  curve: number; // how much spin can be imparted
  freeKicks: number;

  // Mental
  vision: number; // quality of pass selection
  positioning: number; // off-ball intelligence
  reactions: number; // how quickly decisions are made
  aggression: number;
  interceptions: number;
  marking: number;
  tackling: number;
}

export interface PlayerProfile {
  topSpeed: number; // m/s
  accel: number; // m/s^2
  turnRateWalk: number; // rad/s
  turnRateSprint: number; // rad/s
  controlRadius: number; // m
  firstTouchError: number; // m
  passErrorDeg: number; // 1 sd
  shotErrorDeg: number; // 1 sd
  maxSpinRpm: number;
  staminaDrainScale: number;
  reactionTicks: number;
}

function r99(v: number): number {
  return clamp(Math.round(v), 1, 99);
}

/** Turn a rating card into concrete SI numbers, scaled by difficulty bias. */
export function profileOf(attr: PlayerAttributes, speedBias = 1): PlayerProfile {
  const pace01 = invLerp(40, 99, attr.pace);
  const accel01 = invLerp(40, 99, attr.acceleration);
  const agility01 = invLerp(40, 99, attr.agility);
  const control01 = invLerp(40, 99, attr.ballControl);
  const dribble01 = invLerp(40, 99, attr.dribbling);
  const reactions01 = invLerp(40, 99, attr.reactions);

  const controlSkill = (control01 + dribble01) * 0.5;

  return {
    topSpeed: (LOCOMOTION.sprintSpeedBaseline + pace01 * LOCOMOTION.sprintSpeedEliteBonus) * speedBias,
    accel: LOCOMOTION.accelBaseline + accel01 * LOCOMOTION.accelEliteBonus,
    turnRateWalk: LOCOMOTION.turnRateWalk,
    // Agility buys turn rate at speed; pace without agility is a straight-line runner.
    turnRateSprint: lerp(LOCOMOTION.turnRateSprint * 0.75, LOCOMOTION.turnRateSprint * 1.35, agility01),
    controlRadius:
      LOCOMOTION.ballControlRadiusBase + controlSkill * LOCOMOTION.ballControlRadiusPerSkill,
    firstTouchError: lerp(
      LOCOMOTION.firstTouchErrorBase,
      LOCOMOTION.firstTouchErrorElite,
      controlSkill,
    ),
    passErrorDeg: lerp(KICK.passErrorBaseDeg, KICK.passErrorEliteDeg, invLerp(40, 99, attr.shortPassing)),
    shotErrorDeg: lerp(KICK.shotErrorBaseDeg, KICK.shotErrorEliteDeg, invLerp(40, 99, attr.finishing)),
    maxSpinRpm: lerp(KICK.maxSpinRpm * 0.25, KICK.maxSpinRpm, invLerp(40, 99, attr.curve)),
    staminaDrainScale: lerp(1.35, 0.7, invLerp(40, 99, attr.stamina)),
    reactionTicks: Math.max(1, Math.round(lerp(26, 3, reactions01))),
  };
}

export function makeAttributes(
  id: number,
  name: string,
  shirtNumber: number,
  position: Position,
  team: number,
  base = 72,
  seedOffset = 0,
): PlayerAttributes {
  // Deterministic per-player variance derived from id, so a squad is stable
  // across runs without needing a stored RNG.
  const wobble = (n: number, amp: number) =>
    r99(base + amp * (((id * 2654435761 + n * 40503 + seedOffset * 7919) % 1000) / 500 - 1));

  const isDefender = position === 'CB' || position === 'LB' || position === 'RB' || position === 'CDM';
  const isAttacker = position === 'ST' || position === 'LW' || position === 'RW' || position === 'CAM';

  return {
    id,
    name,
    shirtNumber,
    position,
    team,
    pace: wobble(1, 12) + (isAttacker ? 4 : 0),
    acceleration: wobble(2, 12) + (isAttacker ? 3 : 0),
    stamina: wobble(3, 10),
    strength: wobble(4, 10) + (isDefender ? 4 : 0),
    agility: wobble(5, 10),
    balance: wobble(6, 10),
    ballControl: wobble(7, 10) + (isAttacker ? 5 : 0),
    dribbling: wobble(8, 12) + (isAttacker ? 5 : 0),
    shortPassing: wobble(9, 10),
    longPassing: wobble(10, 12) + (position === 'CM' || position === 'CDM' ? 5 : 0),
    shotPower: wobble(11, 12) + (isAttacker ? 5 : 0),
    finishing: wobble(12, 14) + (isAttacker ? 6 : 0),
    curve: wobble(13, 12),
    freeKicks: wobble(14, 14),
    vision: wobble(15, 10) + (position === 'CM' || position === 'CAM' ? 5 : 0),
    positioning: wobble(16, 10) + (isDefender ? 4 : 0),
    reactions: wobble(17, 10),
    aggression: wobble(18, 12) + (isDefender ? 5 : 0),
    interceptions: wobble(19, 10) + (isDefender ? 6 : 0),
    marking: wobble(20, 10) + (isDefender ? 6 : 0),
    tackling: wobble(21, 10) + (isDefender ? 6 : 0),
  };
}

/**
 * Fatigue.
 *
 * Below STAMINA.fatigueOnset nothing changes; below that, top speed and
 * accuracy degrade together, which is how real players actually drop off —
 * they get slower AND sloppier, not just slower.
 */
export interface FatigueEffect {
  speedMul: number;
  accelMul: number;
  errorMul: number;
}

export function fatigueEffect(stamina01: number): FatigueEffect {
  const t = invLerp(0, STAMINA.fatigueOnset, stamina01); // 0 = exhausted, 1 = fresh enough
  const speedMul = lerp(STAMINA.fatigueFloorSpeed, 1, t);
  return {
    speedMul,
    accelMul: lerp(0.6, 1, t),
    errorMul: lerp(STAMINA.fatigueFloorAccuracy, 1, t),
  };
}

/**
 * Stamina drain for a step, given how hard the player is working.
 *
 * `effort` is 0 (standing) to 1 (flat out), supplied by the locomotion model.
 * `drainScale` comes from the player's cached profile (a 99 stamina player
 * burns at ~0.7x, a 40 at ~1.35x) — pass it in rather than recomputing the
 * whole profile 22 times a frame.
 */
export function drainPerStep(effort: number, drainScale: number, dt: number): number {
  const rate = lerp(STAMINA.drainWalk, STAMINA.drainSprint, clamp(effort, 0, 1));
  return rate * drainScale * dt;
}

/** Recover stamina, but only while genuinely resting or walking. */
export function recoverPerStep(effort: number, dt: number): number {
  const ceiling = STAMINA.recoverEffortCeiling;
  if (effort >= ceiling) return 0;
  const rate = lerp(STAMINA.recoverIdle, STAMINA.recoverWalk, effort / ceiling);
  return rate * dt;
}

/** How good a shot this player takes from here — used by the AI. */
export function shotThreat(attr: PlayerAttributes, distanceToGoalM: number, angleOpenness01: number): number {
  const finishing01 = invLerp(40, 99, attr.finishing);
  const distanceFactor = remap(distanceToGoalM, 6, 30, 1, 0);
  return clamp(finishing01 * distanceFactor * (0.35 + 0.65 * angleOpenness01), 0, 1);
}
