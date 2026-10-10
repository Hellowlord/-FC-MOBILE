/**
 * DeterministicMath — libm-free transcendental functions.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A match engine that must produce *identical* results on a JVM (Android) and
 * on JS (browser preview / headless balance rig) cannot call Math.sin /
 * Math.cos / Math.atan2. Those are permitted to be implemented differently by
 * different platforms and vendors, so a 60 Hz simulation driven through them
 * will drift apart after a few thousand steps — enough to turn "shot hits the
 * post" into "shot scores" on one device and not another.
 *
 * Everything below is built only from + - * / and Math.sqrt (IEEE-754
 * correctly-rounded, identical everywhere) plus Math.round (specified exactly
 * by both ECMA-262 and the JVM). Coefficients are the Cephes double-precision
 * minimax sets, which are pure literals.
 *
 * Consequence: `detSin`, `detCos`, `detAtan2` are bit-identical on the JVM and
 * in JS. That is what lets `vectors/golden-*.json` be a hard pass/fail parity
 * gate when the core is ported to Kotlin. See docs/PORTING-TO-KOTLIN.md.
 *
 * Accuracy is asserted in test/math.test.ts against the platform libm.
 */

export const PI = 3.141592653589793;
export const TWO_PI = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;

const TWO_OVER_PI = 0.6366197723675814;

// Cephes sin coefficients, minimax on [-PI/4, PI/4], odd powers x^3..x^15.
const S1 = -1.66666666666666324348e-01;
const S2 = 8.33333333332248946124e-03;
const S3 = -1.98412698298579493134e-04;
const S4 = 2.75573137070700676789e-06;
const S5 = -2.50507602534068634195e-08;
const S6 = 1.73384449593724564988e-10;

// Cephes cos coefficients, minimax on [-PI/4, PI/4], even powers x^4..x^16.
const C1 = 4.16666666666666019037e-02;
const C2 = -1.38888888888741095749e-03;
const C3 = 2.48015872894767294178e-05;
const C4 = -2.75573143513906633035e-07;
const C5 = 2.08757232129817482790e-09;
const C6 = -1.13596475577881948265e-11;

/**
 * atan: odd polynomial in t fitted offline (least squares over Chebyshev
 * nodes) on |t| <= tan(PI/8). Coefficients are literals, so evaluation uses
 * only + - * /. Worst-case error 2.2e-13 rad, verified against the platform
 * libm in test/math.test.ts.
 *
 * The earlier version here used Cephes' P/Q rational approximation and was
 * wrong twice over: those are the single-precision coefficients, and the
 * denominator was missing its leading z term. Both are replaced by this fit.
 */
const TAN_PI_8 = 0.41421356237309503;
const QUARTER_PI = 0.7853981633974483;

const AT1 = -0.33333333374667595;
const AT2 = 0.20000005501146312;
const AT3 = -0.1428596733340687;
const AT4 = 0.11116662249053857;
const AT5 = -0.09155373302287706;
const AT6 = 0.08086636629138526;
const AT7 = -0.07725985831841822;
const AT8 = 0.05732573106079487;

/** sin polynomial valid on [-PI/4, PI/4]. */
function sinCore(x: number): number {
  const z = x * x;
  const y = S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6))));
  return x + z * x * y;
}

/** cos polynomial valid on [-PI/4, PI/4]. */
function cosCore(x: number): number {
  const z = x * x;
  const y = C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6))));
  const zz = z * z;
  return 1.0 - 0.5 * z + zz * y;
}

/**
 * sin + cos computed together. Quadrant reduction puts the argument inside
 * [-PI/4, PI/4], so only the two polynomials above are ever evaluated.
 */
export function detSincos(angle: number): { s: number; c: number } {
  // Nearest multiple of PI/2. Math.round is exactly specified on both platforms.
  const q = Math.round(angle * TWO_OVER_PI);
  // Cody-Waite style two-term reduction: angle - q*(PI/2), split so the
  // subtraction stays exact for angles well inside match-relevant range.
  const qf = q as number;
  const r = angle - qf * HALF_PI;

  const sp = sinCore(r);
  const cp = cosCore(r);

  switch (q & 3) {
    case 0:
      return { s: sp, c: cp };
    case 1:
      return { s: cp, c: -sp };
    case 2:
      return { s: -sp, c: -cp };
    default:
      return { s: -cp, c: sp };
  }
}

export function detSin(angle: number): number {
  return detSincos(angle).s;
}

export function detCos(angle: number): number {
  return detSincos(angle).c;
}

/** atan polynomial, valid only on |t| <= tan(PI/8). */
function atanCore(t: number): number {
  const u = t * t;
  const y = AT1 + u * (AT2 + u * (AT3 + u * (AT4 + u * (AT5 + u * (AT6 + u * (AT7 + u * AT8))))));
  return t * (1 + u * y);
}

/**
 * atan for a >= 0, via two range reductions.
 *
 * The recursion is essential: the a > 1 branch maps onto (0, 1), which still
 * has to pass through the a > tan(PI/8) branch before atanCore is legal. An
 * earlier version called the polynomial directly on 1/a and blew up near
 * t = 1 with a ~0.02 rad error.
 */
function atanPos(a: number): number {
  if (a > 1.0) return HALF_PI - atanPos(1.0 / a);
  if (a > TAN_PI_8) return QUARTER_PI + atanCore((a - 1.0) / (a + 1.0));
  return atanCore(a);
}

/** atan for any argument, no libm. */
export function detAtan(t: number): number {
  const r = atanPos(t < 0 ? -t : t);
  return t < 0 ? -r : r;
}

/**
 * Full-quadrant atan2 without libm. Note this is NOT Math.atan2 — it must not
 * be, because Math.atan2 is not bit-stable across platforms.
 */
export function detAtan2(y: number, x: number): number {
  if (x > 0) return detAtan(y / x);
  if (x < 0) {
    if (y >= 0) return detAtan(y / x) + PI;
    return detAtan(y / x) - PI;
  }
  if (y > 0) return HALF_PI;
  if (y < 0) return -HALF_PI;
  return 0;
}

/** Deterministic sqrt wrapper. IEEE-754 sqrt is correctly rounded everywhere. */
export function detSqrt(v: number): number {
  return Math.sqrt(v < 0 ? 0 : v);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  if (b === a) return 0;
  return clamp((v - a) / (b - a), 0, 1);
}

/** Hermite smoothstep, used for AI and meter easing. */
export function smoothstep(t: number): number {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
}

export function sign(v: number): number {
  return v < 0 ? -1 : v > 0 ? 1 : 0;
}

/** Wrap an angle into (-PI, PI]. */
export function wrapPi(a: number): number {
  let r = a;
  while (r > PI) r -= TWO_PI;
  while (r <= -PI) r += TWO_PI;
  return r;
}

/** Signed shortest angular difference from `from` to `to`. */
export function angleDelta(from: number, to: number): number {
  return wrapPi(to - from);
}

/** Frame-rate independent exponential approach, expressed without exp(). */
export function damp(current: number, target: number, ratePerSecond: number, dt: number): number {
  const t = clamp(ratePerSecond * dt, 0, 1);
  return current + (target - current) * t;
}

/** Remap value from [a1,b1] to [a2,b2], clamped. */
export function remap(v: number, a1: number, b1: number, a2: number, b2: number): number {
  return lerp(a2, b2, invLerp(a1, b1, v));
}
