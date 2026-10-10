/**
 * Formation — where players should be, as a function of where the ball is.
 *
 * A formation is NOT eleven fixed dots. If it were, the team would stretch
 * apart the moment the ball moved and the shape would be meaningless. The
 * standard technique — and the one used here — is a BALL-CENTRIC TRANSFORM:
 *
 *   1. Store each slot in normalised coordinates (0..1 across the pitch).
 *   2. Each tick, shift the whole block towards the ball and compress it
 *      around the ball's position.
 *   3. Add a phase offset: a defending team drops deeper and tighter, an
 *      attacking team stretches.
 *   4. Convert back to world coordinates, mirrored for the team attacking the
 *      other way.
 *
 * The result is that a 4-4-2 defending in its own box looks nothing like the
 * same 4-4-2 pressing high, which is the single biggest visual difference
 * between "AI that plays football" and "AI that wanders".
 */

import { clamp } from '../core/math.js';
import { type Vec3, v3 } from '../core/vec3.js';
import { PITCH } from '../config/tuning.js';

export interface FormationSlot {
  /** Role name, used by the brain to pick behaviour. */
  role: string;
  /** 0 = own goal line, 1 = opponent goal line. */
  nx: number;
  /** 0 = left touchline, 1 = right touchline (team-relative). */
  nz: number;
  /** 0 = pure hold-shape, 1 = free to roam and make runs. */
  freedom: number;
  /** How far this slot is allowed to push up when attacking. */
  attackingPush: number;
  /** How far this slot drops when defending (negative = deeper). */
  defendingDrop: number;
}

export interface Formation {
  id: string;
  name: string;
  slots: FormationSlot[];
}

function slot(role: string, nx: number, nz: number, freedom: number, push: number, drop: number): FormationSlot {
  return { role, nx, nz, freedom, attackingPush: push, defendingDrop: drop };
}

export const FORMATIONS: Record<string, Formation> = {
  '4-4-2': {
    id: '4-4-2',
    name: '4-4-2',
    slots: [
      slot('GK', 0.04, 0.5, 0.05, 0.0, 0.0),
      slot('LB', 0.22, 0.1, 0.5, 0.14, -0.06),
      slot('LCB', 0.18, 0.38, 0.1, 0.05, -0.05),
      slot('RCB', 0.18, 0.62, 0.1, 0.05, -0.05),
      slot('RB', 0.22, 0.9, 0.5, 0.14, -0.06),
      slot('LM', 0.48, 0.08, 0.75, 0.18, -0.1),
      slot('LCM', 0.44, 0.38, 0.6, 0.12, -0.08),
      slot('RCM', 0.44, 0.62, 0.6, 0.12, -0.08),
      slot('RM', 0.48, 0.92, 0.75, 0.18, -0.1),
      slot('LST', 0.72, 0.38, 0.85, 0.16, -0.16),
      slot('RST', 0.72, 0.62, 0.85, 0.16, -0.16),
    ],
  },
  '4-3-3': {
    id: '4-3-3',
    name: '4-3-3',
    slots: [
      slot('GK', 0.04, 0.5, 0.05, 0.0, 0.0),
      slot('LB', 0.22, 0.1, 0.55, 0.16, -0.06),
      slot('LCB', 0.18, 0.38, 0.1, 0.05, -0.05),
      slot('RCB', 0.18, 0.62, 0.1, 0.05, -0.05),
      slot('RB', 0.22, 0.9, 0.55, 0.16, -0.06),
      slot('CDM', 0.38, 0.5, 0.5, 0.08, -0.08),
      slot('LCM', 0.5, 0.3, 0.7, 0.16, -0.1),
      slot('RCM', 0.5, 0.7, 0.7, 0.16, -0.1),
      slot('LW', 0.72, 0.1, 0.9, 0.14, -0.2),
      slot('ST', 0.78, 0.5, 0.85, 0.14, -0.18),
      slot('RW', 0.72, 0.9, 0.9, 0.14, -0.2),
    ],
  },
  '4-2-3-1': {
    id: '4-2-3-1',
    name: '4-2-3-1',
    slots: [
      slot('GK', 0.04, 0.5, 0.05, 0.0, 0.0),
      slot('LB', 0.22, 0.1, 0.5, 0.14, -0.06),
      slot('LCB', 0.18, 0.38, 0.1, 0.05, -0.05),
      slot('RCB', 0.18, 0.62, 0.1, 0.05, -0.05),
      slot('RB', 0.22, 0.9, 0.5, 0.14, -0.06),
      slot('LCDM', 0.36, 0.38, 0.45, 0.08, -0.08),
      slot('RCDM', 0.36, 0.62, 0.45, 0.08, -0.08),
      slot('LAM', 0.58, 0.2, 0.85, 0.14, -0.14),
      slot('CAM', 0.62, 0.5, 0.9, 0.16, -0.14),
      slot('RAM', 0.58, 0.8, 0.85, 0.14, -0.14),
      slot('ST', 0.8, 0.5, 0.85, 0.12, -0.2),
    ],
  },
};

export enum Phase {
  /** Our team has the ball. */
  Attack = 0,
  /** Opponent has the ball. */
  Defend = 1,
  /** Nobody has it; react to the loose ball. */
  Transition = 2,
}

export interface FormationParams {
  /** How much the block shifts with the ball along the length, 0..1. */
  shiftX: number;
  /** How much the block shifts with the ball across the width, 0..1. */
  shiftZ: number;
  /** Compression towards the ball across the width. <1 tightens. */
  compressZ: number;
  /** Compression along the length. <1 shortens the team. */
  compressX: number;
}

export const ATTACK_SHAPE: FormationParams = { shiftX: 0.34, shiftZ: 0.3, compressZ: 0.92, compressX: 1.0 };
export const DEFEND_SHAPE: FormationParams = { shiftX: 0.42, shiftZ: 0.42, compressZ: 0.78, compressX: 0.82 };
export const TRANSITION_SHAPE: FormationParams = { shiftX: 0.38, shiftZ: 0.36, compressZ: 0.85, compressX: 0.9 };

/**
 * World position of a formation slot for the current ball position.
 *
 * @param team 0 attacks towards +x, 1 attacks towards -x
 * @param phaseSlot 0..1 phase blend used to interpolate push/drop
 */
export function homePosition(
  s: FormationSlot,
  ball: Vec3,
  team: number,
  phase: Phase,
  params: FormationParams,
): Vec3 {
  // Normalise the ball into team-relative attacking coordinates so both teams
  // can share one set of formation tables.
  const ballNx = team === 0 ? ball.x / PITCH.length : 1 - ball.x / PITCH.length;
  const ballNz = ball.z / PITCH.width;

  const shiftX = (ballNx - 0.5) * params.shiftX;
  const shiftZ = (ballNz - 0.5) * params.shiftZ;

  // Phase-driven push/drop. Defending pulls the line back; attacking stretches it.
  let phaseX = 0;
  if (phase === Phase.Attack) phaseX = s.attackingPush;
  else if (phase === Phase.Defend) phaseX = s.defendingDrop;
  else phaseX = (s.attackingPush + s.defendingDrop) * 0.5;

  let nx = 0.5 + (s.nx - 0.5) * params.compressX + shiftX + phaseX;
  let nz = 0.5 + (s.nz - 0.5) * params.compressZ + shiftZ;

  // The keeper holds a line just off his goal and tracks the ball laterally.
  if (s.role === 'GK') {
    nx = 0.045 + clamp((ballNx - 0.5) * 0.03, -0.02, 0.02);
    nz = clamp(0.5 + (ballNz - 0.5) * 0.55, 0.36, 0.64);
  }

  // Hard limits: nobody leaves the pitch, and defenders do not stray into the
  // opponent's half while defending (a very visible AI tell).
  if (phase === Phase.Defend && s.role !== 'GK' && nx > 0.62 && s.freedom < 0.8) {
    nx = Math.min(nx, 0.62);
  }
  nx = clamp(nx, 0.035, 0.965);
  nz = clamp(nz, 0.05, 0.95);

  const wx = team === 0 ? nx * PITCH.length : (1 - nx) * PITCH.length;
  const wz = nz * PITCH.width;
  return v3(wx, 0, wz);
}

/** Kickoff positions: a rigid version of the formation with the ball at centre. */
export function kickoffPosition(s: FormationSlot, team: number): Vec3 {
  // At kickoff nobody has pressed, so use the raw slot with a slight pull back.
  const nx = clamp(s.nx * 0.92 + 0.03, 0.04, 0.6);
  const nz = s.nz;
  const wx = team === 0 ? nx * PITCH.length : (1 - nx) * PITCH.length;
  return v3(wx, 0, nz * PITCH.width);
}

const FALLBACK = FORMATIONS['4-4-2'];
if (FALLBACK === undefined) throw new Error('formation table missing 4-4-2');
export const DEFAULT_FORMATION: Formation = FALLBACK;

export function formationById(id: string): Formation {
  const f = FORMATIONS[id];
  return f ?? DEFAULT_FORMATION;
}
