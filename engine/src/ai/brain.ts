/**
 * TeamBrain — what the CPU decides to do, and how difficulty is expressed.
 *
 * Architecture: a UTILITY AI, not a state machine. Every tick (on a per-team
 * cadence) each player scores a small set of candidate actions with a
 * continuous 0..1 "utility" and the highest wins. Utility beats a state
 * machine here for a concrete reason: football decisions are comparative
 * ("shoot vs. pass vs. carry" depends on three continuous quantities at
 * once), and state machines end up as a pile of if-else edge cases that
 * designers cannot tune.
 *
 * Difficulty is NOT "the AI gets extra speed". It is expressed as human-like
 * error, which is both fairer and more convincing:
 *
 *   reactionMs      how long after a change the CPU notices it
 *   aimErrorDeg     angular noise added to every pass and shot
 *   positionalErrorM  noise added to run targets
 *   decisionEveryNTicks  how often it re-plans
 *   offBallQuality  willingness to make runs into space
 *   shapeDiscipline how tightly it holds the formation
 *
 * A Legend opponent therefore plays the same football as a Beginner one, just
 * faster and cleaner — which is what actually happens between divisions.
 */

import { clamp, invLerp, detSqrt, detAtan2 } from '../core/math.js';
import { type Vec3, v3, distanceXZ } from '../core/vec3.js';
import type { Rng } from '../core/rng.js';
import { PITCH } from '../config/tuning.js';
import type { DifficultyProfile } from '../config/tuning.js';
import type { PlayerRuntime } from '../player/entity.js';
import {
  bestReceiver,
  nearestDefenderDistance,
  resolveThroughBallTarget,
} from '../player/controller.js';
// asFieldView is defined further down this file; hoisted function declarations
// make that legal.
import {
  ATTACK_SHAPE,
  DEFEND_SHAPE,
  TRANSITION_SHAPE,
  Phase,
  homePosition,
  type Formation,
} from './formation.js';

export interface BrainInput {
  team: number;
  players: PlayerRuntime[];
  opponents: PlayerRuntime[];
  formation: Formation;
  difficulty: DifficultyProfile;
  ball: Vec3;
  ballVel: Vec3;
  phase: Phase;
  possessionId: number;
  /** Id of the player under human control this tick; the brain skips them. */
  humanControlledId: number;
  tick: number;
  rng: Rng;
}

export interface BrainDecision {
  playerId: number;
  target: Vec3;
  markId: number;
  wantsTackle: boolean;
  wantsPass: boolean;
  wantsThroughBall: boolean;
  wantsShoot: boolean;
  aim: Vec3 | null;
  power: number;
  curve: number;
  placement: number;
  autoPower: boolean;
  sprint: boolean;
}

/** Per-player reaction delay bookkeeping. */
export class TeamBrain {
  private nextDecisionTick = new Map<number, number>();
  private decisions = new Map<number, BrainDecision>();

  getDecision(id: number): BrainDecision | null {
    return this.decisions.get(id) ?? null;
  }

  /**
   * Re-plan. Called every tick; internally each player re-decides on its own
   * cadence, offset by a reaction delay. That staggering is important: if all
   * eleven re-decided on the same tick the team visibly "snaps" in unison.
   */
  update(input: BrainInput): void {
    const reactionTicks = Math.max(1, Math.round(input.difficulty.reactionMs / (1000 / 60)));

    for (const p of input.players) {
      if (p.attr.id === input.humanControlledId) continue;
      if (p.role === 1) {
        this.updateKeeper(p, input);
        continue;
      }

      const due = this.nextDecisionTick.get(p.attr.id) ?? 0;
      if (input.tick < due) continue;

      const decision = this.decide(p, input);
      this.decisions.set(p.attr.id, decision);

      // Re-plan cadence, plus this player's own reaction lag. A player with
      // better reactions genuinely re-plans more often.
      const ownReaction = Math.round(lerpTicks(p.attr.reactions, reactionTicks));
      this.nextDecisionTick.set(
        p.attr.id,
        input.tick + input.difficulty.decisionEveryNTicks + ownReaction,
      );
    }
  }

  // ------------------------------------------------------------------

  private decide(p: PlayerRuntime, input: BrainInput): BrainDecision {
    const d = input.difficulty;
    const base: BrainDecision = {
      playerId: p.attr.id,
      target: v3(p.loco.pos.x, 0, p.loco.pos.z),
      markId: -1,
      wantsTackle: false,
      wantsPass: false,
      wantsThroughBall: false,
      wantsShoot: false,
      aim: null,
      power: 0,
      curve: 0,
      placement: 0,
      autoPower: true,
      sprint: false,
    };

    if (p.hasBall) return this.carrierDecision(p, input, base);
    if (input.phase === Phase.Defend || (input.phase === Phase.Transition && !p.hasBall)) {
      return this.defensiveDecision(p, input, base);
    }
    return this.offBallDecision(p, input, base);
  }

  /** On the ball: shoot, pass, thread it through, or carry. */
  private carrierDecision(p: PlayerRuntime, input: BrainInput, base: BrainDecision): BrainDecision {
    const d = input.difficulty;
    const attackDir = input.team === 0 ? 1 : -1;
    const goal: Vec3 = input.team === 0 ? v3(PITCH.length, 0, PITCH.centreSpotZ) : v3(0, 0, PITCH.centreSpotZ);
    const distToGoal = distanceXZ(p.loco.pos, goal);
    const keeperDist = nearestKeeperDistance(input, p);

    // --- utilities -------------------------------------------------------
    // Shooting: only realistic inside ~28 m with a lane.
    const finishing01 = invLerp(40, 99, p.attr.finishing);
    const laneOpen = clamp(keeperDist / 6, 0, 1);
    // Shooting from outside ~22 m with a defender in the lane is a wasted
    // possession; the earlier 28 m / 0.18 threshold produced ~140 shots a match.
    // Shot selection. Three things gate it: range, whether the keeper is
    // exposed, and whether a defender is actually in the lane. The last one
    // matters most -- without it the AI shot on sight from 20 m through three
    // bodies and the match ended 14-4.
    const blockedShot = 1 - clamp(blockedLane(input, p, goal) / 1.6, 0, 1);
    // Shot selection. The range term is steep because most real goals come from
    // inside the penalty area. It was originally quadratic out to 18 m, but that
    // was tuned while a separate bug was inflating the shot count: corners were
    // being awarded backwards, handing each team ~26 bogus attacking set pieces
    // a match. Fixing that rule (Law 16/17) took shots from 24.6 to 11.1 a
    // match, so the range term was doing double duty suppressing a problem that
    // no longer exists. Widened to 24 m to bring the count back towards the
    // real-world ~25; the 1.5 multiplier that came with it overshot to 38 shots
    // a match once shots stopped flying over the bar, so it is trimmed to 1.12.
    //
    // Note: shots are NOT the main source of byline exits -- measured at 2% of
    // them, against 45% with no kick at all. Do not re-tighten this term to
    // chase the corner count.
    const rangeFactor = clamp((24 - distToGoal) / 16, 0, 1);
    const shootUtility =
      finishing01 *
      rangeFactor *
      (0.25 + 0.75 * laneOpen) *
      (0.35 + 0.65 * blockedShot) *
      1.12;

    // Settle before releasing. Without this the carrier re-decided every ~17
    // ticks and passed almost immediately on every touch, producing ~22,000
    // passes a match of pure hot potato and a ball that was loose half the time.
    const timeOnBall = clamp(p.ticksSinceTouch / 50, 0.22, 1);

    const mate = bestReceiverFor(input, p);
    let passUtility = 0;
    let throughUtility = 0;
    let passTarget: Vec3 | null = null;
    let throughTarget: Vec3 | null = null;

    if (mate !== null) {
      const md = distanceXZ(mate.loco.pos, p.loco.pos);
      const openness = 1 - clamp(nearestDefenderDistanceFor(input, mate) / 6, 0, 1);
      const risk = 1 - laneRisk(input, p, mate);
      const vision01 = invLerp(40, 99, p.attr.vision);
      passUtility =
        (0.35 + openness * 0.75 + vision01 * 0.35) * risk * (md > 30 ? 0.7 : 1) * timeOnBall;
      passTarget = resolveThroughBallTarget(mate, 0.35);

      // A through ball is worth more when the runner is beating his man and
      // there is space behind the line.
      const runningOn = mate.loco.vel.x * attackDir > 2.0;
      const spaceBehind = clamp((nearestDefenderDistanceFor(input, mate) - 2.5) / 6, 0, 1);
      throughUtility = runningOn
        ? (0.3 + spaceBehind * 0.8) * risk * (0.5 + vision01 * 0.5) * timeOnBall
        : 0;
      throughTarget = resolveThroughBallTarget(mate, 0.7 + d.offBallQuality * 0.3);
    }

    // Carrying: good when there is grass in front and nobody closing.
    const pressure = 1 - clamp(nearestOpponentDistance(input, p) / 5, 0, 1);
    const spaceAhead = clamp(forwardSpace(input, p, attackDir) / 14, 0, 1);
    // Carrying is the default early in a touch, which is what makes the AI
    // look like it is playing rather than passing on reflex.
    const dribbleUtility = (0.42 + spaceAhead * 0.55) * (0.4 + pressure * 0.6) * (1.35 - timeOnBall * 0.35);

    // --- difficulty noise: Legend picks the true maximum far more often ----
    const noise = (input.rng.gauss() * d.aimErrorDeg) / 90;
    const pick = argmax([
      { k: 'shoot', u: shootUtility + noise * 0.6 },
      { k: 'through', u: throughUtility + noise * 0.5 },
      { k: 'pass', u: passUtility + noise * 0.5 },
      { k: 'dribble', u: dribbleUtility },
    ]);

    if (pick === 'shoot' && shootUtility > 0.42) {
      base.wantsShoot = true;
      // Aim away from the keeper: pick the far corner more often as the angle
      // tightens, which is what real finishers do.
      const side = input.rng.next() < 0.5 ? -1 : 1;
      base.placement = clamp(side * (0.45 + (1 - laneOpen) * 0.45), -1, 1);
      base.power = clamp(0.55 + (28 - distToGoal) / 60, 0.35, 0.98);
      base.curve = clamp(input.rng.gaussScaled(0.35), -1, 1) * invLerp(40, 99, p.attr.curve);
      base.aim = goalWithPlacement(goal, p.loco.pos, base.placement);
      base.autoPower = false;
      return base;
    }

    if (pick === 'through' && throughTarget !== null) {
      base.wantsThroughBall = true;
      base.aim = throughTarget;
      base.autoPower = true;
      return base;
    }

    if (pick === 'pass' && passTarget !== null) {
      base.wantsPass = true;
      base.aim = passTarget;
      base.autoPower = true;
      // Loft it if the lane is crowded.
      base.power = clamp(0.5 + laneRisk(input, p, mate!) * 0.5, 0.3, 0.95);
      return base;
    }

    // Carry: head for the pocket of space, biased towards goal.
    const carryDirX = attackDir;
    const drift = (PITCH.centreSpotZ - p.loco.pos.z) * 0.06;
    base.target = v3(
      clamp(p.loco.pos.x + carryDirX * 12, 2, PITCH.length - 2),
      0,
      clamp(p.loco.pos.z + drift, 2, PITCH.width - 2),
    );
    base.sprint = pressure < 0.35;
    // Sometimes beat a man instead of running straight at him.
    const nearest = nearestOpponent(input, p);
    if (nearest !== null && distanceXZ(nearest.loco.pos, p.loco.pos) < 3.5) {
      const side = (p.loco.pos.z < nearest.loco.pos.z ? -1 : 1) * (input.rng.next() < 0.5 ? 1 : -1);
      base.target = v3(
        base.target.x,
        0,
        clamp(base.target.z + side * 5, 2, PITCH.width - 2),
      );
    }
    return base;
  }

  /** Off the ball while we have possession: hold shape or make a run. */
  private offBallDecision(p: PlayerRuntime, input: BrainInput, base: BrainDecision): BrainDecision {
    const d = input.difficulty;
    const params = input.phase === Phase.Attack ? ATTACK_SHAPE : TRANSITION_SHAPE;
    const slot = input.formation.slots[p.formationSlot] ?? input.formation.slots[1];
    if (slot === undefined) return base;

    let target = homePosition(slot, input.ball, input.team, input.phase, params);

    // Off-ball runs, weighted by the difficulty's off-ball quality.
    const attackDir = input.team === 0 ? 1 : -1;
    const runChance = slot.freedom * d.offBallQuality;
    if (input.rng.next() < runChance * 0.5) {
      const forwardBias = (input.ball.x * attackDir) / PITCH.length;
      target = v3(
        clamp(target.x + attackDir * (4 + runChance * 10) * (0.4 + forwardBias), 2, PITCH.length - 2),
        0,
        clamp(target.z + input.rng.gaussScaled(4 * (1 - d.shapeDiscipline)), 2, PITCH.width - 2),
      );
    }

    base.target = jitter(target, d.positionalErrorM, input.rng);
    base.sprint = distanceXZ(p.loco.pos, base.target) > 9;
    return base;
  }

  /** Out of possession: press, cover, or mark. */
  private defensiveDecision(p: PlayerRuntime, input: BrainInput, base: BrainDecision): BrainDecision {
    const d = input.difficulty;
    const params = input.phase === Phase.Defend ? DEFEND_SHAPE : TRANSITION_SHAPE;
    const slot = input.formation.slots[p.formationSlot] ?? input.formation.slots[1];
    if (slot === undefined) return base;

    const carrier = input.opponents.find((o) => o.hasBall) ?? null;

    // Who presses? The nearest eligible player, but only if the difficulty
    // says so — low tiers stand off and let you play.
    const presser = nearestTo(input.players, input.ball, input.humanControlledId);
    const iAmPresser = presser !== null && presser.attr.id === p.attr.id;

    if (iAmPresser && input.rng.next() < 0.35 + d.aggression * 0.65) {
      // Intercept rather than chase: aim where the ball is going.
      const lead = clamp(distanceXZ(p.loco.pos, input.ball) * 0.12, 0, 0.7);
      base.target = v3(
        input.ball.x + input.ballVel.x * lead,
        0,
        input.ball.z + input.ballVel.z * lead,
      );
      base.sprint = true;
      if (carrier !== null && distanceXZ(p.loco.pos, carrier.loco.pos) < 1.4) {
        base.wantsTackle = input.rng.next() < d.aggression * 0.35;
      }
      return base;
    }

    // Everyone else: mark a man goal-side, blended with the formation slot
    // according to shape discipline. Low discipline = man-marking chaos;
    // high discipline = a compact zonal block.
    const mark = pickMark(p, input);
    base.markId = mark === null ? -1 : mark.attr.id;

    const shape = homePosition(slot, input.ball, input.team, input.phase, params);
    if (mark === null) {
      base.target = jitter(shape, d.positionalErrorM, input.rng);
    } else {
      const goalX = input.team === 0 ? 0 : PITCH.length;
      const goalZ = PITCH.centreSpotZ;
      // Stand between your man and your goal, a metre or so goal-side.
      const dx = goalX - mark.loco.pos.x;
      const dz = goalZ - mark.loco.pos.z;
      const dl = detSqrt(dx * dx + dz * dz) || 1;
      const standoff = 1.6 + (1 - d.aggression) * 1.6;
      const manPos = v3(
        mark.loco.pos.x + (dx / dl) * standoff,
        0,
        mark.loco.pos.z + (dz / dl) * standoff,
      );
      const w = d.shapeDiscipline; // 1 = pure zonal, 0 = pure man-marking
      base.target = jitter(
        v3(lerpNum(manPos.x, shape.x, w), 0, lerpNum(manPos.z, shape.z, w)),
        d.positionalErrorM,
        input.rng,
      );
    }
    base.sprint = distanceXZ(p.loco.pos, base.target) > 7;
    return base;
  }

  /** Keepers stay on their line, come out for through balls, and close down. */
  private updateKeeper(p: PlayerRuntime, input: BrainInput): void {
    const goalX = input.team === 0 ? 0 : PITCH.length;
    const attackDir = input.team === 0 ? 1 : -1;
    const ballDist = distanceXZ(p.loco.pos, input.ball);

    // How far the ball is in front of this goal (+ve = in front, towards the pitch).
    const ballOffLine = (input.ball.x - goalX) * attackDir;

    // DEFAULT: hold the line. Depth off it grows only slightly with the ball's
    // distance, and is capped low.
    //
    // This used to be a flat 5.5 m off the line, which left an empty net behind
    // the keeper for most of the match. Measurement over 8 matches: the keeper
    // was more than 5 m away at 74 of 102 goals, and 55 of those goals had no
    // shot at all -- the ball was simply passed or carried into an open goal.
    const baseDepth = clamp(0.9 + ballOffLine * 0.055, 0.9, 4.5);

    let x = goalX + attackDir * baseDepth;
    let z = PITCH.centreSpotZ + (input.ball.z - PITCH.centreSpotZ) * 0.6;

    // Read the shot. When the ball is travelling towards this goal, get to the
    // point where it will cross the line instead of shuffling sideways behind
    // it — that difference is the whole job, and without it ~90% of on-target
    // shots were goals because the keeper was simply never in the way.
    const closingSpeed = -input.ballVel.x * attackDir; // >0 when moving at the goal
    if (closingSpeed > 4) {
      const distToLine = (goalX - input.ball.x) * attackDir;
      if (distToLine > 0) {
        const timeToLine = distToLine / closingSpeed;
        if (timeToLine < 2.5) {
          z = clamp(
            input.ball.z + input.ballVel.z * timeToLine,
            PITCH.centreSpotZ - PITCH.goalWidth / 2 + 0.35,
            PITCH.centreSpotZ + PITCH.goalWidth / 2 - 0.35,
          );
          // Come off the line to cut the angle down as the shot arrives.
          x = goalX + attackDir * clamp(1.2 + distToLine * 0.12, 1.2, 7);
        }
      }
    }

    // Sweep up behind a high line, but ONLY while we have the ball and it is
    // deep in the opponent half. Sweeping unconditionally meant the keeper was
    // stranded 12 m out whenever play was at the other end, and could not get
    // back in time.
    if (input.phase === Phase.Attack && ballOffLine > 55) {
      x = goalX + attackDir * clamp(6 + (ballOffLine - 55) * 0.12, 6, 13);
    }

    // Come for a loose ball, or a carrier who is genuinely goalbound. Charging
    // at any opponent inside 16 m (the old rule) abandoned the goal far too
    // often. When he does come, he stops goal-side of the ball rather than
    // running past it.
    if (input.possessionId !== p.attr.id && ballDist < 12) {
      const loose = input.possessionId < 0;
      const carrierClose = ballDist < 5.5;
      if (loose || carrierClose) {
        const stopShort = 0.8;
        const dirToBall = ballOffLine >= 0 ? attackDir : -attackDir;
        x = clamp(input.ball.x - dirToBall * stopShort, 0.8, PITCH.length - 0.8);
        z = input.ball.z;
      }
    }

    // A keeper who has gathered the ball must release it. Standing on it stalls
    // the match and, before the dribble-pocket fix, let them walk it in.
    if (p.hasBall) {
      const mate = bestReceiver(asFieldView(input), p);
      if (mate !== null) {
        this.decisions.set(p.attr.id, {
          playerId: p.attr.id,
          target: mate.loco.pos,
          markId: -1,
          wantsTackle: false,
          wantsPass: p.ticksSinceTouch > 30,
          wantsThroughBall: false,
          wantsShoot: false,
          aim: resolveThroughBallTarget(mate, 0.4),
          power: 0.85,
          curve: 0,
          placement: 0,
          autoPower: true,
          sprint: false,
        });
        return;
      }
    }

    // Lateral position, clamped INSIDE the goal frame.
    //
    // This used to clamp to +/- PITCH.goalWidth (7.32 m) either side of the
    // centre spot, i.e. a 14.6 m band for a 7.32 m goal. The keeper therefore
    // spent much of the match standing OUTSIDE his own goal, next to the post
    // or beyond it. Measured over 8 matches: at the moment of a goal his median
    // lateral miss was 4.66 m and the 90th percentile 8.10 m, against a maximum
    // he can usefully cover of ~3.7 m.
    const goalZ0 = PITCH.centreSpotZ - PITCH.goalWidth / 2;
    const goalZ1 = PITCH.centreSpotZ + PITCH.goalWidth / 2;
    // Track the ball, then clamp into the frame. Bias slightly towards the ball
    // side so he covers the near post without abandoning the far one.
    const tracked = PITCH.centreSpotZ + (input.ball.z - PITCH.centreSpotZ) * 0.45;
    const goalZ = clamp(tracked, goalZ0 + 0.35, goalZ1 - 0.35);

    const target = v3(
      clamp(x, 0.8, PITCH.length - 0.8),
      0,
      goalZ,
    );
    void z;
    this.decisions.set(p.attr.id, {
      playerId: p.attr.id,
      target,
      markId: -1,
      wantsTackle: ballDist < 2.2 && input.phase !== Phase.Attack,
      wantsPass: false,
      wantsThroughBall: false,
      wantsShoot: false,
      aim: null,
      power: 0,
      curve: 0,
      placement: 0,
      autoPower: true,
      sprint: distanceXZ(p.loco.pos, target) > 6,
    });
  }
}

// ----------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------

function lerpTicks(reactionRating: number, baseTicks: number): number {
  return baseTicks * lerpNum(1.35, 0.65, invLerp(40, 99, reactionRating));
}

function lerpNum(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function jitter(target: Vec3, metres: number, rng: Rng): Vec3 {
  if (metres <= 0) return target;
  return v3(
    clamp(target.x + rng.gaussScaled(metres), 2, PITCH.length - 2),
    0,
    clamp(target.z + rng.gaussScaled(metres), 2, PITCH.width - 2),
  );
}

function argmax(items: { k: string; u: number }[]): string {
  let best = items[0];
  if (best === undefined) return 'dribble';
  for (const it of items) if (it.u > best.u) best = it;
  return best.k;
}

function bestReceiverFor(input: BrainInput, p: PlayerRuntime): PlayerRuntime | null {
  // Reuse the same scoring the human assist uses, so the CPU cannot pick a
  // pass the player could not.
  return bestReceiver(asFieldView(input), p);
}

function asFieldView(input: BrainInput) {
  // The controller only reads this shape; keeping the two types compatible
  // avoids a second scoring implementation drifting out of sync.
  return {
    players: [...input.players, ...input.opponents],
    ball: {
      pos: input.ball,
      vel: input.ballVel,
      spin: v3(0, 0, 0),
      grounded: true,
      lastBounceTick: -1,
      lastImpactSpeed: 0,
      lastTouchId: -1,
      lastTouchTeam: -1,
    },
    possessionId: input.possessionId,
    possessionTeam: -1,
    tick: input.tick,
    dt: 1 / 60,
    rng: input.rng,
  };
}

function nearestDefenderDistanceFor(input: BrainInput, p: PlayerRuntime): number {
  let best = 999;
  for (const o of input.opponents) {
    const d = distanceXZ(o.loco.pos, p.loco.pos);
    if (d < best) best = d;
  }
  return best;
}

function nearestOpponentDistance(input: BrainInput, p: PlayerRuntime): number {
  return nearestDefenderDistanceFor(input, p);
}

function nearestOpponent(input: BrainInput, p: PlayerRuntime): PlayerRuntime | null {
  let best: PlayerRuntime | null = null;
  let bestD = 999;
  for (const o of input.opponents) {
    const d = distanceXZ(o.loco.pos, p.loco.pos);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

function nearestKeeperDistance(input: BrainInput, p: PlayerRuntime): number {
  for (const o of input.opponents) {
    if (o.role === 1) return distanceXZ(o.loco.pos, p.loco.pos);
  }
  return 20;
}

/** How many defenders are standing between the shooter and the goal. */
function blockedLane(input: BrainInput, p: PlayerRuntime, goal: Vec3): number {
  const ax = p.loco.pos.x;
  const az = p.loco.pos.z;
  const dx = goal.x - ax;
  const dz = goal.z - az;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-6) return 0;
  let block = 0;
  for (const o of input.opponents) {
    const t = clamp(((o.loco.pos.x - ax) * dx + (o.loco.pos.z - az) * dz) / len2, 0, 1);
    const px = ax + dx * t;
    const pz = az + dz * t;
    const d = detSqrt((o.loco.pos.x - px) * (o.loco.pos.x - px) + (o.loco.pos.z - pz) * (o.loco.pos.z - pz));
    if (d < 1.2) block += (1.2 - d) / 1.2;
  }
  return clamp(block, 0, 1);
}

/** Fraction of opponents standing in the passing lane (0 = clear, 1 = blocked). */
function laneRisk(input: BrainInput, from: PlayerRuntime, to: PlayerRuntime): number {
  const ax = from.loco.pos.x;
  const az = from.loco.pos.z;
  const bx = to.loco.pos.x;
  const bz = to.loco.pos.z;
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-6) return 0;

  let risk = 0;
  for (const o of input.opponents) {
    const t = clamp(((o.loco.pos.x - ax) * dx + (o.loco.pos.z - az) * dz) / len2, 0, 1);
    const px = ax + dx * t;
    const pz = az + dz * t;
    const dist = detSqrt((o.loco.pos.x - px) * (o.loco.pos.x - px) + (o.loco.pos.z - pz) * (o.loco.pos.z - pz));
    if (dist < 2.2) risk += (2.2 - dist) / 2.2;
  }
  return clamp(risk, 0, 1);
}

/** How much clear grass is in front of the carrier. */
function forwardSpace(input: BrainInput, p: PlayerRuntime, attackDir: number): number {
  const probeX = p.loco.pos.x + attackDir * 12;
  let best = 999;
  for (const o of input.opponents) {
    const d = detSqrt(
      (o.loco.pos.x - probeX) * (o.loco.pos.x - probeX) + (o.loco.pos.z - p.loco.pos.z) * (o.loco.pos.z - p.loco.pos.z),
    );
    if (d < best) best = d;
  }
  return best;
}

function nearestTo(players: PlayerRuntime[], target: Vec3, skipId: number): PlayerRuntime | null {
  let best: PlayerRuntime | null = null;
  let bestD = Infinity;
  for (const p of players) {
    if (p.attr.id === skipId) continue;
    if (p.role === 1) continue;
    const d = distanceXZ(p.loco.pos, target);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/** Assign a mark, preferring the nearest unmarked opponent. */
function pickMark(p: PlayerRuntime, input: BrainInput): PlayerRuntime | null {
  let best: PlayerRuntime | null = null;
  let bestScore = -Infinity;
  for (const o of input.opponents) {
    if (o.role === 1) continue;
    const d = distanceXZ(o.loco.pos, p.loco.pos);
    // Prefer staying close to your own slot; a defender should not follow a
    // striker 40 m out of position.
    const slotDist = distanceXZ(p.homeTarget, o.loco.pos);
    const score = -d * 0.6 - slotDist * 0.4 + invLerp(40, 99, o.attr.finishing) * 2;
    if (score > bestScore) {
      bestScore = score;
      best = o;
    }
  }
  return best;
}

function goalWithPlacement(goal: Vec3, from: Vec3, placement: number): Vec3 {
  let dx = goal.x - from.x;
  let dz = goal.z - from.z;
  const len = detSqrt(dx * dx + dz * dz) || 1;
  dx /= len;
  dz /= len;
  const px = -dz;
  const pz = dx;
  const half = (PITCH.goalWidth / 2 - 0.4) * placement;
  return v3(goal.x + px * half, 0.9, goal.z + pz * half);
}

export { detAtan2 as brainAtan2 };
