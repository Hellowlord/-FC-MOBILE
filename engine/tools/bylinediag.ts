/**
 * bylinediag — why are corners ~13x too low?
 *
 * The Law 16/17 rule is correct now, so a corner requires a DEFENDER to be the
 * last touch over his own goal line. Measured: 0.8 corners and ~57 goal kicks a
 * match against a real ~11 and ~14. This records, for every goal-line
 * out-of-play, who the engine thought touched it last and whether a defender was
 * even in a position to.
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

/** Last touch, split by whether it was the line's defending side. */
const toucherSide: Record<string, number> = {};
/** Role of the last toucher. */
const toucherRole: Record<string, number> = {};
/** Nearest defender of the line-owning team to the exit point, in metres. */
const nearestDefender: number[] = [];
/** How deep in his own half the exit happened, from the goal line. */
const exitDepth: number[] = [];
let corners = 0;
let goalKicks = 0;

for (let seed = 1; seed <= MATCHES; seed++) {
  const m = new MatchEngine(mk(seed));
  let prevX = m.ball.pos.x;
  let prevZ = m.ball.pos.z;

  for (let t = 0; t < 60 * 60 * 90 + 4000; t++) {
    m.step();

    for (const e of m.drainEvents()) {
      if (e.kind !== 'corner' && e.kind !== 'goalkick') continue;
      if (e.kind === 'corner') corners++;
      else goalKicks++;

      // The exit point: the engine has already reset the ball to restartSpot,
      // so use last tick's position. One tick of travel, close enough to place
      // the event on the pitch.
      const exitX = prevX;
      const overFarLine = exitX > PITCH.centreSpotX;
      const lineOwner = overFarLine ? 1 : 0;
      const goalX = lineOwner === 1 ? PITCH.length : 0;

      const toucher = m.players.find((p) => p.attr.id === m.ball.lastTouchId);
      const side =
        m.lastTouchTeam === lineOwner ? 'DEFENDER (should be a corner)'
        : m.lastTouchTeam === 1 - lineOwner ? 'ATTACKER (goal kick, correct)'
        : 'UNKNOWN';
      toucherSide[side] = (toucherSide[side] ?? 0) + 1;

      const role = toucher === undefined ? 'none' : toucher.role === 1 ? 'keeper' : 'outfield';
      toucherRole[role] = (toucherRole[role] ?? 0) + 1;

      // Was a defender of the line-owning side close enough to have played it?
      let best = Infinity;
      for (const p of m.players) {
        if (p.attr.team !== lineOwner || p.role === 1) continue;
        const d = Math.hypot(p.loco.pos.x - exitX, p.loco.pos.z - prevZ);
        if (d < best) best = d;
      }
      nearestDefender.push(best);
      exitDepth.push(Math.abs(exitX - goalX));
    }
    prevX = m.ball.pos.x;
    prevZ = m.ball.pos.z;
  }
}

const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
};
const total = corners + goalKicks;

console.log(`${MATCHES} matches | goal-line out-of-play ${total} (${(total / MATCHES).toFixed(1)}/match)`);
console.log(`  corners   ${corners}  (${(corners / MATCHES).toFixed(1)}/match; real ~11)`);
console.log(`  goal kicks ${goalKicks}  (${(goalKicks / MATCHES).toFixed(1)}/match; real ~14)`);

console.log('\nwho the engine recorded as the last touch:');
for (const [k, v] of Object.entries(toucherSide).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(34)} ${String(v).padStart(4)}  ${((v / Math.max(1, total)) * 100).toFixed(0)}%`);
}
console.log('\nlast toucher role:');
for (const [k, v] of Object.entries(toucherRole).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(34)} ${String(v).padStart(4)}  ${((v / Math.max(1, total)) * 100).toFixed(0)}%`);
}

console.log(`\nnearest outfield defender of the line-owning team to the exit (m):`);
console.log(`  median ${pct(nearestDefender, 0.5).toFixed(1)}  p10 ${pct(nearestDefender, 0.1).toFixed(1)}  p90 ${pct(nearestDefender, 0.9).toFixed(1)}`);
const close = nearestDefender.filter((d) => d < 2.5).length;
console.log(`  within 2.5 m (should usually have touched it): ${close}  ${((close / Math.max(1, nearestDefender.length)) * 100).toFixed(0)}%`);
console.log(`\nexit depth from the goal line (m): median ${pct(exitDepth, 0.5).toFixed(1)}  p90 ${pct(exitDepth, 0.9).toFixed(1)}`);
