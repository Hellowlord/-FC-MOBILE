/**
 * PlayerRuntime — everything the simulation holds about one player on the pitch.
 *
 * Split from PlayerAttributes on purpose: attributes are static data that a
 * career mode could save to disk, runtime state is per-match and mutable.
 */

import type { Vec3 } from '../core/vec3.js';
import type { PlayerAttributes, PlayerProfile } from './attributes.js';
import { type LocomotionState, createLocomotion } from './locomotion.js';

export enum Role {
  OUTFIELD = 0,
  KEEPER = 1,
}

export interface PlayerRuntime {
  attr: PlayerAttributes;
  profile: PlayerProfile;
  loco: LocomotionState;
  role: Role;

  /** 1 = fresh, 0 = empty. */
  stamina: number;

  /** True while this player is the one currently in control of the ball. */
  hasBall: boolean;
  /** Ticks since the player last touched the ball. */
  ticksSinceTouch: number;

  // Action state -------------------------------------------------------------
  /** Frames of animation lock remaining after a kick / tackle / skill move. */
  actionTimer: number;
  actionKind: ActionKind;
  /** Set when a skill move grants a temporary speed burst. */
  burstTimer: number;
  burstMul: number;
  /** Set by an opponent's feint: the defender cannot act until it expires. */
  frozenTimer: number;

  /** Home slot in the formation, recomputed by the team brain. */
  formationSlot: number;
  homeTarget: Vec3;
  /** Marked opponent id, or -1. */
  markId: number;

  /** Presentation layer writes these; the sim never reads them. */
  animStateHint: AnimHint;
}

export enum ActionKind {
  None = 0,
  Trap = 1,
  Pass = 2,
  Shoot = 3,
  Tackle = 4,
  SkillMove = 5,
  Celebrate = 6,
  Stunned = 7,
}

export enum AnimHint {
  Idle = 0,
  Walk = 1,
  Jog = 2,
  Run = 3,
  Sprint = 4,
  Kick = 5,
  Tackle = 6,
  Celebrate = 7,
  Stumble = 8,
}

export function createPlayer(
  attr: PlayerAttributes,
  pos: Vec3,
  heading: number,
  speedBias = 1,
  profile?: PlayerProfile,
): PlayerRuntime {
  // Lazy import avoided: profileOf is cheap and pure.
  const p = profile ?? defaultProfileFor(attr, speedBias);
  return {
    attr,
    profile: p,
    loco: createLocomotion(pos, heading),
    role: attr.position === 'GK' ? Role.KEEPER : Role.OUTFIELD,
    stamina: 1,
    hasBall: false,
    ticksSinceTouch: 9999,
    actionTimer: 0,
    actionKind: ActionKind.None,
    burstTimer: 0,
    burstMul: 1,
    frozenTimer: 0,
    formationSlot: 0,
    homeTarget: { ...pos },
    markId: -1,
    animStateHint: AnimHint.Idle,
  };
}

// Imported lazily to keep this module dependency-light at type level.
import { profileOf } from './attributes.js';
function defaultProfileFor(attr: PlayerAttributes, speedBias: number): PlayerProfile {
  return profileOf(attr, speedBias);
}
