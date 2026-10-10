package com.fcmobile.core

import com.fcmobile.core.DeterministicMath.atan2
import com.fcmobile.core.DeterministicMath.cos
import com.fcmobile.core.DeterministicMath.sin
import com.fcmobile.core.DeterministicMath.sqrt

/**
 * Minimal 3-vector, mirrored from engine/src/core/vec3.ts.
 *
 * Pitch convention:
 *   x = along the length  [0 .. PITCH_LENGTH]
 *   y = UP                (0 = turf surface)
 *   z = along the width   [0 .. PITCH_WIDTH]
 * Units are SI throughout: metres, m/s, m/s^2, radians.
 *
 * A data class of Doubles rather than a pooled struct: it keeps the port
 * line-for-line comparable with the TypeScript. If Simpleperf shows GC pressure
 * from allocation in the hot loop, swap this for a pooled mutable type — call
 * sites will not change.
 */
data class Vec3(val x: Double, val y: Double, val z: Double) {
    operator fun plus(o: Vec3) = Vec3(x + o.x, y + o.y, z + o.z)
    operator fun minus(o: Vec3) = Vec3(x - o.x, y - o.y, z - o.z)
    operator fun times(s: Double) = Vec3(x * s, y * s, z * s)
}

val V3_ZERO = Vec3(0.0, 0.0, 0.0)

/** Vector on the pitch plane from a heading. 0 rad = +x, increasing towards +z. */
fun v3FromHeading(heading: Double, length: Double = 1.0): Vec3 =
    Vec3(cos(heading) * length, 0.0, sin(heading) * length)

fun dot(a: Vec3, b: Vec3): Double = a.x * b.x + a.y * b.y + a.z * b.z

fun cross(a: Vec3, b: Vec3): Vec3 = Vec3(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x,
)

fun lengthSq(a: Vec3): Double = a.x * a.x + a.y * a.y + a.z * a.z

fun length(a: Vec3): Double = sqrt(lengthSq(a))

fun normalize(a: Vec3): Vec3 {
    val l = length(a)
    return if (l < 1e-9) V3_ZERO else Vec3(a.x / l, a.y / l, a.z / l)
}

/** Planar distance, ignoring height. Most football queries want this. */
fun distanceXZ(a: Vec3, b: Vec3): Double {
    val dx = a.x - b.x
    val dz = a.z - b.z
    return sqrt(dx * dx + dz * dz)
}

fun headingOf(a: Vec3): Double = atan2(a.z, a.x)
