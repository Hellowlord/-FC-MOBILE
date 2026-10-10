/**
 * Vec3 — minimal 3-vector used by the whole core.
 *
 * Convention for the pitch (see docs/MATCH-SIM-SPEC.md):
 *   x = along the length of the pitch   [0 .. PITCH_LENGTH]
 *   y = UP                              (0 = turf surface)
 *   z = along the width of the pitch    [0 .. PITCH_WIDTH]
 *
 * Units are SI: metres, metres/second, metres/second^2, radians.
 *
 * Deliberately plain data + free functions rather than a class with chained
 * methods: it ports 1:1 to a Kotlin `data class` / object of top-level
 * functions, and it keeps the hot loop allocation-light. If profiling on a
 * low-end device shows GC pressure, swap the implementation for a pooled
 * struct — the call sites do not change.
 */

import { detAtan2, detCos, detSin, detSqrt } from './math.js';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const V3_ZERO: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 0 });

export function v3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

/** Vector on the pitch plane (y = 0) built from a heading in radians. */
export function v3FromHeading(heading: number, length = 1): Vec3 {
  // heading 0 points down +x; heading increases towards +z.
  return { x: detCos(heading) * length, y: 0, z: detSin(heading) * length };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function lengthSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function length(a: Vec3): number {
  return detSqrt(lengthSq(a));
}

export function distance(a: Vec3, b: Vec3): number {
  return length(sub(a, b));
}

export function distanceSq(a: Vec3, b: Vec3): number {
  return lengthSq(sub(a, b));
}

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  if (l < 1e-9) return { x: 0, y: 0, z: 0 };
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

export function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

/** Heading (radians) of the planar component, 0 = +x, increasing towards +z. */
export function headingOf(a: Vec3): number {
  return detAtan2(a.z, a.x);
}

/** Planar (x,z) distance, ignoring height. Most football queries want this. */
export function distanceXZ(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return detSqrt(dx * dx + dz * dz);
}

export function distanceSqXZ(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

export function withY(a: Vec3, y: number): Vec3 {
  return { x: a.x, y, z: a.z };
}

export function clampToBox(a: Vec3, minX: number, maxX: number, minZ: number, maxZ: number): Vec3 {
  return {
    x: a.x < minX ? minX : a.x > maxX ? maxX : a.x,
    y: a.y,
    z: a.z < minZ ? minZ : a.z > maxZ ? maxZ : a.z,
  };
}

export function approxEqual(a: Vec3, b: Vec3, eps = 1e-9): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.z - b.z) <= eps;
}

export function toFixedArray(a: Vec3, digits = 9): [number, number, number] {
  const f = (n: number) => Number(n.toFixed(digits));
  return [f(a.x), f(a.y), f(a.z)];
}
