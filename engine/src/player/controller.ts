/**
 * PlayerController — movement + ball interaction for one player.
 *
 * This is the script a human player drives directly and that the AI fills in
 * synthetic input for. It is deliberately thin: it converts intent into a kick
 * or a step, and delegates the actual numbers to Locomotion (body) and
 * BallPhysics (ball). Keeping it thin is what lets the CPU use exactly the
 * same code path as the human — the AI cannot do anything the player cannot.
 *
 * Order of operations per tick (matters — do not reorder):
 *   1. consume queued, edge-triggered requests (pass/shoot/tackle/skill)
 *   2. resolve possession changes (trap / knock loose)
 *   3. run locomotion for the body
 *   4. if in possession, place the ball in the dribble pocket
 *
 * ── The kick model ──────────────────────────────────────────────────────────
 * Every kick produces (direction, launch angle, speed, spin):
 *
 *   • launch angle is chosen by kick TYPE (drive ~9 deg, normal ~18, chip ~36)
 *   • speed comes either from the power meter, or — on "assisted" kicks —
 *     from a bisection solve through the real drag model so the ball actually
 *     arrives (see BallPhysics.solveLaunchSpeed)
 *   • accuracy is an angular error drawn from a per-player distribution,
 *     scaled by fatigue and by how hard you hit it. Full power is never full
 *     accuracy; that trade-off is the whole game.
 *   • curve sets vertical-axis spin, so the Magnus term bends the flight.
 */

import {
  clamp,
  lerp,
  invLerp,
  detAtan2,
  detSqrt,
  detSincos,
  PI,
  wrapPi,
} from '../core/math.js';
import {
  type Vec3,
  v3,
  add,
  sub,
  scale,
  normalize,
  length,
  distanceXZ,
} from '../core/vec3.js';
import type { Rng } from '../core/rng.js';
import { type BallState, solveLaunchSpeed, solveLaunchAngle } from '../physics/ball.js';
import { BALL, KICK, LOCOMOTION, PITCH } from '../config/tuning.js';
import { stepLocomotion } from './locomotion.js';
import { ActionKind, AnimHint, type PlayerRuntime } from './entity.js';
import { fatigueEffect } from './attributes.js';

export type KickKind =
  | 'shortPass'
  | 'longPass'
  | 'throughBall'
  | 'shotDrive'
  | 'shotNormal'
  | 'shotChip'
  | 'clearance';

export interface PlayerInput {
  /** Analogue stick, -1..1 on each axis. Magnitude acts as a throttle. */
  moveX: number;
  moveZ: number;
  sprint: boolean;

  // Edge-triggered: the controller clears these after consuming them.
  pass: boolean;
  throughBall: boolean;
  shoot: boolean;
  tackle: boolean;
  /** 0 = none, 1 = knock-on into space, 2 = feint / step-over. */
  skillMove: number;

  /** World-space aim point for the requested action, if the caller has one. */
  aim: Vec3 | null;
  /** 0..1 power meter. Ignored when `autoPower` is set. */
  power: number;
  /** -1..1 curve. Positive curves to the kicker's right. */
  curve: number;
  /** -1..1 shot placement across the goal mouth. */
  placement: number;
  /** Solve the speed that reaches `aim` instead of using the power meter. */
  autoPower: boolean;
}

export function emptyInput(): PlayerInput {
  return {
    moveX: 0,
    moveZ: 0,
    sprint: false,
    pass: false,
    throughBall: false,
    shoot: false,
    tackle: false,
    skillMove: 0,
    aim: null,
    power: 0,
    curve: 0,
    placement: 0,
    autoPower: false,
  };
}

export interface FieldView {
  players: PlayerRuntime[];
  ball: BallState;
  /** Id of the player currently in possession, or -1 for a loose ball. */
  possessionId: number;
  /** Team currently in possession, or -1. */
  possessionTeam: number;
  tick: number;
  dt: number;
  rng: Rng;
}

export interface ControllerEvents {
  /** Emitted so presentation can play SFX/VFX and the match engine can log. */
  kicked: KickEvent[];
  possessionGained: number[];
  possessionLost: number[];
  tackleAttempted: TackleEvent[];
}

export interface KickEvent {
  playerId: number;
  kind: KickKind;
  speed: number;
  power01: number;
  spinRpm: number;
  target: Vec3;
}

export interface TackleEvent {
  tacklerId: number;
  victimId: number;
  success: boolean;
}

/** Minimum ticks between two challenges by the same player (0.83 s). */
const TACKLE_COOLDOWN_TICKS = 50;

export class PlayerController {
  readonly player: PlayerRuntime;
  private input: PlayerInput = emptyInput();
  /** Kick recovery: after a strike you cannot touch the ball for a few frames. */
  private touchCooldown = 0;
  private lastTackleTick = -9999;

  constructor(player: PlayerRuntime) {
    this.player = player;
  }

  /** Queue intent for the next tick. The AI and the human both call this. */
  setInput(input: Partial<PlayerInput>): void {
    this.input = { ...this.input, ...input };
  }

  resetInput(): void {
    this.input = emptyInput();
  }

  get currentInput(): Readonly<PlayerInput> {
    return this.input;
  }

  /**
   * Advance one fixed simulation step.
   *
   * @param view read-only snapshot of the world this tick
   * @param events out-parameter; the caller clears it before the tick
   */
  update(view: FieldView, events: ControllerEvents): void {
    const p = this.player;
    const { dt } = view;

    // ---- timers ----------------------------------------------------------
    if (this.touchCooldown > 0) this.touchCooldown--;
    if (p.actionTimer > 0) {
      p.actionTimer--;
      if (p.actionTimer === 0) p.actionKind = ActionKind.None;
    }
    if (p.burstTimer > 0) {
      p.burstTimer--;
      if (p.burstTimer === 0) p.burstMul = 1;
    }
    if (p.frozenTimer > 0) p.frozenTimer--;

    p.ticksSinceTouch++;

    const fatigue = fatigueEffect(p.stamina);
    const canAct = p.frozenTimer <= 0 && p.actionKind !== ActionKind.Stunned;

    // ---- 1. edge-triggered actions ---------------------------------------
    if (canAct) {
      if (this.input.skillMove > 0 && p.hasBall) {
        this.doSkillMove(this.input.skillMove, view, fatigue);
      } else if (this.input.tackle) {
        this.doTackle(view, events);
      } else if (this.input.shoot) {
        this.doKick(view, events, 'shotNormal', fatigue);
      } else if (this.input.throughBall) {
        this.doKick(view, events, 'throughBall', fatigue);
      } else if (this.input.pass) {
        this.doKick(view, events, 'shortPass', fatigue);
      }
    }
    this.clearEdgeTriggers();

    // ---- 2. possession: trap a loose ball ---------------------------------
    // Must be gated on canAct. An earlier version trapped unconditionally, so a
    // player stunned by a winning tackle simply picked the ball back up on the
    // next tick: the away side kept 98.7% possession and the home side won 726
    // tackles in a match while holding the ball for 0.1% of it.
    if (canAct) this.resolveTrap(view, events, fatigue);

    // ---- 3. body ----------------------------------------------------------
    stepLocomotion(
      p.loco,
      {
        dirX: this.input.moveX,
        dirZ: this.input.moveZ,
        sprint: this.input.sprint,
      },
      p.profile,
      fatigue,
      dt,
      p.burstMul,
    );

    // ---- 4. dribble pocket ------------------------------------------------
    if (p.hasBall) placeBallInPocket(view);

    p.animStateHint = animHintFor(p);
  }

  // ------------------------------------------------------------------
  // Possession
  // ------------------------------------------------------------------

  private resolveTrap(view: FieldView, events: ControllerEvents, fatigue: { errorMul: number }): void {
    const p = this.player;
    if (p.hasBall) return;
    if (this.touchCooldown > 0) return;

    // You cannot steal directly off a teammate who is already in control;
    // the match engine handles turnovers from tackles instead.
    if (view.possessionId >= 0 && view.possessionId !== p.attr.id) return;

    const ball = view.ball;
    const dx = ball.pos.x - p.loco.pos.x;
    const dz = ball.pos.z - p.loco.pos.z;
    const dy = ball.pos.y - p.loco.pos.y;
    const planar = detSqrt(dx * dx + dz * dz);

    // Reach grows with control skill. A keeper gets arms and a much bigger
    // envelope up to crossbar height; an outfielder does not.
    const isKeeper = p.role === 1;
    const verticalReach = isKeeper ? PITCH.goalHeight : 1.15;
    // A keeper diving at an arriving shot covers considerably more ground than
    // one standing and gathering a back-pass. Modelling that spread is the
    // difference between a keeper who makes saves and a goalmouth you walk into.
    const closing =
      isKeeper &&
      ball.pos.y < PITCH.goalHeight &&
      -(ball.vel.x * (p.attr.team === 0 ? 1 : -1)) > 6 &&
      ballDistanceToOwnGoal(p, ball) < 9;
    const reach =
      p.profile.controlRadius +
      p.loco.bodyRadius +
      (isKeeper ? (closing ? 2.6 : 0.75) : 0);
    if (planar > reach || ball.pos.y > verticalReach) return;

    // A ball moving too fast to control pops off the foot instead of sticking.
    // Keepers are allowed to gather a struck ball — that is literally their job,
    // and without it every shot on target was a goal (38-34 in testing).
    const ballSpeed = detSqrt(ball.vel.x * ball.vel.x + ball.vel.z * ball.vel.z);
    const controlCeiling = isKeeper ? 42 : lerp(9, 24, invLerp(40, 99, p.attr.ballControl));
    if (ballSpeed > controlCeiling) {
      // Deflect rather than control: the ball keeps going, slightly deflected.
      //
      // The deflection must push towards the FIELD, never along the
      // player-to-ball axis. When a shot beats the keeper and he turns to chase
      // it, the ball is goal-side of him, so pushing along player->ball shoved
      // it into his own net. That single line accounted for 75% of all goals in
      // an 8-match measurement -- slow balls (median 2.2 m/s) crossing the line
      // with no kick anywhere near them.
      const field = towardsField(p);
      ball.vel = v3(
        ball.vel.x * 0.55 + field.x * ballSpeed * 0.25,
        ball.vel.y * 0.6,
        ball.vel.z * 0.55 + field.z * ballSpeed * 0.25,
      );
      ball.lastTouchId = p.attr.id;
      ball.lastTouchTeam = p.attr.team;
      this.touchCooldown = 8;
      return;
    }

    // ---- first touch ----------------------------------------------------
    // Error scatters perpendicular to the ball's travel, which is why a hard
    // pass to a poor first touch visibly squirts away.
    const errMetres = p.profile.firstTouchError * fatigue.errorMul;
    const travel = detSqrt(ball.vel.x * ball.vel.x + ball.vel.z * ball.vel.z);
    let perpX = 0;
    let perpZ = 0;
    if (travel > 0.4) {
      perpX = -ball.vel.z / travel;
      perpZ = ball.vel.x / travel;
    }
    const off = view.rng.gaussScaled(errMetres);

    p.hasBall = true;
    p.ticksSinceTouch = 0;
    p.actionKind = ActionKind.Trap;
    // A keeper gathering a shot needs a moment to bring it under control.
    p.actionTimer = isKeeper ? 16 : 4;
    ball.lastTouchId = p.attr.id;
    ball.lastTouchTeam = p.attr.team;
    ball.spin = v3(0, 0, 0);
    ball.pos = v3(
      p.loco.pos.x + perpX * off,
      BALL.radius,
      p.loco.pos.z + perpZ * off,
    );
    ball.vel = scale(p.loco.vel, 0.4);
    events.possessionGained.push(p.attr.id);
  }

  // ------------------------------------------------------------------
  // Kicking
  // ------------------------------------------------------------------

  private doKick(
    view: FieldView,
    events: ControllerEvents,
    requested: KickKind,
    fatigue: { errorMul: number },
  ): void {
    const p = this.player;
    if (!p.hasBall) return;

    const kind = resolveKickKind(requested, view, p);
    const target = this.chooseTarget(view, kind);
    if (target === null) {
      // Nothing sensible to do: fall back to a short carry, do not waste the ball.
      return;
    }

    const strike = computeStrike({
      profile: p.profile,
      attr: p.attr,
      ball: view.ball,
      kind,
      target,
      power01: this.input.power,
      curve: this.input.curve,
      placement: this.input.placement,
      autoPower: this.input.autoPower,
      errorMul: fatigue.errorMul,
      rng: view.rng,
      dt: view.dt,
    });

    view.ball.pos = v3(view.ball.pos.x, Math.max(view.ball.pos.y, BALL.radius), view.ball.pos.z);
    view.ball.vel = strike.velocity;
    view.ball.spin = strike.spin;
    view.ball.lastTouchId = p.attr.id;
    view.ball.lastTouchTeam = p.attr.team;
    view.ball.grounded = false;

    p.hasBall = false;
    p.actionKind = isShotKind(kind) ? ActionKind.Shoot : ActionKind.Pass;
    p.actionTimer = isShotKind(kind) ? 14 : 10;
    this.touchCooldown = 12;

    events.kicked.push({
      playerId: p.attr.id,
      kind,
      speed: length(strike.velocity),
      power01: strike.power01,
      spinRpm: strike.spinRpm,
      target,
    });
    events.possessionLost.push(p.attr.id);
  }

  /** Where should this kick go? Human aim wins; otherwise pick sensibly. */
  private chooseTarget(view: FieldView, kind: KickKind): Vec3 | null {
    const p = this.player;
    const aim = this.input.aim;

    if (isShotKind(kind)) {
      if (aim !== null) return aim;
      return goalCentreFor(p.attr.team);
    }

    if (aim !== null) return aim;

    // No explicit aim: find the best receiver and LEAD them.
    const mate = bestReceiver(view, p);
    if (mate === null) {
      // Nobody on: clear it upfield rather than standing on the ball.
      const dirX = p.attr.team === 0 ? 1 : -1;
      return v3(
        clamp(p.loco.pos.x + dirX * 30, 2, PITCH.length - 2),
        BALL.radius,
        p.loco.pos.z,
      );
    }
    // Aiming at where the receiver IS now guarantees a failed pass: by the time
    // the ball arrives they have moved 2-4 m. Lead them by the flight time.
    const estSpeed = estimatePassSpeed(kind);
    const flight = clamp(distanceXZ(mate.loco.pos, p.loco.pos) / Math.max(estSpeed, 1), 0.1, 1.4);
    return resolveThroughBallTarget(mate, flight);
  }

  private doSkillMove(index: number, view: FieldView, fatigue: { errorMul: number }): void {
    const p = this.player;
    if (index === 1) {
      // Knock-on: shove the ball into space and burst after it.
      const dir = facing(p);
      view.ball.pos = v3(
        p.loco.pos.x + dir.x * 2.2,
        BALL.radius,
        p.loco.pos.z + dir.z * 2.2,
      );
      view.ball.vel = scale(dir, Math.max(p.loco.speed, 6) + LOCOMOTION.knockOnBurst);
      view.ball.spin = v3(0, 0, 0);
      view.ball.lastTouchId = p.attr.id;
      view.ball.lastTouchTeam = p.attr.team;
      p.burstMul = 1.16;
      p.burstTimer = 22;
      p.hasBall = false;
      this.touchCooldown = 6;
      p.actionKind = ActionKind.SkillMove;
      p.actionTimer = 8;
    } else {
      // Feint: the body sells one way. Freeze the nearest opponent briefly.
      const perpX = -facing(p).z;
      const perpZ = facing(p).x;
      p.loco.heading = wrapPi(p.loco.heading + (view.rng.next() < 0.5 ? 0.5 : -0.5));
      void perpX;
      void perpZ;
      const nearest = nearestOpponent(view, p, 2.5);
      if (nearest !== null) nearest.frozenTimer = Math.round(LOCOMOTION.feintDefenderFreeze / view.dt);
      p.actionKind = ActionKind.SkillMove;
      p.actionTimer = 10;
    }
    void fatigue;
  }

  private doTackle(view: FieldView, events: ControllerEvents): void {
    const p = this.player;
    if (p.hasBall) return;

    // A tackle commits the body. Without this cooldown the two sides simply
    // ping-ponged possession every dozen ticks and the stat sheet recorded
    // ~26,000 "won" tackles per match.
    if (view.tick - this.lastTackleTick < TACKLE_COOLDOWN_TICKS) return;
    this.lastTackleTick = view.tick;

    const victim = nearestOpponentWithBall(view, p, 1.4);
    if (victim === null) {
      // Nothing in range: commit to a lunge anyway, which costs recovery time.
      p.actionKind = ActionKind.Tackle;
      p.actionTimer = 18;
      p.loco.locked = true;
      p.loco.lockTimer = 0.28;
      return;
    }

    // Contest quality: tackler's skill and balance vs the carrier's dribbling,
    // plus a distance penalty. Aggression only decides WHETHER to commit,
    // never how likely the tackle is to land — that keeps it fair.
    const tacklerSkill = invLerp(40, 99, p.attr.tackling) * 0.65 + invLerp(40, 99, p.attr.strength) * 0.35;
    const carrierSkill = invLerp(40, 99, victim.attr.dribbling);
    const dist = distanceXZ(p.loco.pos, victim.loco.pos);
    const distPenalty = clamp((dist - 0.8) / 1.6, 0, 1) * 0.35;
    // Approaching from behind is easier to win but more likely to be a foul;
    // from the front the carrier can see it coming.
    const behind = dotUnit(facing(victim), facing(p)) > 0.3 ? 0.08 : 0;
    const pWin = clamp(0.28 + (tacklerSkill - carrierSkill) * 0.6 - distPenalty + behind, 0.05, 0.92);

    const success = view.rng.next() < pWin;
    p.actionKind = ActionKind.Tackle;
    p.actionTimer = success ? 12 : 20;
    p.loco.locked = true;
    p.loco.lockTimer = success ? 0.18 : 0.34;

    if (success) {
      victim.hasBall = false;
      victim.actionKind = ActionKind.Stunned;
      victim.actionTimer = 14;
      const dir = normalize(sub(p.loco.pos, victim.loco.pos));
      view.ball.pos = v3(victim.loco.pos.x, BALL.radius, victim.loco.pos.z);
      view.ball.vel = scale(dir, 2.2);
      // Short cooldown: the tackler should usually collect what they won.
      this.touchCooldown = 4;
      view.ball.spin = v3(0, 0, 0);
      view.ball.lastTouchId = victim.attr.id;
      view.ball.lastTouchTeam = victim.attr.team;
    } else {
      // Failed: the tackler is committed and the carrier gets a shove away.
      const away = normalize(sub(victim.loco.pos, p.loco.pos));
      view.ball.vel = add(view.ball.vel, scale(away, 1.4));
    }

    events.tackleAttempted.push({
      tacklerId: p.attr.id,
      victimId: victim.attr.id,
      success,
    });
  }

  private clearEdgeTriggers(): void {
    this.input.pass = false;
    this.input.throughBall = false;
    this.input.shoot = false;
    this.input.tackle = false;
    this.input.skillMove = 0;
  }
}

// ----------------------------------------------------------------------
// Dribbling
// ----------------------------------------------------------------------

/**
 * Hold the ball in the "pocket" just ahead of the dribbler.
 *
 * The pocket distance grows with speed (you push it further when running,
 * tighter when walking) and shrinks with dribbling skill. The ball's velocity
 * is matched to the player's plus a little lead, so a knock forward keeps
 * rolling realistically instead of teleporting to a fixed offset.
 */
function placeBallInPocket(view: FieldView): void {
  const p = view.players.find((x) => x.hasBall);
  if (p === undefined) return;

  const speedFrac = clamp(p.loco.speed / p.profile.topSpeed, 0, 1);
  const closeControl = invLerp(40, 99, p.attr.dribbling);
  const pocketDist = lerp(0.55, 1.35, speedFrac) * lerp(0.85, 1.05, 1 - closeControl);

  // Direction the ball is carried in. For a keeper this must NOT be their
  // facing: a keeper stands facing their own net, so a normal dribble pocket
  // put the ball behind them and they walked it over their own line. That
  // single interaction was responsible for the 67-17 scoreline in testing.
  const dir = dribbleDirection(p);

  // Keep the pocket inside the field of play. The facing used above lags the
  // run by a few ticks, so a winger going down the touchline aims the pocket
  // straight through the line and is then credited with carrying the ball out
  // of play. Measured over 8 matches that was 36% of every goal-line crossing:
  // a player within 3 m of the ball with no kick for a median of 3.7 s. A real
  // player shields the ball infield instead of walking it out, so clamp.
  const margin = BALL.radius + 0.05;
  const target = v3(
    clamp(p.loco.pos.x + dir.x * pocketDist, margin, PITCH.length - margin),
    BALL.radius,
    clamp(p.loco.pos.z + dir.z * pocketDist, margin, PITCH.width - margin),
  );

  // Blend towards the pocket rather than snapping: keeps the ball attached
  // through sharp turns without looking welded to the boot.
  const k = clamp(14 * view.dt, 0, 1);
  view.ball.pos = v3(
    view.ball.pos.x + (target.x - view.ball.pos.x) * k,
    BALL.radius,
    view.ball.pos.z + (target.z - view.ball.pos.z) * k,
  );

  const lead = 1.0 + speedFrac * 0.25;
  view.ball.vel = v3(p.loco.vel.x * lead, 0, p.loco.vel.z * lead);
  // A dribbled ball rolls, it does not spin sideways.
  view.ball.spin = v3(
    view.ball.vel.z / BALL.radius,
    view.ball.spin.y * 0.5,
    -view.ball.vel.x / BALL.radius,
  );
  view.ball.grounded = true;
  view.ball.lastTouchId = p.attr.id;
  view.ball.lastTouchTeam = p.attr.team;
}

// ----------------------------------------------------------------------
// Strike computation (pure — unit tested directly)
// ----------------------------------------------------------------------

export interface StrikeRequest {
  profile: PlayerProfileLike;
  attr: AttributeLike;
  ball: BallState;
  kind: KickKind;
  target: Vec3;
  power01: number;
  curve: number;
  placement: number;
  autoPower: boolean;
  errorMul: number;
  rng: Rng;
  dt: number;
}

export interface StrikeResult {
  velocity: Vec3;
  spin: Vec3;
  power01: number;
  spinRpm: number;
  errorDeg: number;
  launchAngle: number;
}

export interface PlayerProfileLike {
  passErrorDeg: number;
  shotErrorDeg: number;
  maxSpinRpm: number;
}

export interface AttributeLike {
  shotPower: number;
  shortPassing: number;
  longPassing: number;
  curve: number;
}

export function computeStrike(req: StrikeRequest): StrikeResult {
  const { ball, kind, rng } = req;
  // Clamp the aim point into the field of play. Every caller should already
  // have done this, but a kick aimed off the pitch is never what anyone meant.
  const target = v3(
    clamp(req.target.x, 1.0, PITCH.length - 1.0),
    req.target.y,
    clamp(req.target.z, 1.0, PITCH.width - 1.0),
  );

  // ---- direction -------------------------------------------------------
  let dx = target.x - ball.pos.x;
  let dz = target.z - ball.pos.z;
  let planar = detSqrt(dx * dx + dz * dz);
  if (planar < 0.05) {
    // Aim point is under the ball: fall back to the body's facing so the
    // strike is still deterministic rather than dividing by ~0.
    dx = 1;
    dz = 0;
    planar = 0.05;
  }
  let dirX = dx / planar;
  let dirZ = dz / planar;

  const isShot = isShotKind(kind);
  const [minSpeed, maxSpeedBase, envelopeAngle] = kickEnvelope(kind);
  let launchAngle = envelopeAngle;

  // Shot power rating widens the top of the range.
  const powerRating01 = invLerp(40, 99, isShot ? req.attr.shotPower : req.attr.longPassing);
  const maxSpeed = maxSpeedBase * lerp(0.86, 1.14, powerRating01);

  // ---- speed -----------------------------------------------------------
  let speed: number;
  let power01: number;
  if (req.autoPower) {
    // Assisted: solve the speed that carries the ball to the target through
    // the real drag model, then report the equivalent meter position so the
    // HUD can still animate a power bar.
    speed = solveLaunchSpeed(planar, launchAngle, Math.max(ball.pos.y, BALL.radius), req.dt, minSpeed, maxSpeed, KICK.solverIterations);
    power01 = invLerp(minSpeed, maxSpeed, speed);
  } else {
    power01 = clamp(req.power01, 0, 1);
    speed = lerp(minSpeed, maxSpeed, power01);
  }

  // ---- launch angle (shots only) ---------------------------------------
  // A fixed angle per kick kind cannot work for a shot, because the height a
  // ball arrives at grows with the distance it travels. Measured over 8
  // matches: 65% of shots reaching the goal plane went OVER THE BAR, at a
  // median distance of just 12.2 m and a median arrival height of 3.56 m
  // against a 2.44 m bar. So solve the angle that puts the ball at a chosen
  // height inside the frame at the target distance, through the same drag
  // model the ball then flies under.
  //
  // Target height is a real trade, not a freebie: aiming low is safer against
  // the bar but easier for a keeper to reach, and a chip clears a keeper at
  // the cost of needing more loft.
  if (isShot) {
    const targetHeight =
      kind === 'shotChip'
        ? PITCH.goalHeight * 0.86
        : lerp(PITCH.goalHeight * 0.18, PITCH.goalHeight * 0.62, clamp(power01, 0, 1));
    launchAngle = solveLaunchAngle(
      planar,
      targetHeight,
      speed,
      Math.max(ball.pos.y, BALL.radius),
      req.dt,
      0.02,
      envelopeAngle * 1.6,
      KICK.solverIterations,
    );
  }

  // ---- placement (shots only) ------------------------------------------
  // Placement shifts the aim point across the goal mouth before error is
  // applied, so it is a genuine trade: the corners are further from centre
  // and therefore a miss is more likely to be wide.
  if (isShot && Math.abs(req.placement) > 0.001) {
    const halfWidth = (PITCH.goalWidth / 2 - 0.35) * clamp(req.placement, -1, 1);
    // Perpendicular to the strike direction, in the pitch plane.
    const px = -dirZ;
    const pz = dirX;
    const tx = target.x + px * halfWidth;
    const tz = target.z + pz * halfWidth;
    const ndx = tx - ball.pos.x;
    const ndz = tz - ball.pos.z;
    const nlen = detSqrt(ndx * ndx + ndz * ndz);
    if (nlen > 1e-6) {
      dirX = ndx / nlen;
      dirZ = ndz / nlen;
    }
  }

  // ---- accuracy --------------------------------------------------------
  const baseErr = isShot ? req.profile.shotErrorDeg : req.profile.passErrorDeg;
  const powerFactor = 1 + KICK.errorPowerMultiplier * clamp(power01 - 0.5, 0, 0.5) * 2;
  const distFactor = 1 + clamp((planar - 8) / 40, 0, 1) * 0.6; // longer balls drift more
  const errorDeg = baseErr * req.errorMul * powerFactor * distFactor;
  const errRad = (rng.gaussScaled(errorDeg) * PI) / 180;

  // Rotate the planar direction by the error angle.
  const sc = detSincos(errRad);
  const rdx = dirX * sc.c - dirZ * sc.s;
  const rdz = dirX * sc.s + dirZ * sc.c;

  // ---- launch ----------------------------------------------------------
  const lc = detSincos(launchAngle);
  const velocity = v3(rdx * lc.c * speed, lc.s * speed, rdz * lc.c * speed);

  // ---- spin ------------------------------------------------------------
  // Sidespin (curve) lives on the vertical axis: omega x v then points
  // sideways, which is what bends a free kick. Positive `curve` pushes the
  // ball towards the kicker's right.
  // Backspin lives on the axis perpendicular to travel and gives lift; chips
  // and lofted passes get some, drives get almost none.
  const spinRpm = clamp(req.curve, -1, 1) * req.profile.maxSpinRpm;
  const spinRad = (spinRpm * 2 * PI) / 60;
  const backspinRpm = kind === 'shotChip' ? 320 : kind === 'longPass' || kind === 'throughBall' ? 180 : 60;
  const backspinRad = (backspinRpm * 2 * PI) / 60;
  const spin = v3(-rdz * backspinRad, spinRad, rdx * backspinRad);

  return { velocity, spin, power01, spinRpm, errorDeg, launchAngle };
}

/** Speed range and launch angle for each kick type. */
export function kickEnvelope(kind: KickKind): [number, number, number] {
  switch (kind) {
    case 'shortPass':
      return [KICK.shortPassSpeedMin, KICK.shortPassSpeedMax, KICK.launchAngleDrive * 0.6];
    case 'longPass':
      return [KICK.longPassSpeedMin, KICK.longPassSpeedMax, KICK.launchAngleNormal];
    case 'throughBall':
      return [KICK.shortPassSpeedMin, KICK.longPassSpeedMax * 0.85, KICK.launchAngleDrive * 0.8];
    case 'shotDrive':
      return [KICK.shotSpeedMin, KICK.shotSpeedMax, KICK.launchAngleDrive];
    case 'shotNormal':
      return [KICK.shotSpeedMin, KICK.shotSpeedMax, KICK.launchAngleNormal];
    case 'shotChip':
      return [KICK.shotSpeedMin * 0.75, KICK.shotSpeedMax * 0.8, KICK.launchAngleChip];
    case 'clearance':
      return [KICK.longPassSpeedMin, KICK.longPassSpeedMax, KICK.launchAngleChip * 0.85];
  }
}

/** Rough mid-range speed for a kick type, used only to estimate flight time. */
export function estimatePassSpeed(kind: KickKind): number {
  const [lo, hi] = kickEnvelope(kind);
  return (lo + hi) * 0.5;
}

export function isShotKind(kind: KickKind): boolean {
  return kind === 'shotDrive' || kind === 'shotNormal' || kind === 'shotChip';
}

/** Centre of the goal this team is attacking. Team 0 attacks +x. */
export function goalCentreFor(team: number): Vec3 {
  return team === 0
    ? v3(PITCH.length, 1.0, PITCH.centreSpotZ)
    : v3(0, 1.0, PITCH.centreSpotZ);
}

// ----------------------------------------------------------------------
// Small helpers shared with the AI
// ----------------------------------------------------------------------

/** Distance from the ball to the goal this player defends. */
function ballDistanceToOwnGoal(p: PlayerRuntime, ball: BallState): number {
  const goalX = p.attr.team === 0 ? 0 : PITCH.length;
  return distanceXZ(ball.pos, v3(goalX, 0, PITCH.centreSpotZ));
}

/**
 * Direction the dribble pocket sits in.
 *
 * A keeper always carries towards the field, because he stands facing his own
 * net. The same trap catches outfield defenders: a centre-back who turns to
 * chase a loose ball ends up facing his own goal, and a pocket placed along his
 * facing walks the ball over his own line. Inside his own penalty area we blend
 * the pocket towards the field so that cannot happen, while leaving normal
 * play anywhere else untouched.
 */
function dribbleDirection(p: PlayerRuntime): Vec3 {
  const f = facing(p);
  if (p.role === 1) return towardsField(p);

  const goalX = p.attr.team === 0 ? 0 : PITCH.length;
  const distToOwnGoal = Math.abs(p.loco.pos.x - goalX);
  // Positive when the facing has a component pointing at his own goal.
  const towardOwnGoal = p.attr.team === 0 ? -f.x : f.x;

  if (distToOwnGoal < PITCH.penaltyAreaLength && towardOwnGoal > 0.3) {
    const field = towardsField(p);
    return normalize(
      v3(f.x * 0.3 + field.x * 0.7, 0, f.z * 0.3 + field.z * 0.7),
    );
  }
  return f;
}

/** Unit vector pointing from a player towards the middle of the field of play. */
function towardsField(p: PlayerRuntime): Vec3 {
  const toFar = PITCH.length - p.loco.pos.x;
  const toNear = p.loco.pos.x;
  const sign = toFar > toNear ? 1 : -1;
  return v3(sign, 0, 0);
}

export function facing(p: PlayerRuntime): Vec3 {
  const sc = detSincos(p.loco.heading);
  return v3(sc.c, 0, sc.s);
}

export function facingOf(p: PlayerRuntime): number {
  return p.loco.heading;
}

function dotUnit(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.z * b.z;
}

export function nearestOpponent(view: FieldView, p: PlayerRuntime, maxDist: number): PlayerRuntime | null {
  let best: PlayerRuntime | null = null;
  let bestD = maxDist;
  for (const o of view.players) {
    if (o.attr.team === p.attr.team) continue;
    const d = distanceXZ(o.loco.pos, p.loco.pos);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

export function nearestOpponentWithBall(
  view: FieldView,
  p: PlayerRuntime,
  maxDist: number,
): PlayerRuntime | null {
  for (const o of view.players) {
    if (o.attr.team === p.attr.team) continue;
    if (!o.hasBall) continue;
    if (distanceXZ(o.loco.pos, p.loco.pos) <= maxDist) return o;
  }
  return null;
}

/**
 * Pick a receiver.
 *
 * Scores each teammate on distance (not too close, not too far), how open
 * they are, and how far forward the pass takes us. This is the same scoring
 * the AI uses, which is why "assisted passing" feels like a teammate chose
 * well rather than like the game grabbed the nearest body.
 */
export function bestReceiver(view: FieldView, from: PlayerRuntime): PlayerRuntime | null {
  const attackDir = from.attr.team === 0 ? 1 : -1;
  let best: PlayerRuntime | null = null;
  let bestScore = -Infinity;

  for (const o of view.players) {
    if (o.attr.team !== from.attr.team || o.attr.id === from.attr.id) continue;
    if (o.role === 1) continue; // never auto-pass to the keeper

    const d = distanceXZ(o.loco.pos, from.loco.pos);
    if (d < 2.5 || d > 34) continue;

    const openness = 1 - clamp(nearestDefenderDistance(view, o, from.attr.team) / 6, 0, 1);
    const forward = clamp(((o.loco.pos.x - from.loco.pos.x) * attackDir) / 25, -1, 1);
    // Reachability, and it has to dominate. Measured over 8 matches this scored
    // openness at 2.2 against distFit at 0.8, so a wide-open teammate 40 m away
    // beat a free one 10 m away — distant players are almost always the most
    // open, which is exactly backwards. The result: 49% of all passes were long
    // balls against a real-world ~15-20%, and pass completion was 41% against
    // ~80-85%. Peaked at 12 m and squared, so the score falls off hard.
    const distFit = clamp(1 - Math.abs(d - 12) / 20, 0, 1);

    const vision = invLerp(40, 99, from.attr.vision);
    const score = openness * 1.3 + forward * (0.6 + vision) * 0.7 + distFit * distFit * 2.4;

    if (score > bestScore) {
      bestScore = score;
      best = o;
    }
  }
  return best;
}

export function nearestDefenderDistance(
  view: FieldView,
  p: PlayerRuntime,
  ownTeam: number,
): number {
  let best = 999;
  for (const o of view.players) {
    if (o.attr.team === ownTeam) continue;
    const d = distanceXZ(o.loco.pos, p.loco.pos);
    if (d < best) best = d;
  }
  return best;
}

/** Upgrade a generic request based on context (e.g. shoot -> chip if the keeper is off his line). */
function resolveKickKind(requested: KickKind, view: FieldView, p: PlayerRuntime): KickKind {
  if (requested !== 'shortPass') return requested;
  const mate = bestReceiver(view, p);
  if (mate === null) return 'shortPass';
  const d = distanceXZ(mate.loco.pos, p.loco.pos);
  if (d > 22) return 'longPass';
  // A teammate running into space behind the line wants a through ball.
  const attackDir = p.attr.team === 0 ? 1 : -1;
  const runningOn = (mate.loco.vel.x * attackDir) > 2.5;
  if (runningOn && nearestDefenderDistance(view, mate, p.attr.team) > 3) return 'throughBall';
  return 'shortPass';
}

export function resolveThroughBallTarget(runner: PlayerRuntime, leadSec = 0.75): Vec3 {
  // Lead the runner: aim where they will be, not where they are.
  //
  // The lead must be capped and then clamped inside the pitch. With a 1.4 s
  // lead on a runner doing 8 m/s the aim point lands 11 m beyond them, which is
  // routinely off the field — and a pass aimed at a point outside the pitch is
  // a pass straight out of play. That single bug accounted for ~13,000 throw-ins
  // in a 30-minute match.
  const t = clamp(leadSec, 0, 0.9);
  return v3(
    clamp(runner.loco.pos.x + runner.loco.vel.x * t, 1.5, PITCH.length - 1.5),
    BALL.radius,
    clamp(runner.loco.pos.z + runner.loco.vel.z * t, 1.5, PITCH.width - 1.5),
  );
}

function animHintFor(p: PlayerRuntime): AnimHint {
  if (p.actionKind === ActionKind.Celebrate) return AnimHint.Celebrate;
  if (p.actionKind === ActionKind.Tackle) return AnimHint.Tackle;
  if (p.actionKind === ActionKind.Shoot || p.actionKind === ActionKind.Pass) return AnimHint.Kick;
  if (p.actionKind === ActionKind.Stunned) return AnimHint.Stumble;
  const e = p.loco.effort;
  if (e < 0.06) return AnimHint.Idle;
  if (e < 0.25) return AnimHint.Walk;
  if (e < 0.55) return AnimHint.Jog;
  if (e < 0.82) return AnimHint.Run;
  return AnimHint.Sprint;
}
