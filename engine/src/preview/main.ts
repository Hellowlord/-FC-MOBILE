/**
 * Browser preview harness.
 *
 * This file is presentation only. Every number you see comes from the same
 * deterministic core the Android build will use — the renderer holds no game
 * state and never mutates the simulation. That is the whole point of the
 * architecture: if this looks right, the Android client will too, because it
 * is drawing the same MatchSnapshot.
 *
 * Controls
 *   WASD / arrows   move            (analogue: hold two keys to go diagonally)
 *   Shift           sprint
 *   Space           pass / through ball
 *   X               shoot           (hold to charge power)
 *   C               curve modifier  (hold while shooting)
 *   Q               switch player
 *   1 / 2 / 3       camera: broadcast / player / tactical
 */

import { MatchEngine, type MatchConfig, type MatchSnapshot, MatchPeriod } from '../match/engine.js';
import { DIFFICULTY, PITCH } from '../config/tuning.js';
import { FixedTimeStep } from '../core/fixed-step.js';
import { clamp, detCos, detSin } from '../core/math.js';

type CameraMode = 'broadcast' | 'player' | 'tactical';

const canvas = document.getElementById('pitch') as HTMLCanvasElement;
/**
 * TS will not carry a null-narrowing of a module-level const into the closures
 * below, so resolve it once behind a function that returns a non-null type.
 */
function requireCtx(c: CanvasRenderingContext2D | null): CanvasRenderingContext2D {
  if (c === null) throw new Error('canvas 2d context unavailable');
  return c;
}
const ctx = requireCtx(canvas.getContext('2d'));

const ui = {
  score: document.getElementById('score') as HTMLElement,
  clock: document.getElementById('clock') as HTMLElement,
  feed: document.getElementById('feed') as HTMLElement,
  power: document.getElementById('powerBar') as HTMLElement,
  stamina: document.getElementById('staminaBar') as HTMLElement,
  stats: document.getElementById('stats') as HTMLElement,
  hint: document.getElementById('hint') as HTMLElement,
};

const config: MatchConfig = {
  seed: Number(new URLSearchParams(location.search).get('seed') ?? 20260),
  halfLengthSec: 45 * 60,
  home: {
    name: 'Arena FC',
    shortName: 'ARE',
    formationId: '4-3-3',
    rating: 80,
    difficulty: DIFFICULTY.pro,
    human: true,
    primaryColour: '#e03131',
    secondaryColour: '#ffffff',
  },
  away: {
    name: 'Nomad United',
    shortName: 'NOM',
    formationId: '4-4-2',
    rating: 78,
    difficulty: DIFFICULTY.pro,
    human: false,
    primaryColour: '#1c7ed6',
    secondaryColour: '#0b2c4d',
  },
};

const engine = new MatchEngine(config);
const loop = new FixedTimeStep(5);
let camera: CameraMode = 'broadcast';
let cameraX = PITCH.centreSpotX;
let cameraZoom = 1;

// ---------------------------------------------------------------- input
const keys = new Set<string>();
let shootCharge = 0;
let charging = false;

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (['w', 'a', 's', 'd', ' ', 'x', 'c', 'q', 'shift', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
    e.preventDefault();
  }
  if (k === '1') camera = 'broadcast';
  if (k === '2') camera = 'player';
  if (k === '3') camera = 'tactical';
  if (k === 'q') engine.autoSwitch();
  if (k === 'x' && !charging) {
    charging = true;
    shootCharge = 0;
  }
  keys.add(k);
});
addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'x' && charging) {
    charging = false;
    engine.setHumanInput({ shoot: true, power: clamp(shootCharge, 0.05, 1), curve: keys.has('c') ? 0.85 : 0 });
  }
  keys.delete(k);
});

function pollInput(dt: number): void {
  let mx = 0;
  let mz = 0;
  if (keys.has('a') || keys.has('arrowleft')) mx -= 1;
  if (keys.has('d') || keys.has('arrowright')) mx += 1;
  if (keys.has('w') || keys.has('arrowup')) mz -= 1;
  if (keys.has('s') || keys.has('arrowdown')) mz += 1;

  if (charging) shootCharge = clamp(shootCharge + dt * 1.1, 0, 1);

  const pass = keys.has(' ');
  if (pass) keys.delete(' ');

  engine.setHumanInput({
    moveX: mx,
    moveZ: mz,
    sprint: keys.has('shift'),
    pass,
    throughBall: false,
    shoot: false,
    tackle: false,
    skillMove: 0,
    aim: null,
    power: 0,
    curve: 0,
    placement: 0,
    autoPower: true,
  });
}

// ---------------------------------------------------------------- render
function resize(): void {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.floor(canvas.clientWidth * dpr);
  canvas.height = Math.floor(canvas.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize);

function drawPitch(w: number, h: number, scale: number, ox: number, oy: number): void {
  const L = PITCH.length;
  const W = PITCH.width;

  // Turf with mowing stripes.
  ctx.fillStyle = '#2f7d32';
  ctx.fillRect(ox, oy, L * scale, W * scale);
  for (let i = 0; i < 12; i++) {
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.035)';
    ctx.fillRect(ox + (i * L * scale) / 12, oy, (L * scale) / 12, W * scale);
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = Math.max(1, scale * 0.12);
  const line = (x1: number, z1: number, x2: number, z2: number) => {
    ctx.beginPath();
    ctx.moveTo(ox + x1 * scale, oy + z1 * scale);
    ctx.lineTo(ox + x2 * scale, oy + z2 * scale);
    ctx.stroke();
  };
  const box = (x: number, z: number, w2: number, h2: number) => {
    ctx.strokeRect(ox + x * scale, oy + z * scale, w2 * scale, h2 * scale);
  };

  ctx.strokeRect(ox, oy, L * scale, W * scale);
  line(L / 2, 0, L / 2, W);
  ctx.beginPath();
  ctx.arc(ox + (L / 2) * scale, oy + (W / 2) * scale, PITCH.centreCircleRadius * scale, 0, Math.PI * 2);
  ctx.stroke();

  const gz0 = W / 2 - PITCH.goalWidth / 2;
  for (const side of [0, 1]) {
    const px = side === 0 ? 0 : L;
    const dir = side === 0 ? 1 : -1;
    box(
      side === 0 ? 0 : L - PITCH.penaltyAreaLength,
      W / 2 - PITCH.penaltyAreaWidth / 2,
      PITCH.penaltyAreaLength,
      PITCH.penaltyAreaWidth,
    );
    box(
      side === 0 ? 0 : L - PITCH.goalAreaLength,
      W / 2 - PITCH.goalAreaWidth / 2,
      PITCH.goalAreaLength,
      PITCH.goalAreaWidth,
    );
    // Goal mouth.
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(2, scale * 0.3);
    line(px, gz0, px + dir * PITCH.goalDepth, gz0);
    line(px, gz0 + PITCH.goalWidth, px + dir * PITCH.goalDepth, gz0 + PITCH.goalWidth);
    line(px + dir * PITCH.goalDepth, gz0, px + dir * PITCH.goalDepth, gz0 + PITCH.goalWidth);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = Math.max(1, scale * 0.12);
    // Penalty spot.
    const spotX = side === 0 ? PITCH.penaltySpotFromGoalLine : L - PITCH.penaltySpotFromGoalLine;
    ctx.beginPath();
    ctx.arc(ox + spotX * scale, oy + (W / 2) * scale, scale * 0.2, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
  }
}

let lastSnap: MatchSnapshot = engine.snapshot(0);

function render(): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.fillStyle = '#12261a';
  ctx.fillRect(0, 0, w, h);

  const snap = lastSnap;
  const controlled = snap.players.find((p) => p.controlled) ?? null;

  // Camera: broadcast frames the ball with a bias towards the play; player cam
  // centres the controlled man and zooms in.
  let focusX = snap.ball.x;
  let focusZ = snap.ball.z;
  let zoom = 1;
  if (camera === 'player' && controlled !== null) {
    focusX = controlled.pos.x;
    focusZ = controlled.pos.z;
    zoom = 1.55;
  } else if (camera === 'tactical') {
    zoom = 0.72;
  }
  const spread = snap.players.reduce((acc, p) => acc + Math.abs(p.pos.x - snap.ball.x), 0) / snap.players.length;
  if (camera === 'broadcast') zoom = clamp(1.35 - spread / 45, 0.78, 1.25);

  cameraX += (focusX - cameraX) * 0.12;
  cameraZoom += (zoom - cameraZoom) * 0.08;

  const baseScale = (w / PITCH.length) * 1.02;
  const scale = baseScale * cameraZoom;
  const ox = w / 2 - cameraX * scale;
  const oy = h / 2 - focusZ * scale + (h - PITCH.width * scale) / 2 * 0;

  drawPitch(w, h, scale, ox, oy);

  // Shadows first, then bodies, so nobody is drawn under a shadow.
  for (const p of snap.players) {
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(ox + p.pos.x * scale + 2, oy + p.pos.z * scale + 3, scale * 0.42, scale * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const p of snap.players) {
    const cx = ox + p.pos.x * scale;
    const cy = oy + p.pos.z * scale;
    const r = scale * (p.anim === 3 ? 0.44 : 0.4);
    const team = p.team === 0 ? config.home : config.away;

    if (p.controlled) {
      ctx.strokeStyle = '#ffe066';
      ctx.lineWidth = Math.max(2, scale * 0.12);
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.75, 0, Math.PI * 2);
      ctx.stroke();
    } else if (p.hasBall) {
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = Math.max(1.5, scale * 0.08);
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.fillStyle = p.role === 1 ? '#f59f00' : team.primaryColour;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = team.secondaryColour;
    ctx.lineWidth = Math.max(1, scale * 0.05);
    ctx.stroke();

    // Facing indicator, so momentum and turning are visible.
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = Math.max(1, scale * 0.07);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + detCos(p.heading) * r * 1.5, cy + detSin(p.heading) * r * 1.5);
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.font = `${Math.max(8, scale * 0.34)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(p.shirt), cx, cy + 0.5);
  }

  // Ball + shadow.
  const bx = ox + snap.ball.x * scale;
  const by = oy + snap.ball.z * scale;
  const lift = snap.ball.y * scale * 1.6;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(bx + lift * 0.4, by + scale * 0.15, scale * 0.2, scale * 0.12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(bx, by - lift, scale * 0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.stroke();

  updateHud(snap);
}

function updateHud(snap: MatchSnapshot): void {
  ui.score.textContent = `${config.home.shortName} ${snap.score[0]} - ${snap.score[1]} ${config.away.shortName}`;
  const mins = Math.floor(snap.clock / 60);
  const secs = Math.floor(snap.clock % 60);
  const period = snap.period === MatchPeriod.FirstHalf ? '1H' : snap.period === MatchPeriod.SecondHalf ? '2H' : 'HT';
  ui.clock.textContent = `${period} ${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  const controlled = snap.players.find((p) => p.controlled);
  ui.stamina.style.width = `${Math.round((controlled?.stamina ?? 1) * 100)}%`;
  ui.stamina.style.background = (controlled?.stamina ?? 1) < 0.3 ? '#fa5252' : '#51cf66';
  ui.power.style.width = `${Math.round(clamp(shootCharge, 0, 1) * 100)}%`;

  const s = engine.stats;
  ui.stats.textContent =
    `shots ${(s.shots[0] ?? 0)}-${(s.shots[1] ?? 0)}   on target ${(s.shotsOnTarget[0] ?? 0)}-${(s.shotsOnTarget[1] ?? 0)}` +
    `   passes ${(s.passes[0] ?? 0)}-${(s.passes[1] ?? 0)}   tackles ${(s.tackles[0] ?? 0)}-${(s.tackles[1] ?? 0)}` +
    `   cam ${camera}   ${loop.droppedTime ? 'DROPPED' : `${engine.tick} ticks`}`;
}

function pushFeed(kind: string, text: string): void {
  const div = document.createElement('div');
  div.className = `feed-item feed-${kind}`;
  div.textContent = text || kind;
  ui.feed.prepend(div);
  while (ui.feed.childElementCount > 6) ui.feed.lastElementChild?.remove();
}

// ---------------------------------------------------------------- loop
let prev = performance.now();
function frame(now: number): void {
  const elapsed = (now - prev) / 1000;
  prev = now;

  loop.update(elapsed, (dt) => {
    pollInput(dt);
    engine.step();
    lastSnap = engine.snapshot(loop.alpha);
  });

  for (const e of engine.drainEvents()) {
    if (e.kind === 'bounce') continue; // too noisy for the feed
    if (e.kind === 'pass') continue;
    pushFeed(e.kind, e.text);
  }

  render();
  requestAnimationFrame(frame);
}

resize();
ui.hint.textContent = 'WASD move · Shift sprint · Space pass · X shoot (hold to charge, +C curve) · Q switch · 1/2/3 camera';
requestAnimationFrame(frame);
