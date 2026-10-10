/**
 * goaldiag — why is the goal rate ~4x too high?
 *
 * Measures the state of the defending side at the exact tick a goal is
 * detected, rather than guessing at causes.
 */
import { MatchEngine, type MatchConfig } from '../src/match/engine.js';
import { DIFFICULTY, PITCH } from '../src/config/tuning.js';

const MATCHES = Number(process.argv[2] ?? 8);

function mk(seed: number): MatchConfig {
  return {
    seed,
    halfLengthSec: 45 * 60,
    home: { name: 'H', shortName: 'H', formationId: '4-3-3', rating: 78, difficulty: DIFFICULTY.pro, human: false, primaryColour: '#f00', secondaryColour: '#fff' },
    away: { name: 'A', shortName: 'A', formationId: '4-4-2', rating: 78, difficulty: DIFFICULTY.pro, human: false, primaryColour: '#00f', secondaryColour: '#fff' },
  };
}

const gkDepthFromLine: number[] = [];
const gkLateralOffset: number[] = [];
const defendersNearLine: number[] = [];
const ballSpeedAtGoal: number[] = [];
const lastKick: Record<string, number> = {};
let goals = 0;
let shots = 0;
let lineCrossings = 0;
let lineCrossingsInMouth = 0;
/** What the last kick was before the ball crossed a goal line, wide of the mouth. */
const crossingCause: Record<string, number> = {};
/** How fast the ball was moving when it crossed, wide of the mouth. */
const crossingSpeed: number[] = [];
/** Distance from the crossing point to the nearest corner flag. */
const crossingDistFromGoalMouth: number[] = [];
/** Corner vs goal kick, straight from the engine's own restart decisions. */
const restartKind: Record<string, number> = {};
/** Distance from the nearest player to the ball as it crosses the line. */
const crossingNearestPlayer: number[] = [];
/** Ticks since the last recorded kick, so "NO-KICK" can be split finely. */
const crossingTicksSinceKick: number[] = [];

for (let seed = 1; seed <= MATCHES; seed++) {
  const m = new MatchEngine(mk(seed));
  let lastKickKind = 'NONE';
  let lastKickTick = -9999;

  let prevX = m.ball.pos.x;
  for (let t = 0; t < 60 * 60 * 90 + 4000; t++) {
    m.step();

    // Count every crossing of either goal line, in or out of the mouth.
    //
    // NOTE: this counter is a lower bound, not a truth. step() calls
    // checkOutOfBounds(), which teleports the ball back to restartSpot INSIDE
    // the pitch before it returns, so a ball that genuinely left play is
    // usually invisible here by the time we look. Only a ball still sitting in
    // the 0.11 m band between the line and line+radius gets caught. The
    // authoritative byline count is the engine's own corner/goalkick events,
    // printed below -- use those, not this number.
    const crossed = (m.ball.pos.x > PITCH.length && prevX <= PITCH.length) || (m.ball.pos.x < 0 && prevX >= 0);
    if (crossed) {
      lineCrossings++;
      const gz0 = PITCH.centreSpotZ - PITCH.goalWidth / 2;
      const gz1 = PITCH.centreSpotZ + PITCH.goalWidth / 2;
      const inMouth = m.ball.pos.z > gz0 && m.ball.pos.z < gz1;
      if (inMouth) lineCrossingsInMouth++;
      else {
        const cause = t - lastKickTick < 200 ? lastKickKind : 'NO-KICK';
        crossingCause[cause] = (crossingCause[cause] ?? 0) + 1;
        crossingSpeed.push(Math.hypot(m.ball.vel.x, m.ball.vel.z));
        crossingDistFromGoalMouth.push(
          m.ball.pos.z < gz0 ? gz0 - m.ball.pos.z : m.ball.pos.z - gz1,
        );
        // Is a player right there (dribbled out) or is this a ball nobody
        // could reach (over-hit pass)? Measured before the engine resets.
        let nearest = Infinity;
        for (const pl of m.players) {
          const d = Math.hypot(pl.loco.pos.x - m.ball.pos.x, pl.loco.pos.z - m.ball.pos.z);
          if (d < nearest) nearest = d;
        }
        crossingNearestPlayer.push(nearest);
        crossingTicksSinceKick.push(t - lastKickTick);
      }
    }
    prevX = m.ball.pos.x;

    for (const e of m.drainEvents()) {
      if (e.kind === 'pass' || e.kind === 'shot') {
        lastKickKind = e.kind === 'shot' ? 'SHOT' : String(e.data['kind'] ?? 'pass').toUpperCase();
        lastKickTick = t;
      }
      if (e.kind === 'shot') shots++;
      if (e.kind === 'corner' || e.kind === 'goalkick' || e.kind === 'throwin') {
        const team = Number(e.data['team']);
        const key = `${e.kind}:${team === 0 ? 'home' : team === 1 ? 'away' : '?'}`;
        restartKind[key] = (restartKind[key] ?? 0) + 1;
      }
      if (e.kind !== 'goal') continue;

      goals++;
      const team = Number(e.data['team']);
      const goalX = team === 0 ? PITCH.length : 0;
      const attackDir = team === 0 ? 1 : -1;

      const gk = m.players.find((p) => p.role === 1 && p.attr.team === 1 - team);
      if (gk !== undefined) {
        gkDepthFromLine.push(Math.abs(gk.loco.pos.x - goalX));
        gkLateralOffset.push(Math.abs(gk.loco.pos.z - m.ball.pos.z));
      }
      defendersNearLine.push(
        m.players.filter((p) => p.attr.team === 1 - team && p.role === 0 && Math.abs(p.loco.pos.x - goalX) < 16.5).length,
      );
      ballSpeedAtGoal.push(Math.hypot(m.ball.vel.x, m.ball.vel.z));

      const key = t - lastKickTick < 200 ? lastKickKind : 'NO-KICK';
      lastKick[key] = (lastKick[key] ?? 0) + 1;
      void attackDir;
    }
  }
}

const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length * p)] ?? 0;
};

console.log(`${MATCHES} matches | goals ${goals} (${(goals / MATCHES).toFixed(1)}/match) | shots ${shots} (${(shots / MATCHES).toFixed(1)}/match)`);
console.log(`\ngoal-line crossings seen by this tool: ${lineCrossings} (UNDERCOUNT -- see note in source)`);
console.log(`  the authoritative byline count is corners + goal kicks below`);

console.log('\nlast kick before goal:');
for (const [k, v] of Object.entries(lastKick).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(16)} ${String(v).padStart(4)}  ${((v / goals) * 100).toFixed(0)}%`);
}

console.log('\nkeeper at the moment of the goal:');
console.log(`  depth off his line (m):  median ${pct(gkDepthFromLine, 0.5).toFixed(2)}  p90 ${pct(gkDepthFromLine, 0.9).toFixed(2)}  max ${Math.max(...gkDepthFromLine).toFixed(2)}`);
console.log(`  lateral miss (m):        median ${pct(gkLateralOffset, 0.5).toFixed(2)}  p90 ${pct(gkLateralOffset, 0.9).toFixed(2)}  max ${Math.max(...gkLateralOffset).toFixed(2)}`);
console.log(`  (goal is ${PITCH.goalWidth} m wide, so a keeper can cover ~3.7 m of lateral miss)`);

console.log(`\ndefenders inside their own penalty area: median ${pct(defendersNearLine, 0.5)}  min ${Math.min(...defendersNearLine)}`);
console.log(`ball speed at goal (m/s): median ${pct(ballSpeedAtGoal, 0.5).toFixed(1)}  p90 ${pct(ballSpeedAtGoal, 0.9).toFixed(1)}`);

const totalWide = Object.values(crossingCause).reduce((a, b) => a + b, 0);
console.log(`\n=== ${totalWide} wide-of-mouth crossings (${(totalWide / MATCHES).toFixed(1)}/match; real football ~10 corners + ~10 goal kicks) ===`);
console.log('last kick before the ball went out:');
for (const [k, v] of Object.entries(crossingCause).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(16)} ${String(v).padStart(4)}  ${((v / Math.max(1, totalWide)) * 100).toFixed(0)}%`);
}
console.log(`\nball speed crossing the line (m/s): median ${pct(crossingSpeed, 0.5).toFixed(1)}  p90 ${pct(crossingSpeed, 0.9).toFixed(1)}  max ${Math.max(...crossingSpeed).toFixed(1)}`);
console.log(`how far wide of the goal mouth (m):  median ${pct(crossingDistFromGoalMouth, 0.5).toFixed(1)}  p90 ${pct(crossingDistFromGoalMouth, 0.9).toFixed(1)}  max ${Math.max(...crossingDistFromGoalMouth).toFixed(1)}`);

console.log('\nrestarts awarded by the engine (per match):');
for (const [k, v] of Object.entries(restartKind).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(18)} ${(v / MATCHES).toFixed(1)}`);
}

console.log(`\nnearest player to the ball as it crossed (m): median ${pct(crossingNearestPlayer, 0.5).toFixed(1)}  p10 ${pct(crossingNearestPlayer, 0.1).toFixed(1)}  p90 ${pct(crossingNearestPlayer, 0.9).toFixed(1)}`);
const dribbled = crossingNearestPlayer.filter((d) => d < 3).length;
const loose = crossingNearestPlayer.filter((d) => d > 10).length;
console.log(`  within 3 m (dribbled out):  ${dribbled}  ${((dribbled / Math.max(1, totalWide)) * 100).toFixed(0)}%`);
console.log(`  beyond 10 m (unreachable):  ${loose}  ${((loose / Math.max(1, totalWide)) * 100).toFixed(0)}%`);
console.log(`\nticks since last kick at the crossing: median ${pct(crossingTicksSinceKick, 0.5).toFixed(0)}  p90 ${pct(crossingTicksSinceKick, 0.9).toFixed(0)}`);
