import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detSin, detCos, detSincos, detAtan, detAtan2, detSqrt, wrapPi, angleDelta, PI, TWO_PI } from '../src/core/math.js';

/**
 * These tests do two different jobs, and it matters which is which:
 *
 *  - ACCURACY: our polynomials must agree with the platform libm to ~1e-12.
 *    That is checked against Math.sin / Math.cos / Math.atan2 below.
 *  - DETERMINISM: the functions must not CALL libm at all, otherwise a JVM
 *    port of the same coefficients will disagree in the last bits and a
 *    60 Hz match will drift. That is checked by construction (no libm in
 *    math.ts) plus the golden vectors in tools/golden-vectors.ts.
 */

const ANGLES: number[] = [];
for (let i = 0; i <= 720; i++) ANGLES.push((i / 720) * TWO_PI);
for (const a of [0, PI / 6, PI / 4, PI / 3, PI / 2, PI, 1.5 * PI, TWO_PI, -PI / 4, 7.3, -11.9]) {
  ANGLES.push(a);
}

test('detSin matches Math.sin to 1e-12', () => {
  let worst = 0;
  for (const a of ANGLES) worst = Math.max(worst, Math.abs(detSin(a) - Math.sin(a)));
  assert.ok(worst < 1e-12, `worst sin error ${worst}`);
});

test('detCos matches Math.cos to 1e-12', () => {
  let worst = 0;
  for (const a of ANGLES) worst = Math.max(worst, Math.abs(detCos(a) - Math.cos(a)));
  assert.ok(worst < 1e-12, `worst cos error ${worst}`);
});

test('detSincos is consistent with detSin/detCos', () => {
  for (const a of ANGLES) {
    const { s, c } = detSincos(a);
    assert.ok(Math.abs(s - detSin(a)) < 1e-15);
    assert.ok(Math.abs(c - detCos(a)) < 1e-15);
  }
});

test('Pythagorean identity holds', () => {
  for (const a of ANGLES) {
    const { s, c } = detSincos(a);
    assert.ok(Math.abs(s * s + c * c - 1) < 1e-12, `identity failed at ${a}: ${s * s + c * c}`);
  }
});

test('detAtan2 matches Math.atan2 to 1e-12', () => {
  const vals = [-3, -1.5, -1, -0.5, -0.1, 0, 0.1, 0.5, 1, 1.5, 3];
  let worst = 0;
  for (const y of vals) {
    for (const x of vals) {
      if (x === 0 && y === 0) continue;
      worst = Math.max(worst, Math.abs(detAtan2(y, x) - Math.atan2(y, x)));
    }
  }
  assert.ok(worst < 1e-12, `worst atan2 error ${worst}`);
});

test('detAtan matches Math.atan', () => {
  const vals = [-100, -8, -2, -1, -0.3, 0, 0.3, 1, 2, 8, 100];
  let worst = 0;
  for (const t of vals) worst = Math.max(worst, Math.abs(detAtan(t) - Math.atan(t)));
  assert.ok(worst < 1e-12, `worst atan error ${worst}`);
});

test('detSqrt never returns NaN for negative input', () => {
  assert.equal(detSqrt(-4), 0);
  assert.equal(detSqrt(9), 3);
});

test('wrapPi keeps angles in (-PI, PI]', () => {
  for (const a of [0, PI, -PI, 3 * PI, -3 * PI, 100, -100]) {
    const w = wrapPi(a);
    assert.ok(w > -PI - 1e-12 && w <= PI + 1e-12, `wrapPi(${a}) = ${w}`);
  }
});

test('angleDelta takes the short way round', () => {
  // From 3.0 rad to -3.0 rad the short way is a small negative turn, not ~6 rad.
  assert.ok(Math.abs(angleDelta(3.0, -3.0)) < 0.4, `got ${angleDelta(3.0, -3.0)}`);
  assert.ok(Math.abs(angleDelta(0, PI / 2) - PI / 2) < 1e-12);
});
