/**
 * Tuning — every magic number in the simulation lives here, in one plain
 * serialisable object.
 *
 * Two rules:
 *   1. No function calls, no libm. Values that would normally be `exp(...)` are
 *      precomputed literals so the JVM and JS cores agree bit-for-bit.
 *   2. Every constant carries its real-world source or the calibration target
 *      it was fitted to. Balance passes should edit this file (or a JSON
 *      override), never a gameplay source file.
 */

import { PI } from '../core/math.js';

/** FIFA Law 1 / Law 2 dimensions, in metres. */
export const PITCH = {
  length: 105, // FIFA recommended range 100-110; 105 is the international standard
  width: 68, // range 64-75
  goalWidth: 7.32,
  goalHeight: 2.44,
  goalDepth: 2.0,
  penaltyAreaLength: 16.5, // from goal line
  penaltyAreaWidth: 40.32, // 16.5 + 7.32 + 16.5
  goalAreaLength: 5.5,
  goalAreaWidth: 18.32,
  penaltySpotFromGoalLine: 11,
  centreCircleRadius: 9.15,
  cornerArcRadius: 1,
  centreSpotX: 52.5,
  centreSpotZ: 34,
} as const;

/** Law 2: circumference 68-70 cm, mass 410-450 g. */
export const BALL = {
  radius: 0.11, // 69 cm circumference -> ~0.22 m diameter
  mass: 0.43,
  crossSectionArea: PI * 0.11 * 0.11, // 0.038013 m^2 (multiply only, no libm)
} as const;

/**
 * Aerodynamics.
 *
 * Drag: a football sits right at the drag crisis, so Cd falls from ~0.5 (low
 * speed, laminar) to ~0.15 (high speed, turbulent). We model that with a
 * speed-dependent Cd rather than a single constant, otherwise free kicks are
 * wildly over-slowed and goal kicks under-slowed.
 *
 * Magnus: lift coefficient as a function of the spin factor
 * S = r*|omega|/|v|. Empirically (Asai et al., wind-tunnel work on footballs)
 * C_L rises roughly linearly at low S and saturates near 0.2-0.3.
 */
export const AERO = {
  airDensity: 1.205, // kg/m^3, dry air at 20 C, sea level
  dragCdLow: 0.24, // at or below DRAG_CRISIS_SPEED
  dragCdHigh: 0.15, // well above it
  dragCrisisSpeed: 18, // m/s, ~65 km/h
  magnusMaxCl: 0.32,
  magnusHalfSaturationS: 0.22, // spin factor where C_L reaches half its max
  /**
   * Spin bleeds off with time constant tau ~= 4 s.
   * Precomputed: exp(-SIM_DT / 4.0) = exp(-1/240) = 0.995842025.
   * Hard-coded deliberately: calling exp() here would break cross-platform
   * determinism.
   */
  spinDecayPerStep: 0.995842025,
} as const;

/**
 * Turf interaction.
 *
 * Rolling deceleration is calibrated against a real observation rather than a
 * textbook coefficient: a firm ground pass at ~15 m/s travels roughly 35-40 m
 * before stopping. With v^2 = 2*a*d that needs a ~= 2.9 m/s^2, which is why
 * the constant below is higher than the 0.02-0.05 you will find quoted as
 * "rolling resistance of grass" — that quoted number ignores grass-blade
 * deformation, which dominates.
 */
export const TURF = {
  gravity: 9.81,
  rollDecelConst: 1.25, // m/s^2, speed-independent part
  rollDecelPerSpeed: 0.11, // m/s^2 per (m/s), speed-dependent part
  bounceRestitution: 0.72, // vertical coefficient of restitution, turf vs ball
  bounceRestitutionFloor: 0.35, // used once the ball is nearly settled
  settleSpeed: 0.6, // m/s, below this a bounce is treated as settling
  groundFriction: 0.35, // tangential Coulomb friction at impact
  spinFromBounce: 0.35, // how strongly tangential slip converts to spin
} as const;

/** Human locomotion, in SI units, for an outfield player. */
export const LOCOMOTION = {
  walkSpeed: 1.6,
  jogSpeed: 4.0,
  sprintSpeedBaseline: 8.2, // m/s, ~30 km/h: an average professional
  sprintSpeedEliteBonus: 1.6, // added at pace 99 -> ~9.8 m/s, Mbappe-class
  accelBaseline: 3.6, // m/s^2 at a standstill
  accelEliteBonus: 1.6, // added at acceleration 99
  decelMax: 6.5, // m/s^2, braking is harder than accelerating
  turnRateWalk: 4.2, // rad/s when nearly stopped
  turnRateSprint: 1.7, // rad/s at top speed: you cannot pivot flat out
  turnSpeedPenalty: 0.35, // fraction of top speed lost while turning hard
  /** Fractional pace lost per second of sustained hard turning (see stepLocomotion). */
  turnBleedPerSecond: 2.2,
  /** Momentum: velocity relaxes towards the heading at this rate (per second). */
  momentumResponse: 9.0,
  ballControlRadiusBase: 0.45, // m from the body's centre
  ballControlRadiusPerSkill: 0.35, // m added at dribbling 99
  firstTouchErrorBase: 0.55, // m of first-touch scatter at skill 0
  firstTouchErrorElite: 0.06, // m at skill 99
  knockOnBurst: 1.9, // extra m/s when playing the ball into space
  feintDefenderFreeze: 0.35, // s the nearest defender is frozen for
} as const;

/** Kick speeds. Pro shots top out around 30-35 m/s (~120 km/h). */
export const KICK = {
  shortPassSpeedMin: 5.5,
  shortPassSpeedMax: 14.0,
  longPassSpeedMin: 14.0,
  longPassSpeedMax: 25.0,
  shotSpeedMin: 16.0,
  shotSpeedMax: 33.0,
  launchAngleDrive: 0.16, // rad, ~9 degrees: a driven shot
  launchAngleNormal: 0.31, // rad, ~18 degrees
  launchAngleChip: 0.62, // rad, ~36 degrees
  maxSpinRpm: 900, // a heavily whipped free kick
  /**
   * Accuracy model. A kick's angular error scales with (1 - technique) and with
   * fatigue, and grows for high power: a 100% power shot is never a 100%
   * accurate shot. These are standard deviations in degrees.
   */
  passErrorBaseDeg: 4.5,
  passErrorEliteDeg: 0.7,
  shotErrorBaseDeg: 6.5,
  shotErrorEliteDeg: 1.1,
  errorPowerMultiplier: 1.6, // extra error at full power
  errorFatigueMultiplier: 2.2, // extra error when exhausted
  /** Bisection budget for the launch-speed solver. 10 is enough for <1 cm. */
  solverIterations: 14,
} as const;

/** Stamina. A midfielder covers ~10-12 km per match, with ~1 km sprinting. */
export const STAMINA = {
  // Calibrated so a player at a realistic mix of efforts (roughly 45% of the
  // match spent above a jog) goes from fresh to ~0.3 over 90 minutes. The
  // previous values were ~15x too hot AND recovery was almost exactly the same
  // size as the drain, so stamina sat pinned at 1.0 for the whole match.
  drainWalk: 0.00004, // per second
  drainJog: 0.00015,
  drainSprint: 0.0006,
  /** Recovery is an order of magnitude smaller than drain, or it cancels out. */
  recoverIdle: 0.00025,
  recoverWalk: 0.00008,
  /** Effort above which no recovery happens at all. */
  recoverEffortCeiling: 0.25,
  /** Below this fraction, top speed and accuracy degrade. */
  fatigueOnset: 0.45,
  fatigueFloorSpeed: 0.72, // worst-case speed multiplier when empty
  fatigueFloorAccuracy: 1.9, // error multiplier when empty
} as const;

export const MATCH = {
  halfLengthSec: 45 * 60,
  kickoffResetDelay: 1.5,
  goalCelebrationSec: 4.0,
  /** Ball is "loose" for this long after a keeper save before anyone may grab it. */
  looseBallGrace: 0.1,
} as const;

/**
 * AI difficulty. Everything the CPU is allowed to be good at is expressed here
 * so a designer can add a tier without touching decision code.
 */
export interface DifficultyProfile {
  name: string;
  /** Milliseconds of reaction lag before the AI responds to a change. */
  reactionMs: number;
  /** Standard deviation (degrees) added to every pass/shoot angle. */
  aimErrorDeg: number;
  /** Standard deviation (m) added to every run target. */
  positionalErrorM: number;
  /** How often the AI re-evaluates, in sim ticks. */
  decisionEveryNTicks: number;
  /** 0..1 willingness to commit to a tackle. */
  aggression: number;
  /** 0..1 quality of off-ball movement. */
  offBallQuality: number;
  /** 0..1 how tightly the defensive line holds its shape. */
  shapeDiscipline: number;
  /** Multiplier on the CPU team's effective top speed. */
  speedBias: number;
}

export const DIFFICULTY = {
  beginner: {
    name: 'Beginner',
    reactionMs: 420,
    aimErrorDeg: 7.0,
    positionalErrorM: 3.2,
    decisionEveryNTicks: 14,
    aggression: 0.25,
    offBallQuality: 0.25,
    shapeDiscipline: 0.3,
    speedBias: 0.9,
  },
  amateur: {
    name: 'Amateur',
    reactionMs: 300,
    aimErrorDeg: 4.5,
    positionalErrorM: 2.2,
    decisionEveryNTicks: 10,
    aggression: 0.45,
    offBallQuality: 0.45,
    shapeDiscipline: 0.5,
    speedBias: 0.96,
  },
  pro: {
    name: 'Professional',
    reactionMs: 190,
    aimErrorDeg: 2.6,
    positionalErrorM: 1.4,
    decisionEveryNTicks: 7,
    aggression: 0.65,
    offBallQuality: 0.7,
    shapeDiscipline: 0.72,
    speedBias: 1.0,
  },
  worldClass: {
    name: 'World Class',
    reactionMs: 120,
    aimErrorDeg: 1.4,
    positionalErrorM: 0.8,
    decisionEveryNTicks: 5,
    aggression: 0.8,
    offBallQuality: 0.88,
    shapeDiscipline: 0.88,
    speedBias: 1.03,
  },
  legend: {
    name: 'Legend',
    reactionMs: 75,
    aimErrorDeg: 0.7,
    positionalErrorM: 0.45,
    decisionEveryNTicks: 4,
    aggression: 0.92,
    offBallQuality: 0.97,
    shapeDiscipline: 0.96,
    speedBias: 1.06,
  },
} satisfies Record<string, DifficultyProfile>;

/** Freeze the whole table so a stray write during a match fails loudly in dev. */
export function currentTuning(): typeof PITCH {
  return PITCH;
}
