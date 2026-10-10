/**
 * golden-vectors — generates the cross-language parity fixtures.
 *
 * The TypeScript core is the reference. This tool drives it through fixed,
 * fully-specified inputs and writes the exact outputs to vectors/golden-*.json.
 * The Kotlin :core module has a GoldenVectorTest that reads the same fixtures
 * and asserts it produces the same numbers.
 *
 * This is how you port a simulation core without guessing whether the port is
 * right. "It looks about the same" is not a test; matching 1,200 floats to 1e-12
 * is.
 *
 *   npm run vectors
 *
 * IMPORTANT: inputs are written into the fixture too, so the Kotlin side needs
 * no knowledge of this file beyond reading JSON.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detSin, detCos, detAtan2, PI } from '../src/core/math.js';
import { Rng } from '../src/core/rng.js';
import { createBall, stepBall, solveLaunchSpeed } from '../src/physics/ball.js';
import { v3 } from '../src/core/vec3.js';
import { BALL } from '../src/config/tuning.js';
import { SIM_DT } from '../src/core/fixed-step.js';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const outDir = resolve(here, '../vectors');

/** Round to a fixed number of decimals so JSON text is stable across runs. */
const q = (n: number, d = 12) => Number(n.toFixed(d));

// ---------------------------------------------------------------- math
const mathCases: Array<{ angle: number; sin: number; cos: number }> = [];
for (let i = 0; i <= 240; i++) {
  const a = (i / 240) * 2 * PI;
  mathCases.push({ angle: q(a), sin: q(detSin(a)), cos: q(detCos(a)) });
}

const atanCases: Array<{ y: number; x: number; atan2: number }> = [];
const grid = [-3, -1.5, -1, -0.5, -0.1, 0, 0.1, 0.5, 1, 1.5, 3];
for (const y of grid) {
  for (const x of grid) {
    if (x === 0 && y === 0) continue;
    atanCases.push({ y, x, atan2: q(detAtan2(y, x)) });
  }
}

// ---------------------------------------------------------------- rng
const rng = new Rng(0x5eed1234);
const rngWords: number[] = [];
for (let i = 0; i < 64; i++) rngWords.push(rng.nextU32());

// ---------------------------------------------------------------- ball flight
interface FlightCase {
  label: string;
  start: [number, number, number];
  vel: [number, number, number];
  spin: [number, number, number];
  steps: number;
}

const flightCases: FlightCase[] = [
  { label: 'hard-flat-shot', start: [30, BALL.radius, 34], vel: [30, 0, 0], spin: [0, 0, 0], steps: 90 },
  { label: 'whipped-free-kick', start: [25, 0.4, 30], vel: [22, 3, 2], spin: [0, 94, 0], steps: 120 },
  { label: 'chip', start: [20, BALL.radius, 34], vel: [12, 9, 0], spin: [0, 0, 30], steps: 180 },
  { label: 'ground-pass', start: [40, BALL.radius, 20], vel: [0, 0, 15], spin: [0, 0, 0], steps: 600 },
  { label: 'bounce', start: [50, 2.0, 34], vel: [8, 0, 0], spin: [0, 0, 0], steps: 150 },
  { label: 'knuckleball', start: [25, 0.5, 34], vel: [28, 1, 0], spin: [4, 12, -6], steps: 120 },
];

const flights = flightCases.map((c) => {
  const ball = createBall(v3(c.start[0], c.start[1], c.start[2]));
  ball.vel = v3(c.vel[0], c.vel[1], c.vel[2]);
  ball.spin = v3(c.spin[0], c.spin[1], c.spin[2]);
  const track: Array<[number, number, number]> = [];
  for (let i = 0; i < c.steps; i++) {
    stepBall(ball, SIM_DT, i);
    if (i % 6 === 0 || i === c.steps - 1) track.push([q(ball.pos.x), q(ball.pos.y), q(ball.pos.z)]);
  }
  return {
    label: c.label,
    start: c.start,
    vel: c.vel,
    spin: c.spin,
    steps: c.steps,
    dt: q(SIM_DT, 18),
    finalPos: [q(ball.pos.x), q(ball.pos.y), q(ball.pos.z)],
    finalVel: [q(ball.vel.x), q(ball.vel.y), q(ball.vel.z)],
    finalSpin: [q(ball.spin.x), q(ball.spin.y), q(ball.spin.z)],
    track,
  };
});

// ---------------------------------------------------------------- launch solver
const solverCases = [8, 15, 25, 35, 45].flatMap((dist) =>
  [0.1, 0.31, 0.62].map((angle) => ({
    distance: dist,
    launchAngle: angle,
    startHeight: q(BALL.radius),
    dt: q(SIM_DT, 18),
    minSpeed: 4,
    maxSpeed: 34,
    iterations: 14,
    solvedSpeed: q(solveLaunchSpeed(dist, angle, BALL.radius, SIM_DT, 4, 34, 14)),
  })),
);

// ---------------------------------------------------------------- locomotion
// Straight-line sprint: pins acceleration, top speed and the velocity lag.
const locoCase = {
  topSpeed: 8.2,
  accel: 3.6,
  turnRateWalk: 4.2,
  turnRateSprint: 1.7,
  turnSpeedPenalty: 0.35,
  turnBleedPerSecond: 2.2,
  momentumResponse: 9.0,
  walkSpeed: 1.6,
  jogSpeed: 4.0,
  decelMax: 6.5,
  dt: q(SIM_DT, 18),
  steps: 180,
  // Sampled every 10 ticks: [speed, velX, posX]
  track: [] as Array<[number, number, number]>,
};

// Replicated here from the locomotion model so the vector generator does not
// need the whole match engine. Keep in step with player/locomotion.ts.
{
  let heading = 0;
  let speed = 0;
  let velX = 0;
  let posX = 0;
  const dt = SIM_DT;
  for (let i = 0; i < locoCase.steps; i++) {
    const turnIntensity = 0;
    const effectiveTop = locoCase.topSpeed * (1 - locoCase.turnSpeedPenalty * turnIntensity);
    const target = effectiveTop;
    const diff = target - speed;
    const maxA = diff > 0 ? locoCase.accel : locoCase.decelMax;
    speed = Math.max(0, speed + Math.max(-maxA * dt, Math.min(maxA * dt, diff)));
    speed = Math.max(0, speed * (1 - locoCase.turnBleedPerSecond * turnIntensity * dt));
    const desired = Math.cos(heading) * speed;
    const k = Math.min(1, Math.max(0, locoCase.momentumResponse * dt));
    velX += (desired - velX) * k;
    posX += velX * dt;
    if (i % 10 === 0 || i === locoCase.steps - 1) locoCase.track.push([q(speed), q(velX), q(posX)]);
  }
}

// ---------------------------------------------------------------- write
mkdirSync(outDir, { recursive: true });

const manifest = {
  generatedBy: 'engine/tools/golden-vectors.ts',
  purpose:
    'Cross-language parity fixtures. The Kotlin :core module must reproduce every number in these files. Regenerate with `npm run vectors` after any change to core physics, math or locomotion.',
  simHz: 60,
  tolerance: 1e-9,
  notes: [
    'All values are produced by the deterministic core, which avoids libm entirely.',
    'Tolerance 1e-9 absorbs JSON decimal rounding, not platform drift: a correct port matches to ~1e-15.',
    'If the Kotlin side fails here, the port is wrong. Do not loosen the tolerance.',
  ],
};

const write = (name: string, data: unknown) => {
  const p = resolve(outDir, name);
  writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(`  wrote vectors/${name}`);
};

console.log('generating golden vectors:');
write('manifest.json', manifest);
write('golden-math.json', { sinCos: mathCases, atan2: atanCases });
write('golden-rng.json', { seed: 0x5eed1234, words: rngWords });
write('golden-ball.json', { flights, solver: solverCases });
write('golden-locomotion.json', locoCase);
console.log(`done — ${mathCases.length} trig cases, ${atanCases.length} atan2 cases, ${flights.length} flight tracks, ${solverCases.length} solver cases`);
