# Porting the core to Android (Kotlin)

## Where things stand

The repository currently has **two** copies of the match core:

| | Language | Status |
|---|---|---|
| `engine/` | TypeScript | **Complete and verified.** 45 unit tests pass; drives the playable browser preview. |
| `android/:core` | Kotlin | **Partial.** Math, vectors, RNG, tuning, ball physics, locomotion and the player controller are ported. Not compiled in this environment (no JVM available in the sandbox). |

So: the TypeScript core is the reference implementation and the source of truth
for behaviour. The Kotlin core is a structural mirror, written line-by-line from
it, waiting to be compiled and verified.

**Do not treat the Kotlin module as verified until `./gradlew :core:test` is
green.** That is the whole point of the parity harness below.

## Why the parity harness exists

Porting a simulation by hand is how you get a game that plays *slightly* wrong
on one platform and you never find out why. "It looks about the same" is not a
test.

Instead:

1. `engine/tools/golden-vectors.ts` drives the TypeScript core through fixed
   inputs and writes the exact outputs to `vectors/golden-*.json`.
2. `android/core/src/test/kotlin/.../GoldenVectorTest.kt` reads the same JSON and
   asserts the Kotlin core produces the same numbers to 1e-9.

Tolerance 1e-9 absorbs JSON decimal rounding only. A correct port matches to
about 1e-15. **If you are hitting 1e-9, your port is wrong — do not loosen it.**

## Porting order

Work bottom-up, and get the test green at each step before moving on. The order
is chosen so each layer has a fixture that already covers it.

| Step | Kotlin file | Covered by fixture |
|---|---|---|
| 1 | `core/DeterministicMath.kt` | `golden-math.json` — 241 trig + 120 atan2 cases |
| 2 | `core/Rng.kt` | `golden-rng.json` — 64 exact 32-bit words |
| 3 | `physics/BallPhysics.kt` | `golden-ball.json` — 6 flight tracks + 15 solver cases |
| 4 | `player/Locomotion.kt` | `golden-locomotion.json` — sprint curve |
| 5 | `player/PlayerController.kt` | *needs a new fixture* — see below |
| 6 | `ai/Formation.kt`, `ai/Brain.kt` | *needs a new fixture* |
| 7 | `match/MatchEngine.kt` | *needs a new fixture* — whole-match state hash |

Steps 1-4 are done and have fixtures. Steps 5-7 are the remaining work.

For step 7 the fixture should be a **whole-match fingerprint**: run 60,000 ticks
with a fixed seed and a fixed scripted input, then record the ball position, all
22 player positions, the score and the event log. That single fixture catches any
divergence anywhere in the port.

```bash
cd engine && npm run vectors     # regenerate after any core change
cd android && ./gradlew :core:test
```

## Determinism rules for the Kotlin side

These are not style preferences. Breaking any of them silently breaks parity.

1. **Never call `Math.sin`, `Math.cos`, `Math.atan2`, `Math.exp`, `Math.log`,
   `Math.pow`.** Use `DeterministicMath`. Only `kotlin.math.sqrt` is allowed —
   IEEE-754 sqrt is correctly rounded on every platform.
2. **Never call `Random`.** Use `core/Rng`. A match must be reproducible from
   `(seed, inputs)` alone.
3. **Constants that would be `exp(x)` must be precomputed literals**, with a
   comment giving the value they represent. See `Aero.SPIN_DECAY_PER_STEP`.
4. **Fixed timestep only.** `SIM_DT = 1.0/60`, always. No variable-dt integration
   anywhere in the core.
5. **Integer arithmetic for the RNG.** JS uses `Math.imul`; Kotlin's `Int`
   multiplication is already 32-bit wrapping, so `a * b` is correct — but keep
   the `ushr` (unsigned shift) rather than `shr` where the JS uses `>>>`.
6. **`Math.round` is safe.** Both ECMA-262 and the JVM round half toward positive
   infinity.
7. **`q and 3` is safe** for negative `q`: Kotlin `and` and JS `&` are both
   two's-complement bitwise AND.

## Module boundaries

```
:core    pure Kotlin/JVM. No Android imports. No third-party runtime deps.
         -> unit-testable in seconds with no emulator, so it can gate CI.
:app     Android SDK, Compose, rendering, touch, audio, platform services.
         -> holds NO game state. Reads snapshots, sends input.
```

Keep `:core` free of Android dependencies even when it is tempting. The moment
`android.*` leaks in, you lose the ability to run the simulation in CI on every
tuning change, and that is the single most valuable thing about this
architecture.

## Renderer swap

`android/app/.../MainActivity.kt` currently uses a `SurfaceView` + Canvas
placeholder so the loop, input and HUD are wired end to end and verifiable on a
device today. It is explicitly **not** the shipping renderer.

To replace it: keep `GameLoop` and `TouchInputState` exactly as they are, and
swap `PitchView`'s drawing for a `GLSurfaceView` or Vulkan swapchain that draws
`engine.snapshot(alpha)`, interpolating positions between the previous and
current snapshot. The core's contract does not change, which is the point of
having the seam.
