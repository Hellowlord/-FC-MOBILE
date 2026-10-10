# FC MOBILE — Architecture & Tech Stack

## 0. Read this first: what "like EA Sports FC 27" actually costs

I want to be straight with you rather than hand you a plan that quietly fails in
month nine.

EA Sports FC is made by ~1,500 people over ~18 months per release, on a 20-year
old proprietary engine, with licensed motion-capture stages, scan-based player
heads, and a dedicated animation team per feature. The *match simulation* is
maybe 5% of that. The other 95% is assets: animation, faces, kits, stadiums,
commentary, presentation, and licensed content.

So the realistic question is not "can I build FC 27" but **"what is the smallest
system that plays like a real football match, and what do I build first?"**
Everything below is built around that framing.

Two honest rules that follow from it:

1. **Do not write a 3D renderer.** You will spend a year on shadows before a
   ball moves. Use an engine.
2. **Do write your own match simulation.** No engine ships one. This is the part
   that *is* your game, it is mostly maths, and it is the part this repository
   actually contains.

---

## 1. Recommended tech stack

### The engine decision

| Option | Fidelity | Mobile fit | Time to a playable match | Verdict |
|---|---|---|---|---|
| **Unreal Engine 5** (C++/Blueprints) | Highest (Nanite, Lumen, Chaos, MetaHuman) | Needs aggressive mobile settings; large APK | 6-9 months | Best fidelity, heaviest |
| **Unity 6** (C#) | Very good, mobile-proven | Excellent; small APK; huge asset store | 4-6 months | **Recommended default** |
| **Native Android** (Kotlin + Vulkan/GL) | Whatever you build | Perfect | 18-36 months | Only if you specifically want no engine |
| **libGDX** (Kotlin, OpenGL ES + Bullet) | Stylised 3D, not photoreal | Excellent | 9-12 months | Best "no big engine" middle ground |

**Recommendation: Unity 6** unless you specifically need UE5's rendering.
Rationale: mobile sports titles live and die by install size, thermal behaviour
and low-end device support, and Unity is the strongest of the three there.

### Where Android Studio fits

Android Studio is still central — just not as the renderer:

- **Gradle build & AAB packaging** for the Play Store (Unity/UE both export a
  Gradle project you open in Android Studio).
- **Kotlin platform layer**: Play Games Services, sign-in, cloud save, IAP,
  push, deep links, ad mediation.
- **Profiling**: Android Studio Profiler, Perfetto and Simpleperf for CPU/thermal
  analysis on real devices — this is where a mobile football game is won or lost.
- **Running the JVM test suite** for the simulation core (`./gradlew :core:test`).

### The architecture that matters more than the engine choice

**Separate the deterministic simulation core from the presentation layer.**

This is the single most important decision in this document, and it is what the
rest of the repo implements:

```
┌───────────────────────────────────────────────────────────────┐
│  PRESENTATION (platform-specific, replaceable)                │
│  Renderer · animation · audio · HUD · touch input · menus     │
│  Runs at display refresh rate (60/90/120 Hz)                  │
│  Holds NO game state. Reads snapshots. Sends input.           │
└──────────────────────────┬────────────────────────────────────┘
                           │  PlayerInput ↓        MatchSnapshot ↑
┌──────────────────────────┴────────────────────────────────────┐
│  MATCH CORE (platform-agnostic, deterministic, headless)      │
│  Ball physics · locomotion · ball interaction · AI · clock    │
│  Fixed 60 Hz. Seeded RNG. No rendering. No I/O. No libm.      │
└───────────────────────────────────────────────────────────────┘
```

What this buys you, concretely:

- **Replays.** A replay is `(seed, input-per-tick)` — a few KB instead of video.
- **Rollback netcode.** Two clients with the same seed and inputs agree exactly.
- **CI balance testing.** 1,000 headless matches in minutes. See `npm run sim`.
  Every tuning change gets an objective "did goals-per-match move?" answer.
- **Deterministic bug reports.** "Seed 4821, tick 91,004" reproduces exactly.
- **Portability.** Swap Unity for UE, or ship a web preview, without touching
  the game logic. `src/preview/` in this repo is exactly that: a second
  presentation layer over the same core.
- **Testability.** The physics and AI are unit-testable on a laptop. That is how
  the twelve bugs found during initial development were found (see §7).

### Module layout

```
-FC-MOBILE/
  engine/                     TypeScript reference core (runs + tests here)
    src/core/                 deterministic math, vectors, RNG, fixed timestep
    src/physics/              ball flight, turf, aerodynamics
    src/player/               attributes, locomotion, controller
    src/ai/                   formations, team brain
    src/match/                match engine, events, snapshots
    src/preview/              browser renderer (2nd presentation layer)
    test/                     unit tests (node --test)
    tools/                    headless balance rig, golden-vector generator
  android/                    Android Studio project (Kotlin)
    :core                     the same match core, ported to Kotlin/JVM
    :app                      Activity, renderer, input, HUD
  vectors/                    golden parity fixtures shared by both cores
  docs/
  web/                        static server + index.html for the preview
```

---

## 2. The game loop

Three nested loops, each at a different rate. Getting this structure right early
is what keeps a 120 Hz phone and a 30 fps phone playing the same game.

```
┌─ RENDER LOOP ─────────────────────────────────────────────────────┐
│ Choreographer / requestAnimationFrame — display refresh rate      │
│                                                                   │
│   1. Read real elapsed time                                       │
│   2. Poll input → write into the input buffer                     │
│   3. accumulator += elapsed                                       │
│                                                                   │
│   ┌─ SIM LOOP ───────────────────────────────────────────────┐    │
│   │ while accumulator >= 1/60:                               │    │
│   │   engine.step()        // exactly 1/60 s, always         │    │
│   │   accumulator -= 1/60                                    │    │
│   │   (cap at 5 steps; drop the rest — see "spiral of death")│    │
│   └──────────────────────────────────────────────────────────┘    │
│                                                                   │
│   4. snapshot = engine.snapshot(alpha)                            │
│   5. Draw, interpolating prev→current by alpha                    │
└───────────────────────────────────────────────────────────────────┘

┌─ ONE engine.step() ───────────────────────────────────────────────┐
│  1 clock + restart state machine                                  │
│  2 possession determination                                       │
│  3 build FieldView snapshot                                       │
│  4 human player switching                                         │
│  5 AI brains re-plan (each on its own cadence)                    │
│  6 all 22 PlayerControllers run ONE step                          │
│  7 player/player separation                                       │
│  8 ball physics + posts + goal detection                          │
│  9 restart checks (goal, out of play)                             │
│ 10 stamina                                                        │
└───────────────────────────────────────────────────────────────────┘
```

### Why fixed timestep is non-negotiable

1. **Determinism.** Variable `dt` makes integration path-dependent; replays and
   rollback become impossible.
2. **Stability.** Bounce impulses are stiff. A frame that stretches to 90 ms
   because the GPU hitched will tunnel the ball through the goal line.
3. **Fairness.** Physics must not depend on the device's refresh rate.

The renderer interpolates between the previous and current snapshot using
`alpha`, so 60 Hz simulation still looks smooth at 120 Hz.

See `engine/src/core/fixed-step.ts` and `android/.../GameLoop.kt`.

---

## 3. Gameplay systems

### Player movement — momentum and inertia

The naive approach (`position += inputDir * speed * dt`) is what makes amateur
football games feel like ice hockey. Three things fix it, all in
`engine/src/player/locomotion.ts`:

1. **Turn-rate limit.** A player has a facing and can only rotate so fast —
   ~4 rad/s standing still, under 2 rad/s flat out. To go a new way you must
   first turn to face it.
2. **Speed is a scalar along the heading.** Acceleration is bounded (~4-5 m/s²),
   braking is stronger (~6.5 m/s²). A sprinter cannot stop on a dime.
3. **Velocity lags heading.** The velocity vector relaxes towards the heading
   instead of snapping, so turning at speed produces a visible outward drift.

Top speed is additionally penalised by turn intensity, and sustained hard
turning bleeds pace — committing to a sharp cut costs you acceleration out of
it.

### Ball interaction

- **First touch** scatters the ball perpendicular to its travel, scaled by
  control rating and ball speed. A hard pass to a weak first touch visibly
  squirts away.
- **Dribbling** holds the ball in a "pocket" ahead of the player. The pocket
  grows with speed and shrinks with close-control rating.
- **Skill moves**: knock-on (shove into space + burst) and feint (freezes the
  nearest defender briefly).
- **Tackling** is a contest of tackling/strength vs dribbling, with a distance
  penalty and a body-committing cooldown. Failure locks the tackler.

### Passing, shooting, curve

Every kick produces `(direction, launch angle, speed, spin)`:

- **Launch angle by kick type** — drive ~9°, normal ~18°, chip ~36°.
- **Speed** comes either from the power meter, or on assisted kicks from a
  **bisection solve through the real drag model**, so the ball actually arrives.
  Using a vacuum closed-form for aiming and a drag model for flight is a classic
  bug that makes assisted passes land short.
- **Accuracy** is angular error drawn from a per-player distribution, scaled by
  fatigue, power and distance. Full power is never full accuracy — that
  trade-off is the whole game.
- **Curve** sets vertical-axis spin; the Magnus term then bends the flight.

### Ball physics

Gravity + quadratic drag (with the drag crisis modelled) + Magnus lift,
semi-implicit Euler at 60 Hz, plus restitution, Coulomb friction, slip-to-spin
conversion on bounce, and a rolling-resistance model calibrated against real
roll-out distance. Full derivation and numbers in `MATCH-SIM-SPEC.md`.

### AI

A **utility AI**, not a state machine — football decisions are comparative
("shoot vs pass vs carry" depends on three continuous quantities at once), and
state machines degrade into untunable if-else piles.

Formation behaviour uses a **ball-centric transform**: formation slots are
stored normalised, then shifted and compressed around the ball each tick with a
phase offset. A 4-4-2 defending in its own box looks nothing like the same
4-4-2 pressing high.

**Difficulty is expressed as human-like error, not stat inflation** — reaction
time, aim noise, positional noise, re-planning cadence, off-ball quality and
shape discipline. A Legend opponent plays the same football as a Beginner one,
just faster and cleaner, which is what actually happens between divisions. It
also keeps multiplayer fair, because the CPU never gets a physical advantage the
human cannot have.

### Camera & HUD

Three cameras in the preview: broadcast (frames the ball, zooms out as play
spreads), player (centres the controlled man), tactical (zoomed out). The HUD
carries scoreboard, clock, shot power, stamina and a live event feed.

---

## 4. Game modes

Build in this order — each one is a superset of the last:

1. **Quick match.** Two squads, one match. This is what exists now.
2. **Season.** A fixture list, a league table, and persistence of results.
   Almost no new simulation — it is a scheduler around quick match.
3. **Career.** Transfers, squad growth, morale, injury, save slots. This is
   mostly *data and UI*, not simulation, and it is where most of the remaining
   effort actually goes.

Team management (lineups, formation selection, tactics) slots into step 2-3 and
is already supported by the core: formations are data, and
`MatchConfig` takes any squad and formation.

---

## 5. Cross-platform determinism

The core avoids `Math.sin` / `Math.cos` / `Math.atan2` entirely, because those
are permitted to differ between platforms. `engine/src/core/math.ts` implements
them from Cephes-style minimax polynomials using only `+ - * /` and IEEE-754
`sqrt`, which are identical on a JVM and in JS.

That is what makes `vectors/golden-*.json` a hard pass/fail parity gate when the
core is ported to Kotlin: both cores run the same fixed inputs and must produce
byte-identical output. See `PORTING-TO-KOTLIN.md`.

---

## 6. Performance budget (mobile)

Target 60 fps sustained on a mid-range device without thermal throttling:

| System | Budget | Notes |
|---|---|---|
| Match core, 22 players | < 1.5 ms / frame | Measured here at ~1,300 sim-minutes per wall-second |
| Animation | 3-4 ms | GPU-skinning, LOD by distance from camera |
| Rendering | 8-10 ms | The dominant cost by far |
| HUD / UI | < 1 ms | Cache, do not rebuild every frame |

The core is comfortably not your bottleneck. Budget your time accordingly.

---

## 7. What was actually verified

The core compiles and its test suite passes (45 tests). Those tests, plus the
headless rig and the goal/shot diagnostics, found **eighteen** genuine bugs.
None were found by reading code, and `tsc` would have passed on every one.
Selected:

- every player capped at ~3.6 m/s because `speed` was being overwritten by the
  lagged velocity each tick;
- ground friction charged 60 times a second, halving ball roll distance;
- a kickoff state machine that re-armed itself forever, so the ball never moved;
- `checkGoal` firing every tick during a celebration → 110,000 goals per match;
- a stunned player instantly re-trapping the ball they had just been tackled
  off, giving one side 98.7% possession;
- the keeper dribbling the ball into his own net, because a keeper faces his own
  goal;
- pass targets led so far they landed outside the pitch (~13,000 throw-ins per
  match);
- restarts placed outside the field, re-triggering out-of-bounds in a loop;
- a `lastTouchTeam` field that was read but never written, awarding every
  corner to the same team;
- `detAtan` using single-precision coefficients with a wrong reduction;
- the keeper's lateral position clamped to a 14.6 m band for a 7.32 m goal, so
  he spent much of the match standing outside his own goal;
- a too-fast ball deflected along the player→ball axis, so a keeper chasing a
  shot pushed it into his own net — 75% of all goals at one point;
- outfield defenders dribbling over their own goal line, because the dribble
  pocket is placed along the player's facing and a defender turning to chase a
  loose ball faces his own net;
- the corner/goal-kick rule inverted against Laws 16 and 17, awarding a corner
  when an attacker put the ball out — 52.9 corners and 1.4 goal kicks a match
  against a real ~11 and ~14;
- shots using a fixed launch angle per kick kind, so 65% of shots reaching the
  goal plane sailed over the bar from a median distance of 12.2 m.

None of these would have been caught by looking at code. All were caught by
running it. That is the argument for the headless core, in one paragraph.

### Current known limitations

Stated plainly, because you should not have to discover them:

- **Goals, shots, on-target, conversion, passes and possession are all in band**
  now (2.50 goals/match vs a real ~2.7). Getting there took six separate
  defects, none of them "the AI shoots too much". The two largest: the keeper
  was standing *outside his own goal* (a 14.6 m lateral clamp on a 7.32 m
  goal), and shots used a **fixed launch angle regardless of distance**, so 65%
  of shots reaching the goal plane went over the bar from a median distance of
  12.2 m. See `MATCH-SIM-SPEC.md` §9.
- **Corners ~13x too low, goal kicks ~4x too high.** The Law 16/17 rule was
  inverted and is now fixed, but defenders are rarely recorded as the last
  touch, so almost nothing becomes a corner. Top-priority measurement target.
- **Tackles ~154/match against a real ~20**, and **results skew home** (15/3/6
  between identically rated sides).
- **Two diagnostic instruments reported false numbers** and were only caught
  because their outputs contradicted each other — a crossing counter that could
  not see a ball the engine had already reset, and a corner count exceeding the
  crossing count it is a subset of. Worth reading before trusting any number in
  this repo: `MATCH-SIM-SPEC.md` §9, "On measuring".
- Restarts are simplified: throw-ins, corners and goal kicks all become a
  placed ball with no dedicated animation.
- No offside, fouls, free kicks, penalties, or yellow/red cards.
- No headers or volleys; balls above 1.15 m cannot be controlled by outfielders.
- One keeper dive model (an enlarged reach), not a real dive animation.
- 2D top-down preview only; there is no 3D renderer yet.
