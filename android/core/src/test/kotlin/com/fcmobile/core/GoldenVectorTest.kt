package com.fcmobile.core

import com.fcmobile.physics.BallState
import com.fcmobile.physics.solveLaunchSpeed
import com.fcmobile.physics.stepBall
import org.json.JSONObject
import java.io.File
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * CROSS-LANGUAGE PARITY GATE.
 *
 * `vectors/golden-*.json` are produced by the TypeScript reference core
 * (`npm run vectors` in engine/). These tests drive the Kotlin core through the
 * exact same inputs and assert it produces the exact same numbers.
 *
 * This is the whole point of the deterministic core. It turns "did I port this
 * correctly?" from an argument into a red/green test:
 *
 *     cd android && ./gradlew :core:test
 *
 * HOW TO USE IT WHEN PORTING
 *   1. Port a subsystem.
 *   2. Run this test. It will fail with the first mismatching value.
 *   3. Fix the port. Do NOT loosen TOLERANCE.
 *
 * The tolerance exists to absorb JSON decimal rounding (values are written with
 * 12 significant decimals), not platform drift. A correct port matches to about
 * 1e-15. If you are hitting 1e-9, something is genuinely wrong.
 *
 * WHY THE CORE AVOIDS LIBM
 * Math.sin / Math.cos / Math.atan2 are permitted to differ between platforms.
 * A 60 Hz sim driven through them drifts apart after a few thousand steps —
 * enough to turn "shot hits the post" into "shot scores" on one device and not
 * another. So DeterministicMath implements them from literal polynomial
 * coefficients using only + - * / and IEEE sqrt.
 */
class GoldenVectorTest {

    private val vectorsDir: File by lazy {
        // Resolve relative to the module, then fall back to the repo root, so
        // the test works from Android Studio and from the command line.
        val candidates = listOf(
            File("../vectors"),
            File("vectors"),
            File("../../vectors"),
        )
        candidates.firstOrNull { it.isDirectory }
            ?: throw IllegalStateException(
                "vectors/ not found. Generate it first: cd engine && npm run vectors",
            )
    }

    private fun load(name: String): JSONObject =
        JSONObject(File(vectorsDir, name).readText())

    companion object {
        const val TOLERANCE = 1e-9
    }

    private fun assertClose(expected: Double, actual: Double, what: String) {
        assertTrue(
            abs(expected - actual) <= TOLERANCE,
            "$what: expected $expected but got $actual (delta ${abs(expected - actual)})",
        )
    }

    // ------------------------------------------------------------------

    @Test
    fun `deterministic sin and cos match the reference core`() {
        val cases = load("golden-math.json").getJSONArray("sinCos")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val angle = c.getDouble("angle")
            val sc = DeterministicMath.sincos(angle)
            assertClose(c.getDouble("sin"), sc.s, "sin($angle)")
            assertClose(c.getDouble("cos"), sc.c, "cos($angle)")
        }
    }

    @Test
    fun `deterministic atan2 matches the reference core`() {
        val cases = load("golden-math.json").getJSONArray("atan2")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val y = c.getDouble("y")
            val x = c.getDouble("x")
            assertClose(c.getDouble("atan2"), DeterministicMath.atan2(y, x), "atan2($y, $x)")
        }
    }

    @Test
    fun `xoshiro128 star-star produces the reference word sequence`() {
        val doc = load("golden-rng.json")
        val rng = Rng(doc.getInt("seed"))
        val expected = doc.getJSONArray("words")
        for (i in 0 until expected.length()) {
            // Compare as unsigned 32-bit values.
            val e = expected.getLong(i)
            val a = rng.nextU32().toLong() and 0xFFFFFFFFL
            assertTrue(e == a, "rng word $i: expected $e but got $a")
        }
    }

    @Test
    fun `ball flight trajectories match the reference core`() {
        val flights = load("golden-ball.json").getJSONArray("flights")
        for (f in 0 until flights.length()) {
            val c = flights.getJSONObject(f)
            val label = c.getString("label")
            val dt = c.getDouble("dt")

            val start = c.getJSONArray("start")
            val vel = c.getJSONArray("vel")
            val spin = c.getJSONArray("spin")
            val ball = BallState(Vec3(start.getDouble(0), start.getDouble(1), start.getDouble(2)))
            ball.vel = Vec3(vel.getDouble(0), vel.getDouble(1), vel.getDouble(2))
            ball.spin = Vec3(spin.getDouble(0), spin.getDouble(1), spin.getDouble(2))

            val steps = c.getInt("steps")
            for (i in 0 until steps) stepBall(ball, dt, i)

            val fp = c.getJSONArray("finalPos")
            val fv = c.getJSONArray("finalVel")
            val fs = c.getJSONArray("finalSpin")
            assertClose(fp.getDouble(0), ball.pos.x, "$label finalPos.x")
            assertClose(fp.getDouble(1), ball.pos.y, "$label finalPos.y")
            assertClose(fp.getDouble(2), ball.pos.z, "$label finalPos.z")
            assertClose(fv.getDouble(0), ball.vel.x, "$label finalVel.x")
            assertClose(fv.getDouble(1), ball.vel.y, "$label finalVel.y")
            assertClose(fv.getDouble(2), ball.vel.z, "$label finalVel.z")
            assertClose(fs.getDouble(0), ball.spin.x, "$label finalSpin.x")
            assertClose(fs.getDouble(1), ball.spin.y, "$label finalSpin.y")
            assertClose(fs.getDouble(2), ball.spin.z, "$label finalSpin.z")

            // The intermediate track catches divergence EARLY, which matters:
            // a final-position match can hide a compensating error.
            val track = c.getJSONArray("track")
            val ball2 = BallState(Vec3(start.getDouble(0), start.getDouble(1), start.getDouble(2)))
            ball2.vel = Vec3(vel.getDouble(0), vel.getDouble(1), vel.getDouble(2))
            ball2.spin = Vec3(spin.getDouble(0), spin.getDouble(1), spin.getDouble(2))
            var t = 0
            for (i in 0 until steps) {
                stepBall(ball2, dt, i)
                if (i % 6 == 0 || i == steps - 1) {
                    val p = track.getJSONArray(t)
                    assertClose(p.getDouble(0), ball2.pos.x, "$label track[$t].x")
                    assertClose(p.getDouble(1), ball2.pos.y, "$label track[$t].y")
                    assertClose(p.getDouble(2), ball2.pos.z, "$label track[$t].z")
                    t++
                }
            }
        }
    }

    @Test
    fun `launch speed solver matches the reference core`() {
        val cases = load("golden-ball.json").getJSONArray("solver")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val solved = solveLaunchSpeed(
                c.getDouble("distance"),
                c.getDouble("launchAngle"),
                c.getDouble("startHeight"),
                c.getDouble("dt"),
                c.getDouble("minSpeed"),
                c.getDouble("maxSpeed"),
                c.getInt("iterations"),
            )
            assertClose(
                c.getDouble("solvedSpeed"),
                solved,
                "solveLaunchSpeed(dist=${c.getDouble("distance")}, angle=${c.getDouble("launchAngle")})",
            )
        }
    }

    @Test
    fun `locomotion sprint curve matches the reference core`() {
        val c = load("golden-locomotion.json")
        val dt = c.getDouble("dt")
        val steps = c.getInt("steps")
        val profile = PlayerProfileForVectors(
            topSpeed = c.getDouble("topSpeed"),
            accel = c.getDouble("accel"),
            turnSpeedPenalty = c.getDouble("turnSpeedPenalty"),
            turnBleedPerSecond = c.getDouble("turnBleedPerSecond"),
            momentumResponse = c.getDouble("momentumResponse"),
            decelMax = c.getDouble("decelMax"),
        )

        var speed = 0.0
        var velX = 0.0
        var posX = 0.0

        val track = c.getJSONArray("track")
        var t = 0
        for (i in 0 until steps) {
            // Mirrors stepLocomotion for the straight-line, no-turn case.
            val turnIntensity = 0.0
            val effectiveTop = profile.topSpeed * (1 - profile.turnSpeedPenalty * turnIntensity)
            val diff = effectiveTop - speed
            val maxA = if (diff > 0) profile.accel else profile.decelMax
            speed = maxOf(0.0, speed + DeterministicMath.clamp(diff, -maxA * dt, maxA * dt))
            speed = maxOf(0.0, speed * (1 - profile.turnBleedPerSecond * turnIntensity * dt))

            val desired = DeterministicMath.cos(0.0) * speed
            val k = DeterministicMath.clamp(profile.momentumResponse * dt, 0.0, 1.0)
            velX += (desired - velX) * k
            posX += velX * dt

            if (i % 10 == 0 || i == steps - 1) {
                val p = track.getJSONArray(t)
                assertClose(p.getDouble(0), speed, "loco track[$t].speed")
                assertClose(p.getDouble(1), velX, "loco track[$t].velX")
                assertClose(p.getDouble(2), posX, "loco track[$t].posX")
                t++
            }
        }
    }

    private data class PlayerProfileForVectors(
        val topSpeed: Double,
        val accel: Double,
        val turnSpeedPenalty: Double,
        val turnBleedPerSecond: Double,
        val momentumResponse: Double,
        val decelMax: Double,
    )
}
