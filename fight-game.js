'use strict';

/* Fight simulation (fixed 60 Hz), procedural fighter rig and scene/HUD
   rendering. Entity pools are preallocated; update/render paths do not
   allocate. AI hooks (aiTick, aiNotify) live in fight-ai.js. */

const S_IDLE = 0, S_WALK = 1, S_JUMP = 2, S_DASH = 3, S_ATTACK = 4, S_BLOCK = 5, S_BLOCKSTUN = 6,
  S_HITSTUN = 7, S_AIRHIT = 8, S_DOWN = 9, S_GETUP = 10, S_STUN = 11, S_KO = 12, S_WIN = 13;
const PH_SU = 0, PH_AC = 1, PH_RE = 2;
const HIT_MISS = 0, HIT_HIT = 1, HIT_BLOCK = 2, HIT_PARRY = 3;
const SRC_MELEE = 0, SRC_PROJ = 1, SRC_ZONE = 2;
const GRAV = 0.3, JUMP_VY = -5.6, JUMP_VX = 2.1, SEP_MAX = W - 48;
const MAX_PROJ = 40, MAX_ZONES = 24, MAX_POP = 40;
const ROUND_TIME = 99;
const PASSIVE_WARN = 3, PASSIVE_LV1 = 5, PASSIVE_LV2 = 9;
const FX_RAMP = { volt: R_ELEC, ronin: R_PINK, brick: R_GOLD, glitch: R_HACK, viper: R_TOX, pyra: R_FIRE };
const AIRKICK = P(0, 0, 10, 0, 60, 60, 40, 90, -4, 10, 16, 2);
const AIR_BOX = [2, 30, 24, 30];
const PROJ_SFX = ['', 'bolt', 'wave', 'hack', 'spit', 'grenade', 'quake', 'bullet'];

const game = {
  phase: 'attract', phaseT: 0, round: 1, timer: ROUND_TIME, hitstop: 0, camX: (STAGE_W - W) / 2,
  simTime: 0, animFrame: 0, tick: 0, fighters: [null, null], announce: '', announceT: 0, announceCol: C.YEL2,
  glitchT: 0, superT: 0, superName: '', superCol: C.WHITE, matchId: 0, winner: -1, onMatchEnd: null,
  shakeT: 0, shakeX: 0, shakeY: 0, paused: false, showAi: false,
};

function opp(f) { return game.fighters[1 - f.side]; }
function startShake(frames) { if (frames > game.shakeT) game.shakeT = frames; }

/* ---------- Fighter ---------- */
function makeFighter(side, def, alt) {
  const f = {
    side, def, look: def.look, moves: def.moves, alt, ramp: FX_RAMP[def.id],
    x: 0, y: GROUND, vx: 0, vy: 0, dir: side === 0 ? 1 : -1, onGround: true,
    hp: def.hp, hpMax: def.hp, trail: def.hp, trailWait: 0,
    energy: 50, meter: 0, guard: 100, heat: 0, shieldHP: 0,
    state: S_IDLE, stateT: 0, stun: 0, move: null, phase: PH_SU, phaseT: 0, hits: 0, lastHitT: -99, hitConfirmed: false,
    invT: 0, parryT: 0, jolt: 0, shockClock: 0, juggle: 0, juggleImmune: false, comboHits: 0, comboDmg: 0,
    showCombo: 0, showComboT: 0, ambush: false, dotAcc: 0, tucked: false, walkPh: 0, walkSign: 1, flashT: 0,
    st: new Float32Array(NST), stk: new Uint8Array(NST), cds: new Float32Array(NACT), dashCd: 0, dashDir: 1,
    pose: new Float32Array(POSE_N), from: new Float32Array(POSE_N), tgt: new Float32Array(POSE_N), shown: new Float32Array(POSE_N),
    twT: 0, twDur: 1, twEase: linear, forceShow: true, lastAnim: -1,
    input: { left: false, right: false, block: false, act: 0, actT: 0, jump: 0, dash: 0 },
    passiveT: 0, passiveLv: 0, passiveDrain: 0,
    cpu: false, ai: null, wins: 0, cutOn: 0, cutN: 0, cutT: 0, beamLen: 0, aiLabel: '',
  };
  f.pose.set(PO.STANCE); f.shown.set(PO.STANCE); f.from.set(PO.STANCE); f.tgt.set(PO.STANCE);
  return f;
}

function resetFighter(f, x, keepMeter) {
  f.x = x; f.y = GROUND; f.vx = 0; f.vy = 0; f.onGround = true; f.dir = f.side === 0 ? 1 : -1;
  f.hp = f.hpMax; f.trail = f.hpMax; f.trailWait = 0; f.energy = 50; if (!keepMeter) f.meter = 0;
  f.guard = 100; f.heat = 0; f.shieldHP = 0; f.move = null; f.stun = 0; f.invT = 0; f.parryT = 0; f.jolt = 0;
  f.juggle = 0; f.juggleImmune = false; f.comboHits = 0; f.comboDmg = 0; f.showComboT = 0; f.ambush = false; f.dotAcc = 0;
  f.st.fill(0); f.stk.fill(0); f.cds.fill(0); f.dashCd = 0; f.cutOn = 0; f.flashT = 0;
  f.passiveT = 0; f.passiveLv = 0; f.passiveDrain = 0;
  f.input.left = f.input.right = f.input.block = false; f.input.act = 0; f.input.actT = 0; f.input.jump = 0; f.input.dash = 0;
  setState(f, S_IDLE);
  f.pose.set(PO.STANCE); f.shown.set(PO.STANCE);
}

function tween(f, pose, frames, ease) {
  f.from.set(f.pose); f.tgt.set(pose); f.twT = 0; f.twDur = frames < 1 ? 1 : frames; f.twEase = ease;
}

function setState(f, s) {
  f.state = s; f.stateT = 0; f.forceShow = true;
  switch (s) {
    case S_IDLE: tween(f, PO.STANCE, 6, easeInOut); break;
    case S_WALK: tween(f, PO.STANCE, 4, easeInOut); break;
    case S_BLOCK: case S_BLOCKSTUN: tween(f, PO.BLOCK, 2, easeOutQuad); break;
    case S_HITSTUN: case S_STUN: tween(f, PO.HIT, 1, linear); break;
    case S_AIRHIT: tween(f, PO.AIRHIT, 3, easeOutQuad); break;
    case S_DOWN: case S_KO: tween(f, PO.DOWN, 5, easeOutQuad); break;
    case S_GETUP: tween(f, PO.STANCE, 16, easeInOut); break;
    case S_JUMP: tween(f, PO.JUMP, 4, easeOutQuad); f.tucked = false; break;
    case S_DASH: tween(f, PO.DASH, 3, easeOutQuad); break;
    case S_WIN: tween(f, PO.WIN, 10, easeOutBack); break;
  }
}

function speedOf(f) {
  let s = f.def.speed;
  if (f.st[ST_SLOW] > 0) s *= 0.5;
  if (f.st[ST_SHOCK] > 0) s *= 0.65;
  if (f.st[ST_OVERCHARGE] > 0) s *= 1.3;
  if (f.st[ST_CLOAK] > 0) s *= 1.2;
  return s;
}

function moveCost(f, o, m) {
  let c = m.cost;
  if (f.def.id === 'glitch' && o.st[ST_HACK] > 0 && m.level >= 3) c = Math.round(c * 0.75);
  return c;
}
function canUse(f, o, m) {
  if (!m) return false;
  if (f.cds[m.slot] > 0) return false;
  if (f.energy < moveCost(f, o, m) || f.meter < m.meter) return false;
  if (f.st[ST_HACK] > 0 && m.level >= 3) return false;
  return true;
}
function isActionable(f) {
  if (f.st[ST_FREEZE] > 0 || f.jolt > 0) return false;
  return f.state === S_IDLE || f.state === S_WALK || f.state === S_BLOCK || f.state === S_JUMP;
}
function inHitState(f) {
  return f.state === S_HITSTUN || f.state === S_AIRHIT || f.state === S_BLOCKSTUN || (f.state === S_STUN && f.st[ST_FREEZE] <= 0);
}
function burstReady(f) {
  return f.meter >= BURST_COST && f.cds[A_BURST] <= 0 && f.hp > 0 && inHitState(f);
}
function countDebuffs(f) {
  let n = 0;
  for (let i = 0; i < NST; i++) if (f.st[i] > 0 && ST_INFO[i].debuff) n++;
  return n;
}

/* ---------- Moves ---------- */
function startMove(f, o, m) {
  f.energy -= moveCost(f, o, m);
  f.meter -= m.meter;
  f.cds[m.slot] = m.cd;
  f.move = m; f.state = S_ATTACK; f.stateT = 0; f.phase = PH_SU; f.phaseT = 0;
  f.hits = 0; f.lastHitT = -99; f.hitConfirmed = false; f.forceShow = true;
  if (f.onGround) f.vx = 0;
  const pa = !f.onGround && m.slot === A_HEAVY ? AIRKICK : m.pa;
  tween(f, pa, Math.max(2, m.su), easeOutQuad);
  if (f.st[ST_CLOAK] > 0 && m.id !== 'cloak') { f.st[ST_CLOAK] = 0; f.ambush = true; burst(f.x, f.y - 24, 10, 50, 0.4, R_PURP, 0, 1); }
  if (m.level >= 3) popText(f.x, f.y - 60 * f.look.scale, m.name, f.look.eye);
  if (m.level === 3) sfx('skill', f.x);
  else if (m.slot === A_GRAB) sfx('grab', f.x);
  if (m.level === 4) {
    sfx('ult', f.x);
    game.superT = 40; game.superName = m.name; game.superCol = f.look.eye; game.hitstop = 22;
    burst(f.x, f.y - 26, 26, 90, 0.6, f.ramp, 0, 2);
  }
  if (m.fire && f.def.id === 'pyra') addHeat(f, 25);
  f.passiveT = Math.max(0, f.passiveT - 1);
  aiNotify(o, 1);
}

function enterActive(f, o) {
  const m = f.move;
  f.phase = PH_AC; f.phaseT = 0; f.forceShow = true;
  tween(f, !f.onGround && m.slot === A_HEAVY ? AIRKICK : m.pb, 2, easeOutQuad);
  if (m.vy) { f.vy = m.vy; f.onGround = false; }
  if (m.level <= 2 && m.slot !== A_GRAB) sfx('whiff', f.x);
  if (m.proj) spawnProj(f, m);
  if (m.onActive) m.onActive(f, o);
}

function enterRecovery(f, o) {
  const m = f.move;
  if (!m) return;
  f.phase = PH_RE; f.phaseT = 0;
  tween(f, f.onGround ? PO.STANCE : PO.JUMP, m.re, easeInOut);
  if (m.vx && f.onGround) f.vx *= 0.3;
  if (m.onEnd) m.onEnd(f, o);
}

function endMove(f) {
  f.move = null; f.ambush = false; f.parryT = 0; f.cutOn = 0;
  setState(f, f.onGround ? S_IDLE : S_JUMP);
}

function interruptMove(f) {
  if (!f.move) return;
  const m = f.move;
  f.move = null; f.parryT = 0; f.cutOn = 0; f.ambush = false;
  if (m.onEnd && f.phase !== PH_RE) m.onEnd(f, opp(f));
}

function tickMove(f, o) {
  const m = f.move;
  f.phaseT++;
  if (f.phase === PH_SU) {
    if (m.level === 4 && (game.tick & 1)) {
      const a = rand() * Math.PI * 2;
      spawn(f.x + Math.cos(a) * 26, f.y - 26 + Math.sin(a) * 20, -Math.cos(a) * 70, -Math.sin(a) * 60, 0.35, f.ramp, 0, 1, 1);
    }
    if (f.phaseT >= m.su) enterActive(f, o);
    return;
  }
  if (f.phase === PH_AC) {
    if (m.vx) f.vx = f.dir * m.vx;
    moveFxTick(f, m);
    if (m.onTick) m.onTick(f, o);
    if (f.move !== m) return;
    if (f.phase === PH_AC && m.hb && m.h) checkMelee(f, o, m);
    if (f.move !== m) return;
    if (f.phase === PH_AC && f.phaseT >= m.ac) enterRecovery(f, o);
    return;
  }
  if (f.onGround) f.vx *= 0.7;
  if (f.phaseT >= m.re) endMove(f);
}

function moveFxTick(f, m) {
  const d = f.dir;
  switch (m.id) {
    case 'flame_burst':
      for (let i = 0; i < 2; i++) spawn(f.x + d * 18, f.y - 34 + randRange(-2, 2), d * randRange(120, 210), randRange(-35, 30), 0.3, R_FIRE, -30, 3, 2);
      break;
    case 'afterburner':
      spawn(f.x - d * 6, f.y - 6, -d * randRange(10, 50), randRange(30, 70), 0.35, R_FIRE, 0, 2, 2);
      break;
    case 'rail_dash':
      spawn(f.x + randRange(-6, 6), f.y - randRange(6, 40), -d * 30, randRange(-20, 20), 0.3, R_ELEC, 0, 2, 1);
      break;
    case 'iaido': case 'thousand_cuts':
      if (f.phaseT < 16) spawn(f.x - d * 4, f.y - randRange(10, 36), -d * 20, 0, 0.3, R_PINK, 0, 2, 1);
      break;
    case 'serpent_rise':
      spawn(f.x + randRange(-4, 4), f.y - randRange(0, 30), 0, 20, 0.4, R_TOX, 0, 2, 1);
      break;
  }
}

/* ---------- Hit boxes ---------- */
let BX0 = 0, BY0 = 0, BX1 = 0, BY1 = 0;
function moveBox(f, hb) {
  if (f.dir > 0) { BX0 = f.x + hb[0]; BX1 = BX0 + hb[2]; } else { BX1 = f.x - hb[0]; BX0 = BX1 - hb[2]; }
  BY0 = f.y - hb[1]; BY1 = BY0 + hb[3];
}
function boxHitsFighter(o, x0, y0, x1, y1) {
  const s = o.look.scale;
  const hx0 = o.x - 8 * s, hx1 = o.x + 8 * s, hy0 = o.y - 44 * s, hy1 = o.y;
  return x0 < hx1 && x1 > hx0 && y0 < hy1 && y1 > hy0;
}
function isInvuln(def, src) {
  if (def.hp <= 0 && def.state !== S_AIRHIT) return true;
  if (def.state === S_DOWN || def.state === S_GETUP || def.state === S_KO) return true;
  if (def.invT > 0) return true;
  if (def.juggleImmune && def.state === S_AIRHIT) return true;
  if (def.state === S_ATTACK && def.move && def.move.inv && def.stateT < def.move.invF) {
    if (def.move.inv === 'all' || src !== SRC_MELEE) return true;
  }
  return false;
}

function checkMelee(f, o, m) {
  if (f.hits >= m.hits) return;
  if (m.every && f.hits > 0 && f.phaseT - f.lastHitT < m.every) return;
  const airNormal = !f.onGround && m.level <= 2;
  moveBox(f, airNormal ? AIR_BOX : m.hb);
  if (!boxHitsFighter(o, BX0, BY0, BX1, BY1)) return;
  const r = resolveHit(f, o, m.h, SRC_MELEE, m, f.x);
  if (r === HIT_MISS) return;
  if (r === HIT_PARRY) return;
  f.hits++; f.lastHitT = f.phaseT; f.hitConfirmed = true;
  if (r === HIT_HIT && m.onHit) m.onHit(f, o);
  aiNotify(f, 2);
}

function dmgMult(att, def) {
  let k = 1;
  if (att.st[ST_OVERHEAT] > 0) k *= 1.3;
  if (att.def.id === 'volt' && def.st[ST_SHOCK] > 0) k *= 1.2;
  if (att.def.id === 'viper' && def.st[ST_POISON] > 0) k *= 1.25;
  if (def.def.id === 'brick') k *= 0.9;
  if (def.passiveLv === 1) k *= 1.15; else if (def.passiveLv === 2) k *= 1.3;
  return k;
}

function applyDamage(def, amt) {
  if (def.shieldHP > 0) {
    const a = Math.min(def.shieldHP, amt);
    def.shieldHP -= a; amt -= a;
    if (def.shieldHP <= 0) { def.shieldHP = 0; def.st[ST_SHIELD] = 0; burst(def.x, def.y - 26, 14, 70, 0.4, R_ELEC, 0, 1); }
  }
  def.hp -= amt;
  if (def.hp < 0) def.hp = 0;
  def.trailWait = 36;
  return amt;
}

function heal(f, amt) {
  if (f.st[ST_POISON] > 0) amt *= 0.5;
  amt = Math.round(amt);
  f.hp = Math.min(f.hpMax, f.hp + amt);
  if (f.trail < f.hp) f.trail = f.hp;
  popNum(f.x, f.y - 50, amt, C.GRN2);
  sfx('heal', f.x);
}

function resolveHit(att, def, spec, src, move, srcX) {
  if (isInvuln(def, src)) return HIT_MISS;
  if (spec.grab && (!def.onGround || def.state === S_HITSTUN || def.state === S_BLOCKSTUN || def.state === S_AIRHIT)) return HIT_MISS;
  if (def.parryT > 0 && src !== SRC_ZONE && !spec.grab) { doParry(def, att, src); return HIT_PARRY; }

  const away = def.x >= srcX ? 1 : -1;
  const faces = def.dir * (srcX - def.x) >= -4;
  const blocking = (def.state === S_BLOCK || def.state === S_BLOCKSTUN) && !spec.ub && faces;
  const cx = def.x - away * 6, cy = def.y - 28 * def.look.scale;

  if (blocking) {
    let chip = Math.round(spec.dmg * 0.15 * dmgMult(att, def));
    if (def.hp - chip < 1) chip = Math.max(0, def.hp - 1);
    applyDamage(def, chip);
    def.guard -= spec.gd;
    att.meter = Math.min(METER_MAX, att.meter + spec.dmg * 0.2);
    def.meter = Math.min(METER_MAX, def.meter + spec.dmg * 0.15);
    burst(cx, cy, 8, 70, 0.25, R_ELEC, 0, 1);
    sfx('block', def.x);
    if (def.guard <= 0) {
      sfx('guardbreak', def.x);
      def.guard = 60; setState(def, S_STUN); def.stun = 60; def.vx = away * 2;
      popText(def.x, def.y - 56, 'GUARD BREAK', C.RED2); startShake(10);
    } else {
      setState(def, S_BLOCKSTUN); def.stun = spec.bs > 0 ? spec.bs : 6; def.vx = away * (1 + Math.abs(spec.kx) * 0.5);
    }
    game.hitstop = Math.max(game.hitstop, 4);
    aiNotify(def, 3);
    return HIT_BLOCK;
  }

  let dmg = spec.dmg * dmgMult(att, def);
  const counter = src === SRC_MELEE && def.state === S_ATTACK && def.phase === PH_SU;
  if (counter) {
    const ronin = att.def.id === 'ronin';
    dmg *= ronin ? 1.4 : 1.25;
    if (ronin) att.energy = Math.min(100, att.energy + 10);
    popText(att.x, att.y - 66, 'COUNTER', C.YEL2);
  }
  dmg *= Math.max(0.35, 1 - 0.1 * def.comboHits);
  if (att.ambush && src === SRC_MELEE) { dmg *= 1.5; att.ambush = false; popText(att.x, att.y - 66, 'AMBUSH', C.PUR2); }
  dmg = Math.max(1, Math.round(dmg));
  const dealt = applyDamage(def, dmg);

  if (spec.fx) for (let i = 0; i < spec.fx.length; i++) addStatus(def, spec.fx[i][0], spec.fx[i][1], spec.fx[i][2], att);
  if (att.st[ST_OVERCHARGE] > 0 && move && move.level <= 2 && !spec.grab) addStatus(def, ST_SHOCK, 1, 1, att);

  att.meter = Math.min(METER_MAX, att.meter + dmg * 0.5);
  def.meter = Math.min(METER_MAX, def.meter + dmg * 0.35);
  att.passiveT = 0;
  att.energy = Math.min(100, att.energy + 2);
  def.comboHits++; def.comboDmg += dmg;
  att.showCombo = def.comboHits; att.showComboT = 90;

  const frozen = def.st[ST_FREEZE] > 0;
  const armored = def.st[ST_ARMOR] > 0 || (def.state === S_ATTACK && def.move && def.move.armor && def.phase !== PH_RE);
  if (frozen) {
    def.st[ST_FREEZE] = Math.max(0.1, def.st[ST_FREEZE] - 0.35);
  } else if (spec.nostun && def.hp > 0) {
    def.flashT = 2;
  } else if (armored && !spec.grab && def.hp > 0) {
    def.flashT = 4;
  } else {
    interruptMove(def);
    if (def.hp <= 0 || spec.ky < 0 || !def.onGround || spec.kd) {
      setState(def, S_AIRHIT);
      def.onGround = false;
      def.vy = spec.ky < 0 ? spec.ky : -3;
      def.vx = away * (spec.kx === 0 ? 1.5 : spec.kx);
      def.juggle++;
      if (def.juggle > 6) def.juggleImmune = true;
    } else {
      setState(def, S_HITSTUN);
      def.stun = spec.hs;
      def.vx = away * spec.kx;
    }
  }
  def.flashT = Math.max(def.flashT, 3);
  if (!spec.nostun) game.hitstop = Math.max(game.hitstop, dmg >= 90 ? 9 : dmg >= 50 ? 6 : 4);
  if (dmg >= 80) startShake(8);
  if (spec.nostun) { if (dealt > 0) sfx('status', def.x); }
  else sfx(spec.grab || dmg >= 80 ? 'heavy' : dmg >= 45 ? 'kick' : 'jab', def.x);
  burst(cx, cy, dmg >= 60 ? 14 : 8, 90, 0.35, spec.spark, 0, dmg >= 60 ? 2 : 1);
  if (dealt > 0) popNum(def.x + randRange(-6, 6), def.y - 48 * def.look.scale, dealt, dmg >= 80 ? C.YEL2 : C.WHITE);
  aiNotify(def, 4);
  return HIT_HIT;
}

function doParry(def, att, src) {
  def.parryT = 0;
  sfx('parry', def.x);
  popText(def.x, def.y - 60, 'PARRY', C.PNK2);
  burst(def.x + def.dir * 8, def.y - 30, 16, 90, 0.4, R_PINK, 0, 2);
  game.hitstop = Math.max(game.hitstop, 8);
  if (src === SRC_PROJ) {
    def.energy = Math.min(100, def.energy + 15);
    if (def.move && def.phase === PH_AC) enterRecovery(def, att);
    return;
  }
  burst(def.x, def.y - 24, 10, 50, 0.3, R_PINK, 0, 1);
  def.x = clamp(att.x - att.dir * 22, 14, STAGE_W - 14);
  def.dir = att.x >= def.x ? 1 : -1;
  if (def.move && def.phase === PH_AC) enterRecovery(def, att);
  resolveHit(def, att, SPEC_RIPOSTE, SRC_ZONE, null, def.x);
}

/* ---------- Status effects ---------- */
function addStatus(f, id, dur, stacks, src) {
  if (f.hp <= 0) return;
  const info = ST_INFO[id];
  if (f.st[id] < dur) f.st[id] = dur;
  f.stk[id] = info.max > 1 ? Math.min(info.max, f.stk[id] + stacks) : 1;
  if (id === ST_BLEED && f.stk[id] >= 5) {
    f.stk[id] = 0; f.st[id] = 0;
    dotHit(f, 80, src);
    popText(f.x, f.y - 60, 'BLEED BURST', C.PNK2);
    burst(f.x, f.y - 26, 20, 80, 0.5, R_PINK, 120, 2);
  } else if (id === ST_FREEZE) {
    interruptMove(f); setState(f, S_STUN); f.stun = Math.round(dur * 60); f.vx = 0;
  } else if (id === ST_CLOAK) {
    burst(f.x, f.y - 24, 16, 50, 0.5, R_PURP, 0, 1);
  }
}

function addHeat(f, n) {
  f.heat += n;
  if (f.heat >= 100) {
    f.heat = 0;
    addStatus(f, ST_OVERHEAT, 4, 1, f);
    popText(f.x, f.y - 70, 'OVERHEAT', C.RED2);
    sfx('skill', f.x);
    burst(f.x, f.y - 24, 20, 80, 0.5, R_FIRE, -40, 2);
  }
}

function dotHit(f, d, src) {
  if (f.hp <= 0) return;
  f.hp -= d; f.trailWait = 20;
  if (f.hp <= 0) {
    f.hp = 0;
    if (game.phase === 'fight') { interruptMove(f); setState(f, S_AIRHIT); f.onGround = false; f.vy = -3; f.vx = -f.dir * 1.5; }
  }
}

function updateStatuses(f, o) {
  for (let i = 0; i < NST; i++) {
    if (f.st[i] <= 0) continue;
    f.st[i] -= DT;
    if (f.st[i] <= 0) {
      f.st[i] = 0; f.stk[i] = 0;
      if (i === ST_SHIELD) f.shieldHP = 0;
      if (i === ST_FREEZE && f.state === S_STUN) { f.stun = 0; setState(f, f.onGround ? S_IDLE : S_JUMP); }
    }
  }
  let dps = 0;
  if (f.st[ST_BURN] > 0) dps += 6 * f.stk[ST_BURN];
  if (f.st[ST_POISON] > 0) dps += 7;
  if (f.st[ST_BLEED] > 0) dps += 3 * f.stk[ST_BLEED];
  if (dps > 0 && f.hp > 0) {
    f.dotAcc += dps * DT;
    if (f.dotAcc >= 5) {
      const d = Math.floor(f.dotAcc);
      f.dotAcc -= d;
      dotHit(f, d, o);
      popNum(f.x + randRange(-8, 8), f.y - 44, d, C.ORG2);
      if (f.st[ST_POISON] > 0 && o.def.id === 'viper') o.meter = Math.min(METER_MAX, o.meter + d * 0.8);
    }
  } else f.dotAcc = 0;
  if (f.st[ST_SHOCK] > 0) {
    f.shockClock += DT;
    if (f.shockClock >= 0.8) { f.shockClock = 0; f.jolt = 8; burst(f.x, f.y - 24, 6, 50, 0.25, R_ELEC, 0, 1); }
  } else f.shockClock = 0;
  if (f.jolt > 0) f.jolt--;

  if ((game.tick & 3) === 0) {
    const s = f.look.scale;
    if (f.st[ST_BURN] > 0) spawn(f.x + randRange(-6, 6), f.y - randRange(6, 40) * s, randRange(-6, 6), -randRange(20, 45), 0.5, R_FIRE, -20, 1, 1);
    if (f.st[ST_POISON] > 0) spawn(f.x + randRange(-7, 7), f.y - randRange(4, 36) * s, 0, -randRange(8, 20), 0.7, R_PURP, 0, 1, 1);
    if (f.st[ST_BLEED] > 0) spawn(f.x + randRange(-5, 5), f.y - randRange(16, 34) * s, randRange(-10, 10), 0, 0.6, R_PINK, 220, 0.5, 1);
    if (f.st[ST_HACK] > 0) spawn(f.x + randRange(-8, 8), f.y - 50 * s - randRange(0, 6), 0, -10, 0.4, R_HACK, 0, 1, 1);
    if (f.st[ST_OVERCHARGE] > 0) spawn(f.x + randRange(-8, 8), f.y - randRange(4, 44) * s, randRange(-20, 20), randRange(-20, 20), 0.2, R_ELEC, 0, 2, 1);
    if (f.st[ST_OVERHEAT] > 0) spawn(f.x + randRange(-8, 8), f.y - randRange(4, 44) * s, 0, -30, 0.5, R_FIRE, -30, 1, 1);
  }
}

/* Passivity: time spent neither attacking nor moving toward the opponent builds
   passiveT; being hit or pressured pauses it. Level 1 (PASSIVE_LV1 s): +15%
   damage taken, half energy regen, super drains to the opponent. Level 2
   (PASSIVE_LV2 s): +30% damage taken and a slow health drain that never kills. */
function updatePassivity(f, o) {
  if (f.hp <= 0) return;
  const s = f.state;
  if (s === S_HITSTUN || s === S_AIRHIT || s === S_DOWN || s === S_GETUP || s === S_STUN || s === S_BLOCKSTUN || s === S_KO || f.st[ST_FREEZE] > 0) return;
  const toward = o.x >= f.x ? 1 : -1;
  const active = s === S_ATTACK || ((s === S_WALK || s === S_JUMP) && f.vx * toward > 0.2) || (s === S_DASH && f.dashDir === toward);
  if (active) f.passiveT = Math.max(0, f.passiveT - DT * 2);
  else f.passiveT += DT;
  const lv = f.passiveT >= PASSIVE_LV2 ? 2 : f.passiveT >= PASSIVE_LV1 ? 1 : 0;
  if (lv > f.passiveLv) {
    popText(f.x, f.y - 66, lv === 2 ? 'NEGATIVE PENALTY' : 'PASSIVE', C.RED2);
    sfx('guardbreak', f.x);
  }
  f.passiveLv = lv;
  if (lv >= 1) {
    f.meter = Math.max(0, f.meter - 10 * DT);
    o.meter = Math.min(METER_MAX, o.meter + 6 * DT);
  }
  if (lv === 2) {
    f.passiveDrain += 6 * DT;
    if (f.passiveDrain >= 1) {
      const d = Math.floor(f.passiveDrain);
      f.passiveDrain -= d;
      if (f.hp - d >= 1) { f.hp -= d; f.trailWait = 10; }
    }
  }
}

function updateResources(f, o) {
  let regen = 10;
  if (f.st[ST_POISON] > 0) regen *= 0.5;
  if (f.st[ST_OVERCHARGE] > 0) regen *= 2;
  if (f.def.id === 'glitch') regen += 3 * countDebuffs(o);
  if (f.passiveLv > 0) regen *= 0.5;
  f.energy = Math.min(100, f.energy + regen * DT);
  if (f.state !== S_BLOCK && f.state !== S_BLOCKSTUN) f.guard = Math.min(100, f.guard + 14 * DT);
  for (let i = 0; i < NACT; i++) if (f.cds[i] > 0) f.cds[i] = Math.max(0, f.cds[i] - DT);
  if (f.dashCd > 0) f.dashCd -= DT;
}

function updateTimers(f) {
  if (f.invT > 0) f.invT--;
  if (f.parryT > 0) f.parryT--;
  if (f.flashT > 0) f.flashT--;
  if (f.showComboT > 0) f.showComboT--;
  if (f.trailWait > 0) f.trailWait--;
  else if (f.trail > f.hp) f.trail = Math.max(f.hp, f.trail - 4);
  if (f.trail < f.hp) f.trail = f.hp;
  const s = f.state;
  if (s !== S_HITSTUN && s !== S_AIRHIT && s !== S_STUN && s !== S_DOWN && s !== S_GETUP && s !== S_BLOCKSTUN && s !== S_KO) {
    f.comboHits = 0; f.comboDmg = 0; f.juggle = 0; f.juggleImmune = false;
  }
}

/* ---------- Special move behaviours (referenced from fight-data.js) ---------- */
function teleportBehind(f, o) {
  burst(f.x, f.y - 24, 12, 60, 0.4, R_PINK, 0, 1);
  const side = f.x < o.x ? 1 : -1;
  let nx = o.x + side * 24;
  if (nx < 14 || nx > STAGE_W - 14) nx = o.x - side * 24;
  f.x = clamp(nx, 14, STAGE_W - 14);
  f.dir = o.x >= f.x ? 1 : -1;
  f.invT = 10;
  sfx('dash', f.x);
  burst(f.x, f.y - 24, 12, 60, 0.4, R_PINK, 0, 1);
}

function tickThousandCuts(f, o) {
  const m = f.move;
  if (!f.cutOn) {
    if (f.phaseT <= 14) {
      f.vx = f.dir * 8;
      moveBox(f, m.hb);
      if (!isInvuln(o, SRC_MELEE) && boxHitsFighter(o, BX0, BY0, BX1, BY1)) {
        f.cutOn = 1; f.cutN = 0; f.cutT = 0; f.vx = 0; o.vx = 0;
        interruptMove(o); setState(o, S_STUN); o.stun = 96;
        game.hitstop = 8;
      }
    } else { f.vx = 0; enterRecovery(f, o); }
    return;
  }
  f.vx = 0; f.cutT++;
  if (f.cutT % 8 === 0 && f.cutN < 8) {
    f.cutN++;
    f.x = clamp(o.x + ((f.cutN & 1) ? 1 : -1) * 22, 14, STAGE_W - 14);
    f.dir = o.x >= f.x ? 1 : -1;
    resolveHit(f, o, SPEC_CUT, SRC_ZONE, m, f.x);
    burst(o.x, o.y - 26, 8, 110, 0.3, R_PINK, 0, 2);
  }
  if (f.cutT >= 72) {
    resolveHit(f, o, SPEC_CUT_END, SRC_ZONE, m, f.x);
    startShake(12);
    f.cutOn = 0;
    enterRecovery(f, o);
  }
}

function tickMagnet(f, o) {
  if (f.phaseT !== 1) return;
  const dx = (o.x - f.x) * f.dir;
  f.beamLen = 150;
  if (dx > 0 && dx <= 150 && o.onGround && !isInvuln(o, SRC_PROJ)) {
    f.beamLen = dx;
    const r = resolveHit(f, o, SPEC_PULL, SRC_PROJ, f.move, f.x);
    if (r === HIT_HIT && o.hp > 0) {
      interruptMove(o);
      o.x = clamp(f.x + f.dir * 22, 14, STAGE_W - 14);
      setState(o, S_STUN); o.stun = 30; o.vx = 0;
      burst(o.x, o.y - 26, 12, 60, 0.4, R_GOLD, 0, 1);
    }
  }
}

function tickOrbitalDrop(f, o) {
  const t = f.phaseT;
  if (t === 1) { f.vy = -10; f.vx = 0; f.onGround = false; burst(f.x, GROUND, 16, 80, 0.5, R_DUST, 60, 2); startShake(6); }
  else if (t > 1 && t < 22) { f.vy += 0.15; }
  else if (t === 22) { f.x = clamp(o.x, 14, STAGE_W - 14); f.y = -70; f.vy = 0; f.vx = 0; }
  else if (t > 22 && t < 46) { f.vy = 0; f.x += (clamp(o.x, 14, STAGE_W - 14) - f.x) * 0.06; }
  else if (t === 46) { f.vy = 13; }
  if (t >= f.move.ac - 2 && !f.onGround) f.phaseT = f.move.ac - 3;
}

function landDrop(f, o) {
  startShake(18);
  sfx('quake', f.x);
  burst(f.x, GROUND - 2, 34, 140, 0.7, R_GOLD, 120, 2);
  burst(f.x, GROUND - 2, 20, 90, 0.8, R_DUST, 60, 2);
  if (Math.abs(o.x - f.x) < 54 && o.y > GROUND - 40) resolveHit(f, o, SPEC_DROP, SRC_MELEE, f.move, f.x);
  if (f.move) enterRecovery(f, o);
}

function leechHit(f, o) {
  const d = Math.min(30, o.energy);
  o.energy -= d;
  f.energy = Math.min(100, f.energy + d);
  heal(f, 60);
}

function systemCrash(f, o) {
  game.glitchT = 40;
  startShake(10);
  sfx('crash', o.x);
  resolveHit(f, o, SPEC_CRASH, SRC_ZONE, f.move, f.x);
}

function ventHeat(f, o) {
  for (let i = 0; i < NST; i++) if (ST_INFO[i].debuff && i !== ST_FREEZE) { f.st[i] = 0; f.stk[i] = 0; }
  heal(f, 40 + 30 * o.stk[ST_BURN]);
  burst(f.x, f.y - 24, 26, 110, 0.6, R_STEAM, -30, 2);
  if (Math.abs(o.x - f.x) < 46) resolveHit(f, o, SPEC_VENT, SRC_MELEE, f.move, f.x);
}

function tryBurst(f, o) {
  if (!burstReady(f)) return false;
  f.meter -= BURST_COST; f.cds[A_BURST] = 12;
  interruptMove(f);
  f.invT = 26; f.comboHits = 0; f.vx = 0;
  if (f.onGround) setState(f, S_IDLE); else { setState(f, S_JUMP); f.vy = Math.min(f.vy, -1); }
  if (!isInvuln(o, SRC_ZONE)) {
    interruptMove(o); setState(o, S_AIRHIT); o.onGround = false; o.vy = -3.5; o.vx = (o.x >= f.x ? 1 : -1) * 4.5;
  }
  burst(f.x, f.y - 24, 34, 150, 0.5, R_GOLD, 0, 2);
  popText(f.x, f.y - 62, 'BURST', C.YEL2);
  sfx('burst', f.x);
  startShake(10);
  aiNotify(o, 5);
  return true;
}

/* ---------- Control (human keyboard and CPU executor share f.input) ---------- */
function control(f, o) {
  const inp = f.input;
  if (inp.actT > 0) { inp.actT--; if (inp.actT === 0) inp.act = 0; }
  if (inp.jump > 0) inp.jump--;
  if (inp.dash > 0) inp.dash--;
  if (inp.act === A_BURST) { tryBurst(f, o); inp.act = 0; inp.actT = 0; return; }
  if (f.st[ST_FREEZE] > 0) return;
  const st = f.state;
  if (st === S_ATTACK) {
    if (inp.act && f.hitConfirmed && f.phase !== PH_SU) {
      const m = f.moves[inp.act];
      if (m && m.level > f.move.level && canUse(f, o, m) && (f.onGround || m.air)) {
        interruptMove(f); startMove(f, o, m); inp.act = 0; inp.actT = 0;
      }
    }
    return;
  }
  if (!(st === S_IDLE || st === S_WALK || st === S_BLOCK || st === S_JUMP)) return;
  if (f.jolt > 0) { if (f.onGround) f.vx = 0; return; }
  if (inp.act) {
    const m = f.moves[inp.act];
    if (m && canUse(f, o, m) && (f.onGround || m.air)) { startMove(f, o, m); inp.act = 0; inp.actT = 0; return; }
  }
  if (st === S_JUMP) return;
  const mvDir = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
  if (inp.jump) {
    inp.jump = 0;
    f.vy = JUMP_VY * (f.st[ST_SLOW] > 0 ? 0.8 : 1);
    f.vx = mvDir * JUMP_VX * (speedOf(f) / f.def.speed);
    f.onGround = false;
    setState(f, S_JUMP);
    sfx('jump', f.x);
    burst(f.x, GROUND, 4, 30, 0.3, R_DUST, 40, 1);
    return;
  }
  if (inp.dash && f.energy >= 10 && f.dashCd <= 0) {
    inp.dash = 0;
    f.energy -= 10; f.dashCd = 0.45; f.dashDir = mvDir !== 0 ? mvDir : f.dir;
    setState(f, S_DASH);
    sfx('dash', f.x);
    burst(f.x, GROUND, 6, 40, 0.3, R_DUST, 40, 1);
    return;
  }
  if (inp.block) { if (st !== S_BLOCK) setState(f, S_BLOCK); f.vx = 0; return; }
  if (mvDir !== 0) {
    if (st !== S_WALK) setState(f, S_WALK);
    const back = mvDir !== f.dir;
    f.walkSign = back ? -1 : 1;
    f.vx = mvDir * speedOf(f) * (back ? 0.8 : 1);
  } else {
    if (st !== S_IDLE) setState(f, S_IDLE);
    f.vx = 0;
  }
}

function updateFighter(f, o) {
  f.stateT++;
  switch (f.state) {
    case S_ATTACK: tickMove(f, o); break;
    case S_DASH:
      f.vx = f.dashDir * Math.max(0, 6 - f.stateT * 0.35) * (speedOf(f) / f.def.speed);
      if (f.stateT >= 14) setState(f, S_IDLE);
      break;
    case S_HITSTUN: case S_BLOCKSTUN: case S_STUN:
      if (f.onGround) f.vx *= 0.82;
      if (f.st[ST_FREEZE] > 0) break;
      f.stun--;
      if (f.stun <= 0) {
        if (!f.onGround) setState(f, S_JUMP);
        else setState(f, f.state === S_BLOCKSTUN && f.input.block ? S_BLOCK : S_IDLE);
      }
      break;
    case S_DOWN:
      f.vx *= 0.8;
      if (f.stateT >= 34) setState(f, S_GETUP);
      break;
    case S_GETUP:
      if (f.stateT >= 16) { setState(f, S_IDLE); f.invT = 8; }
      break;
    case S_KO: case S_WIN: f.vx *= 0.8; break;
  }
}

function physics(f, o) {
  const noGrav = f.state === S_ATTACK && f.move && f.move.noGrav && f.phase === PH_AC;
  const frozen = f.st[ST_FREEZE] > 0;
  if (frozen) f.vx = 0;
  if (!f.onGround && !noGrav) { f.vy += GRAV; if (f.vy > 9) f.vy = 9; }
  f.x += f.vx; f.y += f.vy;
  if (!f.onGround && f.y >= GROUND) land(f, o);
  if (f.onGround) { f.y = GROUND; f.vy = 0; }
  if (f.x < 14) f.x = 14; else if (f.x > STAGE_W - 14) f.x = STAGE_W - 14;
}

function land(f, o) {
  f.y = GROUND; f.vy = 0; f.onGround = true;
  switch (f.state) {
    case S_AIRHIT:
      f.vx *= 0.3;
      setState(f, f.hp <= 0 ? S_KO : S_DOWN);
      sfx('land', f.x);
      burst(f.x, GROUND, 10, 50, 0.4, R_DUST, 60, 1);
      startShake(4);
      break;
    case S_JUMP: setState(f, S_IDLE); f.vx = 0; break;
    case S_ATTACK:
      if (f.move && f.move.id === 'orbital_drop') { landDrop(f, o); break; }
      if (f.move && (f.move.air || f.phase === PH_RE)) { f.vx = 0; endMove(f); }
      break;
  }
}

function separate(a, b) {
  const ghost = (a.state === S_ATTACK && a.move && a.move.ghost) || (b.state === S_ATTACK && b.move && b.move.ghost);
  const dx = b.x - a.x;
  if (!ghost && Math.abs(a.y - b.y) < 40 && a.state !== S_KO && b.state !== S_KO) {
    const min = 8 * (a.look.scale + b.look.scale);
    const ad = Math.abs(dx);
    if (ad < min) {
      const sgn = dx === 0 ? (a.dir > 0 ? 1 : -1) : (dx > 0 ? 1 : -1);
      const push = (min - ad) / 2;
      a.x -= sgn * push; b.x += sgn * push;
      if (a.x < 14) { b.x += 14 - a.x; a.x = 14; }
      if (b.x < 14) { a.x += 14 - b.x; b.x = 14; }
      if (a.x > STAGE_W - 14) { b.x -= a.x - (STAGE_W - 14); a.x = STAGE_W - 14; }
      if (b.x > STAGE_W - 14) { a.x -= b.x - (STAGE_W - 14); b.x = STAGE_W - 14; }
    }
  }
  const sep = Math.abs(b.x - a.x);
  if (sep > SEP_MAX) {
    const ex = sep - SEP_MAX, sg = b.x > a.x ? 1 : -1;
    const aAway = a.vx * -sg > 0, bAway = b.vx * sg > 0;
    if (aAway && !bAway) a.x += sg * ex;
    else if (bAway && !aAway) b.x -= sg * ex;
    else { a.x += sg * ex / 2; b.x -= sg * ex / 2; }
  }
}

function faceOpponent(f, o) {
  if (!f.onGround) return;
  if (f.state === S_IDLE || f.state === S_WALK || f.state === S_BLOCK || f.state === S_GETUP) {
    if (Math.abs(o.x - f.x) > 1) f.dir = o.x >= f.x ? 1 : -1;
  }
}

function updatePose(f) {
  f.twT++;
  const t = clamp01(f.twT / f.twDur), e = f.twEase(t);
  if (f.st[ST_FREEZE] <= 0) for (let i = 0; i < POSE_N; i++) f.pose[i] = lerp(f.from[i], f.tgt[i], e);
  if (f.state === S_WALK) {
    f.walkPh += 0.2 * (speedOf(f) / 1.5);
    const sw = Math.sin(f.walkPh) * f.walkSign, cw = Math.cos(f.walkPh);
    f.pose[8] = -7 + sw * 5; f.pose[10] = 7 - sw * 5;
    f.pose[9] = cw > 0 ? cw * 3 : 0; f.pose[11] = cw < 0 ? -cw * 3 : 0;
    f.pose[1] = 1 + Math.abs(sw);
    f.pose[4] = 25 - sw * 12; f.pose[6] = 50 + sw * 10;
  } else if (f.state === S_IDLE || f.state === S_BLOCK) {
    f.pose[1] += (game.animFrame >> 2) & 1;
  } else if (f.state === S_JUMP && !f.tucked && f.vy > -1.5) {
    f.tucked = true; tween(f, PO.TUCK, 6, easeOutQuad);
  } else if (f.state === S_STUN && f.st[ST_FREEZE] <= 0) {
    f.pose[3] = -10 + ((game.animFrame >> 1) & 1) * 8;
  }
  if (game.animFrame !== f.lastAnim || f.forceShow) {
    f.lastAnim = game.animFrame; f.forceShow = false;
    f.shown.set(f.pose);
  }
}

/* ---------- Projectiles ---------- */
const projs = [];
for (let i = 0; i < MAX_PROJ; i++) projs.push({ on: false, owner: 0, kind: 0, x: 0, y: 0, vx: 0, vy: 0, g: 0, w: 0, h: 0, life: 0, age: 0, dir: 1, spec: null, move: null, ground: false });
function freeProj() { for (let i = 0; i < MAX_PROJ; i++) if (!projs[i].on) return projs[i]; return projs[0]; }
function spawnProj(f, m) {
  const p = freeProj(), d = m.proj;
  p.on = true; p.owner = f.side; p.kind = d.kind; p.dir = f.dir;
  p.x = f.x + f.dir * d.x; p.y = f.y - d.y; p.vx = f.dir * d.vx; p.vy = d.vy; p.g = d.g;
  p.w = d.w; p.h = d.h; p.life = d.life; p.age = 0; p.spec = m.h; p.move = m; p.ground = !!d.ground;
  if (p.ground) p.y = GROUND - p.h / 2;
  sfx(PROJ_SFX[p.kind], p.x);
  aiNotify(opp(f), 6);
}
function spawnBullet(f, x, y, tx, ty) {
  const p = freeProj();
  const dx = tx - x, dy = ty - y, d = Math.sqrt(dx * dx + dy * dy) || 1;
  p.on = true; p.owner = f.side; p.kind = K_BULLET; p.dir = dx >= 0 ? 1 : -1;
  p.x = x; p.y = y; p.vx = dx / d * 4.5; p.vy = dy / d * 4.5; p.g = 0; p.w = 5; p.h = 4; p.life = 120; p.age = 0;
  p.spec = SPEC_BULLET; p.move = null; p.ground = false;
  sfx('bullet', x);
}
function projOverlap(p, x0, y0, x1, y1) {
  return p.x - p.w / 2 < x1 && p.x + p.w / 2 > x0 && p.y - p.h / 2 < y1 && p.y + p.h / 2 > y0;
}
function explodeGrenade(p) {
  spawnZone(Z_FIRE, game.fighters[p.owner], p.x, GROUND, 52, 12, 180, 0);
  burst(p.x, GROUND - 4, 22, 110, 0.5, R_FIRE, 60, 2);
  sfx('explode', p.x);
  startShake(5);
}
function updateProjectiles() {
  for (let i = 0; i < MAX_PROJ; i++) {
    const p = projs[i];
    if (!p.on) continue;
    p.age++; p.life--;
    p.x += p.vx; p.y += p.vy; p.vy += p.g;
    if (p.ground) p.y = GROUND - p.h / 2;
    if (p.life <= 0 || p.x < -30 || p.x > STAGE_W + 30) { p.on = false; continue; }
    if (!p.ground && p.y + p.h / 2 >= GROUND) {
      if (p.kind === K_GRENADE) explodeGrenade(p);
      else burst(p.x, GROUND - 2, 6, 40, 0.3, p.spec.spark, 60, 1);
      p.on = false; continue;
    }
    let blocked = false;
    for (let k = 0; k < MAX_ZONES; k++) {
      const z = zones[k];
      if (!z.on || z.kind !== Z_WALL || z.owner === p.owner || z.delay > 0) continue;
      if (Math.abs(p.x - z.x) < z.w / 2 + p.w / 2 && p.y > z.y - z.h) { blocked = true; break; }
    }
    if (blocked) { burst(p.x, p.y, 10, 60, 0.3, R_HACK, 0, 1); p.on = false; continue; }
    for (let k = i + 1; k < MAX_PROJ; k++) {
      const q = projs[k];
      if (!q.on || q.owner === p.owner || q.ground || p.ground) continue;
      if (projOverlap(p, q.x - q.w / 2, q.y - q.h / 2, q.x + q.w / 2, q.y + q.h / 2)) {
        burst((p.x + q.x) / 2, (p.y + q.y) / 2, 14, 90, 0.35, R_SPARK, 0, 1);
        p.on = false; q.on = false; break;
      }
    }
    if (!p.on) continue;
    const a = game.fighters[p.owner], e = game.fighters[1 - p.owner];
    if (boxHitsFighter(e, p.x - p.w / 2, p.y - p.h / 2, p.x + p.w / 2, p.y + p.h / 2)) {
      const r = resolveHit(a, e, p.spec, SRC_PROJ, p.move, p.x);
      if (r !== HIT_MISS) {
        if (p.kind === K_GRENADE) explodeGrenade(p);
        p.on = false; continue;
      }
    }
    switch (p.kind) {
      case K_BOLT: if (p.age & 1) spawn(p.x - p.dir * 6, p.y + randRange(-2, 2), -p.dir * 20, randRange(-15, 15), 0.25, R_ELEC, 0, 2, 1); break;
      case K_WAVE: if (p.age & 1) spawn(p.x - p.dir * 3, p.y + randRange(-10, 10), -p.dir * 15, 0, 0.3, R_PINK, 0, 2, 1); break;
      case K_HACK: if ((p.age & 3) === 0) spawn(p.x, p.y + randRange(-4, 4), -p.dir * 10, randRange(-10, 10), 0.4, R_HACK, 0, 1, 1); break;
      case K_SPIT: if ((p.age & 3) === 0) spawn(p.x, p.y + 2, 0, 20, 0.4, R_TOX, 120, 1, 1); break;
      case K_GRENADE: if ((p.age & 3) === 0) spawn(p.x, p.y, 0, -10, 0.5, R_SMOKE, -10, 1, 1); break;
      case K_QUAKE: if (p.age & 1) spawn(p.x + randRange(-6, 6), GROUND - 2, randRange(-20, 20), -randRange(30, 70), 0.4, R_DUST, 200, 1, 1); break;
    }
  }
}

/* ---------- Zones (fields, fire, clouds, walls, drones, strikes, columns) ---------- */
const zones = [];
for (let i = 0; i < MAX_ZONES; i++) zones.push({ on: false, kind: 0, owner: 0, x: 0, y: 0, w: 0, h: 0, life: 0, delay: 0, t: 0, eSide: 1 });
function spawnZone(kind, f, x, y, w, h, life, delay) {
  if (kind === Z_DRONE || kind === Z_FIELD) for (let i = 0; i < MAX_ZONES; i++) if (zones[i].on && zones[i].kind === kind && zones[i].owner === f.side) zones[i].on = false;
  let z = zones[0];
  for (let i = 0; i < MAX_ZONES; i++) if (!zones[i].on) { z = zones[i]; break; }
  const e = opp(f);
  z.on = true; z.kind = kind; z.owner = f.side; z.x = clamp(x, 8, STAGE_W - 8); z.y = y; z.w = w; z.h = h;
  z.life = life; z.delay = delay; z.t = 0;
  if (kind === Z_STRIKE && delay === 0) z.x = e.x;
  z.eSide = e.x >= z.x ? 1 : -1;
  if (kind === Z_WALL && Math.abs(e.x - z.x) < 10) z.eSide = f.dir;
  return z;
}
function zoneHits(z, e) {
  return boxHitsFighter(e, z.x - z.w / 2, z.y - z.h, z.x + z.w / 2, z.y);
}
function updateZones() {
  for (let i = 0; i < MAX_ZONES; i++) {
    const z = zones[i];
    if (!z.on) continue;
    const owner = game.fighters[z.owner], e = game.fighters[1 - z.owner];
    if (z.delay > 0) { z.delay--; if (z.delay === 0 && z.kind === Z_STRIKE) z.x = e.x; continue; }
    z.t++;
    switch (z.kind) {
      case Z_FIELD:
        z.x = owner.x; z.y = owner.y;
        if (z.t % 30 === 0 && zoneHits(z, e)) resolveHit(owner, e, SPEC_FIELD, SRC_ZONE, null, z.x);
        break;
      case Z_FIRE:
        if (z.t % 20 === 0 && zoneHits(z, e)) resolveHit(owner, e, SPEC_FIRE, SRC_ZONE, null, z.x);
        if ((z.t & 3) === 0) spawn(z.x + randRange(-z.w / 2, z.w / 2), GROUND - 2, 0, -randRange(20, 40), 0.5, R_FIRE, -20, 1, 1);
        break;
      case Z_CLOUD:
        if (z.t % 30 === 0 && zoneHits(z, e)) resolveHit(owner, e, SPEC_CLOUD, SRC_ZONE, null, z.x);
        break;
      case Z_WALL:
        if (e.y > z.y - z.h) {
          const lim = z.w / 2 + 8 * e.look.scale;
          if ((e.x - z.x) * z.eSide < lim) e.x = z.x + z.eSide * lim;
        }
        break;
      case Z_DRONE:
        z.x += (owner.x - owner.dir * 14 - z.x) * 0.08;
        z.y = owner.y - 62 + Math.sin(z.t * 0.1) * 3;
        if (z.t % 60 === 30 && e.hp > 0) spawnBullet(owner, z.x, z.y, e.x, e.y - 26);
        break;
      case Z_STRIKE:
        if (z.t < 22) z.x += (e.x - z.x) * 0.05;
        if (z.t === 22) {
          if (zoneHits(z, e)) resolveHit(owner, e, SPEC_STRIKE, SRC_ZONE, null, z.x);
          startShake(5);
          sfx('zap', z.x);
          burst(z.x, GROUND - 2, 16, 100, 0.4, R_ELEC, 80, 2);
        }
        break;
      case Z_COLUMN:
        if (z.t === 12) {
          if (zoneHits(z, e)) resolveHit(owner, e, SPEC_COLUMN, SRC_ZONE, null, z.x);
          burst(z.x, GROUND - 4, 10, 80, 0.5, R_FIRE, -40, 2);
          sfx('fire', z.x);
          startShake(3);
        }
        break;
    }
    z.life--;
    if (z.life <= 0) z.on = false;
  }
}

/* ---------- Popups ---------- */
const pops = [];
for (let i = 0; i < MAX_POP; i++) pops.push({ on: false, x: 0, y: 0, t: 0, life: 0, str: '', num: -1, col: 0 });
function freePop() {
  let best = pops[0];
  for (let i = 0; i < MAX_POP; i++) { if (!pops[i].on) return pops[i]; if (pops[i].t > best.t) best = pops[i]; }
  return best;
}
function popText(x, y, str, col) { const p = freePop(); p.on = true; p.x = x; p.y = y; p.t = 0; p.life = 60; p.str = str; p.num = -1; p.col = col; }
function popNum(x, y, n, col) { const p = freePop(); p.on = true; p.x = x; p.y = y; p.t = 0; p.life = 40; p.str = ''; p.num = n; p.col = col; }
function updatePops() {
  for (let i = 0; i < MAX_POP; i++) {
    const p = pops[i];
    if (!p.on) continue;
    p.t++; p.y -= p.num >= 0 ? 0.5 : 0.25;
    if (p.t >= p.life) p.on = false;
  }
}

/* ---------- Round flow ---------- */
function clearPools() {
  for (let i = 0; i < MAX_PROJ; i++) projs[i].on = false;
  for (let i = 0; i < MAX_ZONES; i++) zones[i].on = false;
  for (let i = 0; i < MAX_POP; i++) pops[i].on = false;
  clearParticles();
}

function announce(str, frames, col) {
  game.announce = str; game.announceT = frames; game.announceCol = col;
  sfx(str === 'FIGHT!' ? 'fight' : str === 'K.O.' ? 'ko' : str === 'TIME' || str === 'DRAW' ? 'round' : str.endsWith('WINS') || str === 'PERFECT' ? 'win' : 'round');
}

function setupFighters(defA, defB, cpuA, cpuB) {
  const a = makeFighter(0, defA, false), b = makeFighter(1, defB, defA === defB);
  a.cpu = cpuA; b.cpu = cpuB;
  game.fighters[0] = a; game.fighters[1] = b;
  resetFighter(a, STAGE_W / 2 - 70, false); resetFighter(b, STAGE_W / 2 + 70, false);
  game.camX = (STAGE_W - W) / 2;
  return [a, b];
}

function startMatch(defA, defB, cpuA, cpuB) {
  game.matchId++;
  setupFighters(defA, defB, cpuA, cpuB);
  game.round = 1; game.winner = -1;
  startRound();
}

function startRound() {
  clearPools();
  const a = game.fighters[0], b = game.fighters[1];
  resetFighter(a, STAGE_W / 2 - 70, game.round > 1);
  resetFighter(b, STAGE_W / 2 + 70, game.round > 1);
  game.camX = (STAGE_W - W) / 2;
  game.timer = ROUND_TIME; game.hitstop = 0; game.superT = 0; game.glitchT = 0;
  game.phase = 'intro'; game.phaseT = 0;
  announce(ROUND_LABELS[Math.min(game.round, ROUND_LABELS.length) - 1], 66, C.YEL2);
}
const ROUND_LABELS = ['ROUND 1', 'ROUND 2', 'ROUND 3', 'ROUND 4', 'FINAL ROUND'];

function endRound(timeUp) {
  const a = game.fighters[0], b = game.fighters[1];
  const ra = a.hp / a.hpMax, rb = b.hp / b.hpMax;
  game.winner = ra > rb ? 0 : rb > ra ? 1 : -1;
  game.phase = 'ko'; game.phaseT = 0;
  announce(timeUp ? 'TIME' : 'K.O.', 90, timeUp ? C.YEL2 : C.RED2);
  if (!timeUp) startShake(14);
  aiNotify(a, 0); aiNotify(b, 0);
}

function stepSim(controls) {
  const a = game.fighters[0], b = game.fighters[1];
  if (game.hitstop > 0) { game.hitstop--; return; }
  if (controls) {
    if (a.cpu) aiTick(a, b); else humanTick(a, b);
    if (b.cpu) aiTick(b, a);
    updateStatuses(a, b); updateStatuses(b, a);
    updateResources(a, b); updateResources(b, a);
    updatePassivity(a, b); updatePassivity(b, a);
    control(a, b); control(b, a);
  }
  updateTimers(a); updateTimers(b);
  updateFighter(a, b); updateFighter(b, a);
  physics(a, b); physics(b, a);
  separate(a, b);
  if (controls) { updateProjectiles(); updateZones(); }
  faceOpponent(a, b); faceOpponent(b, a);
  updatePose(a); updatePose(b);
  const target = clamp((a.x + b.x) / 2 - W / 2, 0, STAGE_W - W);
  game.camX += (target - game.camX) * 0.15;
}

function tickGame() {
  game.tick++;
  game.simTime += DT;
  game.animFrame = Math.floor(game.simTime * ANIM_FPS);
  updateParticles(DT);
  updateRain();
  updatePops();
  if (game.shakeT > 0) { game.shakeT--; game.shakeX = ((rand() * 3) | 0) - 1; game.shakeY = ((rand() * 3) | 0) - 1; }
  else { game.shakeX = 0; game.shakeY = 0; }
  if (game.glitchT > 0) game.glitchT--;
  if (game.superT > 0) game.superT--;
  if (game.announceT > 0) game.announceT--;
  const a = game.fighters[0], b = game.fighters[1];
  if (!a) return;
  game.phaseT++;
  switch (game.phase) {
    case 'attract':
    case 'matchend':
      stepSim(false);
      break;
    case 'intro':
      stepSim(false);
      if (game.phaseT === 70) announce('FIGHT!', 40, C.PNK2);
      if (game.phaseT >= 100) { game.phase = 'fight'; game.phaseT = 0; aiNotify(a, 0); aiNotify(b, 0); }
      break;
    case 'fight':
      stepSim(true);
      if (game.hitstop === 0 && game.superT === 0) game.timer -= DT;
      if (a.hp <= 0 || b.hp <= 0) endRound(false);
      else if (game.timer <= 0) { game.timer = 0; endRound(true); }
      break;
    case 'ko':
      if (game.phaseT > 50 || game.tick % 3 === 0) stepSim(false);
      if (game.phaseT >= 150) {
        game.phase = 'roundend'; game.phaseT = 0;
        if (game.winner >= 0) {
          const w = game.fighters[game.winner];
          w.wins++;
          if (w.onGround && w.hp > 0) { w.move = null; setState(w, S_WIN); }
          announce(w.hp >= w.hpMax ? 'PERFECT' : w.def.name + ' WINS', 110, w.look.eye);
        } else announce('DRAW', 110, C.CLO2);
      }
      break;
    case 'roundend':
      stepSim(false);
      if (game.phaseT >= 130) {
        const done = a.wins >= 2 || b.wins >= 2 || game.round >= 5;
        if (done) {
          game.phase = 'matchend'; game.phaseT = 0;
          game.winner = a.wins > b.wins ? 0 : b.wins > a.wins ? 1 : -1;
          if (game.onMatchEnd) game.onMatchEnd(game.winner);
        } else { game.round++; startRound(); }
      }
      break;
  }
}

/* ---------- Fighter rig rendering ---------- */
let IKX = 0, IKY = 0, IFX = 0, IFY = 0, HANDX = 0, HANDY = 0, FAANG = 0;
function ik2(hx, hy, fx, fy, l1, l2, dir) {
  let vx = fx - hx, vy = fy - hy;
  let d = Math.sqrt(vx * vx + vy * vy);
  const maxd = l1 + l2 - 0.01;
  if (d > maxd) { fx = hx + vx / d * maxd; fy = hy + vy / d * maxd; vx = fx - hx; vy = fy - hy; d = maxd; }
  if (d < 0.01) d = 0.01;
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const hh = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const ux = vx / d, uy = vy / d;
  const px = dir > 0 ? uy : -uy, py = dir > 0 ? -ux : ux;
  IKX = hx + ux * a + px * hh; IKY = hy + uy * a + py * hh; IFX = fx; IFY = fy;
}
function drawArm(sx, sy, a, e, dark, L, lw, ua, fa, d) {
  const a1 = a * DEG, a2 = (a + e) * DEG;
  const ex = sx + d * Math.sin(a1) * ua, ey = sy + Math.cos(a1) * ua;
  const hx = ex + d * Math.sin(a2) * fa, hy = ey + Math.cos(a2) * fa;
  const mech = L.gear === 'mech';
  const sleeve = dark ? DARKER[L.sleeve] : L.sleeve;
  const fore = mech ? (dark ? C.MET1 : C.MET2) : sleeve;
  const glove = dark ? DARKER[L.glove] : L.glove;
  const fw = mech ? lw + 1 : lw;
  if (!dark) { brush(sx, sy, ex, ey, lw + 2, C.INK); brush(ex, ey, hx, hy, fw + 2, C.INK); }
  brush(sx, sy, ex, ey, lw, sleeve);
  brush(ex, ey, hx, hy, fw, fore);
  if (mech) rect(hx - 2, hy - 2, 5, 5, glove); else rect(hx - 1, hy - 1, 3, 3, glove);
  HANDX = hx; HANDY = hy; FAANG = a + e;
}
function drawLeg(hx, hy, fx, fy, dark, L, lw, thigh, shin, d) {
  ik2(hx, hy, fx, fy, thigh, shin, d);
  const pants = dark ? DARKER[L.pants] : L.pants, boots = dark ? DARKER[L.boots] : L.boots;
  if (!dark) { brush(hx, hy, IKX, IKY, lw + 3, C.INK); brush(IKX, IKY, IFX, IFY, lw + 2, C.INK); }
  brush(hx, hy, IKX, IKY, lw + 1, pants);
  brush(IKX, IKY, IFX, IFY, lw, pants);
  brush(IFX - d, IFY - 1, IFX + d * 3, IFY - 1, 3, boots);
}

function drawFighter(f) {
  const L = f.look, s = L.scale, d = f.dir, Pp = f.shown;
  const thigh = 11 * s, shin = 11 * s, torso = 13 * s, ua = 8 * s, fa = 8 * s;
  const hr = s > 1.1 ? 5 : 4, lw = s > 1.1 ? 4 : 3;
  const jx = f.jolt > 0 ? ((game.tick & 2) ? 1 : -1) : 0;
  const rx = Math.round(f.x) + jx, ry = Math.round(f.y);
  const hipX = rx + d * Pp[0], hipY = ry - (thigh + shin) * 0.9 + Pp[1];
  const ln = Pp[2] * DEG, sl = Math.sin(ln), cl = Math.cos(ln);
  const shX = hipX + d * sl * torso, shY = hipY - cl * torso;
  const midX = hipX + d * sl * torso * 0.35, midY = hipY - cl * torso * 0.35;
  const ha = ln + Pp[3] * DEG;
  const hdX = shX + d * Math.sin(ha) * (hr + 1), hdY = shY - Math.cos(ha) * (hr + 1) - 1;

  useTarget(layer);
  if (L.gear === 'flamer') { const tx = shX - d * 6; rect(tx - 2, shY + 1, 5, 10, C.MET2); hline(tx - 2, shY + 4, 5, C.RED1); }
  if (L.style === 'ponytail') {
    const sway = (game.animFrame >> 2) & 1;
    brush(hdX - d * hr, hdY - 2, hdX - d * (hr + 5), hdY + 5 + sway, 2, L.hair);
  } else if (L.style === 'long') {
    brush(hdX - d * 2, hdY - 2, hdX - d * (hr + 2), hdY + 9, 4, L.hair);
  }
  drawArm(shX - d, shY + 1, Pp[4], Pp[5], true, L, lw, ua, fa, d);
  drawLeg(hipX - d, hipY, rx + d * Pp[8], ry - Pp[9], true, L, lw, thigh, shin, d);
  brush(hipX, hipY, midX, midY, Math.round(6 * s), L.pants);
  brush(midX, midY, shX, shY + 1, Math.round(7 * s), L.top);
  brush(shX, shY, hdX, hdY, 2, L.skin);
  if (L.style === 'hood') {
    circFill(hdX, hdY, hr + 1, L.hair);
    circFill(hdX + d, hdY + 1, hr - 1, L.skin);
  } else circFill(hdX, hdY, hr, L.skin);
  switch (L.style) {
    case 'spiky':
      rect(hdX - hr, hdY - hr, hr * 2 + 1, 2, L.hair);
      brush(hdX + d, hdY - hr, hdX - d * 3, hdY - hr - 4, 2, L.hair);
      brush(hdX - d * 2, hdY - hr, hdX - d * 6, hdY - hr - 2, 2, L.hair);
      brush(hdX - d * 3, hdY - hr + 2, hdX - d * 7, hdY - hr + 1, 2, L.hair);
      break;
    case 'ponytail': case 'long':
      rect(hdX - hr, hdY - hr, hr * 2 + 1, 2, L.hair);
      rect(d > 0 ? hdX - hr : hdX + hr - 1, hdY - hr, 2, hr + 1, L.hair);
      break;
    case 'mohawk':
      brush(hdX + d, hdY - hr - 2, hdX - d * 3, hdY - hr - 1, 2, L.hair);
      break;
    case 'bald':
      hline(hdX - hr, hdY - 2, hr * 2 + 1, C.ORG1);
      break;
  }
  if (L.gear === 'visor' || L.style === 'bald') rect(d > 0 ? hdX : hdX - 3, hdY - 1, 4, 1, L.eye);
  else pset(hdX + d * 2, hdY - 1, L.eye);
  drawLeg(hipX + d, hipY, rx + d * Pp[10], ry - Pp[11], false, L, lw, thigh, shin, d);
  drawArm(shX + d, shY + 1, Pp[6], Pp[7], false, L, lw, ua, fa, d);
  const fa2 = FAANG * DEG, sx = Math.sin(fa2) * d, cy = Math.cos(fa2);
  switch (L.gear) {
    case 'katana':
      line(HANDX - sx * 3, HANDY - cy * 3, HANDX, HANDY, C.HAI1);
      line(HANDX, HANDY, HANDX + sx * 16, HANDY + cy * 16, C.CLO2);
      line(HANDX, HANDY - 1, HANDX + sx * 15, HANDY + cy * 15 - 1, C.PNK2);
      break;
    case 'claws':
      for (let k = -1; k <= 1; k++) {
        const ca = (FAANG + k * 18) * DEG;
        line(HANDX, HANDY, HANDX + Math.sin(ca) * d * 5, HANDY + Math.cos(ca) * 5, C.GRN2);
      }
      break;
    case 'flamer':
      brush(HANDX, HANDY, HANDX + sx * 6, HANDY + cy * 6, 3, C.MET2);
      pset(HANDX + sx * 7, HANDY + cy * 7, C.ORG2);
      break;
    case 'gloves': pset(HANDX, HANDY, C.CYN2); break;
    case 'mech': pset(HANDX + d, HANDY, C.ORG2); break;
  }
  useTarget(fb);
  compositeFighter(rx + offX - 56, ry + offY - 92, rx + offX + 56, ry + offY + 6, f);
}

function compositeFighter(x0, y0, x1, y1, f) {
  if (x0 < 1) x0 = 1; if (y0 < 1) y0 = 1; if (x1 > W - 1) x1 = W - 1; if (y1 > H - 1) y1 = H - 1;
  if (x1 <= x0 || y1 <= y0) return;
  const cloak = f.st[ST_CLOAK] > 0;
  let tint = null;
  if (f.flashT > 0) tint = TINT_WHITE;
  else if (f.st[ST_FREEZE] > 0) tint = TINT_ICE;
  else if (f.jolt > 0 && (game.tick & 2)) tint = TINT_ICE;
  else if (f.st[ST_POISON] > 0 && game.animFrame % 6 === 0) tint = TINT_TOX;
  else if (f.st[ST_BURN] > 0 && game.animFrame % 5 === 0) tint = TINT_FIRE;
  const blink = (game.animFrame & 1) === 0;
  let oc = C.INK;
  const armorMove = f.state === S_ATTACK && f.move && f.move.armor && f.phase !== PH_RE;
  if (f.st[ST_ARMOR] > 0 || armorMove) oc = blink ? C.YEL1 : C.INK;
  else if (f.st[ST_OVERCHARGE] > 0) oc = blink ? C.CYN1 : C.CYN0;
  else if (f.st[ST_OVERHEAT] > 0) oc = blink ? C.ORG1 : C.RED0;
  else if (f.parryT > 0) oc = blink ? C.PNK2 : C.PNK0;
  else if (f.invT > 0 && (game.tick & 4)) oc = C.CLO1;
  const alt = f.alt;
  for (let y = y0; y < y1; y++) {
    const row = y * W;
    for (let x = x0; x < x1; x++) {
      const i = row + x, c = layer[i];
      if (c === 0) {
        if (layer[i - 1] || layer[i + 1] || layer[i - W] || layer[i + W]) {
          if (cloak) { if (BAYER4[((y & 3) << 2) | (x & 3)] < 3) fb[i] = C.SKY4; }
          else fb[i] = oc;
        }
        continue;
      }
      if (cloak) continue;
      let out = c;
      if (layer[i - W] === 0) out = LIGHTER[c]; else if (layer[i + W] === 0) out = DARKER[c];
      if (alt) out = ALT[out];
      if (tint) out = tint[out];
      fb[i] = out;
    }
  }
  for (let y = y0 - 1; y <= y1; y++) layer.fill(0, y * W + x0 - 1, y * W + x1 + 1);
}

/* ---------- Scene ---------- */
const FAR_N = 40, MID_N = 26, RAIN_N = 90;
const farX = new Int16Array(FAR_N), farW = new Uint8Array(FAR_N), farH = new Uint8Array(FAR_N);
const midX = new Int16Array(MID_N), midW = new Uint8Array(MID_N), midH = new Uint8Array(MID_N), midSign = new Int8Array(MID_N);
const rainX = new Float32Array(RAIN_N), rainY = new Float32Array(RAIN_N);
const SIGNS = ['RAMEN', 'HOTEL', '24H', 'NOODLE', 'BAR', 'SYNC'];
(function buildScene() {
  let x = -10;
  for (let i = 0; i < FAR_N; i++) { farX[i] = x; farW[i] = 12 + ((rand() * 18) | 0); farH[i] = 40 + ((rand() * 60) | 0); x += farW[i] + ((rand() * 4) | 0); }
  x = -20;
  for (let i = 0; i < MID_N; i++) {
    midX[i] = x; midW[i] = 26 + ((rand() * 26) | 0); midH[i] = 50 + ((rand() * 70) | 0);
    midSign[i] = rand() < 0.35 ? (i % SIGNS.length) : -1;
    x += midW[i] + 4 + ((rand() * 10) | 0);
  }
  for (let i = 0; i < RAIN_N; i++) { rainX[i] = rand() * (W + 40); rainY[i] = rand() * GROUND; }
})();

function updateRain() {
  for (let i = 0; i < RAIN_N; i++) {
    rainY[i] += 5.5; rainX[i] -= 1.4;
    if (rainY[i] >= GROUND + ((i * 7) % 18)) {
      rainY[i] = -((i * 13) % 40); rainX[i] = (hash3(i, game.tick, 3) * (W + 40)) | 0;
    }
  }
}
function drawRain() {
  for (let i = 0; i < RAIN_N; i++) {
    const x = rainX[i] | 0, y = rainY[i] | 0;
    pset(x, y, C.SKY4); pset(x - 1, y + 2, C.SKY3);
  }
}

const SKY_BANDS = new Uint8Array([C.SKY0, C.SKY1, C.SKY2, C.SKY3]);
function drawSky() {
  const bh = 34;
  for (let i = 0; i < 4; i++) rect(0, i * bh, W, i === 3 ? H : bh, SKY_BANDS[i]);
  for (let i = 0; i < 3; i++) { ditherRect(0, i * bh + bh - 6, W, 3, SKY_BANDS[i + 1], 4); ditherRect(0, i * bh + bh - 3, W, 3, SKY_BANDS[i + 1], 10); }
  const sx = 300 - Math.round(game.camX * 0.05), sy = 64;
  circFill(sx, sy, 22, C.PNK0);
  circFill(sx, sy, 18, C.PUR1);
  for (let y = sy + 2; y < sy + 23; y += 4) hline(sx - 24, y, 49, C.SKY3);
  hline(sx - 24, sy + 1, 49, C.SKY3);
}
function drawFar(cx) {
  setOffset(-Math.round(cx * 0.2), 0);
  const base = 170;
  for (let i = 0; i < FAR_N; i++) {
    const x = farX[i], w = farW[i], h = farH[i];
    rect(x, base - h, w, h + 20, C.BLD0);
    for (let wy = base - h + 3; wy < base; wy += 4) for (let wx = x + 2; wx < x + w - 1; wx += 3) {
      if (hash3(i, wx, wy) < 0.14) pset(wx, wy, C.WIN0);
    }
    if (i % 5 === 2) { vline(x + (w >> 1), base - h - 7, 7, C.BLD0); if ((game.animFrame >> 3) & 1) pset(x + (w >> 1), base - h - 8, C.RED1); }
  }
}
function drawMid(cx) {
  setOffset(-Math.round(cx * 0.5), 0);
  for (let i = 0; i < MID_N; i++) {
    const x = midX[i], w = midW[i], h = midH[i], top = GROUND - h;
    rect(x, top, w, h, C.BLD1);
    vline(x, top, h, C.BLD2);
    hline(x, top, w, C.BLD2);
    for (let wy = top + 4; wy < GROUND - 12; wy += 5) for (let wx = x + 3; wx < x + w - 3; wx += 5) {
      const hv = hash3(i + 100, wx, wy);
      if (hv < 0.2) {
        const flick = hv < 0.02 && ((game.animFrame + i) & 7) === 0;
        hline(wx, wy, 2, flick ? C.WIN0 : C.WIN1);
      }
    }
    if (midSign[i] >= 0) {
      const str = SIGNS[midSign[i]];
      const sw = textW(str, 1) + 6, sxp = x + ((w - sw) >> 1), syp = top + 8;
      const off = hash3(i, (game.animFrame / 3) | 0, 9) < 0.06;
      rect(sxp, syp, sw, 11, C.BLD0);
      const fc = off ? C.BLD2 : (i & 1 ? C.PNK0 : C.CYN0);
      hline(sxp, syp, sw, fc); hline(sxp, syp + 10, sw, fc); vline(sxp, syp, 11, fc); vline(sxp + sw - 1, syp, 11, fc);
      if (!off) text(str, sxp + 3, syp + 3, i & 1 ? C.PNK1 : C.CYN1);
    }
  }
}
function drawFloor() {
  rect(-8, GROUND - 13, STAGE_W + 16, 1, C.MET1);
  for (let x = 0; x < STAGE_W; x += 24) vline(x, GROUND - 12, 12, C.MET0);
  rect(26, GROUND - 26, 34, 26, C.MET0); rect(28, GROUND - 24, 30, 20, C.MET1);
  for (let k = 0; k < 4; k++) hline(30, GROUND - 22 + k * 5, 26, C.MET0);
  rect(STAGE_W - 64, GROUND - 22, 38, 22, C.MET0); rect(STAGE_W - 62, GROUND - 20, 34, 18, C.MET1);
  circFill(STAGE_W - 45, GROUND - 11, 6, C.MET0);
  const fan = (game.animFrame & 1) ? 0 : 1;
  line(STAGE_W - 50 + fan, GROUND - 16, STAGE_W - 40 - fan, GROUND - 6, C.MET2);
  rect(-8, GROUND, STAGE_W + 16, H - GROUND + 4, C.MET0);
  hline(-8, GROUND, STAGE_W + 16, C.MET1);
  hline(-8, GROUND + 8, STAGE_W + 16, C.SKY2);
  for (let x = 16; x < STAGE_W; x += 48) vline(x, GROUND + 1, H - GROUND, C.SKY2);
  for (let k = 0; k < 5; k++) {
    const px = 60 + k * 110, py = GROUND + 13 + (k & 1) * 4;
    ditherEllipse(px, py, 16, 2, C.SKY3, 10);
    if (((game.animFrame + k * 3) & 7) < 5) { hline(px - 6, py, 5, k & 1 ? C.PNK0 : C.CYN0); }
  }
}
function drawShadow(f) {
  const hgt = GROUND - f.y;
  const w = Math.max(4, Math.round(9 * f.look.scale - hgt / 8));
  ditherEllipse(f.x, GROUND + 1, w, 1, C.INK, hgt > 30 ? 6 : 12);
}

function drawMoveFx(f) {
  const m = f.move;
  if (!m || f.state !== S_ATTACK) return;
  const d = f.dir, s = f.look.scale;
  if (f.phase === PH_AC) {
    switch (m.id) {
      case 'magnet_pull': {
        const y = f.y - 36 * s, x0 = f.x + d * 18, len = f.beamLen || 150;
        for (let k = 0; k < len - 18; k += 4) {
          const yy = y + (((k >> 2) + game.tick) & 1 ? 1 : -1);
          line(x0 + d * k, yy, x0 + d * (k + 4), y, (k >> 2) & 1 ? C.YEL2 : C.ORG2);
        }
        break;
      }
      case 'data_leech': {
        const y = f.y - 32, x0 = f.x + d * 12;
        for (let k = 0; k < 82; k += 2) if (hash3(k, game.tick, 5) < 0.75) pset(x0 + d * k, y + (((k + game.tick) >> 2) & 1), C.GRN2);
        break;
      }
      case 'venom_lash': {
        const y = f.y - 33, x0 = f.x + d * 10;
        let px = x0, py = y;
        for (let k = 1; k <= 8; k++) {
          const nx = x0 + d * k * 8, ny = y + Math.round(Math.sin(k * 0.9 + f.phaseT) * 2);
          line(px, py, nx, ny, C.PUR2); px = nx; py = ny;
        }
        rect(px - 1, py - 1, 3, 3, C.GRN2);
        break;
      }
      case 'iaido': case 'neon_crescent': case 'thousand_cuts':
        if (f.phaseT < 5) for (let k = -4; k <= 4; k++) {
          const a = k * 14 * DEG;
          pset(f.x + d * Math.cos(a) * 22, f.y - 30 + Math.sin(a) * 18, k === 0 ? C.WHITE : C.PNK2);
          pset(f.x + d * Math.cos(a) * 20, f.y - 30 + Math.sin(a) * 16, C.PNK1);
        }
        break;
    }
  }
  if (m.id === 'thousand_cuts' && f.cutOn && (game.tick & 3) < 2) {
    const o = opp(f);
    line(o.x - 14, o.y - 40 + ((f.cutN * 7) % 20), o.x + 14, o.y - 16 - ((f.cutN * 5) % 16), C.PNK2);
  }
  if (m.id === 'orbital_drop' && f.phase === PH_AC && f.phaseT > 22 && f.phaseT < 60 && f.y < GROUND - 20) {
    if ((game.tick >> 2) & 1) {
      hline(f.x - 22, GROUND + 2, 45, C.YEL2);
      vline(f.x - 22, GROUND - 1, 3, C.YEL2); vline(f.x + 22, GROUND - 1, 3, C.YEL2);
    }
    ditherEllipse(f.x, GROUND + 1, 20, 2, C.INK, 8);
  }
}

function drawProjectile(p) {
  const x = Math.round(p.x), y = Math.round(p.y), d = p.dir;
  switch (p.kind) {
    case K_BOLT:
      rect(x - 5, y - 1, 11, 3, C.CYN1); hline(x - 5, y, 11, C.CYN2); pset(x + d * 5, y, C.WHITE); pset(x + d * 4, y, C.WHITE);
      for (let k = 1; k <= 4; k++) pset(x - d * (5 + k * 2), y + (((k + p.age) & 1) ? 1 : -1), C.CYN1);
      break;
    case K_WAVE:
      for (let dy = -12; dy <= 12; dy++) {
        const o = Math.round((dy * dy) / 24);
        pset(x - d * o, y + dy, Math.abs(dy) < 5 ? C.WHITE : C.PNK2);
        pset(x - d * (o + 1), y + dy, C.PNK1);
        pset(x - d * (o + 2), y + dy, C.PNK0);
      }
      break;
    case K_HACK:
      rect(x - 3, y - 3, 7, 7, C.GRN0); rect(x - 2, y - 2, 5, 5, C.GRN1); rect(x - 1, y - 1, 3, 3, C.GRN2);
      if (p.age & 2) { pset(x - 5, y - 4, C.GRN2); pset(x + 5, y + 4, C.GRN2); }
      break;
    case K_SPIT:
      circFill(x, y, 3, C.PUR1); circFill(x - 1, y - 1, 1, C.PUR2); pset(x, y + 1, C.GRN2);
      break;
    case K_GRENADE:
      circFill(x, y, 2, C.MET2); pset(x - 1, y - 1, C.MET3); pset(x, y - 3, (p.age >> 2) & 1 ? C.RED2 : C.ORG2);
      break;
    case K_QUAKE:
      for (let k = 0; k < 4; k++) {
        const hh = 4 + ((k * 7 + p.age) % 6);
        rect(x - 7 + k * 4, GROUND - hh, 3, hh, k & 1 ? C.YEL1 : C.ORG1);
        pset(x - 7 + k * 4 + 1, GROUND - hh, C.YEL2);
      }
      break;
    case K_BULLET:
      hline(x - 2, y, 4, C.GRN2); pset(x - d * 3, y, C.GRN1);
      break;
  }
}

function drawZone(z, front) {
  if (!z.on) return;
  const owner = game.fighters[z.owner];
  const isFront = z.kind === Z_CLOUD || z.kind === Z_STRIKE || z.kind === Z_COLUMN || z.kind === Z_WALL || z.kind === Z_DRONE || z.kind === Z_FIELD;
  if (isFront !== front) return;
  if (z.delay > 0) return;
  const x = Math.round(z.x);
  switch (z.kind) {
    case Z_FIELD:
      for (let k = 0; k < 7; k++) {
        const a = rand() * Math.PI * 2, r = 22 + rand() * 8;
        const x0 = x + Math.cos(a) * r, y0 = owner.y - 24 + Math.sin(a) * r * 0.8;
        line(x0, y0, x0 + randRange(-4, 4), y0 + randRange(-4, 4), rand() < 0.5 ? C.CYN2 : C.CYN1);
      }
      break;
    case Z_FIRE: {
      const fade = z.life < 40 ? z.life / 40 : 1;
      for (let xx = x - (z.w >> 1); xx < x + (z.w >> 1); xx += 2) {
        const hh = Math.round((2 + hash3(xx, game.animFrame, 7) * 7) * fade);
        if (hh <= 0) continue;
        vline(xx, GROUND - hh, hh, C.ORG1); pset(xx, GROUND - hh, C.YEL2); pset(xx + 1, GROUND - 1, C.RED1);
      }
      break;
    }
    case Z_CLOUD:
      ditherEllipse(x, GROUND - 26, 62, 26, C.PUR0, 7);
      ditherEllipse(x + ((game.animFrame >> 2) & 3) - 1, GROUND - 26, 48, 18, C.PUR1, 4 + ((game.animFrame >> 1) & 1));
      for (let k = 0; k < 6; k++) pset(x + (hash3(k, game.animFrame, 11) * 100 - 50), GROUND - hash3(k, game.animFrame, 13) * 48, C.GRN2);
      break;
    case Z_WALL: {
      if (z.life < 40 && (game.tick & 2)) break;
      const x0 = x - 3, top = GROUND - z.h;
      vline(x0, top, z.h, C.GRN1); vline(x0 + 5, top, z.h, C.GRN1);
      for (let yy = top; yy < GROUND; yy++) if ((yy + z.t) % 4 === 0) hline(x0 + 1, yy, 4, (yy >> 2) & 1 ? C.GRN2 : C.GRN0);
      break;
    }
    case Z_DRONE: {
      const y = Math.round(z.y), dd = owner.dir;
      rect(x - 4, y - 2, 9, 4, C.MET2); hline(x - 4, y - 2, 9, C.MET3); pset(x + dd * 3, y, C.GRN2);
      const wing = (game.tick >> 1) & 1;
      hline(x - 7, y - 4, wing ? 5 : 3, C.MET1); hline(x + 3, y - 4, wing ? 5 : 3, C.MET1);
      break;
    }
    case Z_STRIKE:
      if (z.t < 22) {
        ditherEllipse(x, GROUND + 1, 10, 1, C.CYN0, 10);
        if ((z.t >> 2) & 1) { hline(x - 9, GROUND + 2, 19, C.CYN2); vline(x - 9, GROUND - 1, 3, C.CYN2); vline(x + 9, GROUND - 1, 3, C.CYN2); }
      } else {
        let bx = x;
        for (let yy = 0; yy < GROUND; yy += 6) {
          const nx = x + ((hash3(yy, z.t, x) * 9) | 0) - 4;
          brush(bx, yy, nx, yy + 6, 3, C.CYN2); line(bx, yy, nx, yy + 6, C.WHITE);
          bx = nx;
        }
        ditherEllipse(x, GROUND, 14, 3, C.CYN1, 10);
      }
      break;
    case Z_COLUMN:
      if (z.t < 12) ditherEllipse(x, GROUND, 10, 2, C.ORG0, (z.t & 4) ? 12 : 6);
      else {
        const k = z.t - 12, hh = k < 6 ? k * 12 : Math.max(0, 70 - (k - 6) * 5);
        for (let xx = -9; xx <= 9; xx++) {
          const ch = hh - Math.abs(xx) * 3 + ((hash3(xx, game.animFrame, x) * 8) | 0);
          if (ch <= 0) continue;
          const ax = Math.abs(xx);
          vline(x + xx, GROUND - ch, ch, ax < 3 ? C.YEL2 : ax < 6 ? C.ORG2 : C.ORG1);
        }
      }
      break;
  }
}

/* ---------- HUD ---------- */
const KEY_LABELS_H = ['1', '2', '3', '4', 'UL'];
const KEY_LABELS_C = ['1', '2', '3', '4', 'UL'];
const HUD_SLOTS = [A_S1, A_S2, A_S3, A_S4, A_ULT];

function drawBar(x, y, w, h, v, max, fill, bg, fromRight) {
  rect(x - 1, y - 1, w + 2, h + 2, C.INK);
  rect(x, y, w, h, bg);
  const fw = Math.round(w * clamp01(v / max));
  if (fw > 0) rect(fromRight ? x + w - fw : x, y, fw, h, fill);
}

function drawSideHud(f) {
  const right = f.side === 1;
  const bx = right ? W - 160 : 10;
  rect(bx - 1, 6, 152, 8, C.INK);
  rect(bx, 7, 150, 6, C.SKY1);
  const tw = Math.round(150 * f.trail / f.hpMax), hw = Math.round(150 * f.hp / f.hpMax);
  const low = f.hp < f.hpMax * 0.25 && (game.animFrame & 2);
  rect(right ? bx + 150 - tw : bx, 7, tw, 6, C.RED1);
  if (hw > 0) {
    rect(right ? bx + 150 - hw : bx, 7, hw, 6, low ? C.RED2 : C.YEL1);
    hline(right ? bx + 150 - hw : bx, 7, hw, low ? C.WHITE : C.YEL2);
  }
  if (f.shieldHP > 0) {
    const sw = Math.min(150, Math.round(150 * f.shieldHP / f.hpMax));
    hline(right ? bx + 150 - sw : bx, 13, sw, C.CYN2);
  }
  const name = f.def.name, tag = f.cpu ? 'CPU' : 'P1';
  const nx = right ? W - 10 - textW(name, 1) : 10;
  textShadow(name, nx, 16, C.WHITE, 1);
  textShadow(tag, right ? nx - textW(tag, 1) - 4 : nx + textW(name, 1) + 4, 16, f.cpu ? C.CYN1 : C.YEL1, 1);
  if (f.cpu && f.aiLabel && game.showAi) textShadow(f.aiLabel, right ? W - 10 - textW(f.aiLabel, 1) : 10, 23, C.MET3, 1);
  const ey = 31;
  drawBar(right ? W - 90 : 10, ey, 80, 3, f.energy, 100, C.CYN1, C.SKY1, right);
  drawBar(right ? W - 60 : 10, ey + 5, 50, 2, f.guard, 100, f.guard < 30 ? C.RED1 : C.CLO1, C.SKY1, right);
  if (f.def.id === 'pyra') drawBar(right ? W - 60 : 10, ey + 9, 50, 2, f.heat, 100, C.ORG1, C.SKY1, right);
  let ix = right ? W - 17 : 10;
  const iy = ey + 14;
  for (let i = 0; i < NST; i++) {
    if (f.st[i] <= 0) continue;
    if (f.st[i] < 1 && (game.animFrame & 1)) { ix += right ? -9 : 9; continue; }
    const info = ST_INFO[i];
    rect(ix - 1, iy - 1, 9, 9, C.INK);
    rect(ix, iy, 7, 7, info.col);
    glyph(info.letter.charCodeAt(0), ix + 2, iy + 1, C.INK, 1);
    if (f.stk[i] > 1) { numShadow(f.stk[i], right ? ix - 5 : ix + 9, iy + 1, C.WHITE, 1); ix += right ? -5 : 5; }
    ix += right ? -9 : 9;
  }
  const my = H - 10;
  for (let k = 0; k < 3; k++) {
    const sx = right ? W - 10 - (k + 1) * 30 + 2 : 10 + k * 30;
    const v = clamp01((f.meter - k * 100) / 100);
    rect(sx - 1, my - 1, 30, 6, C.INK);
    rect(sx, my, 28, 4, C.SKY1);
    const w2 = Math.round(28 * v);
    if (w2 > 0) rect(right ? sx + 28 - w2 : sx, my, w2, 4, v >= 1 ? ((game.animFrame & 2) ? C.PUR2 : C.PUR1) : C.PUR0);
  }
  numShadow(Math.floor(f.meter / 100), right ? W - 108 : 102, my - 1, f.meter >= ULT_COST ? C.PUR2 : C.CLO1, 1);
  const o = opp(f), labels = f.cpu ? KEY_LABELS_C : KEY_LABELS_H;
  for (let k = 0; k < 5; k++) {
    const m = f.moves[HUD_SLOTS[k]];
    const sx = right ? W - 10 - (k + 1) * 16 + 2 : 10 + k * 16, sy = H - 25;
    const ready = canUse(f, o, m);
    rect(sx - 1, sy - 1, 16, 13, C.INK);
    rect(sx, sy, 14, 11, C.SKY2);
    if (ready) { hline(sx, sy, 14, f.look.eye); hline(sx, sy + 10, 14, f.look.eye); }
    const cdMax = m.cd > 0 ? m.cd : 1;
    if (f.cds[m.slot] > 0) { const ch = Math.ceil(11 * f.cds[m.slot] / cdMax); ditherRect(sx, sy + 11 - ch, 14, ch, C.INK, 10); }
    const lab = labels[k];
    textS(lab, sx + ((14 - textW(lab, 1)) >> 1), sy + 3, ready ? C.WHITE : C.MET1, 1);
    if (f.st[ST_HACK] > 0) { line(sx + 1, sy + 1, sx + 12, sy + 9, C.RED2); line(sx + 12, sy + 1, sx + 1, sy + 9, C.RED2); }
  }
  if (f.passiveT >= PASSIVE_WARN) {
    const lab = f.passiveLv === 2 ? 'PENALTY' : f.passiveLv === 1 ? 'PASSIVE' : 'MOVE!';
    const px = right ? W - 10 - 44 : 10, py = iy + 11;
    if (f.passiveLv === 0 || (game.animFrame & 2)) textShadow(lab, right ? W - 10 - textW(lab, 1) : 10, py, f.passiveLv ? C.RED2 : C.YEL2, 1);
    drawBar(px, py + 7, 44, 2, f.passiveT, PASSIVE_LV2, f.passiveLv ? C.RED1 : C.YEL1, C.SKY1, right);
  }
  if (f.showComboT > 0 && f.showCombo >= 2) {
    const cx = right ? W - 60 : 14;
    numShadow(f.showCombo, cx, 72, C.YEL2, 3);
    textShadow('HITS', cx + numW(f.showCombo, 3) + 3, 78, C.ORG2, 1);
  }
}

function drawHud() {
  const a = game.fighters[0], b = game.fighters[1];
  drawSideHud(a); drawSideHud(b);
  const t = Math.ceil(game.timer);
  const tw = numW(t, 2);
  rect(W / 2 - 13, 3, 26, 16, C.INK);
  numShadow(t, (W - tw) >> 1, 5, t <= 10 && (game.animFrame & 2) ? C.RED2 : C.WHITE, 2);
  for (let k = 0; k < 2; k++) {
    rect(W / 2 - 14 - k * 6, 21, 4, 4, k < a.wins ? C.YEL2 : C.SKY2);
    rect(W / 2 + 10 + k * 6, 21, 4, 4, k < b.wins ? C.YEL2 : C.SKY2);
  }
}

function drawPops() {
  for (let i = 0; i < MAX_POP; i++) {
    const p = pops[i];
    if (!p.on) continue;
    if (p.t > p.life - 10 && (p.t & 1)) continue;
    if (p.num >= 0) numShadow(p.num, Math.round(p.x - numW(p.num, 1) / 2), Math.round(p.y), p.col, 1);
    else textShadow(p.str, Math.round(p.x - textW(p.str, 1) / 2), Math.round(p.y), p.col, 1);
  }
}

function drawAnnounce() {
  if (game.announceT > 0 && game.announce) {
    const s = game.announce.length > 9 ? 3 : 4;
    const w = textW(game.announce, s);
    if (game.announceT > 8 || (game.announceT & 1)) textShadow(game.announce, (W - w) >> 1, 72, game.announceCol, s);
  }
  if (game.superT > 0) {
    const w = textW(game.superName, 2);
    rect(0, 100, W, 18, C.INK);
    ditherRect(0, 96, W, 4, C.INK, 8); ditherRect(0, 118, W, 4, C.INK, 8);
    const slide = Math.max(0, (game.superT - 30) * 16);
    textS(game.superName, ((W - w) >> 1) + slide, 104, game.superCol, 2);
  }
}

function renderGame() {
  clear(C.SKY0);
  setOffset(0, 0);
  drawSky();
  const cx = Math.round(game.camX);
  drawFar(cx);
  drawMid(cx);
  setOffset(-cx + game.shakeX, game.shakeY);
  drawFloor();
  const a = game.fighters[0], b = game.fighters[1];
  for (let i = 0; i < MAX_ZONES; i++) drawZone(zones[i], false);
  if (a) {
    drawShadow(a); drawShadow(b);
    const aFirst = !(a.state === S_ATTACK) || b.state === S_ATTACK;
    if (aFirst) { drawFighter(a); drawFighter(b); } else { drawFighter(b); drawFighter(a); }
    drawMoveFx(a); drawMoveFx(b);
  }
  for (let i = 0; i < MAX_PROJ; i++) if (projs[i].on) drawProjectile(projs[i]);
  for (let i = 0; i < MAX_ZONES; i++) drawZone(zones[i], true);
  drawParticles();
  drawPops();
  setOffset(0, 0);
  drawRain();
  if (game.glitchT > 0) glitchRows(6);
  if (a && game.phase !== 'attract') drawHud();
  drawAnnounce();
}
