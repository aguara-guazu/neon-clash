'use strict';

/* Rendering core: palette-indexed framebuffer, integer-only primitives,
   pooled particles and integer-scaled presentation. Shared by every fight-*.js
   file through the global lexical scope of classic scripts. */

const W = 384, H = 216;
const SIM_HZ = 60;
const DT = 1 / SIM_HZ;
const ANIM_FPS = 12;
const GROUND = 194;
const STAGE_W = 576;
const MAX_PARTICLES = 768;
const DEG = Math.PI / 180;

const PAL = [
  ['CLEAR', '#00000000'],
  ['SKY0', '#07060f'], ['SKY1', '#0f0d24'], ['SKY2', '#1a1640'], ['SKY3', '#2a2260'], ['SKY4', '#3d3187'],
  ['INK', '#05040a'],
  ['BLD0', '#0c0b1e'], ['BLD1', '#131030'], ['BLD2', '#1d1944'],
  ['WIN0', '#3b2f5c'], ['WIN1', '#5c4a2e'],
  ['MET0', '#2c3446'], ['MET1', '#4a5670'], ['MET2', '#75839e'], ['MET3', '#b3bfd4'],
  ['PNK0', '#7a1a5a'], ['PNK1', '#d42a8a'], ['PNK2', '#ff6ec7'],
  ['CYN0', '#0b4a6a'], ['CYN1', '#1a9ec9'], ['CYN2', '#5ff2ff'],
  ['YEL0', '#6a4a0a'], ['YEL1', '#d9a21a'], ['YEL2', '#fffb96'],
  ['RED0', '#4a0e18'], ['RED1', '#b3202e'], ['RED2', '#ff5a4a'],
  ['GRN0', '#0f3a2a'], ['GRN1', '#1f9a4a'], ['GRN2', '#7bff6e'],
  ['PUR0', '#2e1452'], ['PUR1', '#6a2fb0'], ['PUR2', '#b07aff'],
  ['ORG0', '#7a2a0a'], ['ORG1', '#e0561a'], ['ORG2', '#ffae3d'],
  ['SKA0', '#6e3b32'], ['SKA1', '#b86b4b'], ['SKA2', '#eaa77e'],
  ['SKB0', '#3b2220'], ['SKB1', '#7a4a34'], ['SKB2', '#b07a55'],
  ['CLO0', '#454a5e'], ['CLO1', '#8a90a8'], ['CLO2', '#dde1ec'],
  ['HAI0', '#151220'], ['HAI1', '#2e2745'], ['HAI2', '#4f4570'],
  ['WHITE', '#ffffff'],
];
const C = {};
for (let i = 0; i < PAL.length; i++) C[PAL[i][0]] = i;

const LUT = new Uint32Array(PAL.length);
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
for (let i = 1; i < PAL.length; i++) {
  const hex = PAL[i][1];
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  LUT[i] = LITTLE_ENDIAN ? ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0
                         : ((r << 24) | (g << 16) | (b << 8) | 255) >>> 0;
}

/* Material ramps (dark -> light). LIGHTER/DARKER step one entry along the ramp
   and drive the automatic top-light / bottom-shadow pass on fighters. */
const RAMP_NAMES = [
  ['MET0', 'MET1', 'MET2', 'MET3'], ['PNK0', 'PNK1', 'PNK2'], ['CYN0', 'CYN1', 'CYN2'],
  ['YEL0', 'YEL1', 'YEL2'], ['RED0', 'RED1', 'RED2'], ['GRN0', 'GRN1', 'GRN2'],
  ['PUR0', 'PUR1', 'PUR2'], ['ORG0', 'ORG1', 'ORG2'], ['SKA0', 'SKA1', 'SKA2'],
  ['SKB0', 'SKB1', 'SKB2'], ['CLO0', 'CLO1', 'CLO2'], ['HAI0', 'HAI1', 'HAI2'],
];
const LIGHTER = new Uint8Array(256), DARKER = new Uint8Array(256);
const TINT_WHITE = new Uint8Array(256), TINT_ICE = new Uint8Array(256);
const TINT_TOX = new Uint8Array(256), TINT_FIRE = new Uint8Array(256);
const ALT = new Uint8Array(256);
const RAMP_OF = new Int8Array(256).fill(-1), RAMP_POS = new Uint8Array(256);
(function buildMaps() {
  for (let i = 0; i < 256; i++) {
    LIGHTER[i] = i; DARKER[i] = i; ALT[i] = i;
    TINT_WHITE[i] = i === C.INK ? i : C.WHITE;
    TINT_ICE[i] = i === C.INK ? i : C.CYN1;
    TINT_TOX[i] = i === C.INK ? i : C.PUR1;
    TINT_FIRE[i] = i === C.INK ? i : C.ORG1;
  }
  TINT_WHITE[0] = TINT_ICE[0] = TINT_TOX[0] = TINT_FIRE[0] = 0;
  const ramps = RAMP_NAMES.map((names) => names.map((n) => C[n]));
  for (let r = 0; r < ramps.length; r++) {
    const ramp = ramps[r], n = ramp.length;
    for (let k = 0; k < n; k++) {
      const c = ramp[k];
      RAMP_OF[c] = r; RAMP_POS[c] = k;
      LIGHTER[c] = ramp[Math.min(n - 1, k + 1)];
      DARKER[c] = ramp[Math.max(0, k - 1)];
      const t = Math.round((k / (n - 1)) * 2);
      TINT_ICE[c] = [C.CYN0, C.CYN1, C.CYN2][t];
      TINT_TOX[c] = [C.PUR0, C.PUR1, C.GRN2][t];
      TINT_FIRE[c] = [C.RED1, C.ORG1, C.YEL2][t];
    }
  }
  const swap = [['CYN', 'ORG'], ['PNK', 'GRN'], ['YEL', 'CYN'], ['GRN', 'PNK'], ['PUR', 'YEL'], ['ORG', 'CYN'], ['RED', 'PUR']];
  for (const [from, to] of swap) for (let k = 0; k < 3; k++) ALT[C[from + k]] = C[to + k];
})();

/* Particle ramps: hot -> cool -> dark, then despawn. */
const RAMPS = [
  new Uint8Array([C.WHITE, C.YEL2, C.ORG2, C.ORG1, C.RED0]),
  new Uint8Array([C.WHITE, C.CYN2, C.CYN1, C.CYN0]),
  new Uint8Array([C.WHITE, C.PNK2, C.PNK1, C.PNK0]),
  new Uint8Array([C.GRN2, C.PUR2, C.PUR1, C.PUR0]),
  new Uint8Array([C.WHITE, C.GRN2, C.GRN1, C.GRN0]),
  new Uint8Array([C.YEL2, C.ORG2, C.ORG1, C.RED1, C.RED0]),
  new Uint8Array([C.MET2, C.MET1, C.MET0]),
  new Uint8Array([C.MET1, C.MET0, C.SKY3]),
  new Uint8Array([C.YEL2, C.YEL1, C.YEL0]),
  new Uint8Array([C.PUR2, C.PUR1, C.PUR0]),
  new Uint8Array([C.CLO2, C.CLO1, C.CLO0]),
];
const R_SPARK = 0, R_ELEC = 1, R_PINK = 2, R_TOX = 3, R_HACK = 4, R_FIRE = 5, R_DUST = 6, R_SMOKE = 7, R_GOLD = 8, R_PURP = 9, R_STEAM = 10;

/* ---------- Framebuffer + primitives ---------- */
const fb = new Uint8Array(W * H);
const layer = new Uint8Array(W * H);
const rowTmp = new Uint8Array(W);
let target = fb;
let offX = 0, offY = 0;

const off = document.createElement('canvas');
off.width = W; off.height = H;
const octx = off.getContext('2d');
const img = octx.createImageData(W, H);
const px32 = new Uint32Array(img.data.buffer);

function setOffset(x, y) { offX = Math.round(x); offY = Math.round(y); }
function useTarget(buf) { target = buf; }
function clear(c) { fb.fill(c); }

function put(x, y, c) {
  if (c === 0 || x < 0 || y < 0 || x >= W || y >= H) return;
  target[y * W + x] = c;
}
function pset(x, y, c) { put(Math.round(x) + offX, Math.round(y) + offY, c); }
function rect(x, y, w, h, c) {
  if (c === 0) return;
  x = Math.round(x) + offX; y = Math.round(y) + offY; w = Math.round(w); h = Math.round(h);
  const x0 = x < 0 ? 0 : x, y0 = y < 0 ? 0 : y;
  const x1 = x + w > W ? W : x + w, y1 = y + h > H ? H : y + h;
  if (x1 <= x0) return;
  for (let yy = y0; yy < y1; yy++) target.fill(c, yy * W + x0, yy * W + x1);
}
function hline(x, y, w, c) { rect(x, y, w, 1, c); }
function vline(x, y, h, c) { rect(x, y, 1, h, c); }
function line(x0, y0, x1, y1, c) {
  x0 = Math.round(x0) + offX; y0 = Math.round(y0) + offY;
  x1 = Math.round(x1) + offX; y1 = Math.round(y1) + offY;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 2048; guard++) {
    put(x0, y0, c);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}
/* Thick segment stamped with a w x w square brush along the pixel line. */
function brush(x0, y0, x1, y1, w, c) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = x1 - x0, dy = y1 - y0;
  const n = Math.max(Math.abs(dx), Math.abs(dy));
  const h = (w - 1) >> 1;
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    rect(x0 + Math.round(dx * t) - h, y0 + Math.round(dy * t) - h, w, w, c);
  }
}
function circFill(cx, cy, r, c) {
  cx = Math.round(cx); cy = Math.round(cy); r = Math.round(r);
  for (let dy = -r; dy <= r; dy++) {
    const s = r * r + r - dy * dy;
    const dx = s > 0 ? Math.floor(Math.sqrt(s)) : 0;
    hline(cx - dx, cy + dy, dx * 2 + 1, c);
  }
}
const BAYER4 = new Uint8Array([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);
function ditherRect(x, y, w, h, c, level) {
  x = Math.round(x); y = Math.round(y);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const wx = x + i + offX, wy = y + j + offY;
    if (BAYER4[((wy & 3) << 2) | (wx & 3)] < level) put(wx, wy, c);
  }
}
function ditherEllipse(cx, cy, rx, ry, c, level) {
  cx = Math.round(cx); cy = Math.round(cy);
  for (let dy = -ry; dy <= ry; dy++) {
    const k = 1 - (dy * dy) / ((ry + 0.5) * (ry + 0.5));
    if (k <= 0) continue;
    const dx = Math.floor(rx * Math.sqrt(k));
    ditherRect(cx - dx, cy + dy, dx * 2 + 1, 1, c, level);
  }
}

/* ---------- 3x5 pixel font ---------- */
const FONT = new Uint16Array(128);
(function buildFont() {
  const src = {
    A: '.#./#.#/###/#.#/#.#', B: '##./#.#/##./#.#/##.', C: '.##/#../#../#../.##', D: '##./#.#/#.#/#.#/##.',
    E: '###/#../##./#../###', F: '###/#../##./#../#..', G: '.##/#../#.#/#.#/.##', H: '#.#/#.#/###/#.#/#.#',
    I: '###/.#./.#./.#./###', J: '..#/..#/..#/#.#/.#.', K: '#.#/#.#/##./#.#/#.#', L: '#../#../#../#../###',
    M: '#.#/###/###/#.#/#.#', N: '##./#.#/#.#/#.#/#.#', O: '.#./#.#/#.#/#.#/.#.', P: '##./#.#/##./#../#..',
    Q: '.#./#.#/#.#/##./.##', R: '##./#.#/##./#.#/#.#', S: '.##/#../.#./..#/##.', T: '###/.#./.#./.#./.#.',
    U: '#.#/#.#/#.#/#.#/###', V: '#.#/#.#/#.#/#.#/.#.', W: '#.#/#.#/###/###/#.#', X: '#.#/#.#/.#./#.#/#.#',
    Y: '#.#/#.#/.#./.#./.#.', Z: '###/..#/.#./#../###',
    0: '###/#.#/#.#/#.#/###', 1: '.#./##./.#./.#./###', 2: '##./..#/.#./#../###', 3: '##./..#/.#./..#/##.',
    4: '#.#/#.#/###/..#/..#', 5: '###/#../##./..#/##.', 6: '.##/#../###/#.#/###', 7: '###/..#/.#./.#./.#.',
    8: '###/#.#/###/#.#/###', 9: '###/#.#/###/..#/##.',
    '.': '.../.../.../.../.#.', ',': '.../.../.../.#./#..', '!': '.#./.#./.#./.../.#.', '?': '##./..#/.#./.../.#.',
    ':': '.../.#./.../.#./...', '-': '.../.../###/.../...', '+': '.../.#./###/.#./...', "'": '.#./.#./.../.../...',
    '/': '..#/..#/.#./#../#..', '%': '#.#/..#/.#./#../#.#', 'x': '.../#.#/.#./#.#/...',
  };
  for (const k in src) {
    const rows = src[k].split('/');
    let m = 0;
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (rows[r][c] === '#') m |= 1 << (r * 3 + c);
    FONT[k.charCodeAt(0)] = m;
  }
})();
function glyph(code, x, y, c, s) {
  if (code >= 97 && code <= 122 && code !== 120) code -= 32;
  const m = code < 128 ? FONT[code] : 0;
  if (!m) return;
  for (let b = 0; b < 15; b++) if (m & (1 << b)) {
    if (s === 1) pset(x + (b % 3), y + ((b / 3) | 0), c);
    else rect(x + (b % 3) * s, y + ((b / 3) | 0) * s, s, s, c);
  }
}
function text(str, x, y, c) { textS(str, x, y, c, 1); }
function textS(str, x, y, c, s) {
  x = Math.round(x); y = Math.round(y);
  for (let i = 0; i < str.length; i++) { glyph(str.charCodeAt(i), x, y, c, s); x += 4 * s; }
}
function textShadow(str, x, y, c, s) { textS(str, x + s, y + s, C.INK, s); textS(str, x, y, c, s); }
function textW(str, s) { return str.length * 4 * s - s; }
function numDigits(n) { let d = 1; while (n >= 10) { n = (n / 10) | 0; d++; } return d; }
function numW(n, s) { return numDigits(n) * 4 * s - s; }
/* Draws a non-negative integer digit by digit (no string building). */
function numText(n, x, y, c, s) {
  n = Math.max(0, Math.floor(n));
  const d = numDigits(n);
  let px = x + (d - 1) * 4 * s;
  for (let i = 0; i < d; i++) { glyph(48 + (n % 10), px, y, c, s); n = (n / 10) | 0; px -= 4 * s; }
}
function numShadow(n, x, y, c, s) { numText(n, x + s, y + s, C.INK, s); numText(n, x, y, c, s); }

/* ---------- Math helpers ---------- */
let seed = 1337 | 0;
function rand() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; }
function randRange(a, b) { return a + (b - a) * rand(); }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
function lerp(a, b, t) { return a + (b - a) * t; }
function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) * (-2 * t + 2)) / 2; }
function easeOutQuad(t) { return 1 - (1 - t) * (1 - t); }
function easeInQuad(t) { return t * t; }
function easeOutBack(t) { const c1 = 1.70158, c3 = c1 + 1, u = t - 1; return 1 + c3 * u * u * u + c1 * u * u; }
function linear(t) { return t; }
function hash3(a, b, c) {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/* ---------- Particles (structure of arrays) ---------- */
const pX = new Float32Array(MAX_PARTICLES), pY = new Float32Array(MAX_PARTICLES);
const pVX = new Float32Array(MAX_PARTICLES), pVY = new Float32Array(MAX_PARTICLES);
const pLife = new Float32Array(MAX_PARTICLES), pMax = new Float32Array(MAX_PARTICLES);
const pG = new Float32Array(MAX_PARTICLES), pDrag = new Float32Array(MAX_PARTICLES);
const pRamp = new Uint8Array(MAX_PARTICLES), pOn = new Uint8Array(MAX_PARTICLES), pSz = new Uint8Array(MAX_PARTICLES);
let pNext = 0;

/* World-space particle. g in px/s^2, drag = per-second damping, size 1 or 2. */
function spawn(x, y, vx, vy, life, ramp, g, drag, size) {
  let i = pNext, n = 0;
  while (pOn[i] && n < MAX_PARTICLES) { i = (i + 1) % MAX_PARTICLES; n++; }
  pNext = (i + 1) % MAX_PARTICLES;
  pX[i] = x; pY[i] = y; pVX[i] = vx; pVY[i] = vy;
  pLife[i] = life; pMax[i] = life; pRamp[i] = ramp;
  pG[i] = g; pDrag[i] = drag; pSz[i] = size || 1; pOn[i] = 1;
}
function burst(x, y, n, speed, life, ramp, g, size) {
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2, v = speed * (0.35 + rand() * 0.65);
    spawn(x, y, Math.cos(a) * v, Math.sin(a) * v, life * (0.6 + rand() * 0.4), ramp, g, 3, size);
  }
}
function updateParticles(dt) {
  for (let i = 0; i < MAX_PARTICLES; i++) {
    if (!pOn[i]) continue;
    pLife[i] -= dt;
    if (pLife[i] <= 0) { pOn[i] = 0; continue; }
    pVY[i] += pG[i] * dt;
    const d = 1 - pDrag[i] * dt;
    pVX[i] *= d; pVY[i] *= d;
    pX[i] += pVX[i] * dt; pY[i] += pVY[i] * dt;
    if (pY[i] > GROUND + 1 && pG[i] > 0) { pY[i] = GROUND + 1; pVY[i] *= -0.3; pVX[i] *= 0.6; }
  }
}
function drawParticles() {
  for (let i = 0; i < MAX_PARTICLES; i++) {
    if (!pOn[i]) continue;
    const ramp = RAMPS[pRamp[i]];
    let idx = Math.floor((1 - pLife[i] / pMax[i]) * ramp.length);
    if (idx >= ramp.length) idx = ramp.length - 1;
    if (pSz[i] > 1 && idx < 2) rect(pX[i], pY[i], 2, 2, ramp[idx]);
    else pset(pX[i], pY[i], ramp[idx]);
  }
}
function clearParticles() { pOn.fill(0); }

/* ---------- Post effect: horizontal row displacement (glitch) ---------- */
function glitchRows(strength) {
  for (let k = 0; k < strength; k++) {
    const y0 = (rand() * H) | 0, hgt = 1 + ((rand() * 6) | 0), shift = ((rand() * 17) | 0) - 8;
    for (let y = y0; y < y0 + hgt && y < H; y++) {
      const base = y * W;
      for (let x = 0; x < W; x++) rowTmp[x] = fb[base + x];
      for (let x = 0; x < W; x++) {
        let sx = x - shift;
        if (sx < 0) sx = 0; else if (sx >= W) sx = W - 1;
        fb[base + x] = rowTmp[sx];
      }
      if (k & 1) for (let x = 0; x < W; x += 3) if (fb[base + x] !== C.INK) fb[base + x] = C.GRN1;
    }
  }
}

/* ---------- Presentation: integer scale, DPR-aware ---------- */
const screenCanvas = document.getElementById('screen');
const FIT_TARGET = document.getElementById('stage');
const ctx = screenCanvas.getContext('2d', { alpha: false });
let scale = 1;
/* Renders at the largest integer scale; when that wastes more than 8% of the
   available space (phones in landscape), the canvas is stretched with CSS
   (image-rendering: pixelated) to fill it, so the residual non-integer step
   is applied to an already integer-upscaled image. */
function fit() {
  const dpr = window.devicePixelRatio || 1;
  const aw = FIT_TARGET.clientWidth * dpr, ah = FIT_TARGET.clientHeight * dpr;
  const exact = Math.min(aw / W, ah / H);
  scale = Math.max(1, Math.floor(exact));
  const shown = exact > scale && scale / exact < 0.92 ? exact : scale;
  screenCanvas.width = W * scale; screenCanvas.height = H * scale;
  screenCanvas.style.width = (W * shown / dpr) + 'px';
  screenCanvas.style.height = (H * shown / dpr) + 'px';
  ctx.imageSmoothingEnabled = false;
}
function present() {
  for (let i = 0; i < fb.length; i++) px32[i] = LUT[fb[i]];
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, W * scale, H * scale);
}
