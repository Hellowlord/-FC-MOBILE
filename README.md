# FC MOBILE

A realistic football match simulation, built around a **deterministic,
engine-agnostic core** with a thin presentation layer on top.

```
engine/     TypeScript reference core  — complete, tested, drives the preview
android/    Android Studio project     — Kotlin core (partial) + app shell
vectors/    golden parity fixtures shared by both cores
docs/       architecture, simulation spec, porting guide
web/        static server for the browser preview
```

## Quick start

```bash
cd engine
npm install

npm test        # 45 unit tests — physics, locomotion, math, match engine
npm run sim     # headless balance rig: N full matches, prints real statistics
npm run vectors # regenerate cross-language parity fixtures
```

Playable browser preview (2D top-down, keyboard-driven):

```bash
cd engine && npm run build
node web/serve.mjs 8080      # then open http://localhost:8080/
```

Android (in Android Studio, open the `android/` folder):

```bash
cd android
./gradlew :core:test     # cross-language parity gate
./gradlew :app:assembleDebug
```

### Preview controls

| Key | Action |
|---|---|
| WASD / arrows | Move (analogue: two keys = diagonal) |
| Shift | Sprint |
| Space | Pass |
| X | Shoot — **hold to charge power** |
| C + X | Curved shot |
| Q | Switch player |
| 1 / 2 / 3 | Broadcast / player / tactical camera |

---

## The one architectural idea

**Separate the deterministic simulation core from the presentation layer.**

```
PRESENTATION   renderer · animation · audio · HUD · touch · menus
               runs at display refresh rate · holds NO game state
      │  PlayerInput ↓                    MatchSnapshot ↑
MATCH CORE     ball physics · locomotion · AI · clock
               fixed 60 Hz · seeded RNG · no rendering · no libm
```

That buys you, concretely:

- **Replays** — a replay is `(seed, inputs)`, a few KB instead of video
- **Rollback netcode** — same seed + inputs ⇒ identical match on both clients
- **CI balance testing** — ~1,300 simulated minutes per wall-second, so tuning
  questions become thousands-of-matches questions
- **Deterministic bug reports** — "seed 4821, tick 91004" reproduces exactly
- **Portability** — the browser preview and the Android app draw the same
  snapshots from the same core

And the reason it matters most: **it makes the game testable.** The twelve bugs
found while building this were all found by running it, not by reading it. See
`docs/ARCHITECTURE.md` §7.

## Read these next

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Tech stack recommendation, module layout, game loop, what's verified, known limitations |
| [docs/MATCH-SIM-SPEC.md](docs/MATCH-SIM-SPEC.md) | Every physics and AI constant, its source, and the bug each one prevented |
| [docs/PORTING-TO-KOTLIN.md](docs/PORTING-TO-KOTLIN.md) | Porting order, determinism rules, the parity gate |

## Honest status

**Working and verified:** deterministic ball physics (drag crisis, Magnus curve,
bounce, rolling), locomotion with momentum and inertia, ball interaction
(trap/dribble/pass/shot/curve/tackle/skill moves), formation-based utility AI
with five difficulty tiers, a full match engine with clock, restarts, goals and
events, and a playable 2D preview.

**Not built yet:** 3D rendering, player animation, offside, fouls, free kicks,
penalties, cards, headers, career mode, and the full Kotlin `MatchEngine` port.

**Measured balance** (24 × 90-minute CPU matches, both sides 78-rated):

| | Sim | Real football |
|---|---|---|
| Goals per match | 2.50 | ~2.7 |
| Shots / on target | 25.1 / 10.0 | ~25 / ~9 |
| Conversion | 10.0% | ~10% |
| Passes per team | 501 / 594 | ~400-550 |
| Possession | 50.4 / 49.6 | varies |

**Known out of band:** corners ~13x too low and goal kicks ~4x too high — the
corner rule itself is now correct, but defenders are rarely recorded as the last
touch, so almost nothing becomes a corner. Tackles ~8x too high. Results skew
home. All are documented with their measurements in `docs/MATCH-SIM-SPEC.md` §9,
along with the six defects that took the goal rate from 12.8 to 2.50 and the two
diagnostic instruments that reported false numbers.
