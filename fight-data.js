'use strict';

/* Static game data: status effects, action codes, rig poses, moves and the
   six fighter definitions. Move callbacks call functions from fight-game.js at
   runtime only, so load order between the two files does not matter. */

const ST_BURN = 0, ST_SHOCK = 1, ST_BLEED = 2, ST_POISON = 3, ST_HACK = 4, ST_SLOW = 5,
  ST_FREEZE = 6, ST_SHIELD = 7, ST_ARMOR = 8, ST_OVERCHARGE = 9, ST_CLOAK = 10, ST_OVERHEAT = 11;
const NST = 12;
const ST_INFO = [
  { key: 'burn', letter: 'B', col: C.ORG1, max: 3, debuff: true, es: 'Quemadura', en: 'burning (damage over time, stacks x3)' },
  { key: 'shock', letter: 'S', col: C.CYN1, max: 1, debuff: true, es: 'Electrocutado', en: 'shocked (slower, random micro-stuns)' },
  { key: 'bleed', letter: 'L', col: C.PNK1, max: 5, debuff: true, es: 'Sangrado', en: 'bleeding (stacks; 5 stacks detonate for 80)' },
  { key: 'poison', letter: 'P', col: C.PUR1, max: 1, debuff: true, es: 'Veneno', en: 'poisoned (damage over time, halves regeneration)' },
  { key: 'hacked', letter: 'H', col: C.GRN1, max: 1, debuff: true, es: 'Hackeado', en: 'hacked (cannot use skills or ultimate)' },
  { key: 'slow', letter: 'W', col: C.MET2, max: 1, debuff: true, es: 'Ralentizado', en: 'slowed (half movement speed)' },
  { key: 'frozen', letter: 'F', col: C.CYN2, max: 1, debuff: true, es: 'Congelado', en: 'frozen (cannot act)' },
  { key: 'shield', letter: 'D', col: C.CYN0, max: 1, debuff: false, es: 'Escudo', en: 'shielded (absorbs damage)' },
  { key: 'armor', letter: 'A', col: C.YEL1, max: 1, debuff: false, es: 'Super armadura', en: 'super armor (no hitstun)' },
  { key: 'overcharge', letter: 'O', col: C.CYN2, max: 1, debuff: false, es: 'Sobrecarga', en: 'overcharged (faster, hits shock)' },
  { key: 'cloak', letter: 'C', col: C.PUR2, max: 1, debuff: false, es: 'Camuflaje', en: 'cloaked (invisible, next hit +50%)' },
  { key: 'overheat', letter: 'X', col: C.RED2, max: 1, debuff: false, es: 'Sobrecalentado', en: 'overheated (+30% damage)' },
];

const A_LIGHT = 1, A_HEAVY = 2, A_GRAB = 3, A_S1 = 4, A_S2 = 5, A_S3 = 6, A_S4 = 7, A_ULT = 8, A_BURST = 9;
const NACT = 10;
const ULT_COST = 200, BURST_COST = 100, METER_MAX = 300;

/* Pose layout (degrees for angles, pixels for offsets):
   0 hipX 1 hipY(+down) 2 lean(+forward) 3 head 4 backShoulder 5 backElbow
   6 frontShoulder 7 frontElbow 8 backFootX 9 backFootLift 10 frontFootX 11 frontFootLift
   Arm angles: 0 = hanging down, 90 = pointing forward, 180 = straight up. */
const POSE_N = 12;
function P(hx, hy, lean, head, bsh, bel, fsh, fel, bfx, bfy, ffx, ffy) {
  return new Float32Array([hx, hy, lean, head, bsh, bel, fsh, fel, bfx, bfy, ffx, ffy]);
}
const PO = {
  STANCE: P(0, 1, 6, 0, 25, 95, 50, 85, -7, 0, 7, 0),
  BLOCK: P(-2, 3, -4, 0, 70, 110, 85, 95, -9, 0, 5, 0),
  HIT: P(-3, 2, -18, -10, 10, 30, 30, 40, -9, 0, 5, 0),
  AIRHIT: P(-2, 0, -40, -15, 130, 20, 150, 20, -8, 8, 6, 12),
  DOWN: P(-4, 16, -84, -10, -100, 0, -80, 10, 10, 0, 14, 1),
  JUMP: P(0, -1, 0, 0, 150, 20, 60, 90, -3, 4, 5, 8),
  TUCK: P(0, 2, 10, 0, 40, 100, 60, 100, -4, 10, 6, 12),
  DASH: P(4, 3, 30, 0, -40, 20, -20, 30, -12, 2, 8, 0),
  WIN: P(0, 0, 0, -6, 20, 100, 170, 10, -7, 0, 7, 0),
  JAB_A: P(0, 1, 4, 0, 20, 100, 60, 110, -7, 0, 7, 0),
  JAB: P(3, 1, 14, 0, 30, 110, 92, 0, -7, 0, 10, 0),
  KICK_A: P(-2, 0, -10, 0, 60, 90, 40, 90, -6, 0, 6, 12),
  KICK: P(0, 0, -20, 0, 100, 60, 30, 60, -8, 0, 22, 24),
  GRAB_A: P(-2, 1, 0, 0, 60, 60, 70, 60, -7, 0, 7, 0),
  GRAB: P(4, 1, 18, 0, 85, 10, 95, 5, -8, 0, 12, 0),
  CAST_A: P(-2, 1, -6, 0, 20, 60, 20, 150, -8, 0, 6, 0),
  CAST: P(3, 2, 12, 0, 40, 60, 90, 0, -9, 0, 11, 0),
  UPPER_A: P(0, 6, 15, 0, 30, 90, 20, 120, -6, 0, 8, 0),
  UPPER: P(0, -3, -5, -8, 40, 60, 175, 0, -4, 6, 5, 0),
  SLAM_A: P(0, -2, -8, -6, 170, 10, 175, 5, -6, 0, 6, 0),
  SLAM: P(2, 8, 30, 6, 70, 10, 80, 5, -9, 0, 10, 0),
  DASHATK: P(4, 4, 25, 0, -30, 10, 95, 0, -12, 0, 10, 0),
  SLASH_A: P(-2, 1, -10, 0, 140, 30, 160, 20, -8, 0, 6, 0),
  SLASH: P(5, 4, 25, 0, 90, 0, 100, -10, -12, 0, 12, 0),
  COUNTER: P(0, 4, -6, 0, 100, 70, 120, 60, -9, 0, 6, 0),
  THROW_A: P(-1, 1, -12, 0, 60, 60, -150, 0, -8, 0, 6, 0),
  THROW: P(3, 1, 15, 0, 30, 60, 110, 10, -8, 0, 10, 0),
  POWER: P(0, 5, -4, -6, -30, 10, 30, -10, -10, 0, 10, 0),
  LASH: P(3, 1, 18, 0, 20, 90, 90, 0, -8, 0, 11, 0),
  SPIT_A: P(-1, 1, -10, -15, 20, 100, 40, 100, -7, 0, 7, 0),
  SPIT: P(3, 1, 20, 10, 30, 80, 60, 70, -8, 0, 9, 0),
  FLAME: P(1, 3, 8, 0, 70, 30, 88, 2, -10, 0, 8, 0),
  ROCKET: P(2, 0, 40, 0, -40, 0, 110, 0, -8, 6, 2, 10),
};

/* Hit specification shared by melee, projectiles and zones. */
function HS(dmg, hs, kx, ky, extra) {
  const h = { dmg, hs, bs: Math.round(hs * 0.6), kx, ky, kd: false, gd: Math.round(dmg * 0.35), ub: false, grab: false, fx: null, spark: R_SPARK, nostun: false };
  if (extra) for (const k in extra) h[k] = extra[k];
  return h;
}
const MOVE_DEFAULTS = {
  level: 3, cost: 0, meter: 0, cd: 0, su: 8, ac: 3, re: 12, pa: null, pb: null, hb: null, h: null,
  hits: 1, every: 0, vx: 0, vy: 0, air: false, armor: false, inv: null, invF: 999, ghost: false,
  proj: null, fire: false, range: null, onActive: null, onTick: null, onEnd: null, onHit: null,
  noGrav: false, ai: '', es: '',
};
function mv(o) {
  const m = {};
  for (const k in MOVE_DEFAULTS) m[k] = MOVE_DEFAULTS[k];
  for (const k in o) m[k] = o[k];
  if (!m.pa) m.pa = PO.CAST_A;
  if (!m.pb) m.pb = m.pa;
  return m;
}
function normals(pw, reach, heavyArmor) {
  return [
    mv({ slot: A_LIGHT, id: 'light', name: 'JAB', level: 1, su: 4, ac: 3, re: 9, pa: PO.JAB_A, pb: PO.JAB, air: true,
      hb: [4, 36, 20 + reach, 9], h: HS(30 * pw, 14, 1.6, 0, { bs: 9, gd: 6 }), range: [0, 26 + reach],
      ai: `Fast jab, ${Math.round(30 * pw)} damage, starts in 4 frames. Good to interrupt and to start combos; cancels into heavy or skills on hit.`,
      es: `Golpe rápido (${Math.round(30 * pw)}). Cancela en pesado o skill al conectar.` }),
    mv({ slot: A_HEAVY, id: 'heavy', name: 'KICK', level: 2, su: 9, ac: 4, re: 17, pa: PO.KICK_A, pb: PO.KICK, air: true, armor: heavyArmor,
      hb: [6, 32, 22 + reach, 14], h: HS(65 * pw, 20, 3, 0, { bs: 14, gd: 14 }), range: [0, 32 + reach],
      ai: `Strong kick, ${Math.round(65 * pw)} damage, slower startup (9 frames)${heavyArmor ? ', with super armor' : ''}. Cancels into skills on hit.`,
      es: `Patada fuerte (${Math.round(65 * pw)})${heavyArmor ? ' con super armadura' : ''}. Cancela en skill al conectar.` }),
    mv({ slot: A_GRAB, id: 'grab', name: 'THROW', level: 2, su: 5, ac: 3, re: 26, pa: PO.GRAB_A, pb: PO.GRAB,
      hb: [2, 40, 20, 32], h: HS(90 * pw, 0, 3.5, -4, { grab: true, ub: true, kd: true }), range: [0, 22],
      ai: `Throw, ${Math.round(90 * pw)} damage, unblockable: beats an opponent who is blocking. Very short range, long whiff recovery.`,
      es: `Agarre imbloqueable (${Math.round(90 * pw)}). Vence al bloqueo.` }),
  ];
}

/* Projectile kinds and zone kinds (rendering + behaviour switches in fight-game.js). */
const K_BOLT = 1, K_WAVE = 2, K_HACK = 3, K_SPIT = 4, K_GRENADE = 5, K_QUAKE = 6, K_BULLET = 7;
const Z_FIELD = 1, Z_FIRE = 2, Z_CLOUD = 3, Z_WALL = 4, Z_DRONE = 5, Z_STRIKE = 6, Z_COLUMN = 7;

const SPEC_FIELD = HS(15, 8, 0.8, 0, { fx: [[ST_SHOCK, 0.8, 1]], spark: R_ELEC, gd: 4 });
const SPEC_FIRE = HS(10, 0, 0, 0, { ub: true, nostun: true, fx: [[ST_BURN, 3, 1]], spark: R_FIRE });
const SPEC_CLOUD = HS(22, 0, 0, 0, { ub: true, nostun: true, fx: [[ST_POISON, 3, 1], [ST_SLOW, 1.5, 1]], spark: R_TOX });
const SPEC_BULLET = HS(15, 8, 1, 0, { spark: R_HACK, gd: 3 });
const SPEC_STRIKE = HS(70, 22, 1, -3, { fx: [[ST_SHOCK, 1.5, 1]], spark: R_ELEC, gd: 25 });
const SPEC_COLUMN = HS(45, 18, 1.5, -4, { fx: [[ST_BURN, 4, 2]], spark: R_FIRE, gd: 15 });
const SPEC_RIPOSTE = HS(90, 24, 3, -3, { fx: [[ST_BLEED, 5, 1]], spark: R_PINK, ub: true });
const SPEC_CUT = HS(26, 40, 0, 0, { fx: [[ST_BLEED, 5, 1]], spark: R_PINK, ub: true });
const SPEC_CUT_END = HS(70, 0, 4, -5, { kd: true, spark: R_PINK, ub: true });
const SPEC_PULL = HS(20, 0, 0, 0, { ub: true, nostun: true, spark: R_GOLD });
const SPEC_DROP = HS(250, 0, 4, -6, { kd: true, gd: 80, spark: R_GOLD });
const SPEC_VENT = HS(25, 14, 5, -2, { spark: R_STEAM, ub: true });
const SPEC_CRASH = HS(120, 0, 0, 0, { ub: true, nostun: true, fx: [[ST_FREEZE, 2.5, 1], [ST_HACK, 4, 1]], spark: R_HACK });

const FIGHTERS = [
  {
    id: 'volt', name: 'VOLT', role: 'Velocista eléctrico', roleAi: 'electric speedster', hp: 950, speed: 1.75, pw: 1, reach: 0,
    look: { scale: 1, skin: C.SKA1, hair: C.CLO2, style: 'spiky', top: C.CYN1, pants: C.HAI2, boots: C.MET1, sleeve: C.CYN1, glove: C.MET2, eye: C.CYN2, gear: 'gloves' },
    passive: 'CONDUCTOR: +20% de daño contra rivales electrocutados.',
    passiveAi: 'Conductor: you deal +20% damage to a shocked opponent.',
    skills: [
      mv({ slot: A_S1, id: 'arc_bolt', name: 'ARC BOLT', cost: 20, cd: 1.2, su: 10, ac: 2, re: 14, pa: PO.CAST_A, pb: PO.CAST,
        proj: { kind: K_BOLT, x: 16, y: 31, vx: 6, vy: 0, g: 0, w: 12, h: 6, life: 90 },
        h: HS(55, 16, 2, 0, { fx: [[ST_SHOCK, 1.5, 1]], spark: R_ELEC, gd: 10 }),
        ai: 'Fast electric projectile across the screen, 55 damage and shocks. Good zoning at mid or far range.',
        es: 'Proyectil eléctrico rápido (55) que electrocuta.' }),
      mv({ slot: A_S2, id: 'rail_dash', name: 'RAIL DASH', cost: 25, cd: 3, su: 6, ac: 14, re: 14, pa: PO.DASH, pb: PO.DASHATK,
        vx: 7, inv: 'proj', ghost: true, hb: [-6, 42, 26, 42], h: HS(60, 18, 3, 0, { fx: [[ST_SHOCK, 1, 1]], spark: R_ELEC, gd: 12 }), range: [0, 110],
        ai: 'Lightning dash that passes through the opponent and through projectiles, 60 damage and shocks. Closes distance or escapes the corner.',
        es: 'Embestida que atraviesa al rival y a los proyectiles (60).' }),
      mv({ slot: A_S3, id: 'static_field', name: 'STATIC FIELD', cost: 35, cd: 9, su: 12, ac: 2, re: 12, pa: PO.POWER, pb: PO.POWER,
        onActive: (f) => spawnZone(Z_FIELD, f, f.x, f.y, 60, 50, 180, 0), range: [0, 34],
        ai: 'Electric field around you for 3 seconds: shocks and damages the opponent every half second while they stay close.',
        es: 'Campo eléctrico alrededor durante 3 s: daña y electrocuta de cerca.' }),
      mv({ slot: A_S4, id: 'overcharge', name: 'OVERCHARGE', cost: 30, cd: 14, su: 10, ac: 2, re: 10, pa: PO.POWER, pb: PO.WIN,
        onActive: (f) => addStatus(f, ST_OVERCHARGE, 5, 1, f),
        ai: 'Self buff for 5 seconds: +30% movement speed, double energy regeneration and your jab/kick apply shock.',
        es: 'Buff 5 s: +30% velocidad, doble regeneración y golpes que electrocutan.' }),
    ],
    ult: mv({ slot: A_ULT, id: 'thunderdome', name: 'THUNDERDOME', level: 4, meter: ULT_COST, su: 20, ac: 40, re: 20, pa: PO.POWER, pb: PO.WIN, inv: 'all', invF: 24,
      onActive: (f) => { for (let i = 0; i < 5; i++) spawnZone(Z_STRIKE, f, 0, GROUND, 18, 200, 30, i * 18); },
      ai: 'Ultimate: five lightning strikes fall on the opponent position one after another, 70 damage each and shock. Hard to escape.',
      es: 'Definitiva: cinco rayos rastrean al rival (70 c/u).' }),
  },
  {
    id: 'ronin', name: 'RONIN-9', role: 'Samurái cibernético', roleAi: 'cyber samurai with a katana', hp: 950, speed: 1.6, pw: 1.05, reach: 4,
    look: { scale: 1, skin: C.SKA2, hair: C.HAI2, style: 'ponytail', top: C.PNK1, pants: C.HAI2, boots: C.HAI1, sleeve: C.PNK1, glove: C.HAI2, eye: C.PNK2, gear: 'katana' },
    passive: 'KENJUTSU: los golpes de contraataque hacen +40% (en vez de +25%) y dan +10 de energía.',
    passiveAi: 'Kenjutsu: your counter hits deal +40% damage and give energy.',
    skills: [
      mv({ slot: A_S1, id: 'iaido', name: 'IAIDO', cost: 20, cd: 2.5, su: 12, ac: 8, re: 18, pa: PO.SLASH_A, pb: PO.SLASH, vx: 5,
        hb: [0, 42, 32, 32], h: HS(80, 22, 3.5, 0, { fx: [[ST_BLEED, 5, 2]], spark: R_PINK, gd: 18 }), range: [0, 75],
        ai: 'Lunging sword draw, travels forward, 80 damage and 2 bleed stacks. Punishes from mid range.',
        es: 'Estocada con avance (80) y 2 cargas de sangrado.' }),
      mv({ slot: A_S2, id: 'mirror_parry', name: 'MIRROR PARRY', cost: 20, cd: 5, su: 2, ac: 30, re: 16, pa: PO.COUNTER, pb: PO.COUNTER,
        onActive: (f) => { f.parryT = 30; }, onEnd: (f) => { f.parryT = 0; },
        ai: 'Counter stance for half a second: if the opponent hits you with a melee attack you teleport behind them and riposte for 90; parried projectiles are erased. Use it when an attack is coming.',
        es: 'Postura de contra 0,5 s: ante un golpe se teletransporta y responde (90).' }),
      mv({ slot: A_S3, id: 'phantom_step', name: 'PHANTOM STEP', cost: 15, cd: 4, su: 6, ac: 2, re: 10, pa: PO.DASH, pb: PO.STANCE, inv: 'all',
        onActive: (f, o) => teleportBehind(f, o),
        ai: 'Invulnerable teleport behind the opponent. Evades attacks and crosses them up.',
        es: 'Teletransporte invulnerable a la espalda del rival.' }),
      mv({ slot: A_S4, id: 'neon_crescent', name: 'NEON CRESCENT', cost: 25, cd: 2, su: 11, ac: 2, re: 16, pa: PO.SLASH_A, pb: PO.SLASH,
        proj: { kind: K_WAVE, x: 14, y: 36, vx: 4.5, vy: 0, g: 0, w: 10, h: 24, life: 100 },
        h: HS(50, 18, 2.5, 0, { fx: [[ST_BLEED, 5, 1]], spark: R_PINK }),
        ai: 'Tall sword wave projectile, 50 damage and 1 bleed stack.',
        es: 'Onda de corte a distancia (50) con sangrado.' }),
    ],
    ult: mv({ slot: A_ULT, id: 'thousand_cuts', name: 'THOUSAND CUTS', level: 4, meter: ULT_COST, su: 14, ac: 96, re: 20, pa: PO.SLASH_A, pb: PO.DASHATK,
      inv: 'all', ghost: true, hb: [-4, 44, 30, 44], h: null, range: [0, 120], onActive: (f) => { f.cutOn = 0; f.cutN = 0; }, onTick: (f, o) => tickThousandCuts(f, o),
      ai: 'Ultimate: invulnerable dash; on contact traps the opponent in eight slashes plus a finisher (about 280 damage and heavy bleed). Needs to connect within about 110px.',
      es: 'Definitiva: embestida invulnerable; al conectar, ocho cortes y remate.' }),
  },
  {
    id: 'brick', name: 'BRICK', role: 'Tanque con brazos mecánicos', roleAi: 'heavy tank with mechanical arms', hp: 1200, speed: 1.15, pw: 1.2, reach: 3,
    look: { scale: 1.2, skin: C.SKB1, hair: 0, style: 'bald', top: C.YEL1, pants: C.MET1, boots: C.HAI2, sleeve: C.SKB1, glove: C.MET2, eye: C.ORG2, gear: 'mech' },
    passive: 'CHASIS PESADO: recibe -10% de daño y su patada tiene super armadura.',
    passiveAi: 'Heavy frame: you take 10% less damage and your kick has super armor.',
    skills: [
      mv({ slot: A_S1, id: 'piston_punch', name: 'PISTON PUNCH', cost: 25, cd: 3, su: 16, ac: 5, re: 20, pa: PO.CAST_A, pb: PO.CAST, armor: true,
        hb: [6, 44, 32, 18], h: HS(110, 26, 6, -2, { gd: 30, bs: 18, spark: R_GOLD }), range: [0, 42],
        ai: 'Armored hydraulic punch: absorbs hits during startup, 110 damage and big knockback. Slow; beats the opponent attacks at close range.',
        es: 'Puñetazo hidráulico con armadura (110).' }),
      mv({ slot: A_S2, id: 'ground_quake', name: 'GROUND QUAKE', cost: 30, cd: 4, su: 18, ac: 3, re: 18, pa: PO.SLAM_A, pb: PO.SLAM,
        proj: { kind: K_QUAKE, x: 18, y: 12, vx: 4.2, vy: 0, g: 0, w: 14, h: 12, life: 110, ground: true },
        h: HS(70, 0, 2, -4, { kd: true, gd: 40, spark: R_GOLD }),
        ai: 'Ground slam that sends a shockwave along the floor, 70 damage and knockdown. The opponent must jump over it.',
        es: 'Onda sísmica por el suelo (70), derriba. Se esquiva saltando.' }),
      mv({ slot: A_S3, id: 'iron_hide', name: 'IRON HIDE', cost: 30, cd: 12, su: 10, ac: 2, re: 8, pa: PO.POWER, pb: PO.POWER,
        onActive: (f) => { f.shieldHP = 150; addStatus(f, ST_SHIELD, 5, 1, f); addStatus(f, ST_ARMOR, 3, 1, f); },
        ai: 'Shield that absorbs 150 damage for 5 seconds plus 3 seconds of super armor.',
        es: 'Escudo de 150 durante 5 s y 3 s de super armadura.' }),
      mv({ slot: A_S4, id: 'magnet_pull', name: 'MAGNET PULL', cost: 25, cd: 6, su: 10, ac: 8, re: 18, pa: PO.CAST_A, pb: PO.CAST,
        onTick: (f, o) => tickMagnet(f, o), range: [0, 150],
        ai: 'Magnetic beam up to 150px: pulls a grounded opponent next to you and stuns them briefly (unblockable). Follow with close attacks.',
        es: 'Rayo magnético: atrae al rival y lo aturde (imbloqueable).' }),
    ],
    ult: mv({ slot: A_ULT, id: 'orbital_drop', name: 'ORBITAL DROP', level: 4, meter: ULT_COST, su: 16, ac: 90, re: 24, pa: PO.SLAM_A, pb: PO.TUCK,
      inv: 'all', invF: 60, noGrav: true, onTick: (f, o) => tickOrbitalDrop(f, o),
      ai: 'Ultimate: leaps off screen and crashes down on the opponent position, 250 damage in an area with knockdown. Blockable.',
      es: 'Definitiva: salta fuera de pantalla y cae sobre el rival (250).' }),
  },
  {
    id: 'glitch', name: 'GLITCH', role: 'Hacker de combate', roleAi: 'combat hacker', hp: 900, speed: 1.55, pw: 0.95, reach: 0,
    look: { scale: 1, skin: C.SKB1, hair: C.GRN1, style: 'hood', top: C.GRN1, pants: C.HAI2, boots: C.MET1, sleeve: C.GRN1, glove: C.HAI2, eye: C.GRN2, gear: 'visor' },
    passive: 'EXPLOIT: +3 energía/s por cada estado negativo del rival; sus skills cuestan 25% menos si el rival está hackeado.',
    passiveAi: 'Exploit: +3 energy per second per debuff on the opponent; skills cost 25% less while the opponent is hacked.',
    skills: [
      mv({ slot: A_S1, id: 'hack_spike', name: 'HACK SPIKE', cost: 20, cd: 5, su: 12, ac: 2, re: 14, pa: PO.CAST_A, pb: PO.CAST,
        proj: { kind: K_HACK, x: 14, y: 31, vx: 4, vy: 0, g: 0, w: 10, h: 8, life: 110 },
        h: HS(30, 14, 1.5, 0, { fx: [[ST_HACK, 3, 1]], spark: R_HACK }),
        ai: 'Virus projectile, 30 damage and hacks the opponent for 3 seconds (they cannot use skills or ultimate).',
        es: 'Proyectil virus (30): hackea 3 s (sin skills).' }),
      mv({ slot: A_S2, id: 'sentry_drone', name: 'SENTRY DRONE', cost: 35, cd: 12, su: 14, ac: 2, re: 10, pa: PO.POWER, pb: PO.WIN,
        onActive: (f) => spawnZone(Z_DRONE, f, f.x, f.y - 60, 8, 6, 420, 0),
        ai: 'Deploys a drone for 7 seconds that shoots the opponent every second (15 damage per shot).',
        es: 'Dron que dispara al rival cada segundo durante 7 s.' }),
      mv({ slot: A_S3, id: 'firewall', name: 'FIREWALL', cost: 25, cd: 8, su: 10, ac: 2, re: 12, pa: PO.CAST_A, pb: PO.CAST,
        onActive: (f) => spawnZone(Z_WALL, f, f.x + f.dir * 34, f.y, 6, 48, 180, 0),
        ai: 'Creates a wall in front of you for 3 seconds that stops opponent projectiles and blocks their path.',
        es: 'Muro de datos 3 s: frena proyectiles y el avance del rival.' }),
      mv({ slot: A_S4, id: 'data_leech', name: 'DATA LEECH', cost: 15, cd: 6, su: 9, ac: 10, re: 14, pa: PO.CAST_A, pb: PO.CAST,
        hb: [8, 36, 82, 10], h: HS(40, 16, 1, 0, { spark: R_HACK }), onHit: (f, o) => leechHit(f, o), range: [0, 90],
        ai: 'Beam up to 90px: 40 damage, steals 30 energy from the opponent and heals you 60.',
        es: 'Rayo (40): roba 30 de energía y cura 60.' }),
    ],
    ult: mv({ slot: A_ULT, id: 'system_crash', name: 'SYSTEM CRASH', level: 4, meter: ULT_COST, su: 18, ac: 20, re: 18, pa: PO.POWER, pb: PO.CAST, inv: 'all', invF: 20,
      onActive: (f, o) => systemCrash(f, o),
      ai: 'Ultimate: crashes the opponent system anywhere on screen: 120 damage, frozen 2.5 seconds and hacked 4 seconds. Fails only if they are knocked down or invulnerable.',
      es: 'Definitiva: congela al rival 2,5 s y lo hackea 4 s (120).' }),
  },
  {
    id: 'viper', name: 'VIPER', role: 'Asesina tóxica', roleAi: 'toxic assassin', hp: 900, speed: 1.85, pw: 1, reach: 2,
    look: { scale: 1, skin: C.SKA1, hair: C.PUR1, style: 'long', top: C.PUR1, pants: C.HAI2, boots: C.PUR0, sleeve: C.SKA1, glove: C.PUR1, eye: C.GRN2, gear: 'claws' },
    passive: 'VENENO: +25% de daño contra rivales envenenados; el veneno le da super.',
    passiveAi: 'Venom: +25% damage against a poisoned opponent; poison ticks build your super meter.',
    skills: [
      mv({ slot: A_S1, id: 'toxic_spit', name: 'TOXIC SPIT', cost: 15, cd: 2, su: 10, ac: 2, re: 14, pa: PO.SPIT_A, pb: PO.SPIT,
        proj: { kind: K_SPIT, x: 10, y: 38, vx: 3.6, vy: -2.2, g: 0.1, w: 8, h: 8, life: 140 },
        h: HS(25, 12, 1, 0, { fx: [[ST_POISON, 5, 1]], spark: R_TOX }),
        ai: 'Arcing venom blob, 25 damage and poison for 5 seconds.',
        es: 'Escupitajo en arco (25): envenena 5 s.' }),
      mv({ slot: A_S2, id: 'cloak', name: 'CLOAK', cost: 30, cd: 12, su: 8, ac: 2, re: 6, pa: PO.POWER, pb: PO.STANCE,
        onActive: (f) => addStatus(f, ST_CLOAK, 3.5, 1, f),
        ai: 'Become invisible for 3.5 seconds with +20% speed; your next hit deals +50% damage and ends the cloak.',
        es: 'Invisible 3,5 s; el siguiente golpe hace +50%.' }),
      mv({ slot: A_S3, id: 'venom_lash', name: 'VENOM LASH', cost: 20, cd: 3, su: 11, ac: 5, re: 16, pa: PO.THROW_A, pb: PO.LASH,
        hb: [14, 38, 58, 10], h: HS(55, 18, -3, 0, { fx: [[ST_SLOW, 2, 1]], spark: R_TOX }), range: [14, 72],
        ai: 'Mid-range whip (15-70px), 55 damage, pulls the opponent toward you and slows them.',
        es: 'Látigo a media distancia (55): atrae y ralentiza.' }),
      mv({ slot: A_S4, id: 'serpent_rise', name: 'SERPENT RISE', cost: 25, cd: 4, su: 4, ac: 12, re: 18, pa: PO.UPPER_A, pb: PO.UPPER, inv: 'all', invF: 12,
        vx: 1.2, vy: -6, hb: [0, 58, 22, 52], h: HS(75, 0, 1.5, -6.5, { fx: [[ST_POISON, 5, 1]], spark: R_TOX }), range: [0, 30],
        ai: 'Invulnerable rising uppercut, 75 damage and poison. Beats jump-ins and attacks at close range; very punishable if it misses.',
        es: 'Gancho ascendente invulnerable (75): antiaéreo.' }),
    ],
    ult: mv({ slot: A_ULT, id: 'neurotoxin', name: 'NEUROTOXIN', level: 4, meter: ULT_COST, su: 16, ac: 4, re: 16, pa: PO.SPIT_A, pb: PO.SPIT, inv: 'all', invF: 20,
      onActive: (f, o) => spawnZone(Z_CLOUD, f, o.x, GROUND, 124, 60, 240, 0),
      ai: 'Ultimate: toxic cloud 120px wide on the opponent for 4 seconds: 22 damage every half second, poison and slow.',
      es: 'Definitiva: nube tóxica sobre el rival durante 4 s.' }),
  },
  {
    id: 'pyra', name: 'PYRA', role: 'Mercenaria lanzallamas', roleAi: 'flamethrower mercenary', hp: 1000, speed: 1.5, pw: 1, reach: 0,
    look: { scale: 1, skin: C.SKA1, hair: C.RED1, style: 'mohawk', top: C.ORG1, pants: C.MET1, boots: C.HAI2, sleeve: C.ORG1, glove: C.MET1, eye: C.YEL2, gear: 'flamer' },
    passive: 'CALOR: cada skill de fuego suma 25 de calor; a 100 entra en SOBRECALENTAMIENTO (+30% de daño durante 4 s).',
    passiveAi: 'Heat: every fire skill adds 25 heat; at 100 heat you overheat for 4 seconds (+30% damage).',
    skills: [
      mv({ slot: A_S1, id: 'flame_burst', name: 'FLAME BURST', cost: 20, cd: 2, su: 8, ac: 24, re: 14, pa: PO.FLAME, pb: PO.FLAME, fire: true,
        hits: 4, every: 6, hb: [10, 40, 54, 20], h: HS(16, 10, 0.6, 0, { fx: [[ST_BURN, 4, 1]], spark: R_FIRE, bs: 8, gd: 5 }), range: [0, 62],
        ai: 'Flamethrower cone up to 60px, four hits of 16 damage, each adds burn stacks.',
        es: 'Lanzallamas (4 golpes de 16) que acumula quemadura.' }),
      mv({ slot: A_S2, id: 'napalm', name: 'NAPALM', cost: 25, cd: 4, su: 12, ac: 2, re: 14, pa: PO.THROW_A, pb: PO.THROW, fire: true,
        proj: { kind: K_GRENADE, x: 8, y: 42, vx: 3, vy: -4, g: 0.2, w: 7, h: 7, life: 160 },
        h: HS(45, 16, 2, -2, { fx: [[ST_BURN, 4, 1]], spark: R_FIRE }),
        ai: 'Arcing grenade, 45 damage, leaves a burning patch on the floor for 3 seconds.',
        es: 'Granada en arco (45): deja fuego en el suelo 3 s.' }),
      mv({ slot: A_S3, id: 'afterburner', name: 'AFTERBURNER', cost: 20, cd: 3, su: 6, ac: 16, re: 10, pa: PO.DASH, pb: PO.ROCKET, fire: true, air: true,
        vx: 5.5, vy: -4.2, hb: [-4, 44, 28, 40], h: HS(35, 16, 2.5, -3, { fx: [[ST_BURN, 4, 1]], spark: R_FIRE }), range: [0, 100],
        ai: 'Rocket dash diagonally up and forward, 35 damage and burn. Usable in the air; jumps over ground attacks.',
        es: 'Propulsión diagonal (35), también en el aire.' }),
      mv({ slot: A_S4, id: 'vent', name: 'VENT', cost: 30, cd: 10, su: 8, ac: 6, re: 12, pa: PO.POWER, pb: PO.POWER,
        onActive: (f, o) => ventHeat(f, o),
        ai: 'Vents heat: removes all your debuffs, heals 40 plus 30 per burn stack on the opponent, and pushes away a nearby opponent.',
        es: 'Libera calor: limpia tus estados, cura y empuja.' }),
    ],
    ult: mv({ slot: A_ULT, id: 'inferno', name: 'INFERNO', level: 4, meter: ULT_COST, su: 16, ac: 50, re: 16, pa: PO.POWER, pb: PO.FLAME, fire: true, inv: 'all', invF: 20,
      onActive: (f) => { for (let i = 0; i < 10; i++) spawnZone(Z_COLUMN, f, f.x + f.dir * (26 + i * 34), GROUND, 22, 70, 30, i * 5); },
      ai: 'Ultimate: ten fire columns erupt forward across the stage, 45 damage each and heavy burn.',
      es: 'Definitiva: diez columnas de fuego hacia delante (45 c/u).' }),
  },
];

/* Per-fighter move table indexed by action code (1..8). */
for (const def of FIGHTERS) {
  const n = normals(def.pw, def.reach, def.id === 'brick');
  def.moves = new Array(NACT).fill(null);
  def.moves[A_LIGHT] = n[0]; def.moves[A_HEAVY] = n[1]; def.moves[A_GRAB] = n[2];
  for (const s of def.skills) def.moves[s.slot] = s;
  def.moves[A_ULT] = def.ult;
}
