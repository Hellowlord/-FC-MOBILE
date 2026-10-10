package com.fcmobile.core

/**
 * Every magic number in the simulation, mirrored from
 * engine/src/config/tuning.ts.
 *
 * RULES
 *  1. No function calls, no libm. Values that would normally be exp(...) are
 *     precomputed literals, so the JVM and JS cores agree bit-for-bit.
 *  2. Every constant carries its real-world source or the calibration target it
 *     was fitted to. Balance passes edit this file, never gameplay logic.
 *
 * If you change a value here, change it in the TS core too and regenerate
 * vectors/golden-*.json.
 */

/** FIFA Law 1 / Law 2 dimensions, metres. */
object Pitch {
    const val LENGTH = 105.0        // international standard; legal range 100-110
    const val WIDTH = 68.0          // legal range 64-75
    const val GOAL_WIDTH = 7.32
    const val GOAL_HEIGHT = 2.44
    const val GOAL_DEPTH = 2.0
    const val PENALTY_AREA_LENGTH = 16.5
    const val PENALTY_AREA_WIDTH = 40.32
    const val GOAL_AREA_LENGTH = 5.5
    const val GOAL_AREA_WIDTH = 18.32
    const val PENALTY_SPOT = 11.0
    const val CENTRE_CIRCLE_RADIUS = 9.15
    const val CENTRE_X = 52.5
    const val CENTRE_Z = 34.0
}

/** Law 2: circumference 68-70 cm, mass 410-450 g. */
object Ball {
    const val RADIUS = 0.11
    const val MASS = 0.43
    val CROSS_SECTION_AREA: Double = DeterministicMath.PI * RADIUS * RADIUS
}

/**
 * Aerodynamics.
 *
 * A football sits at the drag crisis: Cd falls from ~0.24 (laminar) to ~0.15
 * (turbulent) somewhere around 18 m/s. A single constant makes low balls float
 * too long and high balls die too fast.
 *
 * Magnus lift rises with the spin factor S = r*|omega|/|v| and saturates.
 */
object Aero {
    const val AIR_DENSITY = 1.205       // kg/m^3, dry air at 20 C, sea level
    const val DRAG_CD_LOW = 0.24
    const val DRAG_CD_HIGH = 0.15
    const val DRAG_CRISIS_SPEED = 18.0
    const val MAGNUS_MAX_CL = 0.32
    const val MAGNUS_HALF_SATURATION_S = 0.22

    /**
     * Spin bleeds off with time constant tau ~= 4 s.
     * Precomputed exp(-1/240). Hard-coded deliberately: calling exp() would
     * break cross-platform determinism.
     */
    const val SPIN_DECAY_PER_STEP = 0.995842025
}

/**
 * Turf interaction.
 *
 * Rolling deceleration is calibrated against an observation, not a textbook
 * coefficient: a firm 15 m/s ground pass stops after ~35-40 m. With
 * v^2 = 2*a*d that needs a ~= 2.9 m/s^2, which is why these numbers are higher
 * than the 0.02-0.05 usually quoted for grass — that figure ignores grass-blade
 * deformation, which dominates.
 */
object Turf {
    const val GRAVITY = 9.81
    const val ROLL_DECEL_CONST = 1.25
    const val ROLL_DECEL_PER_SPEED = 0.11
    const val BOUNCE_RESTITUTION = 0.72
    const val BOUNCE_RESTITUTION_FLOOR = 0.35
    const val SETTLE_SPEED = 0.6
    const val GROUND_FRICTION = 0.35
    const val SPIN_FROM_BOUNCE = 0.35
}

/** Human locomotion in SI units. */
object Loco {
    const val WALK_SPEED = 1.6
    const val JOG_SPEED = 4.0
    const val SPRINT_SPEED_BASELINE = 8.2       // ~30 km/h, an average professional
    const val SPRINT_SPEED_ELITE_BONUS = 1.6    // +1.6 at pace 99 -> ~9.8 m/s
    const val ACCEL_BASELINE = 3.6
    const ACCEL_ELITE_BONUS = 1.6
    const val DECEL_MAX = 6.5                   // braking beats accelerating
    const val TURN_RATE_WALK = 4.2
    const val TURN_RATE_SPRINT = 1.7
    const val TURN_SPEED_PENALTY = 0.35
    /** Fractional pace lost per second of sustained hard turning. */
    const val TURN_BLEED_PER_SECOND = 2.2
    const val MOMENTUM_RESPONSE = 9.0
    const val CONTROL_RADIUS_BASE = 0.45
    const val CONTROL_RADIUS_PER_SKILL = 0.35
    const val FIRST_TOUCH_ERROR_BASE = 0.55
    const val FIRST_TOUCH_ERROR_ELITE = 0.06
    const val KNOCK_ON_BURST = 1.9
    const val FEINT_DEFENDER_FREEZE = 0.35
}

/** Kick speeds. Professional shots top out around 30-35 m/s (~120 km/h). */
object Kick {
    const val SHORT_PASS_MIN = 5.5
    const val SHORT_PASS_MAX = 14.0
    const val LONG_PASS_MIN = 14.0
    const val LONG_PASS_MAX = 25.0
    const val SHOT_MIN = 16.0
    const val SHOT_MAX = 33.0
    const val ANGLE_DRIVE = 0.16        // ~9 degrees
    const val ANGLE_NORMAL = 0.31       // ~18 degrees
    const val ANGLE_CHIP = 0.62         // ~36 degrees
    const val MAX_SPIN_RPM = 900.0
    const val PASS_ERROR_BASE_DEG = 4.5
    const val PASS_ERROR_ELITE_DEG = 0.7
    const val SHOT_ERROR_BASE_DEG = 6.5
    const val SHOT_ERROR_ELITE_DEG = 1.1
    const val ERROR_POWER_MULTIPLIER = 1.6
    const val ERROR_FATIGUE_MULTIPLIER = 2.2
    /** Bisection budget for the launch-speed solver; 14 gives sub-centimetre. */
    const val SOLVER_ITERATIONS = 14
}

object Stamina {
    // Calibrated so a realistic mix of efforts takes a player from fresh to
    // ~0.3 over 90 minutes. Recovery is an order of magnitude smaller than
    // drain, or it cancels the drain out and nobody ever tires.
    const val DRAIN_WALK = 0.00004
    const val DRAIN_JOG = 0.00015
    const val DRAIN_SPRINT = 0.0006
    const val RECOVER_IDLE = 0.00025
    const val RECOVER_WALK = 0.00008
    const val RECOVER_EFFORT_CEILING = 0.25
    const val FATIGUE_ONSET = 0.45
    const val FATIGUE_FLOOR_SPEED = 0.72
    const val FATIGUE_FLOOR_ACCURACY = 1.9
}

object MatchTiming {
    const val HALF_LENGTH_SEC = 45 * 60.0
    const val KICKOFF_RESET_DELAY = 1.5
    const val GOAL_CELEBRATION_SEC = 4.0
}

/** Fixed simulation rate. The spine of the whole game loop. */
const val SIM_HZ = 60
const val SIM_DT: Double = 1.0 / SIM_HZ

/**
 * AI difficulty, expressed as human-like error rather than stat inflation.
 * A Legend opponent plays the same football as a Beginner one, just faster and
 * cleaner — which is what actually happens between divisions, and which keeps
 * multiplayer fair because the CPU never gets a physical edge the human lacks.
 */
data class Difficulty(
    val name: String,
    val reactionMs: Int,
    val aimErrorDeg: Double,
    val positionalErrorM: Double,
    val decisionEveryNTicks: Int,
    val aggression: Double,
    val offBallQuality: Double,
    val shapeDiscipline: Double,
    val speedBias: Double,
)

val DIFFICULTY_PRO = Difficulty(
    name = "Professional",
    reactionMs = 190,
    aimErrorDeg = 2.6,
    positionalErrorM = 1.4,
    decisionEveryNTicks = 7,
    aggression = 0.65,
    offBallQuality = 0.7,
    shapeDiscipline = 0.72,
    speedBias = 1.0,
)

val DIFFICULTY_LEGEND = Difficulty(
    name = "Legend",
    reactionMs = 75,
    aimErrorDeg = 0.7,
    positionalErrorM = 0.45,
    decisionEveryNTicks = 4,
    aggression = 0.92,
    offBallQuality = 0.97,
    shapeDiscipline = 0.96,
    speedBias = 1.06,
)
