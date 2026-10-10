/**
 * Seeded, portable pseudo-random generator.
 *
 * The core NEVER calls Math.random(): a match must be replayable from
 * (seed, input stream) alone, which is what makes replays, rollback
 * multiplayer and overnight headless balance runs possible.
 *
 * Algorithm: xoshiro128** over four 32-bit words, all arithmetic done with
 * Math.imul so results are exact int32 products on every platform (JS number
 * multiplication would lose precision past 2^53, and the JVM port must match
 * bit-for-bit). Seeded via SplitMix32.
 *
 * `gauss()` uses an Irwin-Hall sum of 12 uniforms rather than Box-Muller,
 * because Box-Muller needs log() and we refuse to depend on libm. For AI
 * noise the resulting distribution is indistinguishable in practice.
 */

import { clamp } from './math.js';

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    // SplitMix32 expansion so even adjacent seeds give uncorrelated states.
    let s = seed >>> 0;
    const mix = (): number => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.s0 = mix();
    this.s1 = mix();
    this.s2 = mix();
    this.s3 = mix();
    // Reject the all-zero state, which is a fixed point of xoshiro.
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 0x9e3779b9;
  }

  /** Raw 32-bit unsigned word. xoshiro128** — see Blackman & Vigna. */
  nextU32(): number {
    const s0 = this.s0;
    const s1 = this.s1;
    const s2 = this.s2;
    const s3 = this.s3;

    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;

    // Reference update order matters; each line sees the previous line's result.
    let n2 = (s2 ^ s0) >>> 0; // s2 ^= s0
    let n3 = (s3 ^ s1) >>> 0; // s3 ^= s1
    const n1 = (s1 ^ n2) >>> 0; // s1 ^= s2
    const n0 = (s0 ^ n3) >>> 0; // s0 ^= s3
    n2 = (n2 ^ t) >>> 0; // s2 ^= t
    n3 = rotl(n3, 11); // s3 = rotl(s3, 11)

    this.s0 = n0;
    this.s1 = n1;
    this.s2 = n2;
    this.s3 = n3;
    return result;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return (this.nextU32() >>> 8) / 16777216;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Approximate standard normal (mean 0, sd 1) via Irwin-Hall n=12. */
  gauss(): number {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += this.next();
    return sum - 6;
  }

  /** Normal with the given standard deviation, clamped to +/-3 sd. */
  gaussScaled(sd: number): number {
    return clamp(this.gauss(), -3, 3) * sd;
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pickIndex(count: number): number {
    if (count <= 0) return 0;
    return Math.floor(this.next() * count) % count;
  }

  /** Serialisable snapshot, so a replay can resume mid-match. */
  state(): [number, number, number, number] {
    return [this.s0, this.s1, this.s2, this.s3];
  }

  static fromState(s: [number, number, number, number]): Rng {
    const r = new Rng(1);
    r.s0 = s[0] >>> 0;
    r.s1 = s[1] >>> 0;
    r.s2 = s[2] >>> 0;
    r.s3 = s[3] >>> 0;
    return r;
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}
