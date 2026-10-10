# FC MOBILE — Match Simulation Spec

Every number the simulation uses, where it came from, and what breaks if you
change it. All values live in `engine/src/config/tuning.ts` and are mirrored in
`android/core/.../Tuning.kt`.

Coordinate system: `x` along the length `[0..105]`, `y` up (0 = turf), `z` along
the width `[0..68]`. SI units throughout. Fixed timestep `dt = 1/60`.

---

## 1. Pitch (FIFA Laws 1 and 2)

| Value | m | Source |
|---|---|---|
| Length | 105 | International standard; legal 100-110 |
| Width | 68 | Legal 64-75 |
| Goal width / height | 7.32 / 2.44 | Law 1 |
| Penalty area | 16.5 × 40.32 | Law 1 |
| Goal area | 5.5 × 18.32 | Law 1 |
| Penalty spot | 11 from goal line | Law 1 |
| Centre circle radius | 9.15 | Law 1 |

## 2. Ball (Law 2)

| Value | | Source |
|---|---|---|
| Radius | 0.11 m | 69 cm circumference → ~0.22 m diameter |
| Mass | 0.43 kg | Legal 410-450 g |
| Cross-section | 0.038013 m² | π r² |

## 3. Aerodynamics

**Drag.** A football sits right at the drag crisis, so a single Cd is wrong:
Cd falls from ~0.24 (laminar, low speed) to ~0.15 (turbulent, high speed) around
18 m/s. Modelled as a linear blend across `[0.55, 1.5] × 18 m/s`.

```
Fd = 0.5 * rho * Cd(v) * A * |v|^2      rho = 1.205 kg/m^3 (dry air, 20 C)
```

At 30 m/s this is ~7-11 m/s² of deceleration — comparable to gravity. That is
why a struck ball cannot be modelled as a simple arc.

**Magnus.** Lift from spin, as a function of the spin factor `S = r*|omega|/|v|`:

```
C_L(S) = C_Lmax * S / (S + 0.5*S_half)     C_Lmax = 0.32, S_half = 0.22
F_M    = 0.5 * rho * C_L * A * |v|^2 * normalize(omega x v)
```

Sanity check: a 900 rpm free kick at 22 m/s gives S ≈ 0.23, C_L ≈ 0.17,
F_M ≈ 3.6 N, ~8.4 m/s² lateral. Over ~0.7 s of flight that is a couple of metres
of bend, which matches what a heavily whipped free kick actually does.

**Spin decay.** Time constant τ ≈ 4 s. Stored as a precomputed per-step literal
`0.995842025` = exp(−1/240) rather than calling `exp()`, because libm breaks
cross-platform determinism.

## 4. Turf

**Rolling resistance is calibrated against an observation, not a coefficient.**
Textbooks quote 0.02-0.05 for grass rolling resistance, which would let a 15 m/s
pass roll 76 m. Real pitch: ~35-40 m. With `v² = 2ad` that needs a ≈ 2.9 m/s².

```
a_roll = 1.25 + 0.11 * v        (m/s^2)
```

The quoted figure ignores grass-blade deformation, which dominates.

**Bounce.** Restitution 0.72 vertical; below 0.6 m/s impact the ball settles
instead of bouncing. Tangential Coulomb friction 0.35, limited by the normal
impulse (`|Jt| <= mu * |Jn|`), with slip converting to spin at 0.35.

> **Bug this prevented:** an early version applied the friction impulse on every
> tick the ball was grounded, not just on real bounces. That charged the ball for
> friction 60 times a second and roughly halved roll distance.

## 5. Locomotion

| Value | | Note |
|---|---|---|
| Top speed | 8.2 + 1.6·pace01 m/s | ~9.8 m/s at pace 99; Mbappé-class is ~10.6 |
| Acceleration | 3.6 + 1.6·accel01 m/s² | |
| Deceleration | 6.5 m/s² | Braking is harder than accelerating |
| Turn rate | 4.2 rad/s standing → 1.7 flat out | Interpolated by speed fraction |
| Turn speed penalty | 0.35 | Top-speed fraction lost while turning hard |
| Turn bleed | 2.2 /s | Pace lost per second of sustained hard turning |
| Momentum response | 9.0 /s | How fast velocity relaxes onto the heading |

Three mechanisms produce the weight: turn-rate limit, bounded acceleration, and
velocity lagging heading. See `player/locomotion.ts`.

> **Bug this prevented:** an early version re-derived `speed` from the lagging
> velocity each tick. The lag shrank `speed`, which throttled acceleration, which
> kept `speed` small — every player converged to ~3.6 m/s. `speed` must stay
> authoritative; the lag is positional only.

## 6. Kicks

| Kind | Speed range m/s | Launch angle |
|---|---|---|
| Short pass | 5.5 - 14.0 | ~5° |
| Long pass | 14.0 - 25.0 | ~18° |
| Through ball | 5.5 - 21.3 | ~7° |
| Shot (drive) | 16.0 - 33.0 | ~9° |
| Shot (normal) | 16.0 - 33.0 | ~18° |
| Shot (chip) | 12.0 - 26.4 | ~36° |

Professional shots top out around 30-35 m/s (~120 km/h).

**Assisted power.** Rather than a vacuum closed form, the launch speed is found
by bisection through the *live drag integrator* (14 iterations, sub-centimetre).
Solving in vacuum and flying with drag is the classic bug that makes assisted
passes land short.

**Accuracy.** Angular error, 1 standard deviation in degrees:

```
err = baseErr * fatigueMul * powerFactor * distFactor
powerFactor = 1 + 1.6 * clamp(power - 0.5, 0, 0.5) * 2     # full power = +60% error
distFactor  = 1 + 0.6 * clamp((dist - 8) / 40, 0, 1)
```

`baseErr` interpolates 4.5° → 0.7° (passes) and 6.5° → 1.1° (shots) across
ratings 40-99. **Full power is never full accuracy** — that trade-off is the
core skill expression in the game.

**Curve.** Sidespin on the vertical axis; `omega = (0, curve * maxSpinRpm, 0)`.
For a ball travelling `+x`, positive spin pushes it toward `-z` (the kicker's
right). Max 900 rpm. Chips and lofted passes also get backspin on the
perpendicular axis for lift.

## 7. Stamina

Calibrated so a realistic mix of efforts takes a player from fresh to ~0.3 over
90 minutes:

```
drain/s:   walk 4e-5   jog 1.5e-4   sprint 6e-4
recover/s: idle 2.5e-4  walk 8e-5   (only below 0.25 effort)
```

> **Bug this prevented:** the first calibration had drain and recovery almost
> exactly equal, so stamina sat pinned at 1.0 for the entire match and fatigue
> never mattered.

Below `fatigueOnset = 0.45`, top speed falls to 0.72× and error rises to 1.9×.
Real players get slower **and** sloppier, not just slower.

## 8. AI

**Utility AI, not a state machine.** Football decisions are comparative —
"shoot vs pass vs carry" depends on range, openness, lane blocking and time on
ball simultaneously. State machines degrade into untunable if-else piles.

**Formation = ball-centric transform.** Slots stored normalised, then shifted
and compressed around the ball each tick with a phase offset (attack / defend /
transition). A 4-4-2 defending deep looks nothing like the same 4-4-2 pressing
high.

**Difficulty is human-like error, not stat inflation:**

| | reaction | aim error | positional error | re-plan | aggression | off-ball | shape |
|---|---|---|---|---|---|---|---|
| Beginner | 420 ms | 7.0° | 3.2 m | 14 ticks | 0.25 | 0.25 | 0.30 |
| Amateur | 300 ms | 4.5° | 2.2 m | 10 | 0.45 | 0.45 | 0.50 |
| Professional | 190 ms | 2.6° | 1.4 m | 7 | 0.65 | 0.70 | 0.72 |
| World Class | 120 ms | 1.4° | 0.8 m | 5 | 0.80 | 0.88 | 0.88 |
| Legend | 75 ms | 0.7° | 0.45 m | 4 | 0.92 | 0.97 | 0.96 |

This keeps multiplayer fair: the CPU never gets a physical advantage the human
lacks, it just makes fewer mistakes.

## 9. Verification status

Measured with `npm run sim -- --matches 24 --halves 45` (78-rated, Professional,
both sides CPU):

| Metric | Sim | Real football | |
|---|---|---|---|
| Goals per match | **2.50** | ~2.7 | ✅ |
| Shots per match | 25.1 | ~25 | ✅ |
| Shots on target | 10.0 | ~9 | ✅ |
| Conversion | 10.0% | ~10% | ✅ |
| Passes per team | 501 / 594 | ~400-550 | ✅ |
| Possession split | 50.4 / 49.6 | varies | ✅ |
| Results (W/D/L) | 15 / 3 / 6 | no fixed bias | ⚠️ home-skewed |
| Corners | 0.8 | ~11 | ❌ **~13x low** |
| Goal kicks | ~57 | ~14 | ❌ **~4x high** |
| Tackles won | 154 | ~20 | ❌ **~8x high** |

Goal rate went **12.8 → 4.0 → 2.50** per match across this work. Every step came
from measuring the state at the tick of the symptom. Six confident guesses about
the cause were wrong; the measurements were right every time.

### What was actually wrong

1. **The keeper stood outside his own goal.** His lateral position was clamped
   to `±PITCH.goalWidth` (7.32 m either side of the centre spot) — a 14.6 m band
   for a 7.32 m goal. At the moment of a goal his median lateral miss was
   4.66 m against the ~3.7 m he can usefully cover. Clamping inside the frame
   took goals from 11.3 to 6.3 per match on its own.

2. **A too-fast ball was deflected along the player→ball axis.** When a shot
   beat the keeper and he turned to chase it, the ball was goal-side of him, so
   the "deflection" pushed it into his own net. Slow balls (median 2.2 m/s)
   crossing the line with no kick anywhere near them accounted for **75% of all
   goals** at one point. Deflections now push towards the field of play.

3. **Defenders dribbled over their own line.** The dribble pocket sits along the
   player's facing, and a centre-back who turns to chase a loose ball faces his
   own goal. Inside his own penalty area the pocket is now blended towards the
   field. (The keeper had the same bug permanently — he always faces his net.)

4. **The dribble pocket had no field bounds.** The facing lags the run by a few
   ticks, so a winger going down the touchline aimed the pocket through the line
   and was credited with carrying the ball out. That was **36% of every byline
   crossing**: a player within 3 m, no kick for a median of 3.7 s. The pocket is
   now clamped inside the pitch.

5. **The corner / goal-kick rule was inverted.** Law 17 awards a corner when a
   *defender* last touched the ball over the line; Law 16 awards a goal kick
   when an *attacker* did. The test compared against `attackingTeam`, reversing
   both. It showed up directly in the aggregates: **52.9 corners and 1.4 goal
   kicks** per match against a real ~11 and ~14. Fixing it removed ~26 bogus
   attacking set pieces per team per match.

6. **Shots used a fixed launch angle regardless of distance.** This was the
   largest single defect and it was invisible to every other metric. Measured
   with `tools/shotdiag.ts`: **65% of shots that reached the goal plane went
   over the bar**, at a median distance of just 12.2 m and a median arrival
   height of 3.56 m against a 2.44 m bar. An 18° strike is a good shot from
   25 m and a wasted one from 12 m. The angle is now solved against a target
   height inside the frame, through the same drag model the ball flies under.
   Over-the-bar fell **65% → 0%**, arrival height to a median 1.38 m, and the
   on-target rate rose **9% → 44%**.

### On measuring: two instruments that lied

Both were caught only because two numbers contradicted each other.

- **A goal-line crossing counter cannot sample ball position.** `step()` calls
  `checkOutOfBounds()`, which teleports the ball back to `restartSpot` *inside*
  the pitch before it returns. So a ball that genuinely left play is already
  gone by the time the caller looks. The counter only caught balls sitting in
  the 0.11 m band between the line and `line + radius`. It reported "69.5
  crossings/match, the biggest structural outlier" — a number that meant
  nothing. The authoritative byline count is the engine's own corner and
  goal-kick events.
- **That counter reported 48.4 crossings/match alongside 52.9 corners/match.**
  Corners are a strict subset of crossings, so the pair was impossible. The
  contradiction, not either number, is what found bugs 4 and 5.

### What is still out of band

**Corners are now ~13x too low and goal kicks ~4x too high.** Inverting the rule
fixed the direction but exposed that `lastTouchTeam` is almost always the
attacking team when the ball leaves play — defenders rarely get recorded as the
last touch, so almost nothing becomes a corner. Deflections push towards the
field (correct, and it stopped the own-goal flood), but that also means
defenders seldom put the ball out for a corner. This is the next thing to
measure.

**Tackles at ~154/match against a real ~20** is the other large outlier, and it
predates this work.

**Results skew home** (15/3/6). Both sides are identically rated, so this is
probably a first-mover advantage in the restart or formation code, not a tuning
issue.
