package com.fcmobile.core

/**
 * Seeded, portable PRNG, mirrored from engine/src/core/rng.ts.
 *
 * The core NEVER calls a platform RNG: a match must be replayable from
 * (seed, input stream) alone. That is what makes replays, rollback multiplayer
 * and overnight headless balance runs possible.
 *
 * xoshiro128** over four 32-bit words. All multiplication goes through 32-bit
 * integer arithmetic so results are exact and identical to the JS core, which
 * uses Math.imul for the same reason.
 */
class Rng(seed: Int) {

    private var s0: Int
    private var s1: Int
    private var s2: Int
    private var s3: Int

    init {
        // SplitMix32 expansion so adjacent seeds give uncorrelated states.
        var s = seed
        fun mix(): Int {
            s += -0x61c88647 // 0x9e3779b9
            var z = s
            z = (z xor (z ushr 16)) * 0x21f0aaad
            z = (z xor (z ushr 15)) * 0x735a2d97
            return z xor (z ushr 15)
        }
        s0 = mix(); s1 = mix(); s2 = mix(); s3 = mix()
        if ((s0 or s1 or s2 or s3) == 0) s0 = -0x61c88647
    }

    /** Raw 32-bit word. xoshiro128** — Blackman & Vigna. */
    fun nextU32(): Int {
        val a0 = s0; val a1 = s1; val a2 = s2; val a3 = s3
        val result = rotl(a1 * 5, 7) * 9
        val t = a1 shl 9

        // Reference update order matters; each line sees the previous result.
        var n2 = a2 xor a0
        var n3 = a3 xor a1
        val n1 = a1 xor n2
        val n0 = a0 xor n3
        n2 = n2 xor t
        n3 = rotl(n3, 11)

        s0 = n0; s1 = n1; s2 = n2; s3 = n3
        return result
    }

    /** Uniform in [0, 1). */
    fun next(): Double = (nextU32().toLong() and 0xFFFFFFL).toDouble() / 16777216.0

    fun range(min: Double, max: Double): Double = min + (max - min) * next()

    /**
     * Approximate standard normal via an Irwin-Hall sum of 12 uniforms.
     * Box-Muller would need log(), and the core refuses to depend on libm.
     */
    fun gauss(): Double {
        var sum = 0.0
        repeat(12) { sum += next() }
        return sum - 6.0
    }

    fun gaussScaled(sd: Double): Double =
        DeterministicMath.clamp(gauss(), -3.0, 3.0) * sd

    fun chance(p: Double): Boolean = next() < p

    private fun rotl(x: Int, k: Int): Int = (x shl k) or (x ushr (32 - k))
}
