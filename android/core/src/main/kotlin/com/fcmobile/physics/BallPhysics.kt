package com.fcmobile.physics

import com.fcmobile.core.Aero
import com.fcmobile.core.Ball
import com.fcmobile.core.DeterministicMath.clamp
import com.fcmobile.core.DeterministicMath.invLerp
import com.fcmobile.core.DeterministicMath.lerp
import com.fcmobile.core.DeterministicMath.sincos
import com.fcmobile.core.DeterministicMath.sqrt
import com.fcmobile.core.Pitch
import com.fcmobile.core.SIM_DT
import com.fcmobile.core.Turf
import com.fcmobile.core.V3_ZERO
import com.fcmobile.core.Vec3
import com.fcmobile.core.cross
import com.fcmobile.core.length
import com.fcmobile.core.normalize

/**
 * The ball flight model, mirrored from engine/src/physics/ball.ts.
 *
 * Forces at match speed, for a 0.43 kg ball:
 *   gravity  m*g                  ~4.2 N       always
 *   drag     0.5*rho*Cd*A*|v|^2   ~5.2 N @30   opposes motion
 *   Magnus   0.5*rho*Cl*A*|v|^2   ~3.6 N @30   perpendicular, spin-driven
 *
 * All three are the same order as gravity, which is exactly why a football
 * cannot be faked with a gravity-only arc: a struck ball decelerates hard and
 * bends visibly, and players feel the difference immediately.
 *
 * Integration is semi-implicit (symplectic) Euler: forces -> acceleration ->
 * velocity -> position, in that order. Stable at 1/60 s, cheap, portable.
 */
class BallState(pos: Vec3) {
    var pos: Vec3 = pos
    var vel: Vec3 = V3_ZERO
    /** Angular velocity, rad/s, right-hand rule. */
    var spin: Vec3 = V3_ZERO
    var grounded: Boolean = pos.y <= Ball.RADIUS + 1e-4
    var lastBounceTick: Int = -1000
    var lastImpactSpeed: Double = 0.0
    var lastTouchId: Int = -1
    var lastTouchTeam: Int = -1
}

/** Speed-dependent drag coefficient (the drag crisis). */
fun dragCoefficient(speed: Double): Double {
    val t = invLerp(Aero.DRAG_CRISIS_SPEED * 0.55, Aero.DRAG_CRISIS_SPEED * 1.5, speed)
    return lerp(Aero.DRAG_CD_LOW, Aero.DRAG_CD_HIGH, t)
}

/** Magnus lift coefficient from the spin factor S = r*|omega|/|v|. */
fun magnusCoefficient(spinFactor: Double): Double {
    if (spinFactor <= 0.0) return 0.0
    return Aero.MAGNUS_MAX_CL * (spinFactor / (spinFactor + Aero.MAGNUS_HALF_SATURATION_S))
}

/** Acceleration on the ball, excluding contact forces. */
fun ballAcceleration(ball: BallState): Vec3 {
    val v = ball.vel
    val speed = length(v)
    val invMass = 1.0 / Ball.MASS
    val qA = 0.5 * Aero.AIR_DENSITY * Ball.CROSS_SECTION_AREA

    var ax = 0.0
    var ay = -Turf.GRAVITY
    var az = 0.0

    if (speed > 1e-6) {
        // Drag: 0.5*rho*Cd*A*|v|^2 along -v_hat == 0.5*rho*Cd*A*|v| * (-v)
        val dragK = qA * dragCoefficient(speed) * speed * invMass
        ax -= v.x * dragK
        ay -= v.y * dragK
        az -= v.z * dragK

        // Magnus: 0.5*rho*Cl*A*|v|^2 along normalize(omega x v)
        val omegaMag = length(ball.spin)
        if (omegaMag > 1e-4) {
            val cl = magnusCoefficient(Ball.RADIUS * omegaMag / speed)
            if (cl > 0.0) {
                val axis = cross(ball.spin, v)
                val axisLen = length(axis)
                if (axisLen > 1e-6) {
                    val k = qA * cl * speed * speed * invMass / axisLen
                    ax += axis.x * k
                    ay += axis.y * k
                    az += axis.z * k
                }
            }
        }
    }
    return Vec3(ax, ay, az)
}

/** Advance one fixed step. Returns true if the ball struck the turf. */
fun stepBall(ball: BallState, dt: Double, tick: Int): Boolean {
    val a = ballAcceleration(ball)

    // Semi-implicit Euler: velocity first, then position with the NEW velocity.
    ball.vel = Vec3(ball.vel.x + a.x * dt, ball.vel.y + a.y * dt, ball.vel.z + a.z * dt)
    ball.pos = ball.pos + ball.vel * dt

    ball.spin = ball.spin * Aero.SPIN_DECAY_PER_STEP

    val bounced = resolveGround(ball, tick)
    if (ball.grounded) applyRollingResistance(ball, dt)
    return bounced
}

/** Turf collision: restitution, Coulomb friction, slip -> spin conversion. */
private fun resolveGround(ball: BallState, tick: Int): Boolean {
    if (ball.pos.y > Ball.RADIUS) {
        ball.grounded = false
        return false
    }
    ball.pos = Vec3(ball.pos.x, Ball.RADIUS, ball.pos.z)
    ball.grounded = true

    val impact = -ball.vel.y
    if (impact <= 0.0) {
        if (ball.vel.y < 0.0) ball.vel = Vec3(ball.vel.x, 0.0, ball.vel.z)
        return false
    }

    ball.lastBounceTick = tick
    ball.lastImpactSpeed = impact

    if (impact < Turf.SETTLE_SPEED) {
        ball.vel = Vec3(ball.vel.x, 0.0, ball.vel.z)
        // No friction impulse here. A resting ball is not bouncing, so there is
        // no normal impulse to scale one against. Charging it anyway (an early
        // version did) applied friction 60 times a second and halved roll
        // distance. Resting deceleration is applyRollingResistance's job.
        return false
    }

    val e = Turf.BOUNCE_RESTITUTION
    ball.vel = Vec3(ball.vel.x, impact * e, ball.vel.z)

    // Tangential friction, limited by the normal impulse: |Jt| <= mu*|Jn|.
    val tx = ball.vel.x
    val tz = ball.vel.z
    val tangentSpeed = sqrt(tx * tx + tz * tz)
    if (tangentSpeed > 1e-6) {
        val budget = Turf.GROUND_FRICTION * (1 + e) * impact
        val reduction = minOf(tangentSpeed, budget)
        val k = (tangentSpeed - reduction) / tangentSpeed
        ball.vel = Vec3(ball.vel.x * k, ball.vel.y, ball.vel.z * k)

        // Slip drives spin towards rolling. Relaxing rather than snapping
        // reproduces the visible "skid then grip" of a driven pass.
        val noSlipZ = -ball.vel.x / Ball.RADIUS
        val noSlipX = ball.vel.z / Ball.RADIUS
        val b = Turf.SPIN_FROM_BOUNCE
        ball.spin = Vec3(
            lerp(ball.spin.x, noSlipX, b),
            ball.spin.y,
            lerp(ball.spin.z, noSlipZ, b),
        )
    }
    return true
}

/** Rolling resistance on grass, plus relaxation towards true rolling. */
private fun applyRollingResistance(ball: BallState, dt: Double) {
    val speed = sqrt(ball.vel.x * ball.vel.x + ball.vel.z * ball.vel.z)
    if (speed < 1e-4) {
        ball.vel = Vec3(0.0, ball.vel.y, 0.0)
        // A stationary ball cannot keep spinning on grass.
        ball.spin = ball.spin * (1.0 - clamp(6.0 * dt, 0.0, 1.0))
        return
    }
    val decel = Turf.ROLL_DECEL_CONST + Turf.ROLL_DECEL_PER_SPEED * speed
    val k = maxOf(0.0, speed - decel * dt) / speed
    ball.vel = Vec3(ball.vel.x * k, ball.vel.y, ball.vel.z * k)

    val rollZ = -ball.vel.x / Ball.RADIUS
    val rollX = ball.vel.z / Ball.RADIUS
    val relax = clamp(4.0 * dt, 0.0, 1.0)
    ball.spin = Vec3(
        lerp(ball.spin.x, rollX, relax),
        ball.spin.y * (1.0 - relax * 0.5),
        lerp(ball.spin.z, rollZ, relax),
    )
}

/**
 * Bisection solve for the launch speed that reaches [targetDistance] at the
 * given launch angle.
 *
 * It runs the SAME integrator as live flight. Solving with a vacuum closed form
 * and then flying with drag is a classic bug that makes assisted passes land
 * short of the receiver.
 */
fun solveLaunchSpeed(
    targetDistance: Double,
    launchAngle: Double,
    startHeight: Double,
    dt: Double,
    minSpeed: Double,
    maxSpeed: Double,
    iterations: Int,
): Double {
    fun flight(speed: Double): Double {
        val sc = sincos(launchAngle)
        val probe = BallState(Vec3(0.0, maxOf(startHeight, Ball.RADIUS), 0.0))
        probe.vel = Vec3(sc.c * speed, sc.s * speed, 0.0)
        for (i in 0 until 300) {
            val a = ballAcceleration(probe)
            probe.vel = Vec3(probe.vel.x + a.x * dt, probe.vel.y + a.y * dt, probe.vel.z + a.z * dt)
            probe.pos = probe.pos + probe.vel * dt
            probe.spin = probe.spin * Aero.SPIN_DECAY_PER_STEP
            if (probe.pos.y <= Ball.RADIUS && probe.vel.y < 0.0 && i > 1) return probe.pos.x
        }
        return probe.pos.x
    }

    if (flight(maxSpeed) < targetDistance) return maxSpeed
    if (flight(minSpeed) > targetDistance) return minSpeed

    var lo = minSpeed
    var hi = maxSpeed
    repeat(iterations) {
        val mid = (lo + hi) * 0.5
        if (flight(mid) < targetDistance) lo = mid else hi = mid
    }
    return (lo + hi) * 0.5
}

/**
 * Predict the ball's height after it has travelled `targetDistance` in the
 * pitch plane.
 *
 * Runs the same integrator as live flight, so a shot cannot be aimed with one
 * model and flown with another. Mirrors predictHeightAtDistance in
 * engine/src/physics/ball.ts.
 *
 * @return height in metres, or -1.0 if the ball hits the turf first.
 */
fun predictHeightAtDistance(
    launchSpeed: Double,
    launchAngle: Double,
    startHeight: Double,
    dt: Double,
    targetDistance: Double,
): Double {
    val sc = sincos(launchAngle)
    val probe = BallState(Vec3(0.0, maxOf(startHeight, Ball.RADIUS), 0.0))
    probe.vel = Vec3(sc.c * launchSpeed, sc.s * launchSpeed, 0.0)

    for (i in 0 until 300) {
        val a = ballAcceleration(probe)
        probe.vel = Vec3(probe.vel.x + a.x * dt, probe.vel.y + a.y * dt, probe.vel.z + a.z * dt)
        probe.pos = probe.pos + probe.vel * dt
        probe.spin = probe.spin * Aero.SPIN_DECAY_PER_STEP

        // The probe is launched along +x, so planar distance is just x.
        if (probe.pos.x >= targetDistance) return probe.pos.y
        if (probe.pos.y <= Ball.RADIUS && probe.vel.y < 0.0 && i > 1) return -1.0
    }
    return probe.pos.y
}

/**
 * Bisection solve for the launch angle that arrives at `targetHeight` after
 * `targetDistance`.
 *
 * Shots used to take a single fixed angle per kick kind, which cannot work: the
 * height a ball arrives at grows with the distance it travels. Measured over 8
 * matches, 65% of shots reaching the goal plane went OVER THE BAR, at a median
 * distance of 12.2 m and a median arrival height of 3.56 m against a 2.44 m bar.
 *
 * Height at a fixed distance rises monotonically with launch angle, so bisection
 * converges from both ends. Mirrors solveLaunchAngle in engine/src/physics/ball.ts.
 */
fun solveLaunchAngle(
    targetDistance: Double,
    targetHeight: Double,
    launchSpeed: Double,
    startHeight: Double,
    dt: Double,
    minAngle: Double,
    maxAngle: Double,
    iterations: Int,
): Double {
    fun heightAt(angle: Double): Double =
        predictHeightAtDistance(launchSpeed, angle, startHeight, dt, targetDistance)

    // A flat strike that still arrives above the target: nothing to solve.
    if (heightAt(minAngle) >= targetHeight) return minAngle
    // Even the steepest allowed angle cannot lift it there (usually too far, or
    // the ball grounds out first): take the steepest and let it drop.
    if (heightAt(maxAngle) <= targetHeight) return maxAngle

    var lo = minAngle
    var hi = maxAngle
    repeat(iterations) {
        val mid = (lo + hi) * 0.5
        if (heightAt(mid) < targetHeight) lo = mid else hi = mid
    }
    return (lo + hi) * 0.5
}

/** Convenience: spin in revolutions per minute, the unit commentators use. */
fun ballSpinRpm(ball: BallState): Double = length(ball.spin) * 60.0 / (2.0 * com.fcmobile.core.DeterministicMath.PI)

@Suppress("unused")
private val unusedRefs = arrayOf(Pitch.CENTRE_X, SIM_DT, normalize(V3_ZERO))
