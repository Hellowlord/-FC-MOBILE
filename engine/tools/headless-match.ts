/**
 * headless-match — runs the simulation with no renderer and reports statistics.
 *
 * This is the rig you use to answer "is the AI actually playing football?"
 * without ever opening a device. Because the core is deterministic and
 * render-free, a full 90-minute match runs in a fraction of a second, so
 * balance questions ("does Legend win too often against Pro?") become
 * thousands-of-matches questions you can run in CI.
 *
 *   npm run sim
 */

import { MatchEngine, type MatchConfig } from '../src/match/engine.js';
import { DIFFICULTY, PITCH } from '../src/config/tuning.js';
import type { DifficultyProfile } from '../src/config/tuning.js';

interface Args {
  matches: number;
  halfMinutes: number;
  homeRating: number;
  awayRating: number;
  homeDifficulty: string;
  awayDifficulty: string;
  seed: number;
}

function parseArgs(): Args {
  const out: Args = {
    matches: 20,
    halfMinutes: 45,
    homeRating: 78,
    awayRating: 78,
    homeDifficulty: 'pro',
    awayDifficulty: 'pro',
    seed: 1,
  };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    const v = a[i + 1];
    if (k === undefined || v === undefined) continue;
    switch (k) {
      case '--matches': out.matches = Number(v); i++; break;
      case '--halves': out.halfMinutes = Number(v); i++; break;
      case '--home-rating': out.homeRating = Number(v); i++; break;
      case '--away-rating': out.awayRating = Number(v); i++; break;
      case '--home-diff': out.homeDifficulty = v; i++; break;
      case '--away-diff': out.awayDifficulty = v; i++; break;
      case '--seed': out.seed = Number(v); i++; break;
    }
  }
  return out;
}

function difficulty(id: string): DifficultyProfile {
  const table = DIFFICULTY as unknown as Record<string, DifficultyProfile>;
  return table[id] ?? DIFFICULTY.pro;
}

function makeConfig(seed: number, args: Args): MatchConfig {
  return {
    seed,
    halfLengthSec: args.halfMinutes * 60,
    home: {
      name: 'Home',
      shortName: 'HOM',
      formationId: '4-3-3',
      rating: args.homeRating,
      difficulty: difficulty(args.homeDifficulty),
      human: false,
      primaryColour: '#e03131',
      secondaryColour: '#ffffff',
    },
    away: {
      name: 'Away',
      shortName: 'AWY',
      formationId: '4-4-2',
      rating: args.awayRating,
      difficulty: difficulty(args.awayDifficulty),
      human: false,
      primaryColour: '#1971c2',
      secondaryColour: '#ffffff',
    },
  };
}

const args = parseArgs();
const totals = {
  goals: [0, 0],
  shots: [0, 0],
  onTarget: [0, 0],
  passes: [0, 0],
  tackles: [0, 0],
  corners: [0, 0],
  poss: [0, 0],
  draws: 0,
  homeWins: 0,
  awayWins: 0,
  ticks: 0,
};
const results: string[] = [];

const started = Date.now();
for (let m = 0; m < args.matches; m++) {
  const engine = new MatchEngine(makeConfig(args.seed + m, args));
  const maxTicks = 60 * 60 * args.halfMinutes * 2 + 60 * 60;
  for (let t = 0; t < maxTicks && engine.tick < maxTicks; t++) {
    engine.step();
    if (engine.period === 3) break;
  }
  totals.ticks += engine.tick;

  for (let i = 0; i < 2; i++) {
    totals.goals[i] = (totals.goals[i] ?? 0) + (engine.score[i] ?? 0);
    totals.shots[i] = (totals.shots[i] ?? 0) + (engine.stats.shots[i] ?? 0);
    totals.onTarget[i] = (totals.onTarget[i] ?? 0) + (engine.stats.shotsOnTarget[i] ?? 0);
    totals.passes[i] = (totals.passes[i] ?? 0) + (engine.stats.passes[i] ?? 0);
    totals.tackles[i] = (totals.tackles[i] ?? 0) + (engine.stats.tackles[i] ?? 0);
    totals.corners[i] = (totals.corners[i] ?? 0) + (engine.stats.corners[i] ?? 0);
    totals.poss[i] = (totals.poss[i] ?? 0) + (engine.stats.possessionTicks[i] ?? 0);
  }
  const h = engine.score[0] ?? 0;
  const a2 = engine.score[1] ?? 0;
  if (h > a2) totals.homeWins++;
  else if (a2 > h) totals.awayWins++;
  else totals.draws++;
  if (m < 10) results.push(`  seed ${args.seed + m}: ${h}-${a2}`);
}
const elapsed = (Date.now() - started) / 1000;

const n = args.matches;
const possTotal = Math.max(1, (totals.poss[0] ?? 0) + (totals.poss[1] ?? 0));
const pct = (v: number) => ((v / possTotal) * 100).toFixed(1);

console.log('='.repeat(64));
console.log(`FC MOBILE headless balance rig`);
console.log(`  ${n} matches x ${args.halfMinutes * 2} min   (${(totals.ticks / 60 / n).toFixed(1)} sim-min/match)`);
console.log(`  home ${args.homeRating}/${args.homeDifficulty}  vs  away ${args.awayRating}/${args.awayDifficulty}`);
console.log(`  ${totals.ticks.toLocaleString()} ticks in ${elapsed.toFixed(2)} s  ->  ${(totals.ticks / elapsed / 60).toFixed(0)} sim-minutes per wall-second`);
console.log('='.repeat(64));
console.log(`  results      home ${totals.homeWins}  draw ${totals.draws}  away ${totals.awayWins}`);
console.log(`  goals        ${(totals.goals[0]! / n).toFixed(2)} - ${(totals.goals[1]! / n).toFixed(2)}   (${((totals.goals[0]! + totals.goals[1]!) / n).toFixed(2)} per match)`);
console.log(`  shots        ${(totals.shots[0]! / n).toFixed(1)} - ${(totals.shots[1]! / n).toFixed(1)}`);
console.log(`  on target    ${(totals.onTarget[0]! / n).toFixed(1)} - ${(totals.onTarget[1]! / n).toFixed(1)}`);
const shotsTotal = Math.max(1, totals.shots[0]! + totals.shots[1]!);
console.log(`  conversion   ${(((totals.goals[0]! + totals.goals[1]!) / shotsTotal) * 100).toFixed(1)}% of shots scored`);
console.log(`  passes       ${(totals.passes[0]! / n).toFixed(0)} - ${(totals.passes[1]! / n).toFixed(0)}`);
console.log(`  tackles won  ${(totals.tackles[0]! / n).toFixed(1)} - ${(totals.tackles[1]! / n).toFixed(1)}`);
console.log(`  corners      ${(totals.corners[0]! / n).toFixed(1)} - ${(totals.corners[1]! / n).toFixed(1)}`);
console.log(`  possession   ${pct(totals.poss[0]!)}% - ${pct(totals.poss[1]!)}%`);
console.log('-'.repeat(64));
console.log('  first matches:');
for (const r of results) console.log(r);
console.log('='.repeat(64));
console.log(`  pitch reference: ${PITCH.length} m x ${PITCH.width} m`);
