/**
 * diagnose — one match, full event accounting. Temporary debugging rig.
 */
import { MatchEngine, type MatchConfig } from '../src/match/engine.js';
import { DIFFICULTY, PITCH } from '../src/config/tuning.js';

const cfg: MatchConfig = {
  seed: Number(process.argv[2] ?? 1),
  halfLengthSec: 45 * 60,
  home: { name: 'Home', shortName: 'HOM', formationId: '4-3-3', rating: 78, difficulty: DIFFICULTY.pro, human: false, primaryColour: '#e03131', secondaryColour: '#fff' },
  away: { name: 'Away', shortName: 'AWY', formationId: '4-4-2', rating: 78, difficulty: DIFFICULTY.pro, human: false, primaryColour: '#1971c2', secondaryColour: '#fff' },
};

const m = new MatchEngine(cfg);
const hist: Record<string, number> = {};
const outByTeam: Record<string, number> = {};
const outWhere: Record<string, number> = {};
let maxClock = 0;
let oobCount = 0;
let ticksPossessionHome = 0;
let ticksPossessionAway = 0;
let ticksLoose = 0;

for (let t = 0; t < 60 * 60 * 90 * 2 + 4000; t++) {
  m.step();
  if (m.clock > maxClock) maxClock = m.clock;
  for (const e of m.drainEvents()) {
    hist[e.kind] = (hist[e.kind] ?? 0) + 1;
    if (e.kind === 'goal') {
      const sp = Math.hypot(m.ball.vel.x, m.ball.vel.z);
      const bucket = sp > 18 ? 'struck(>18m/s)' : sp > 6 ? 'medium(6-18)' : 'trickling(<6)';
      const key = `goal:${bucket}`;
      outByTeam[key] = (outByTeam[key] ?? 0) + 1;
      const shooter = m.players.find((pp) => pp.attr.id === m.ball.lastTouchId);
      const gk = `goal:shooterWas${shooter && shooter.role === 1 ? 'KEEPER' : 'outfield'}`;
      outByTeam[gk] = (outByTeam[gk] ?? 0) + 1;
    }
    if (e.kind === 'corner' || e.kind === 'throwin' || e.kind === 'goalkick') {
      const key = `${e.kind}:team${e.data['team']}`;
      outByTeam[key] = (outByTeam[key] ?? 0) + 1;
      oobCount++;
      const bx = m.ball.pos.x;
      const zone = bx < 15 ? 'own-third-x<15' : bx > PITCH.length - 15 ? 'final-third-x>90' : 'middle';
      outWhere[zone] = (outWhere[zone] ?? 0) + 1;
    }
  }
  if (m.possessionTeam === 0) ticksPossessionHome++;
  else if (m.possessionTeam === 1) ticksPossessionAway++;
  else ticksLoose++;
}

console.log('ticks', m.tick, 'clock(min)', (maxClock / 60).toFixed(1), 'period', m.period, 'score', m.score.join('-'));
console.log('\nevent histogram:');
for (const [k, v] of Object.entries(hist).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)} ${v}`);
console.log('\nout-of-play attribution:');
for (const [k, v] of Object.entries(outByTeam).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);
console.log('\nwhere the ball went out:');
for (const [k, v] of Object.entries(outWhere).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);
console.log('\npossession ticks: home', ticksPossessionHome, 'away', ticksPossessionAway, 'loose', ticksLoose);
const tot = ticksPossessionHome + ticksPossessionAway + ticksLoose;
console.log(`  home ${((ticksPossessionHome / tot) * 100).toFixed(1)}%  away ${((ticksPossessionAway / tot) * 100).toFixed(1)}%  loose ${((ticksLoose / tot) * 100).toFixed(1)}%`);
console.log('\nstats', JSON.stringify(m.stats));
