/**
 * passdiag — are passes actually reaching anyone?
 *
 * 54% of goal-line exits follow a pass, and defenders are a median 10 m from the
 * exit, so the ball is being put into space nobody occupies. This measures
 * completion directly: after each pass, who touches the ball next?
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

interface Outcome { completed: number; intercepted: number; outOfPlay: number; }
const byKind: Record<string, Outcome> = {};
const distByOutcome: Record<string, number[]> = { completed: [], intercepted: [], outOfPlay: [] };
let passes = 0;

const outcomeOf = (k: string): Outcome =>
  (byKind[k] ??= { completed: 0, intercepted: 0, outOfPlay: 0 });

for (let seed = 1; seed <= MATCHES; seed++) {
  const m = new MatchEngine(mk(seed));

  /** Pending pass: kind, passer id, passer team, origin, distance to target. */
  let pending: { kind: string; passerId: number; team: number; origin: { x: number; z: number } } | null = null;
  let pendingDist = 0;
  let lastTouchAtPass = -1;
  let prevX = m.ball.pos.x;

  for (let t = 0; t < 60 * 60 * 90 + 4000; t++) {
    const origin = { x: m.ball.pos.x, z: m.ball.pos.z };
    m.step();

    for (const e of m.drainEvents()) {
      if (e.kind === 'pass') {
        passes++;
        const kind = String(e.data['kind'] ?? 'pass');
        pending = { kind, passerId: m.ball.lastTouchId, team: Number(e.data['team']), origin };
        pendingDist = 0;
        lastTouchAtPass = m.ball.lastTouchId;
        continue;
      }

      if (pending !== null && (e.kind === 'corner' || e.kind === 'goalkick' || e.kind === 'throwin')) {
        outcomeOf(pending.kind).outOfPlay++;
        distByOutcome['outOfPlay']?.push(pendingDist);
        pending = null;
      }
    }

    if (pending !== null) {
      pendingDist = Math.max(
        pendingDist,
        Math.hypot(m.ball.pos.x - pending.origin.x, m.ball.pos.z - pending.origin.z),
      );

      // A change of lastTouchId means somebody got a foot to it.
      if (m.ball.lastTouchId !== lastTouchAtPass && m.ball.lastTouchId >= 0) {
        const toucher = m.players.find((p) => p.attr.id === m.ball.lastTouchId);
        const o = outcomeOf(pending.kind);
        if (toucher !== undefined && toucher.attr.team === pending.team) o.completed++;
        else o.intercepted++;
        const bucket = toucher !== undefined && toucher.attr.team === pending.team ? 'completed' : 'intercepted';
        distByOutcome[bucket]?.push(pendingDist);
        pending = null;
      } else if (Math.hypot(m.ball.vel.x, m.ball.vel.z) < 0.3 && m.ball.grounded) {
        // Nobody ever got there and it stopped dead: an abandoned pass.
        outcomeOf(pending.kind).outOfPlay++;
        distByOutcome['outOfPlay']?.push(pendingDist);
        pending = null;
      }
    }
    prevX = m.ball.pos.x;
    void prevX;
  }
}

const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
};

console.log(`${MATCHES} matches | passes ${passes} (${(passes / MATCHES).toFixed(0)}/match; real ~900-1100)`);
console.log('\nper pass kind — did anyone reach it?');
console.log('  kind          total   completed  intercepted  out of play');
let tc = 0, ti = 0, to = 0;
for (const [k, o] of Object.entries(byKind).sort((a, b) => (b[1].completed + b[1].intercepted + b[1].outOfPlay) - (a[1].completed + a[1].intercepted + a[1].outOfPlay))) {
  const tot = o.completed + o.intercepted + o.outOfPlay;
  tc += o.completed; ti += o.intercepted; to += o.outOfPlay;
  console.log(
    `  ${k.padEnd(12)} ${String(tot).padStart(5)}   ${String(o.completed).padStart(5)} (${((o.completed / tot) * 100).toFixed(0).padStart(3)}%)` +
    `   ${String(o.intercepted).padStart(5)} (${((o.intercepted / tot) * 100).toFixed(0).padStart(3)}%)` +
    `   ${String(o.outOfPlay).padStart(5)} (${((o.outOfPlay / tot) * 100).toFixed(0).padStart(3)}%)`,
  );
}
const all = tc + ti + to;
console.log(`  ${'TOTAL'.padEnd(12)} ${String(all).padStart(5)}   ${String(tc).padStart(5)} (${((tc / all) * 100).toFixed(0).padStart(3)}%)   ${String(ti).padStart(5)} (${((ti / all) * 100).toFixed(0).padStart(3)}%)   ${String(to).padStart(5)} (${((to / all) * 100).toFixed(0).padStart(3)}%)`);
console.log(`\n  real-world pass completion is ~80-85%`);

console.log('\nhow far the ball travelled from the passer, by outcome (m):');
for (const [k, a] of Object.entries(distByOutcome)) {
  if (a.length === 0) continue;
  console.log(`  ${k.padEnd(12)} median ${pct(a, 0.5).toFixed(1)}  p90 ${pct(a, 0.9).toFixed(1)}  max ${Math.max(...a).toFixed(1)}`);
}
void PITCH;
