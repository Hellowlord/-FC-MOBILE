/**
 * shotdiag — where do shots actually go?
 *
 * For every shot, follows the ball to the plane of the target goal and records
 * where it crosses: lateral miss and height. That separates "wide" from "over
 * the bar", which need opposite fixes.
 */
import { MatchEngine, type MatchConfig } from '../src/match/engine.js';
import { DIFFICULTY, PITCH } from '../src/config/tuning.js';

const MATCHES = Number(process.argv[2] ?? 8);

function mk(seed: number): MatchConfig {
  return {
    seed,
    halfLengthSec: 45 * 60,
    home: { name: 'H', shortName: 'H', formationId: '4-3-3', rating: 78, difficulty: DIFFICULTY.pro, human: false, primaryColour: '#f00', secondaryColour: '#fff' },
    away: { name: 'A', shortName: 'A', formationId: '4-4-2', rating: 78, difficulty: DIFFICULTY.pro, human: false, primaryColour: '#f00', secondaryColour: '#fff' },
  };
}

const lateral: number[] = [];
const height: number[] = [];
const dist: number[] = [];
let shots = 0;
let reached = 0;

const goalZ0 = PITCH.centreSpotZ - PITCH.goalWidth / 2;
const goalZ1 = PITCH.centreSpotZ + PITCH.goalWidth / 2;

for (let seed = 1; seed <= MATCHES; seed++) {
  const m = new MatchEngine(mk(seed));
  /** Team that most recently shot, and the x of the goal it was aimed at. */
  let trackGoalX: number | null = null;
  let trackDist = 0;
  let prevX = m.ball.pos.x;

  for (let t = 0; t < 60 * 60 * 90 + 4000; t++) {
    const origin = { x: m.ball.pos.x, z: m.ball.pos.z };
    m.step();

    for (const e of m.drainEvents()) {
      if (e.kind !== 'shot') continue;
      shots++;
      const team = Number(e.data['team']);
      trackGoalX = team === 0 ? PITCH.length : 0;
      trackDist = Math.abs(trackGoalX - origin.x);
    }

    if (trackGoalX === null) { prevX = m.ball.pos.x; continue; }

    const crossed =
      (trackGoalX === PITCH.length && m.ball.pos.x >= PITCH.length && prevX < PITCH.length) ||
      (trackGoalX === 0 && m.ball.pos.x <= 0 && prevX > 0);

    if (crossed) {
      reached++;
      const miss = m.ball.pos.z < goalZ0
        ? goalZ0 - m.ball.pos.z
        : m.ball.pos.z > goalZ1
          ? m.ball.pos.z - goalZ1
          : 0;
      lateral.push(miss);
      height.push(m.ball.pos.y);
      dist.push(trackDist);
      trackGoalX = null;
    } else if (m.ball.grounded || Math.abs(m.ball.pos.x - prevX) < 1e-9) {
      // Ball stopped or was gathered/deflected before reaching the goal plane.
      if (Math.hypot(m.ball.vel.x, m.ball.vel.z) < 0.5) trackGoalX = null;
    }
    prevX = m.ball.pos.x;
  }
}

const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
};

const wide = lateral.filter((v) => v > 0).length;
const overBar = height.filter((y) => y > PITCH.goalHeight).length;
const onTarget = lateral.filter((v, i) => v === 0 && (height[i] ?? 0) <= PITCH.goalHeight).length;

console.log(`${MATCHES} matches | shots ${shots} (${(shots / MATCHES).toFixed(1)}/match)`);
console.log(`shots that reached the goal plane: ${reached} (${((reached / Math.max(1, shots)) * 100).toFixed(0)}%)`);
console.log(`  -> ${(reached / MATCHES).toFixed(1)} per match; a real match has ~9 on target of ~25 shots`);
console.log(`\nof the ${reached} that reached the plane:`);
console.log(`  on target            ${onTarget}  ${((onTarget / Math.max(1, reached)) * 100).toFixed(0)}%`);
console.log(`  wide of the post     ${wide}  ${((wide / Math.max(1, reached)) * 100).toFixed(0)}%`);
console.log(`  over the bar         ${overBar}  ${((overBar / Math.max(1, reached)) * 100).toFixed(0)}%`);
console.log(`\nlateral miss when wide (m): median ${pct(lateral.filter((v) => v > 0), 0.5).toFixed(2)}  p90 ${pct(lateral.filter((v) => v > 0), 0.9).toFixed(2)}`);
console.log(`height at the plane (m):    median ${pct(height, 0.5).toFixed(2)}  p90 ${pct(height, 0.9).toFixed(2)}  max ${Math.max(...height).toFixed(2)}`);
console.log(`  (bar is at ${PITCH.goalHeight} m)`);
console.log(`shot distance (m):          median ${pct(dist, 0.5).toFixed(1)}  p90 ${pct(dist, 0.9).toFixed(1)}`);
