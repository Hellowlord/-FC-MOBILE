/**
 * FixedTimeStep — the spine of the game loop.
 *
 * The simulation always advances in exact 1/60 s increments, no matter what the
 * renderer is doing. This is non-negotiable for three reasons:
 *
 *   1. Determinism. A replay is (seed, input-per-tick). Variable dt would make
 *      integrals path-dependent and replays impossible.
 *   2. Stability. Ball physics has stiff moments (bounce impulses, spin). A
 *      16 ms step that occasionally becomes 90 ms because the GPU hitched will
 *      tunnel the ball through the goal line.
 *   3. Fairness. A player on a 120 Hz phone must not get twice the physics of a
 *      player on a 30 fps phone.
 *
 * The renderer interpolates between the previous and current sim state using
 * `alpha`, so 60 Hz simulation still looks smooth at 90/120 Hz refresh.
 * See docs/ARCHITECTURE.md -> "Game loop".
 */

export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;
export const MS_PER_SIM_STEP = 1000 / SIM_HZ;

/** Longest real-time gap we are willing to absorb in a single frame. */
const MAX_ELAPSED = 0.25;

export class FixedTimeStep {
  private accumulator = 0;

  /**
   * Hard cap on steps per frame. Beyond this we drop time instead of
   * simulating it, which prevents the "spiral of death" where a slow device
   * falls behind, simulates more to catch up, and falls further behind.
   */
  readonly maxStepsPerFrame: number;

  /** Set when we had to discard time, so the HUD can show a hitch indicator. */
  droppedTime = false;

  stepsThisFrame = 0;
  totalSteps = 0;

  constructor(maxStepsPerFrame = 5) {
    this.maxStepsPerFrame = maxStepsPerFrame;
  }

  /**
   * @param elapsedSeconds real time since the previous frame
   * @param step invoked zero or more times with exactly SIM_DT
   * @returns how many simulation steps ran
   */
  update(elapsedSeconds: number, step: (dt: number) => void): number {
    const clamped = elapsedSeconds < 0 ? 0 : elapsedSeconds > MAX_ELAPSED ? MAX_ELAPSED : elapsedSeconds;
    this.accumulator += clamped;

    let n = 0;
    while (this.accumulator >= SIM_DT && n < this.maxStepsPerFrame) {
      step(SIM_DT);
      this.accumulator -= SIM_DT;
      n++;
    }

    if (this.accumulator >= SIM_DT) {
      // Still behind after the cap: discard rather than chase.
      this.accumulator = 0;
      this.droppedTime = true;
    } else {
      this.droppedTime = false;
    }

    this.stepsThisFrame = n;
    this.totalSteps += n;
    return n;
  }

  /** Interpolation blend for the renderer, in [0, 1). */
  get alpha(): number {
    const a = this.accumulator / SIM_DT;
    return a < 0 ? 0 : a >= 1 ? 0.999999 : a;
  }

  /** Simulation time in seconds. */
  get simTime(): number {
    return this.totalSteps * SIM_DT;
  }

  reset(): void {
    this.accumulator = 0;
    this.totalSteps = 0;
    this.stepsThisFrame = 0;
    this.droppedTime = false;
  }
}
