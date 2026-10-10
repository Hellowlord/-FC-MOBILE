/**
 * MatchEngine — the game loop, in simulation terms.
 *
 * One call to `step(dt)` advances the whole match by exactly one fixed tick.
 * The engine owns no timers of its own beyond the match clock: everything is
 * counted in ticks so a match is a pure function of (seed, inputs).
 *
 * Tick order (this ordering is load-bearing):
 *
 *   1. clock + restart state machine
 *   2. decide who is in possession
 *   3. build the field view snapshot
 *   4. human player switching
 *   5. AI brains re-plan (on their own cadence)
 *   6. every player controller runs ONE step
 *   7. player/player separation
 *   8. ball physics + goalposts + goal detection
 *   9. restart checks (goal, out of play)
 *  10. stamina
 *
 * Doing the ball last means a kick resolved on tick N is integrated on tick N
 * too, so there is no one-frame "frozen ball" after a strike.
 */

import { clamp, detSqrt } from '../core/math.js';
import { type Vec3, v3, distanceXZ, scale, sub } from '../core/vec3.js';
import { Rng } from '../core/rng.js';
import { SIM_DT } from '../core/fixed-step.js';
import { BALL, MATCH, PITCH } from '../config/tuning.js';
import type { DifficultyProfile } from '../config/tuning.js';
import { type BallState, createBall, stepBall } from '../physics/ball.js';
import { type PlayerRuntime, createPlayer, ActionKind, AnimHint } from '../player/entity.js';
import { makeAttributes, drainPerStep, recoverPerStep, type PlayerAttributes, type Position } from '../player/attributes.js';
import {
  PlayerController,
  type FieldView,
  type ControllerEvents,
  emptyInput,
  type PlayerInput,
} from '../player/controller.js';
import { clampToPitch, separate } from '../player/locomotion.js';
import { TeamBrain, type BrainDecision } from '../ai/brain.js';
import { Phase, formationById, kickoffPosition, type Formation } from '../ai/formation.js';

export enum MatchPeriod {
  FirstHalf = 0,
  HalfTime = 1,
  SecondHalf = 2,
  FullTime = 3,
}

export enum Restart {
  OpenPlay = 0,
  Kickoff = 1,
  ThrowIn = 2,
  GoalKick = 3,
  Corner = 4,
  AfterGoal = 5,
}

export interface MatchEvent {
  tick: number;
  kind: string;
  /** Human-readable payload for the commentary / HUD feed. */
  text: string;
  data: Record<string, number | string>;
}

export interface TeamConfig {
  name: string;
  shortName: string;
  formationId: string;
  /** Squad-wide rating used to generate the eleven. */
  rating: number;
  difficulty: DifficultyProfile;
  /** True for the team a human controls. */
  human: boolean;
  primaryColour: string;
  secondaryColour: string;
}

export interface MatchConfig {
  seed: number;
  home: TeamConfig;
  away: TeamConfig;
  /** Half length in match seconds. Shorten for arcade modes. */
  halfLengthSec?: number;
}

const POSITIONS: Position[] = [
  'GK',
  'LB',
  'CB',
  'CB',
  'RB',
  'CM',
  'CM',
  'CM',
  'LW',
  'ST',
  'RW',
];

export class MatchEngine {
  readonly rng: Rng;
  readonly config: MatchConfig;

  players: PlayerRuntime[] = [];
  controllers = new Map<number, PlayerController>();
  ball: BallState;

  homeFormation: Formation;
  awayFormation: Formation;

  private homeBrain = new TeamBrain();
  private awayBrain = new TeamBrain();

  score = [0, 0];
  period: MatchPeriod = MatchPeriod.FirstHalf;
  restart: Restart = Restart.Kickoff;
  /** Match clock in seconds, counts up within the current half. */
  clock = 0;
  tick = 0;
  /** Ticks remaining before the current restart is released. */
  private restartTimer = 0;

  possessionId = -1;
  possessionTeam = -1;
  /** Team that last touched the ball; drives throw-in / corner decisions. */
  lastTouchTeam = -1;

  /** The player a human controls. -1 while a restart animation plays. */
  controlledId: number;

  events: MatchEvent[] = [];
  private pendingEvents: MatchEvent[] = [];

  /** Shots on target etc., for the post-match screen. */
  stats = {
    shots: [0, 0],
    shotsOnTarget: [0, 0],
    passes: [0, 0],
    passSuccess: [0, 0],
    tackles: [0, 0],
    saves: [0, 0],
    gathers: [0, 0],
    possessionTicks: [0, 0],
    corners: [0, 0],
  };

  private lastKickTeam = -1;
  private lastKickTarget: Vec3 | null = null;

  constructor(config: MatchConfig) {
    this.config = config;
    this.rng = new Rng(config.seed);
    this.ball = createBall(v3(PITCH.centreSpotX, BALL.radius, PITCH.centreSpotZ));
    this.homeFormation = formationById(config.home.formationId);
    this.awayFormation = formationById(config.away.formationId);

    this.buildSquads();
    this.controlledId = this.players.find((p) => p.attr.team === 0 && p.role === 0)!.attr.id;
    this.setupKickoff(0);
  }

  // ------------------------------------------------------------------
  // Setup
  // ------------------------------------------------------------------

  private buildSquads(): void {
    const mk = (team: number, cfg: TeamConfig, offset: number) => {
      for (let i = 0; i < 11; i++) {
        const pos = POSITIONS[i];
        if (pos === undefined) continue;
        const attr: PlayerAttributes = makeAttributes(
          team * 100 + i + 1,
          `${cfg.shortName} ${i + 1}`,
          i === 0 ? 1 : i + 1,
          pos,
          team,
          pos === 'GK' ? cfg.rating - 4 : cfg.rating,
          offset + i,
        );
        const player = createPlayer(attr, v3(PITCH.centreSpotX, 0, PITCH.centreSpotZ), team === 0 ? 0 : Math.PI, cfg.difficulty.speedBias);
        player.formationSlot = i;
        this.players.push(player);
        this.controllers.set(player.attr.id, new PlayerController(player));
      }
    };
    mk(0, this.config.home, 0);
    mk(1, this.config.away, 500);
  }

  private teamPlayers(team: number): PlayerRuntime[] {
    return this.players.filter((p) => p.attr.team === team);
  }

  private kickoffTeam = 0;

  private setupKickoff(kickingTeam: number): void {
    this.kickoffTeam = kickingTeam;
    this.restart = Restart.Kickoff;
    this.restartTimer = Math.round(MATCH.kickoffResetDelay / SIM_DT);
    this.ball.pos = v3(PITCH.centreSpotX, BALL.radius, PITCH.centreSpotZ);
    this.ball.vel = v3(0, 0, 0);
    this.ball.spin = v3(0, 0, 0);
    this.possessionId = -1;
    this.possessionTeam = -1;

    for (const p of this.players) {
      const team = p.attr.team;
      const slot = (team === 0 ? this.homeFormation : this.awayFormation).slots[p.formationSlot];
      if (slot === undefined) continue;
      const pos = kickoffPosition(slot, team);
      p.loco.pos = v3(pos.x, 0, pos.z);
      p.loco.vel = v3(0, 0, 0);
      p.loco.speed = 0;
      p.loco.heading = team === 0 ? 0 : Math.PI;
      p.hasBall = false;
      p.actionKind = ActionKind.None;
      p.actionTimer = 0;
      p.frozenTimer = 0;
      p.loco.locked = false;
    }

    // One striker from the kicking team stands on the ball.
    const striker = this.kickoffStriker();
    if (striker !== null) {
      striker.loco.pos = v3(
        PITCH.centreSpotX + (kickingTeam === 0 ? -0.8 : 0.8),
        0,
        PITCH.centreSpotZ,
      );
    }
    // Nobody is controllable until the restart is released.
    this.controlledId = -1;
  }

  private kickoffStriker(): PlayerRuntime | null {
    const squad = this.teamPlayers(this.kickoffTeam).filter((p) => p.role === 0);
    // Furthest forward slot, falling back to the nearest player to the spot.
    return (
      squad.reduce((best, p) => (best === null || p.formationSlot > best.formationSlot ? p : best), null as PlayerRuntime | null)
    );
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /** Human input for the player currently under control. */
  setHumanInput(input: Partial<PlayerInput>): void {
    const c = this.controllers.get(this.controlledId);
    if (c !== undefined) c.setInput(input);
  }

  /** Force control onto a specific player (player-switch button). */
  switchTo(playerId: number): void {
    if (this.controlledId === playerId) return;
    const target = this.players.find((p) => p.attr.id === playerId);
    if (target === undefined || target.attr.team !== 0) return;
    this.controlledId = playerId;
  }

  /** Switch to the player best placed to win the ball. */
  autoSwitch(): void {
    const candidates = this.teamPlayers(0).filter((p) => p.role === 0 && p.attr.id !== this.controlledId);
    let best: PlayerRuntime | null = null;
    let bestScore = -Infinity;
    for (const p of candidates) {
      const d = distanceXZ(p.loco.pos, this.ball.pos);
      // Favour being between the ball and your own goal.
      const goalSide = p.loco.pos.x < this.ball.pos.x ? 1.0 : 0.7;
      const score = (-d + p.loco.speed * 0.3) * goalSide;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (best !== null) this.switchTo(best.attr.id);
  }

  get controlledPlayer(): PlayerRuntime | null {
    return this.players.find((p) => p.attr.id === this.controlledId) ?? null;
  }

  // ------------------------------------------------------------------
  // The loop
  // ------------------------------------------------------------------

  step(): void {
    this.tick++;
    this.pendingEvents.length = 0;
    this.advanceClock();

    if (this.period === MatchPeriod.FullTime) {
      this.flushEvents();
      return;
    }

    this.updatePossession();

    const view: FieldView = {
      players: this.players,
      ball: this.ball,
      possessionId: this.possessionId,
      possessionTeam: this.possessionTeam,
      tick: this.tick,
      dt: SIM_DT,
      rng: this.rng,
    };

    const events: ControllerEvents = {
      kicked: [],
      possessionGained: [],
      possessionLost: [],
      tackleAttempted: [],
    };

    // ---- restarts ------------------------------------------------------
    if (this.restartTimer > 0) {
      this.restartTimer--;
      if (this.restartTimer === 0) {
        this.releaseRestart();
      }
    }

    const phase = this.currentPhase();
    const frozen = this.restartTimer > 0;

    // ---- AI ------------------------------------------------------------
    if (!frozen) {
      this.runBrain(0, phase, view);
      this.runBrain(1, phase, view);
      this.applyDecisions(view, events);
    } else {
      // Players hold their restart shape; nobody is controllable yet.
      for (const p of this.players) {
        const c = this.controllers.get(p.attr.id);
        if (c === undefined) continue;
        c.setInput({ moveX: 0, moveZ: 0, sprint: false });
      }
    }

    // ---- players --------------------------------------------------------
    for (const p of this.players) {
      const c = this.controllers.get(p.attr.id);
      if (c === undefined) continue;
      c.update(view, events);
      clampToPitch(p.loco, -3, PITCH.length + 3, -3, PITCH.width + 3);
    }

    this.resolveSeparations();
    this.resolvePostAndBarCollisions();

    // ---- ball -----------------------------------------------------------
    const bounced = stepBall(this.ball, SIM_DT, this.tick);
    if (bounced) {
      this.emit('bounce', '', { speed: this.ball.lastImpactSpeed });
    }

    this.recordKickEvents(events);
    this.recordGatherEvents(events);
    this.checkGoal();
    this.checkOutOfBounds();
    this.updateStamina();

    this.flushEvents();
  }

  private advanceClock(): void {
    if (this.period === MatchPeriod.HalfTime || this.period === MatchPeriod.FullTime) return;
    if (this.restartTimer > 0) return;
    this.clock += SIM_DT;

    const halfLen = this.config.halfLengthSec ?? MATCH.halfLengthSec;
    if (this.clock >= halfLen) {
      if (this.period === MatchPeriod.FirstHalf) {
        this.period = MatchPeriod.HalfTime;
        this.emit('halfTime', 'Half time', {});
        // Second half: swap ends conceptually by giving the away side kickoff.
        this.clock = 0;
        this.period = MatchPeriod.SecondHalf;
        this.setupKickoff(1);
      } else {
        this.period = MatchPeriod.FullTime;
        this.emit('fullTime', 'Full time', {});
      }
    }
  }

  private currentPhase(): Phase {
    if (this.possessionId < 0) return Phase.Transition;
    return this.possessionTeam === 0 || this.possessionTeam === 1
      ? Phase.Attack
      : Phase.Transition;
  }

  private updatePossession(): void {
    let owner: PlayerRuntime | null = null;
    for (const p of this.players) {
      if (p.hasBall) {
        owner = p;
        break;
      }
    }
    this.possessionId = owner === null ? -1 : owner.attr.id;
    this.possessionTeam = owner === null ? -1 : owner.attr.team;
    // Mirror the ball's last toucher. This field was declared and read by
    // checkOutOfBounds but never written, so it stayed -1 forever and every
    // throw-in and corner in the game was awarded to team 1.
    if (this.ball.lastTouchTeam >= 0) this.lastTouchTeam = this.ball.lastTouchTeam;
    if (this.possessionTeam >= 0) {
      this.stats.possessionTicks[this.possessionTeam] =
        (this.stats.possessionTicks[this.possessionTeam] ?? 0) + 1;
    }
  }

  private runBrain(team: number, phase: Phase, view: FieldView): void {
    const brain = team === 0 ? this.homeBrain : this.awayBrain;
    const cfg = team === 0 ? this.config.home : this.config.away;
    const teamPhase =
      this.possessionTeam === -1 ? Phase.Transition : this.possessionTeam === team ? Phase.Attack : Phase.Defend;

    brain.update({
      team,
      players: this.teamPlayers(team),
      opponents: this.teamPlayers(1 - team),
      formation: team === 0 ? this.homeFormation : this.awayFormation,
      difficulty: cfg.difficulty,
      ball: view.ball.pos,
      ballVel: view.ball.vel,
      phase: teamPhase,
      possessionId: this.possessionId,
      humanControlledId: team === 0 && this.config.home.human ? this.controlledId : -1,
      tick: this.tick,
      rng: this.rng,
    });
    void phase;
  }

  /** Convert each AI decision into controller input. */
  private applyDecisions(view: FieldView, events: ControllerEvents): void {
    for (const p of this.players) {
      // Only hold a player back for the human if there IS a human. A headless
      // balance run previously left the home side's nearest man frozen for the
      // whole match, which is why home possession came out at 11%.
      if (this.config.home.human && p.attr.id === this.controlledId) continue;
      const brain = p.attr.team === 0 ? this.homeBrain : this.awayBrain;
      const d = brain.getDecision(p.attr.id);
      const c = this.controllers.get(p.attr.id);
      if (c === undefined) continue;
      if (d === null) {
        c.setInput({ moveX: 0, moveZ: 0, sprint: false });
        continue;
      }
      const input = decisionToInput(p, d, view);
      c.setInput(input);
    }
    void events;
  }

  private resolveSeparations(): void {
    for (let i = 0; i < this.players.length; i++) {
      for (let j = i + 1; j < this.players.length; j++) {
        const a = this.players[i];
        const b = this.players[j];
        if (a === undefined || b === undefined) continue;
        const wa = 0.5 + a.attr.strength / 200;
        const wb = 0.5 + b.attr.strength / 200;
        separate(a.loco, b.loco, wa, wb);
      }
    }
  }

  /** Ball vs posts and crossbar. Cheap, but missing it looks terrible. */
  private resolvePostAndBarCollisions(): void {
    const r = BALL.radius;
    const postR = 0.06;
    const goalZ0 = PITCH.centreSpotZ - PITCH.goalWidth / 2;
    const goalZ1 = PITCH.centreSpotZ + PITCH.goalWidth / 2;

    for (const lineX of [0, PITCH.length]) {
      for (const pz of [goalZ0, goalZ1]) {
        const dx = this.ball.pos.x - lineX;
        const dz = this.ball.pos.z - pz;
        const d = detSqrt(dx * dx + dz * dz);
        const minD = r + postR;
        if (d < minD && this.ball.pos.y < PITCH.goalHeight && d > 1e-6) {
          const nx = dx / d;
          const nz = dz / d;
          this.ball.pos.x = lineX + nx * minD;
          this.ball.pos.z = pz + nz * minD;
          const vn = this.ball.vel.x * nx + this.ball.vel.z * nz;
          if (vn < 0) {
            this.ball.vel.x -= 2 * vn * nx * 0.75;
            this.ball.vel.z -= 2 * vn * nz * 0.75;
            this.emit('post', 'Off the post!', { x: this.ball.pos.x });
          }
        }
      }
    }
    // Crossbar: a horizontal cylinder at goal height spanning the mouth.
    for (const lineX of [0, PITCH.length]) {
      if (
        this.ball.pos.z > goalZ0 &&
        this.ball.pos.z < goalZ1 &&
        Math.abs(this.ball.pos.x - lineX) < r + postR &&
        Math.abs(this.ball.pos.y - PITCH.goalHeight) < r + postR
      ) {
        const dy = this.ball.pos.y - PITCH.goalHeight;
        const dySign = dy >= 0 ? 1 : -1;
        this.ball.pos.y = PITCH.goalHeight + dySign * (r + postR);
        if (this.ball.vel.y * dySign < 0) this.ball.vel.y *= -0.7;
        this.emit('post', 'Off the bar!', { x: this.ball.pos.x });
      }
    }
  }

  // ------------------------------------------------------------------
  // Restarts and goals
  // ------------------------------------------------------------------

  private prevBallX: number = PITCH.centreSpotX;

  /** Straight-line projection of the current ball velocity onto the goal plane. */
  private projectedOnTarget(team: number): boolean {
    const goalX = team === 0 ? PITCH.length : 0;
    const dirX = team === 0 ? 1 : -1;
    if (this.ball.vel.x * dirX <= 0.5) return false; // not travelling at the goal
    const t = (goalX - this.ball.pos.x) / this.ball.vel.x;
    if (t < 0 || t > 4) return false;
    const z = this.ball.pos.z + this.ball.vel.z * t;
    const y = this.ball.pos.y + this.ball.vel.y * t;
    const halfW = PITCH.goalWidth / 2;
    return Math.abs(z - PITCH.centreSpotZ) < halfW && y > 0 && y < PITCH.goalHeight;
  }

  private checkGoal(): void {
    // Only in open play. Without this guard a scored goal re-triggered on every
    // tick of the celebration, because the ball is still behind the line until
    // the kickoff reset moves it: matches ended 300,000-0. The headless rig
    // caught this at ~110,000 goals per match.
    if (this.restartTimer > 0 || this.restart !== Restart.OpenPlay) return;

    const r = BALL.radius;
    const goalZ0 = PITCH.centreSpotZ - PITCH.goalWidth / 2;
    const goalZ1 = PITCH.centreSpotZ + PITCH.goalWidth / 2;
    const inMouth = this.ball.pos.z > goalZ0 && this.ball.pos.z < goalZ1 && this.ball.pos.y < PITCH.goalHeight;

    // Team 0 attacks +x, so a goal at x = PITCH.length is a home goal.
    // Require a genuine crossing of the plane from the field side: without it a
    // ball that ends up behind the line during a scramble keeps re-scoring.
    const crossedFar = this.ball.pos.x > PITCH.length + r && this.prevBallX <= PITCH.length + r;
    const crossedNear = this.ball.pos.x < -r && this.prevBallX >= -r;
    if (crossedFar && inMouth) {
      this.scoreGoal(0);
    } else if (crossedNear && inMouth) {
      this.scoreGoal(1);
    }
    this.prevBallX = this.ball.pos.x;
  }

  private scoreGoal(team: number): void {
    this.score[team] = (this.score[team] ?? 0) + 1;
    this.emit('goal', `GOAL! ${team === 0 ? this.config.home.name : this.config.away.name}`, {
      team,
      scorer: this.ball.lastTouchId,
      home: this.score[0] ?? 0,
      away: this.score[1] ?? 0,
    });

    for (const p of this.players) {
      if (p.attr.team === team) {
        p.actionKind = ActionKind.Celebrate;
        p.actionTimer = Math.round(MATCH.goalCelebrationSec / SIM_DT);
      }
    }

    this.restart = Restart.AfterGoal;
    this.restartTimer = Math.round(MATCH.goalCelebrationSec / SIM_DT);
    this.kickoffTeam = 1 - team;
  }

  private checkOutOfBounds(): void {
    if (this.restartTimer > 0) return;
    const r = BALL.radius;
    const p = this.ball.pos;

    const overLine = p.x < -r || p.x > PITCH.length + r;
    const overTouch = p.z < -r || p.z > PITCH.width + r;
    if (!overLine && !overTouch) return;

    // Which goal line was crossed decides everything. The team that OWNS that
    // line defends it: if the opponents put it out, they get a corner; if the
    // defending team put it out themselves, they concede a goal kick. The
    // previous "attackingTeam = 1 - lastTouchTeam" shortcut got this backwards
    // and handed away ~460 corners a match.
    const overFarLine = p.x > PITCH.length + r;
    const lineOwner = overFarLine ? 1 : 0;
    const attackingTeam = 1 - lineOwner;
    // Law 16 / Law 17. A CORNER is awarded when the ball leaves play over the
    // goal line having last been touched by a DEFENDER; a GOAL KICK when it was
    // last touched by an ATTACKER. The comparison here was against
    // attackingTeam, which is the reverse of both laws, and it showed up
    // directly in the aggregates: 52.9 corners and 1.4 goal kicks per match
    // against a real-world ~11 and ~14. Defenders put the ball out far more
    // often than attackers, so an inverted test manufactures corners.
    const putOutByDefenders = this.lastTouchTeam === lineOwner;
    const wideOfMouthAndDefenders =
      (p.z < PITCH.centreSpotZ - PITCH.goalWidth / 2 || p.z > PITCH.centreSpotZ + PITCH.goalWidth / 2) &&
      putOutByDefenders;

    if (overLine) {
      const goalZ0 = PITCH.centreSpotZ - PITCH.goalWidth / 2;
      const goalZ1 = PITCH.centreSpotZ + PITCH.goalWidth / 2;
      const wideOfMouth = p.z < goalZ0 || p.z > goalZ1;
      if (wideOfMouth && putOutByDefenders) {
        this.stats.corners[attackingTeam] = (this.stats.corners[attackingTeam] ?? 0) + 1;
        this.emit('corner', 'Corner kick', { team: attackingTeam });
      } else {
        this.emit('goalkick', 'Goal kick', { team: lineOwner });
      }
    } else {
      // Throw-in goes to the team that did not touch it last.
      const throwTeam = this.lastTouchTeam === 0 ? 1 : this.lastTouchTeam === 1 ? 0 : attackingTeam;
      this.emit('throwin', 'Throw in', { team: throwTeam });
    }

    // Restart spot: just inside the line where the ball left. Clamping here is
    // load-bearing, not cosmetic -- see releaseRestart.
    this.restartSpot = v3(clamp(p.x, 2, PITCH.length - 2), r, clamp(p.z, 2, PITCH.width - 2));
    this.ball.pos = { ...this.restartSpot };
    this.ball.vel = v3(0, 0, 0);
    this.ball.spin = v3(0, 0, 0);
    for (const pl of this.players) pl.hasBall = false;
    const takingTeam = overLine
      ? wideOfMouthAndDefenders
        ? attackingTeam
        : lineOwner
      : this.lastTouchTeam === 0
        ? 1
        : this.lastTouchTeam === 1
          ? 0
          : attackingTeam;
    this.restart = overLine ? Restart.GoalKick : Restart.ThrowIn;
    this.restartTimer = Math.round(0.6 / SIM_DT);
    this.restartTaker = this.teamPlayers(takingTeam).reduce((best, pl) => {
      if (best === null) return pl;
      return distanceXZ(pl.loco.pos, this.ball.pos) < distanceXZ(best.loco.pos, this.ball.pos) ? pl : best;
    }, null as PlayerRuntime | null);
  }

  private restartTaker: PlayerRuntime | null = null;
  private restartSpot: Vec3 = v3(PITCH.centreSpotX, BALL.radius, PITCH.centreSpotZ);

  /**
   * Release a restart into open play.
   *
   * This used to call setupKickoff() again for a Kickoff/AfterGoal restart,
   * which re-armed the same timer and re-armed it forever: the match sat in a
   * kickoff loop, the ball never moved, and every seed produced an identical
   * 0-0. A restart must HAND OVER the ball and move to OpenPlay, never
   * re-enter the setup state.
   */
  private releaseRestart(): void {
    if (this.restart === Restart.Kickoff || this.restart === Restart.AfterGoal) {
      const striker = this.kickoffStriker();
      this.ball.pos = v3(PITCH.centreSpotX, BALL.radius, PITCH.centreSpotZ);
      this.ball.vel = v3(0, 0, 0);
      this.ball.spin = v3(0, 0, 0);
      if (striker !== null) {
        striker.loco.pos = v3(
          PITCH.centreSpotX + (this.kickoffTeam === 0 ? -0.7 : 0.7),
          0,
          PITCH.centreSpotZ,
        );
        striker.hasBall = true;
        striker.ticksSinceTouch = 0;
        this.ball.lastTouchId = striker.attr.id;
        this.ball.lastTouchTeam = striker.attr.team;
        if (striker.attr.team === 0) this.controlledId = striker.attr.id;
      }
    } else {
      const taker = this.restartTaker;
      if (taker !== null) {
        // Move the taker to the restart spot instead of moving the ball to the
        // taker. Players are allowed to stand up to 3 m outside the pitch, so
        // placing the ball at their feet could put it out of play again, which
        // re-triggered checkOutOfBounds on the very next tick and produced
        // ~2,200 phantom corners a match in an endless restart loop.
        this.ball.pos = { ...this.restartSpot };
        taker.loco.pos = v3(
          clamp(this.restartSpot.x, 1, PITCH.length - 1),
          0,
          clamp(this.restartSpot.z, 1, PITCH.width - 1),
        );
        taker.loco.vel = v3(0, 0, 0);
        taker.loco.speed = 0;
        this.ball.vel = v3(0, 0, 0);
        this.ball.spin = v3(0, 0, 0);
        taker.hasBall = true;
        taker.ticksSinceTouch = 0;
        this.ball.lastTouchId = taker.attr.id;
        this.ball.lastTouchTeam = taker.attr.team;
        if (taker.attr.team === 0) this.controlledId = taker.attr.id;
      }
    }

    // If the human team is not taking the restart, hand them the nearest
    // outfielder so they are never locked out of the match.
    if (this.controlledId < 0) {
      const home = this.teamPlayers(0)
        .filter((p) => p.role === 0)
        .sort((a, b) => distanceXZ(a.loco.pos, this.ball.pos) - distanceXZ(b.loco.pos, this.ball.pos));
      if (home[0] !== undefined) this.controlledId = home[0].attr.id;
    }
    this.restart = Restart.OpenPlay;
  }

  // ------------------------------------------------------------------

  private updateStamina(): void {
    for (const p of this.players) {
      const effort = p.loco.effort;
      p.stamina = clamp(p.stamina - drainPerStep(effort, p.profile.staminaDrainScale, SIM_DT), 0, 1);
      p.stamina = clamp(p.stamina + recoverPerStep(effort, SIM_DT), 0, 1);
    }
  }

  private recordGatherEvents(events: ControllerEvents): void {
    for (const id of events.possessionGained) {
      const player = this.players.find((p) => p.attr.id === id);
      if (player === undefined || player.role !== 1) continue;
      // Only a genuinely struck ball counts as a save. Picking up a back-pass
      // or a loose ball is a gather, and counting those produced the nonsense
      // stat line "73 saves from 18 shots".
      const speed = Math.hypot(this.ball.vel.x, this.ball.vel.z);
      const isSave = speed > 12 && this.ball.lastTouchTeam !== player.attr.team;
      this.stats.gathers[player.attr.team] = (this.stats.gathers[player.attr.team] ?? 0) + 1;
      if (!isSave) continue;
      this.stats.saves[player.attr.team] = (this.stats.saves[player.attr.team] ?? 0) + 1;
      this.emit('save', `Save by ${player.attr.name}`, { team: player.attr.team });
    }
  }

  private recordKickEvents(events: ControllerEvents): void {
    for (const k of events.kicked) {
      const player = this.players.find((p) => p.attr.id === k.playerId);
      const team = player === undefined ? 0 : player.attr.team;
      this.lastKickTeam = team;
      this.lastKickTarget = k.target;

      if (k.kind === 'shotDrive' || k.kind === 'shotNormal' || k.kind === 'shotChip') {
        this.stats.shots[team] = (this.stats.shots[team] ?? 0) + 1;
        // On target is judged from the ACTUAL struck velocity, not the intended
        // aim point: the whole point of the accuracy model is that the ball
        // leaves off-line, so measuring the aim would report ~97% on target.
        // Straight-line projection to the goal plane (ignores drag and curve),
        // which is the right precision for a stat.
        if (this.projectedOnTarget(team)) {
          this.stats.shotsOnTarget[team] = (this.stats.shotsOnTarget[team] ?? 0) + 1;
        }
        this.emit('shot', `Shot by ${player === undefined ? '' : player.attr.name}`, {
          team,
          speed: k.speed,
          rpm: k.spinRpm,
        });
      } else {
        this.stats.passes[team] = (this.stats.passes[team] ?? 0) + 1;
        this.emit('pass', '', { team, kind: k.kind, speed: k.speed });
      }
    }

    for (const t of events.tackleAttempted) {
      const tackler = this.players.find((p) => p.attr.id === t.tacklerId);
      if (tackler === undefined) continue;
      if (t.success) {
        this.stats.tackles[tackler.attr.team] = (this.stats.tackles[tackler.attr.team] ?? 0) + 1;
      }
      this.emit(t.success ? 'tackle' : 'tackleMissed', '', {
        tackler: t.tacklerId,
        victim: t.victimId,
        success: t.success ? 1 : 0,
      });
    }
  }

  private emit(kind: string, text: string, data: Record<string, number | string>): void {
    this.pendingEvents.push({ tick: this.tick, kind, text, data });
  }

  private flushEvents(): void {
    if (this.pendingEvents.length === 0) return;
    for (const e of this.pendingEvents) this.events.push(e);
    // Keep the ring bounded so a long match does not grow without limit.
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
    this.pendingEvents.length = 0;
  }

  /** Consume and clear queued events; the presentation layer calls this per frame. */
  drainEvents(): MatchEvent[] {
    const out = this.events.slice();
    this.events.length = 0;
    return out;
  }

  /** Snapshot for the renderer, interpolated between ticks. */
  snapshot(alpha: number): MatchSnapshot {
    return {
      tick: this.tick,
      clock: this.clock,
      period: this.period,
      score: [this.score[0] ?? 0, this.score[1] ?? 0],
      controlledId: this.controlledId,
      possessionId: this.possessionId,
      ball: { ...this.ball.pos },
      ballVel: { ...this.ball.vel },
      players: this.players.map((p) => ({
        id: p.attr.id,
        team: p.attr.team,
        shirt: p.attr.shirtNumber,
        role: p.role,
        pos: { ...p.loco.pos },
        heading: p.loco.heading,
        speed: p.loco.speed,
        stamina: p.stamina,
        hasBall: p.hasBall,
        anim: p.animStateHint,
        controlled: p.attr.id === this.controlledId,
      })),
      alpha,
    };
  }
}

export interface MatchSnapshotPlayer {
  id: number;
  team: number;
  shirt: number;
  /** 0 = outfield, 1 = goalkeeper. */
  role: number;
  pos: Vec3;
  heading: number;
  speed: number;
  stamina: number;
  hasBall: boolean;
  anim: AnimHint;
  controlled: boolean;
}

export interface MatchSnapshot {
  tick: number;
  clock: number;
  period: MatchPeriod;
  score: [number, number];
  controlledId: number;
  possessionId: number;
  ball: Vec3;
  ballVel: Vec3;
  players: MatchSnapshotPlayer[];
  alpha: number;
}

/**
 * Turn an AI decision into the same input struct a human produces.
 *
 * This is the seam that keeps the AI honest: it cannot move faster, turn
 * sharper or kick harder than a human, because it goes through the identical
 * `PlayerInput` -> `PlayerController` path.
 */
export function decisionToInput(p: PlayerRuntime, d: BrainDecision, view: FieldView): PlayerInput {
  const input = emptyInput();
  const dx = d.target.x - p.loco.pos.x;
  const dz = d.target.z - p.loco.pos.z;
  const dist = detSqrt(dx * dx + dz * dz);

  if (dist > 0.3) {
    // Full stick when far away, feather it when close so the AI does not jitter.
    const mag = clamp(dist / 3, 0.25, 1);
    input.moveX = (dx / dist) * mag;
    input.moveZ = (dz / dist) * mag;
  }
  input.sprint = d.sprint && dist > 2.5;
  input.pass = d.wantsPass;
  input.throughBall = d.wantsThroughBall;
  input.shoot = d.wantsShoot;
  input.tackle = d.wantsTackle;
  input.aim = d.aim;
  input.power = d.power;
  input.curve = d.curve;
  input.placement = d.placement;
  input.autoPower = d.autoPower;
  void view;
  return input;
}

/** Kickoff positions for the human team's striker, used by the menu preview. */
export function strikerKickoffSpot(team: number): Vec3 {
  return v3(PITCH.centreSpotX + (team === 0 ? -0.8 : 0.8), 0, PITCH.centreSpotZ);
}

export { scale as scaleVec, sub as subVec };
