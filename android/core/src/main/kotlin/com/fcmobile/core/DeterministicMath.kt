package com.fcmobile.core

import kotlin.math.sqrt

/**
 * libm-free transcendental functions, mirrored from engine/src/core/math.ts.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A match engine that must produce identical results on this JVM and in the
 * TypeScript reference core cannot call Math.sin / Math.cos / Math.atan2. Those
 * are permitted to be implemented differently by different platforms, so a
 * 60 Hz simulation driven through them drifts apart after a few thousand steps —
 * enough to turn "shot hits the post" into "shot scores" on one device.
 *
 * Everything here uses only + - * / and [sqrt] (IEEE-754 correctly rounded,
 * identical everywhere), plus [Math.round] which is exactly specified by both
 * the JVM and ECMA-262. Coefficients are literals shared with the TS core.
 *
 * PARITY IS TESTED, NOT ASSUMED. `GoldenVectorTest` runs fixed inputs through
 * both cores and compares the outputs in vectors/golden-*.json. If you change a
 * coefficient here, change it in engine/src/core/math.ts too, then regenerate
 * the vectors.
 */
object DeterministicMath {

    const val PI: Double = 3.141592653589793
    const val TWO_PI: Double = 6.283185307179586
    const val HALF_PI: Double = 1.5707963267948966
    private const val QUARTER_PI: Double = 0.7853981633974483
    private const val TWO_OVER_PI: Double = 0.6366197723675814
    private const val TAN_PI_8: Double = 0.41421356237309503

    // Cephes sin, minimax on [-PI/4, PI/4], odd powers x^3..x^15.
    private const val S1 = -1.66666666666666324348e-01
    private const val S2 = 8.33333333332248946124e-03
    private const val S3 = -1.98412698298579493134e-04
    private const val S4 = 2.75573137070700676789e-06
    private const val S5 = -2.50507602534068634195e-08
    private const val S6 = 1.73384449593724564988e-10

    // Cephes cos, minimax on [-PI/4, PI/4], even powers x^4..x^16.
    private const val C1 = 4.16666666666666019037e-02
    private const val C2 = -1.38888888888741095749e-03
    private const val C3 = 2.48015872894767294178e-05
    private const val C4 = -2.75573143513906633035e-07
    private const val C5 = 2.08757232129817482790e-09
    private const val C6 = -1.13596475577881948265e-11

    // atan: odd polynomial fitted offline on |t| <= tan(PI/8). Worst-case
    // error 2.2e-13 rad. Do NOT substitute Math.atan — it is not bit-stable.
    private const val AT1 = -0.33333333374667595
    private const val AT2 = 0.20000005501146312
    private const val AT3 = -0.1428596733340687
    private const val AT4 = 0.11116662249053857
    private const val AT5 = -0.09155373302287706
    private const val AT6 = 0.08086636629138526
    private const val AT7 = -0.07725985831841822
    private const val AT8 = 0.05732573106079487

    private fun sinCore(x: Double): Double {
        val z = x * x
        val y = S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6))))
        return x + z * x * y
    }

    private fun cosCore(x: Double): Double {
        val z = x * x
        val y = C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6))))
        val zz = z * z
        return 1.0 - 0.5 * z + zz * y
    }

    data class Sincos(val s: Double, val c: Double)

    /** sin and cos together; quadrant reduction keeps |r| <= PI/4. */
    fun sincos(angle: Double): Sincos {
        val q = Math.round(angle * TWO_OVER_PI)
        val r = angle - q.toDouble() * HALF_PI
        val sp = sinCore(r)
        val cp = cosCore(r)
        // `q and 3` behaves identically to JS `q & 3` for negatives:
        // both are two's-complement bitwise AND.
        return when (q.toInt() and 3) {
            0 -> Sincos(sp, cp)
            1 -> Sincos(cp, -sp)
            2 -> Sincos(-sp, -cp)
            else -> Sincos(-cp, sp)
        }
    }

    fun sin(angle: Double): Double = sincos(angle).s
    fun cos(angle: Double): Double = sincos(angle).c

    private fun atanCore(t: Double): Double {
        val u = t * t
        val y = AT1 + u * (AT2 + u * (AT3 + u * (AT4 + u * (AT5 + u * (AT6 + u * (AT7 + u * AT8))))))
        return t * (1 + u * y)
    }

    /**
     * The recursion is essential: the a > 1 branch maps onto (0, 1), which
     * still has to pass through the a > tan(PI/8) branch before atanCore is
     * legal. Calling the polynomial directly on 1/a gives ~0.02 rad of error.
     */
    private fun atanPos(a: Double): Double {
        if (a > 1.0) return HALF_PI - atanPos(1.0 / a)
        if (a > TAN_PI_8) return QUARTER_PI + atanCore((a - 1.0) / (a + 1.0))
        return atanCore(a)
    }

    fun atan(t: Double): Double {
        val r = atanPos(if (t < 0) -t else t)
        return if (t < 0) -r else r
    }

    fun atan2(y: Double, x: Double): Double {
        if (x > 0) return atan(y / x)
        if (x < 0) return if (y >= 0) atan(y / x) + PI else atan(y / x) - PI
        if (y > 0) return HALF_PI
        if (y < 0) return -HALF_PI
        return 0.0
    }

    fun sqrt(v: Double): Double = sqrt(if (v < 0.0) 0.0 else v)

    fun clamp(v: Double, lo: Double, hi: Double): Double =
        if (v < lo) lo else if (v > hi) hi else v

    fun clamp(v: Int, lo: Int, hi: Int): Int = if (v < lo) lo else if (v > hi) hi else v

    fun lerp(a: Double, b: Double, t: Double): Double = a + (b - a) * t

    fun invLerp(a: Double, b: Double, v: Double): Double {
        if (b == a) return 0.0
        return clamp((v - a) / (b - a), 0.0, 1.0)
    }

    fun sign(v: Double): Double = if (v < 0.0) -1.0 else if (v > 0.0) 1.0 else 0.0

    fun wrapPi(a: Double): Double {
        var r = a
        while (r > PI) r -= TWO_PI
        while (r <= -PI) r += TWO_PI
        return r
    }

    fun angleDelta(from: Double, to: Double): Double = wrapPi(to - from)
}
