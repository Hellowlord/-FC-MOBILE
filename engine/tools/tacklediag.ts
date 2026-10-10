/**
 * tacklediag — where do 154 tackles a match come from?
 *
 * Real football is ~20. Splits attempts by the tackler's role and by how close
 * they were, so the fix can be aimed at the path that actually fires.
 */
import { MatchEngine, type MatchConfig } from '../src/match/engine.js';
import { DIFFICULTY } from '../src/config/tuning.js';

const MATCHES = Number(process.argv[2] ?? 8);

function mk(seed: number): MatchConfig {
  return {
    seed,
    halfLengthSec: 45 * 60,
    home: { name: 'H', shortName: 'H', formationId: '4-3-3', rating: 78, difficulty: DIFFICULTY.pro, human: false, primaryColour: '#f00', secondaryColour: '#fff' },
    away: { name: 'A', shortName: 'A', formationId: '4-4-2', rating: 78, difficulty: DIFFICULTY.pro, human: false, primaryColour: '#f00', secondaryColour: '#fff' },
  };
}

const byRole: Record<string, { attempts: number; won: number }> = {};
/** Ticks between consecutive attempts by the same player. */
const gapByRole: Record<string, number[]> = {};
const lastAttemptTick = new Map<number, number>();

for (let seed = 1; seed <= MATCHES; seed++) {
  const m = new MatchEngine(mk(seed));
  lastAttemptTick.clear(); // must not leak between matches
  for (let t = 0; t < 60 * 60 * 90 + 4000; t++) {
    m.step();
    for (const e of m.drainEvents()) {
      // The engine emits 'tackle' ONLY on success and 'tackleMissed' otherwise,
      // and the data key is 'tackler', not 'tacklerId'. Reading the wrong key
      // made every tackler look unknown and every attempt look successful.
      if (e.kind !== 'tackle' && e.kind !== 'tackleMissed') continue;
      const tacklerId = Number(e.data['tackler']);
      const won = e.kind === 'tackle';
      const tackler = m.players.find((p) => p.attr.id === tacklerId);
      const role = tackler === undefined ? 'unknown' : tackler.role === 1 ? 'keeper' : 'outfield';
      const b = (byRole[role] ??= { attempts: 0, won: 0 });
      b.attempts++;
      if (won) b.won++;

      const prev = lastAttemptTick.get(tacklerId);
      if (prev !== undefined) (gapByRole[role] ??= []).push(t - prev);
      lastAttemptTick.set(tacklerId, t);
    }
  }
}

const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
};

console.log(`${MATCHES} matches | real football is ~20 tackles per match in total`);
for (const [role, b] of Object.entries(byRole)) {
  console.log(
    `  ${role.padEnd(9)} attempts ${(b.attempts / MATCHES).toFixed(1)}/match  ` +
    `won ${(b.won / MATCHES).toFixed(1)}/match  success ${((b.won / Math.max(1, b.attempts)) * 100).toFixed(0)}%`,
  );
}
console.log('\nticks between two attempts by the SAME player (60 ticks = 1 s):');
for (const [role, a] of Object.entries(gapByRole)) {
  if (a.length === 0) continue;
  console.log(
    `  ${role.padEnd(9)} median ${pct(a, 0.5).toFixed(0)}  p10 ${pct(a, 0.1).toFixed(0)}  ` +
    `min ${Math.min(...a)}  (${(pct(a, 0.5) / 60).toFixed(1)} s median between tries)`,
  );
}
console.log('\n  TACKLE_COOLDOWN_TICKS is 50, so a player can try again after 0.83 s.');
console.log('  Note stats.tackles only counts SUCCESSES, so the ~154/match headline');
console.log('  figure is won tackles, not attempts.');
