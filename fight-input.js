'use strict';

/* Human input with fighting-game command motions. Keyboard and touch write
   the raw device state; humanTick() runs once per simulation tick before
   control(), records direction changes in numpad notation relative to the
   fighter's facing (6 = toward the opponent, 2 = down, 5 = neutral) and turns
   A/B presses into actions by matching motions, newest-first with skipped
   in-between directions allowed:
     236+A skill 1 · 623+A skill 2 · 214+B skill 3 · 22+B skill 4
     236236+B ultimate · A+B grab (burst while being hit) · 66 / 44 dash.
   A lone press waits CHORD_FRAMES for its partner before resolving. */

const HIST_N = 32, CHORD_FRAMES = 3, LAST_WITHIN = 14;
const histDir = new Uint8Array(HIST_N), histAt = new Int32Array(HIST_N);
let histHead = 0, histLen = 0, lastDir = 5, inputTick = 0, pendA = -1, pendB = -1;

const raw = { kl: false, kr: false, ku: false, kd: false, sl: false, sr: false, su: false, sd: false, qA: 0, qB: 0, dash: 0 };

const SEQ_QCF = [[2, 3, 6], [2, 6]];
const SEQ_DP = [[6, 2, 3], [6, 3]];
const SEQ_QCB = [[2, 1, 4], [2, 4]];
const SEQ_DD = [[2, 5, 2]];
const SEQ_DOUBLE = [[2, 3, 6, 2, 3, 6], [2, 6, 2, 6], [2, 3, 6, 2, 6], [2, 6, 2, 3, 6]];
const SEQ_DASH_F = [[6, 5, 6]];
const SEQ_DASH_B = [[4, 5, 4]];

/* Command notation shown to players (→ is toward the opponent). */
const MOVE_COMMANDS = { [A_LIGHT]: 'A', [A_HEAVY]: 'B', [A_GRAB]: 'A + B', [A_S1]: '↓↘→ + A', [A_S2]: '→↓↘ + A', [A_S3]: '↓↙← + B', [A_S4]: '↓↓ + B', [A_ULT]: '↓↘→↓↘→ + B', [A_BURST]: 'A + B (mientras te golpean)' };

function pushDir(d) {
  histHead = (histHead + 1) % HIST_N;
  histDir[histHead] = d; histAt[histHead] = inputTick;
  if (histLen < HIST_N) histLen++;
}

function matchOne(seq, span) {
  let j = seq.length - 1;
  for (let k = 0; k < histLen; k++) {
    const i = (histHead - k + HIST_N) % HIST_N;
    const age = inputTick - histAt[i];
    if (age > span) return false;
    if (histDir[i] !== seq[j]) continue;
    if (j === seq.length - 1 && age > LAST_WITHIN + CHORD_FRAMES) return false;
    if (--j < 0) return true;
  }
  return false;
}

function matches(alts, span) {
  for (let a = 0; a < alts.length; a++) if (matchOne(alts[a], span)) return true;
  return false;
}

function threatened(f, o) {
  const dist = Math.abs(o.x - f.x);
  if (o.state === S_ATTACK && o.phase !== PH_RE && dist < 130) return true;
  for (let i = 0; i < MAX_PROJ; i++) {
    const p = projs[i];
    if (p.on && p.owner === o.side && (p.vx > 0) === (f.x > p.x) && Math.abs(p.x - f.x) < 150) return true;
  }
  return false;
}

function inputReset() {
  raw.kl = raw.kr = raw.ku = raw.kd = raw.sl = raw.sr = raw.su = raw.sd = false;
  raw.qA = raw.qB = raw.dash = 0;
  pendA = pendB = -1; histLen = 0; lastDir = 5;
}

function humanTick(f, o) {
  inputTick++;
  const inp = f.input;
  const dx = (raw.kr || raw.sr ? 1 : 0) - (raw.kl || raw.sl ? 1 : 0);
  const dy = (raw.kd || raw.sd ? 1 : 0) - (raw.ku || raw.su ? 1 : 0);
  const fwd = dx * f.dir;
  const dir = (dy > 0 ? 1 : dy < 0 ? 7 : 4) + fwd + 1;
  if (dir !== lastDir) {
    const wasUp = lastDir >= 7;
    pushDir(dir);
    lastDir = dir;
    if (dy < 0 && !wasUp) inp.jump = 6;
    if (dir === 6 && matches(SEQ_DASH_F, 16)) inp.dash = 6;
    else if (dir === 4 && matches(SEQ_DASH_B, 16)) inp.dash = 6;
  }
  if (raw.dash) { raw.dash = 0; inp.dash = 6; }
  inp.left = dx < 0; inp.right = dx > 0;
  inp.block = dy > 0 || (fwd < 0 && threatened(f, o));

  if (raw.qA) { raw.qA = 0; if (pendA < 0) pendA = inputTick; }
  if (raw.qB) { raw.qB = 0; if (pendB < 0) pendB = inputTick; }
  if (pendA < 0 && pendB < 0) return;
  const first = pendA < 0 ? pendB : pendB < 0 ? pendA : Math.min(pendA, pendB);
  const both = pendA >= 0 && pendB >= 0;
  if (!both && inputTick - first < CHORD_FRAMES) return;
  let code;
  if (both) code = burstReady(f) ? A_BURST : A_GRAB;
  else if (pendA >= 0) code = matches(SEQ_DP, 26) ? A_S2 : matches(SEQ_QCF, 26) ? A_S1 : A_LIGHT;
  else code = matches(SEQ_DOUBLE, 50) ? A_ULT : matches(SEQ_QCB, 26) ? A_S3 : matches(SEQ_DD, 26) ? A_S4 : A_HEAVY;
  inp.act = code; inp.actT = 10;
  pendA = pendB = -1;
}

/* 45° sectors from atan2 (y down): index 0 = left, 2 = up, 4 = right, 6 = down. */
const STICK_X = [-1, -1, 0, 1, 1, 1, 0, -1, -1];
const STICK_Y = [0, -1, -1, -1, 0, 1, 1, 1, 0];

/* Maps a joystick vector (x right, y down, unit radius) to 8-way digital directions. */
function inputStick(x, y) {
  const m = Math.hypot(x, y);
  raw.sl = raw.sr = raw.su = raw.sd = false;
  if (m < 0.32) return;
  const k = Math.round(Math.atan2(y, x) / (Math.PI / 4)) + 4;
  const sx = STICK_X[k], sy = STICK_Y[k];
  raw.sr = sx > 0; raw.sl = sx < 0; raw.sd = sy > 0; raw.su = sy < 0;
}
