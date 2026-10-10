package com.fcmobile.player

import com.fcmobile.core.DeterministicMath.angleDelta
import com.fcmobile.core.DeterministicMath.atan2
import com.fcmobile.core.DeterministicMath.clamp
import com.fcmobile.core.DeterministicMath.lerp
import com.fcmobile.core.DeterministicMath.sqrt
import com.fcmobile.core.DeterministicMath.wrapPi
import com.fcmobile.core.Loco
import com.fcmobile.core.V3_ZERO
import com.fcmobile.core.Vec3
import com.fcmobile.core.dot
import com.fcmobile.core.distanceXZ
import com.fcmobile.core.v3FromHeading

/**
 * Locomotion — momentum and inertia for a human body, mirrored from
 * engine/src/player/locomotion.ts.
 *
 * The naive approach (`position += inputDir * speed * dt`) is what makes
 * amateur football games feel like ice hockey. Three things fix it:
 *
 *  1. TURN-RATE LIMIT. A player has a facing and can only rotate so fast —
 *     ~4 rad/s standing still, under 2 rad/s flat out.
 *  2. SPEED IS A SCALAR ALONG THE HEADING. Acceleration is bounded (~4-5 m/s^2)
 *     and braking is stronger (~6.5 m/s^2).
 *  3. VELOCITY LAGS HEADING. Turning at speed produces a visible outward drift.
 *
 * IMPORTANT — a bug that already happened once in the TypeScript core and must
 * not be reintroduced here: `speed` must stay authoritative. An early version
 * re-derived `speed` from the lagging velocity each tick; the lag shrank it,
 * which throttled the acceleration term, which kept it small, so every player
 * converged to ~3.6 m/s and never reached top speed. The lag below is a visual
 * and positional effect ONLY.
 */

/** Everything derived from a player's rating card, in SI units. */
data class PlayerProfile(
    val topSpeed: Double,          // m/s
    val accel: Double,             // m/s^2
    val turnRateWalk: Double,      // rad/s
    val turnRateSprint: Double,    // rad/s
    val controlRadius: Double,     // m
    val firstTouchError: Double,   // m
    val passErrorDeg: Double,      // 1 sd
    val shotErrorDeg: Double,      // 1 sd
    val maxSpinRpm: Double,
    val staminaDrainScale: Double,
)

/** Effect of fatigue on this player, 1.0 = fresh. */
data class Fatigue(val speedMul: Double, val accelMul: Double, val errorMul: Double)

class LocomotionState(pos: Vec3, var heading: Double = 0.0) {
    var pos: Vec3 = pos
    var vel: Vec3 = V3_ZERO
    /** Speed along the heading, always >= 0. */
    var speed: Double = 0.0
    /** 0 (standing) to 1 (flat out). Drives stamina drain and animation. */
    var effort: Double = 0.0
    /** 0..1, how hard this step turned. Drives animation and top-speed loss. */
    var turnIntensity: Double = 0.0
    var bodyRadius: Double = 0.35
    var locked: Boolean = false
    var lockTimer: Double = 0.0
}

data class LocomotionInput(val dirX: Double, val dirZ: Double, val sprint: Boolean)

val NO_INPUT = LocomotionInput(0.0, 0.0, false)

fun stepLocomotion(
    s: LocomotionState,
    input: LocomotionInput,
    profile: PlayerProfile,
    fatigue: Fatigue,
    dt: Double,
    extraAccelMul: Double = 1.0,
) {
    if (s.locked) {
        s.lockTimer -= dt
        if (s.lockTimer <= 0.0) {
            s.locked = false
            s.lockTimer = 0.0
        }
    }

    val throttle = sqrt(input.dirX * input.dirX + input.dirZ * input.dirZ)
    val wantsMove = throttle > 0.08
    val topSpeed = profile.topSpeed * fatigue.speedMul

    // --- 1. facing -------------------------------------------------------
    var turnIntensity = 0.0
    if (wantsMove) {
        val desiredHeading = atan2(input.dirZ, input.dirX)
        val speedFrac = clamp(s.speed / maxOf(topSpeed, 1e-6), 0.0, 1.0)
        // Turn rate falls as you speed up: you can pivot standing still.
        val turnRate = lerp(profile.turnRateWalk, profile.turnRateSprint, speedFrac)
        val maxTurn = turnRate * dt
        val delta = angleDelta(s.heading, desiredHeading)
        val turn = clamp(delta, -maxTurn, maxTurn)
        s.heading = wrapPi(s.heading + turn)
        turnIntensity = if (maxTurn > 1e-9) clamp(kotlin.math.abs(turn) / maxTurn, 0.0, 1.0) else 0.0
    }
    s.turnIntensity = turnIntensity

    // --- 2. target speed -------------------------------------------------
    val targetSpeed: Double = when {
        !wantsMove || s.locked -> 0.0
        else -> {
            val effectiveTop = topSpeed * (1.0 - Loco.TURN_SPEED_PENALTY * turnIntensity)
            if (input.sprint) {
                // Partial stick still sprints, just not flat out: analogue sticks.
                effectiveTop * (0.4 + 0.6 * clamp(throttle, 0.0, 1.0))
            } else {
                minOf(
                    lerp(Loco.WALK_SPEED, Loco.JOG_SPEED, clamp(throttle, 0.0, 1.0)),
                    effectiveTop,
                )
            }
        }
    }

    // --- 3. accelerate / brake -------------------------------------------
    val diff = targetSpeed - s.speed
    val maxA = if (diff > 0) profile.accel * fatigue.accelMul * extraAccelMul else Loco.DECEL_MAX
    s.speed = maxOf(0.0, s.speed + clamp(diff, -maxA * dt, maxA * dt))

    // --- 4. turning bleeds pace ------------------------------------------
    s.speed = maxOf(0.0, s.speed * (1.0 - Loco.TURN_BLEED_PER_SECOND * turnIntensity * dt))

    // --- 5. velocity lags heading (the inertia feel) ---------------------
    val desiredVel = v3FromHeading(s.heading, s.speed)
    val k = clamp(Loco.MOMENTUM_RESPONSE * dt, 0.0, 1.0)
    s.vel = Vec3(
        s.vel.x + (desiredVel.x - s.vel.x) * k,
        s.vel.y + (desiredVel.y - s.vel.y) * k,
        s.vel.z + (desiredVel.z - s.vel.z) * k,
    )

    s.pos = Vec3(s.pos.x + s.vel.x * dt, s.pos.y, s.pos.z + s.vel.z * dt)
    s.effort = clamp(s.speed / maxOf(profile.topSpeed, 1e-6), 0.0, 1.0)
}

/** Keep a player inside a box extending slightly beyond the touchlines. */
fun clampToPitch(s: LocomotionState, minX: Double, maxX: Double, minZ: Double, maxZ: Double) {
    var x = s.pos.x
    var z = s.pos.z
    var vx = s.vel.x
    var vz = s.vel.z
    if (x < minX) { x = minX; if (vx < 0) vx = 0.0 } else if (x > maxX) { x = maxX; if (vx > 0) vx = 0.0 }
    if (z < minZ) { z = minZ; if (vz < 0) vz = 0.0 } else if (z > maxZ) { z = maxZ; if (vz > 0) vz = 0.0 }
    s.pos = Vec3(x, s.pos.y, z)
    s.vel = Vec3(vx, s.vel.y, vz)
}

/** Separate two overlapping bodies; the stronger one moves less. */
fun separate(a: LocomotionState, b: LocomotionState, aWeight: Double, bWeight: Double) {
    val dx = b.pos.x - a.pos.x
    val dz = b.pos.z - a.pos.z
    val minDist = a.bodyRadius + b.bodyRadius
    val d2 = dx * dx + dz * dz
    if (d2 >= minDist * minDist || d2 < 1e-9) return

    val d = sqrt(d2)
    val overlap = minDist - d
    val nx = dx / d
    val nz = dz / d
    val total = aWeight + bWeight
    val shareA = if (total > 0) bWeight / total else 0.5
    val shareB = if (total > 0) aWeight / total else 0.5

    a.pos = Vec3(a.pos.x - nx * overlap * shareA, a.pos.y, a.pos.z - nz * overlap * shareA)
    b.pos = Vec3(b.pos.x + nx * overlap * shareB, b.pos.y, b.pos.z + nz * overlap * shareB)
}

/** Movement input that drives [s] towards [target]. */
fun moveToward(s: LocomotionState, target: Vec3): LocomotionInput {
    val dx = target.x - s.pos.x
    val dz = target.z - s.pos.z
    val d = sqrt(dx * dx + dz * dz)
    if (d < 0.35) return NO_INPUT
    return LocomotionInput(dx / d, dz / d, d > 4.0)
}

/** Fatigue effect: below the onset threshold, speed AND accuracy both degrade. */
fun fatigueEffect(stamina01: Double): Fatigue {
    val t = com.fcmobile.core.DeterministicMath.invLerp(
        0.0,
        com.fcmobile.core.Stamina.FATIGUE_ONSET,
        stamina01,
    )
    return Fatigue(
        speedMul = lerp(com.fcmobile.core.Stamina.FATIGUE_FLOOR_SPEED, 1.0, t),
        accelMul = lerp(0.6, 1.0, t),
        errorMul = lerp(com.fcmobile.core.Stamina.FATIGUE_FLOOR_ACCURACY, 1.0, t),
    )
}

fun distanceTo(s: LocomotionState, p: Vec3): Double = distanceXZ(s.pos, p)

@Suppress("unused")
private val unused = arrayOf(dot(V3_ZERO, V3_ZERO))
