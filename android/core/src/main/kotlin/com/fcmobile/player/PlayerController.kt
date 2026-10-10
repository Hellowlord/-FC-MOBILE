package com.fcmobile.player

import com.fcmobile.core.Ball
import com.fcmobile.core.DeterministicMath.PI
import com.fcmobile.core.DeterministicMath.clamp
import com.fcmobile.core.DeterministicMath.invLerp
import com.fcmobile.core.DeterministicMath.lerp
import com.fcmobile.core.DeterministicMath.sincos
import com.fcmobile.core.DeterministicMath.sqrt
import com.fcmobile.core.DeterministicMath.wrapPi
import com.fcmobile.core.Kick
import com.fcmobile.core.Loco
import com.fcmobile.core.Pitch
import com.fcmobile.core.Rng
import com.fcmobile.core.V3_ZERO
import com.fcmobile.core.Vec3
import com.fcmobile.core.distanceXZ
import com.fcmobile.core.normalize
import com.fcmobile.physics.BallState
import com.fcmobile.physics.solveLaunchAngle
import com.fcmobile.physics.solveLaunchSpeed

/**
 * PlayerController — movement + ball interaction for one player.
 * Mirrored from engine/src/player/controller.ts.
 *
 * This is what a human drives directly and what the AI fills synthetic input
 * for. It is deliberately thin: it turns intent into a kick or a step and
 * delegates the numbers to [stepLocomotion] and the ball physics. Keeping it
 * thin is what lets the CPU use exactly the same code path as the human, so the
 * AI can never do anything the player cannot.
 *
 * Tick order (load-bearing, do not reorder):
 *   1 consume edge-triggered requests (pass / shoot / tackle / skill)
 *   2 resolve possession changes
 *   3 run locomotion
 *   4 if in possession, place the ball in the dribble pocket
 *
 * ── THE KICK MODEL ──────────────────────────────────────────────────────────
 * Every kick produces (direction, launch angle, speed, spin):
 *   • launch angle comes from kick TYPE (drive ~9, normal ~18, chip ~36 deg)
 *   • speed comes from the power meter, or on assisted kicks from a bisection
 *     solve through the real drag model so the ball actually arrives
 *   • accuracy is angular error from a per-player distribution, scaled by
 *     fatigue, power and distance. Full power is never full accuracy.
 *   • curve sets vertical-axis spin so the Magnus term bends the flight.
 */

enum class KickKind { SHORT_PASS, LONG_PASS, THROUGH_BALL, SHOT_DRIVE, SHOT_NORMAL, SHOT_CHIP, CLEARANCE }

/** Intent for one tick. The human and the AI both produce this. */
data class PlayerInput(
    val moveX: Double = 0.0,
    val moveZ: Double = 0.0,
    val sprint: Boolean = false,
    val pass: Boolean = false,
    val throughBall: Boolean = false,
    val shoot: Boolean = false,
    val tackle: Boolean = false,
    /** 0 = none, 1 = knock-on into space, 2 = feint / step-over. */
    val skillMove: Int = 0,
    val aim: Vec3? = null,
    /** 0..1 power meter. Ignored when [autoPower] is set. */
    val power: Double = 0.0,
    /** -1..1 curve. Positive curves to the kicker's right. */
    val curve: Double = 0.0,
    /** -1..1 shot placement across the goal mouth. */
    val placement: Double = 0.0,
    /** Solve the speed that reaches [aim] instead of using the power meter. */
    val autoPower: Boolean = false,
)

/** Minimal attributes needed by the controller. */
data class PlayerAttributes(
    val id: Int,
    val name: String,
    val team: Int,
    val ballControl: Int,
    val dribbling: Int,
    val shortPassing: Int,
    val longPassing: Int,
    val shotPower: Int,
    val finishing: Int,
    val curve: Int,
    val tackling: Int,
    val strength: Int,
)

/** Runtime state for one player on the pitch. */
class PlayerRuntime(
    val attr: PlayerAttributes,
    val profile: PlayerProfile,
    pos: Vec3,
    heading: Double,
) {
    val loco = LocomotionState(pos, heading)
    var stamina: Double = 1.0
    var hasBall: Boolean = false
    var ticksSinceTouch: Int = 9999
    var frozenTimer: Int = 0
    /** Ticks of recovery remaining after a kick / tackle / skill move. */
    var actionTimer: Int = 0
    var burstTimer: Int = 0
    var burstMul: Double = 1.0
}

/** Read-only view of the world for one tick. */
class FieldView(
    val players: List<PlayerRuntime>,
    val ball: BallState,
    val possessionId: Int,
    val tick: Int,
    val dt: Double,
    val rng: Rng,
)

data class KickEvent(val playerId: Int, val kind: KickKind, val speed: Double, val spinRpm: Double)

/** Minimum ticks between two challenges by the same player (~0.83 s). */
private const val TACKLE_COOLDOWN_TICKS = 50

class PlayerController(val player: PlayerRuntime) {

    private var input = PlayerInput()
    private var touchCooldown = 0
    private var lastTackleTick = -9999
    val kicks = mutableListOf<KickEvent>()

    fun setInput(newInput: PlayerInput) {
        input = newInput
    }

    fun update(view: FieldView) {
        val p = player
        val dt = view.dt

        if (touchCooldown > 0) touchCooldown--
        if (p.actionTimer > 0) p.actionTimer--
        if (p.burstTimer > 0) {
            p.burstTimer--
            if (p.burstTimer == 0) p.burstMul = 1.0
        }
        if (p.frozenTimer > 0) p.frozenTimer--
        p.ticksSinceTouch++

        val fatigue = fatigueEffect(p.stamina)
        val canAct = p.frozenTimer <= 0

        // 1. edge-triggered actions
        if (canAct) {
            when {
                input.skillMove > 0 && p.hasBall -> doSkillMove(input.skillMove, view)
                input.tackle -> doTackle(view)
                input.shoot -> doKick(view, KickKind.SHOT_NORMAL, fatigue)
                input.throughBall -> doKick(view, KickKind.THROUGH_BALL, fatigue)
                input.pass -> doKick(view, KickKind.SHORT_PASS, fatigue)
            }
        }

        // 2. possession. Must be gated on canAct: a player stunned by a winning
        // tackle must not pick the ball straight back up. Doing so made tackles
        // meaningless and handed one side 98.7% possession in testing.
        if (canAct) resolveTrap(view, fatigue)

        // 3. body
        stepLocomotion(
            p.loco,
            LocomotionInput(input.moveX, input.moveZ, input.sprint),
            p.profile,
            fatigue,
            dt,
            p.burstMul,
        )

        // 4. dribble pocket
        if (p.hasBall) placeBallInPocket(view, p)
    }

    // ------------------------------------------------------------------

    private fun resolveTrap(view: FieldView, fatigue: Fatigue) {
        val p = player
        if (p.hasBall) return
        if (touchCooldown > 0) return
        // You cannot steal directly off a player already in control.
        if (view.possessionId >= 0 && view.possessionId != p.attr.id) return

        val ball = view.ball
        val dx = ball.pos.x - p.loco.pos.x
        val dz = ball.pos.z - p.loco.pos.z
        val planar = sqrt(dx * dx + dz * dz)

        val isKeeper = false // goalkeepers are handled by a dedicated keeper AI
        val reach = p.profile.controlRadius + p.loco.bodyRadius
        if (planar > reach || ball.pos.y > 1.15) return

        // Too fast to control: deflect rather than stick.
        val ballSpeed = sqrt(ball.vel.x * ball.vel.x + ball.vel.z * ball.vel.z)
        val ceiling = lerp(9.0, 24.0, invLerp(40.0, 99.0, p.attr.ballControl.toDouble()))
        if (ballSpeed > ceiling) {
            if (planar > 1e-6) {
                ball.vel = Vec3(
                    ball.vel.x * 0.55 + dx / planar * ballSpeed * 0.25,
                    ball.vel.y * 0.6,
                    ball.vel.z * 0.55 + dz / planar * ballSpeed * 0.25,
                )
            }
            ball.lastTouchId = p.attr.id
            ball.lastTouchTeam = p.attr.team
            touchCooldown = 8
            return
        }

        // First touch scatters perpendicular to travel, so a hard pass to a
        // weak first touch visibly squirts away.
        val err = p.profile.firstTouchError * fatigue.errorMul
        var perpX = 0.0
        var perpZ = 0.0
        if (ballSpeed > 0.4) {
            perpX = -ball.vel.z / ballSpeed
            perpZ = ball.vel.x / ballSpeed
        }
        val off = view.rng.gaussScaled(err)

        p.hasBall = true
        p.ticksSinceTouch = 0
        p.actionTimer = if (isKeeper) 16 else 4
        ball.lastTouchId = p.attr.id
        ball.lastTouchTeam = p.attr.team
        ball.spin = V3_ZERO
        ball.pos = Vec3(p.loco.pos.x + perpX * off, Ball.RADIUS, p.loco.pos.z + perpZ * off)
        ball.vel = p.loco.vel * 0.4
    }

    private fun doKick(view: FieldView, kind: KickKind, fatigue: Fatigue) {
        val p = player
        if (!p.hasBall) return

        val target = input.aim ?: bestReceiverTarget(view, p) ?: return
        val strike = computeStrike(p, view.ball, kind, target, input, fatigue, view)

        view.ball.pos = Vec3(view.ball.pos.x, maxOf(view.ball.pos.y, Ball.RADIUS), view.ball.pos.z)
        view.ball.vel = strike.velocity
        view.ball.spin = strike.spin
        view.ball.lastTouchId = p.attr.id
        view.ball.lastTouchTeam = p.attr.team
        view.ball.grounded = false

        p.hasBall = false
        p.actionTimer = if (isShot(kind)) 14 else 10
        touchCooldown = 12
        kicks.add(KickEvent(p.attr.id, kind, lengthOf(strike.velocity), strike.spinRpm))
    }

    private fun doSkillMove(index: Int, view: FieldView) {
        val p = player
        val dir = facing(p)
        if (index == 1) {
            // Knock-on: shove it into space and burst after it.
            view.ball.pos = Vec3(p.loco.pos.x + dir.x * 2.2, Ball.RADIUS, p.loco.pos.z + dir.z * 2.2)
            view.ball.vel = dir * (maxOf(p.loco.speed, 6.0) + Loco.KNOCK_ON_BURST)
            view.ball.spin = V3_ZERO
            p.burstMul = 1.16
            p.burstTimer = 22
            p.hasBall = false
            touchCooldown = 6
            p.actionTimer = 8
        } else {
            // Feint: sell one way, freeze the nearest opponent briefly.
            p.loco.heading = wrapPi(p.loco.heading + if (view.rng.next() < 0.5) 0.5 else -0.5)
            for (o in view.players) {
                if (o.attr.team == p.attr.team) continue
                if (distanceXZ(o.loco.pos, p.loco.pos) < 2.5) {
                    o.frozenTimer = (Loco.FEINT_DEFENDER_FREEZE / view.dt).toInt()
                    break
                }
            }
            p.actionTimer = 10
        }
    }

    private fun doTackle(view: FieldView) {
        val p = player
        if (p.hasBall) return
        // A tackle commits the body. Without this cooldown the sides simply
        // ping-ponged possession every dozen ticks.
        if (view.tick - lastTackleTick < TACKLE_COOLDOWN_TICKS) return
        lastTackleTick = view.tick

        val victim = view.players.firstOrNull {
            it.attr.team != p.attr.team && it.hasBall && distanceXZ(it.loco.pos, p.loco.pos) <= 1.4
        }
        if (victim == null) {
            p.actionTimer = 18
            p.loco.locked = true
            p.loco.lockTimer = 0.28
            return
        }

        val tacklerSkill =
            invLerp(40.0, 99.0, p.attr.tackling.toDouble()) * 0.65 +
                invLerp(40.0, 99.0, p.attr.strength.toDouble()) * 0.35
        val carrierSkill = invLerp(40.0, 99.0, victim.attr.dribbling.toDouble())
        val dist = distanceXZ(p.loco.pos, victim.loco.pos)
        val pWin = clamp(
            0.28 + (tacklerSkill - carrierSkill) * 0.6 -
                clamp((dist - 0.8) / 1.6, 0.0, 1.0) * 0.35,
            0.05,
            0.92,
        )

        val success = view.rng.next() < pWin
        p.actionTimer = if (success) 12 else 20
        p.loco.locked = true
        p.loco.lockTimer = if (success) 0.22 else 0.5

        if (success) {
            victim.hasBall = false
            victim.actionTimer = 14
            val dir = normalize(victim.loco.pos.let { Vec3(p.loco.pos.x - it.x, 0.0, p.loco.pos.z - it.z) })
            view.ball.pos = Vec3(victim.loco.pos.x, Ball.RADIUS, victim.loco.pos.z)
            view.ball.vel = dir * 2.2
            view.ball.spin = V3_ZERO
            touchCooldown = 4
        } else {
            val away = normalize(Vec3(victim.loco.pos.x - p.loco.pos.x, 0.0, victim.loco.pos.z - p.loco.pos.z))
            view.ball.vel = view.ball.vel + away * 1.4
        }
    }
}

/** Hold the ball in the pocket just ahead of the dribbler. */
private fun placeBallInPocket(view: FieldView, p: PlayerRuntime) {
    val speedFrac = clamp(p.loco.speed / p.profile.topSpeed, 0.0, 1.0)
    val closeControl = invLerp(40.0, 99.0, p.attr.dribbling.toDouble())
    val pocketDist = lerp(0.55, 1.35, speedFrac) * lerp(0.85, 1.05, 1.0 - closeControl)

    val dir = dribbleDirection(p)
    val k = clamp(14.0 * view.dt, 0.0, 1.0)
    // Keep the pocket inside the field of play: the facing lags the run by a
    // few ticks, so a winger going down the touchline otherwise aims the
    // pocket through the line and carries the ball out of play. Mirrors
    // placeBallInPocket in engine/src/player/controller.ts.
    val margin = Ball.RADIUS + 0.05
    val tx = clamp(p.loco.pos.x + dir.x * pocketDist, margin, Pitch.LENGTH - margin)
    val tz = clamp(p.loco.pos.z + dir.z * pocketDist, margin, Pitch.WIDTH - margin)
    view.ball.pos = Vec3(
        view.ball.pos.x + (tx - view.ball.pos.x) * k,
        Ball.RADIUS,
        view.ball.pos.z + (tz - view.ball.pos.z) * k,
    )
    val lead = 1.0 + speedFrac * 0.25
    view.ball.vel = Vec3(p.loco.vel.x * lead, 0.0, p.loco.vel.z * lead)
    // A dribbled ball rolls; it does not spin sideways.
    view.ball.spin = Vec3(
        view.ball.vel.z / Ball.RADIUS,
        view.ball.spin.y * 0.5,
        -view.ball.vel.x / Ball.RADIUS,
    )
    view.ball.grounded = true
    view.ball.lastTouchId = p.attr.id
    view.ball.lastTouchTeam = p.attr.team
}

/** Speed range and launch angle for a kick type. */
fun kickEnvelope(kind: KickKind): Triple<Double, Double, Double> = when (kind) {
    KickKind.SHORT_PASS -> Triple(Kick.SHORT_PASS_MIN, Kick.SHORT_PASS_MAX, Kick.ANGLE_DRIVE * 0.6)
    KickKind.LONG_PASS -> Triple(Kick.LONG_PASS_MIN, Kick.LONG_PASS_MAX, Kick.ANGLE_NORMAL)
    KickKind.THROUGH_BALL -> Triple(Kick.SHORT_PASS_MIN, Kick.LONG_PASS_MAX * 0.85, Kick.ANGLE_DRIVE * 0.8)
    KickKind.SHOT_DRIVE -> Triple(Kick.SHOT_MIN, Kick.SHOT_MAX, Kick.ANGLE_DRIVE)
    KickKind.SHOT_NORMAL -> Triple(Kick.SHOT_MIN, Kick.SHOT_MAX, Kick.ANGLE_NORMAL)
    KickKind.SHOT_CHIP -> Triple(Kick.SHOT_MIN * 0.75, Kick.SHOT_MAX * 0.8, Kick.ANGLE_CHIP)
    KickKind.CLEARANCE -> Triple(Kick.LONG_PASS_MIN, Kick.LONG_PASS_MAX, Kick.ANGLE_CHIP * 0.85)
}

data class Strike(val velocity: Vec3, val spin: Vec3, val power01: Double, val spinRpm: Double)

fun computeStrike(
    p: PlayerRuntime,
    ball: BallState,
    kind: KickKind,
    targetIn: Vec3,
    input: PlayerInput,
    fatigue: Fatigue,
    view: FieldView,
): Strike {
    // Clamp the aim point into the field of play. A kick aimed off the pitch is
    // never what anyone meant; an early version passed to led targets outside
    // the field and produced ~13,000 throw-ins in a 30-minute match.
    val target = Vec3(
        clamp(targetIn.x, 1.0, Pitch.LENGTH - 1.0),
        targetIn.y,
        clamp(targetIn.z, 1.0, Pitch.WIDTH - 1.0),
    )

    var dx = target.x - ball.pos.x
    var dz = target.z - ball.pos.z
    var planar = sqrt(dx * dx + dz * dz)
    if (planar < 0.05) {
        dx = 1.0; dz = 0.0; planar = 0.05
    }
    var dirX = dx / planar
    var dirZ = dz / planar

    val isShot = isShot(kind)
    val (minSpeed, maxBase, envelopeAngle) = kickEnvelope(kind)
    var launchAngle = envelopeAngle
    val powerRating = invLerp(40.0, 99.0, (if (isShot) p.attr.shotPower else p.attr.longPassing).toDouble())
    val maxSpeed = maxBase * lerp(0.86, 1.14, powerRating)

    val speed: Double
    val power01: Double
    if (input.autoPower) {
        // Assisted: solve through the real drag model, then report the
        // equivalent meter position so the HUD can still animate a bar.
        val s = solveLaunchSpeed(
            planar, launchAngle, maxOf(ball.pos.y, Ball.RADIUS), view.dt,
            minSpeed, maxSpeed, Kick.SOLVER_ITERATIONS,
        )
        speed = s
        power01 = invLerp(minSpeed, maxSpeed, s)
    } else {
        val q = clamp(input.power, 0.0, 1.0)
        power01 = q
        speed = lerp(minSpeed, maxSpeed, q)
    }

    // Launch angle for shots. A fixed angle per kick kind cannot work, because
    // the height a ball arrives at grows with the distance it travels: an 18
    // degree strike from 12 m arrives at roughly 3.5 m, over a 2.44 m bar.
    // Measured over 8 matches, 65% of shots reaching the goal plane went over
    // the bar at a median distance of 12.2 m. So solve the angle that puts the
    // ball at a chosen height inside the frame, through the same drag model the
    // ball then flies under. Mirrors engine/src/player/controller.ts.
    if (isShot) {
        val targetHeight =
            if (kind == KickKind.SHOT_CHIP) Pitch.GOAL_HEIGHT * 0.86
            else lerp(Pitch.GOAL_HEIGHT * 0.18, Pitch.GOAL_HEIGHT * 0.62, clamp(power01, 0.0, 1.0))
        launchAngle = solveLaunchAngle(
            planar,
            targetHeight,
            speed,
            maxOf(ball.pos.y, Ball.RADIUS),
            view.dt,
            0.02,
            envelopeAngle * 1.6,
            Kick.SOLVER_ITERATIONS,
        )
    }

    // Placement shifts the aim across the mouth BEFORE error is applied, so it
    // is a genuine trade: the corners are further out, so a miss is likelier.
    if (isShot && kotlin.math.abs(input.placement) > 0.001) {
        val halfWidth = (Pitch.GOAL_WIDTH / 2 - 0.35) * clamp(input.placement, -1.0, 1.0)
        val px = -dirZ
        val pz = dirX
        val ndx = target.x + px * halfWidth - ball.pos.x
        val ndz = target.z + pz * halfWidth - ball.pos.z
        val nlen = sqrt(ndx * ndx + ndz * ndz)
        if (nlen > 1e-6) {
            dirX = ndx / nlen
            dirZ = ndz / nlen
        }
    }

    // Accuracy: full power is never full accuracy, and long balls drift more.
    val baseErr = if (isShot) p.profile.shotErrorDeg else p.profile.passErrorDeg
    val powerFactor = 1.0 + Kick.ERROR_POWER_MULTIPLIER * clamp(power01 - 0.5, 0.0, 0.5) * 2.0
    val distFactor = 1.0 + clamp((planar - 8.0) / 40.0, 0.0, 1.0) * 0.6
    val errorDeg = baseErr * fatigue.errorMul * powerFactor * distFactor
    val errRad = view.rng.gaussScaled(errorDeg) * PI / 180.0

    val sc = sincos(errRad)
    val rdx = dirX * sc.c - dirZ * sc.s
    val rdz = dirX * sc.s + dirZ * sc.c

    val lc = sincos(launchAngle)
    val velocity = Vec3(rdx * lc.c * speed, lc.s * speed, rdz * lc.c * speed)

    // Sidespin on the vertical axis bends the flight; positive curves right.
    val spinRpm = clamp(input.curve, -1.0, 1.0) * p.profile.maxSpinRpm
    val spinRad = spinRpm * 2.0 * PI / 60.0
    val backspinRpm = when (kind) {
        KickKind.SHOT_CHIP -> 320.0
        KickKind.LONG_PASS, KickKind.THROUGH_BALL -> 180.0
        else -> 60.0
    }
    val backspinRad = backspinRpm * 2.0 * PI / 60.0
    val spin = Vec3(-rdz * backspinRad, spinRad, rdx * backspinRad)

    return Strike(velocity, spin, power01, spinRpm)
}

fun facing(p: PlayerRuntime): Vec3 {
    val sc = sincos(p.loco.heading)
    return Vec3(sc.c, 0.0, sc.s)
}

/**
 * Direction the dribble pocket sits in.
 *
 * The facing lags the run by a few ticks, so a defender who turns to chase a
 * loose ball ends up facing his own goal and a pocket placed along that facing
 * walks the ball over his own line. Inside his own penalty area the pocket is
 * blended towards the field so that cannot happen, leaving normal play
 * elsewhere untouched.
 *
 * Mirrors dribbleDirection in engine/src/player/controller.ts, minus the
 * goalkeeper branch: this controller never runs a keeper (see isKeeper at the
 * call site -- goalkeepers are handled by a dedicated keeper AI), so there is
 * no permanently-net-facing player to special-case here. If keeper handling is
 * ever folded into this controller, port that branch too.
 */
private fun dribbleDirection(p: PlayerRuntime): Vec3 {
    val f = facing(p)
    val goalX = if (p.attr.team == 0) 0.0 else Pitch.LENGTH
    val distToOwnGoal = kotlin.math.abs(p.loco.pos.x - goalX)
    // Positive when the facing has a component pointing at his own goal.
    val towardOwnGoal = if (p.attr.team == 0) -f.x else f.x

    if (distToOwnGoal < Pitch.PENALTY_AREA_LENGTH && towardOwnGoal > 0.3) {
        return normalize(
            Vec3(
                f.x * 0.3 + towardsField(p).x * 0.7,
                0.0,
                f.z * 0.3 + towardsField(p).z * 0.7,
            ),
        )
    }
    return f
}

/** Unit vector pointing from a player towards the middle of the field of play. */
private fun towardsField(p: PlayerRuntime): Vec3 {
    val toFar = Pitch.LENGTH - p.loco.pos.x
    val toNear = p.loco.pos.x
    return if (toFar > toNear) Vec3(1.0, 0.0, 0.0) else Vec3(-1.0, 0.0, 0.0)
}

fun isShot(kind: KickKind): Boolean =
    kind == KickKind.SHOT_DRIVE || kind == KickKind.SHOT_NORMAL || kind == KickKind.SHOT_CHIP

/**
 * Pick a receiver. Scores distance, how open they are and how far forward the
 * pass takes us. This is the same scoring the human assist uses, so the CPU can
 * never pick a pass the player could not.
 */
fun bestReceiver(view: FieldView, from: PlayerRuntime): PlayerRuntime? {
    val attackDir = if (from.attr.team == 0) 1.0 else -1.0
    var best: PlayerRuntime? = null
    var bestScore = Double.NEGATIVE_INFINITY
    for (o in view.players) {
        if (o.attr.team != from.attr.team || o.attr.id == from.attr.id) continue
        val d = distanceXZ(o.loco.pos, from.loco.pos)
        if (d < 2.5 || d > 45.0) continue

        var nearestDef = 999.0
        for (x in view.players) {
            if (x.attr.team == from.attr.team) continue
            val dd = distanceXZ(x.loco.pos, o.loco.pos)
            if (dd < nearestDef) nearestDef = dd
        }
        val openness = 1.0 - clamp(nearestDef / 6.0, 0.0, 1.0)
        val forward = clamp((o.loco.pos.x - from.loco.pos.x) * attackDir / 25.0, -1.0, 1.0)
        val distFit = 1.0 - kotlin.math.abs(d - 16.0) / 30.0
        val score = openness * 2.2 + forward * 0.9 + distFit * 0.8
        if (score > bestScore) {
            bestScore = score
            best = o
        }
    }
    return best
}

/**
 * Aim where the receiver will BE. The lead is capped and clamped inside the
 * pitch: a 1.4 s lead on a runner doing 8 m/s lands 11 m beyond them, which is
 * routinely off the field.
 */
fun leadTarget(runner: PlayerRuntime, leadSec: Double): Vec3 {
    val t = clamp(leadSec, 0.0, 0.9)
    return Vec3(
        clamp(runner.loco.pos.x + runner.loco.vel.x * t, 1.5, Pitch.LENGTH - 1.5),
        Ball.RADIUS,
        clamp(runner.loco.pos.z + runner.loco.vel.z * t, 1.5, Pitch.WIDTH - 1.5),
    )
}

private fun bestReceiverTarget(view: FieldView, p: PlayerRuntime): Vec3? {
    val mate = bestReceiver(view, p) ?: return null
    val d = distanceXZ(mate.loco.pos, p.loco.pos)
    val estSpeed = kickEnvelope(if (d > 22.0) KickKind.LONG_PASS else KickKind.SHORT_PASS)
        .let { (it.first + it.second) * 0.5 }
    return leadTarget(mate, clamp(d / maxOf(estSpeed, 1.0), 0.1, 1.4))
}

private fun lengthOf(v: Vec3): Double = sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
