'use strict';

/* CPU controller backed by System One decision models: in-browser WebGPU
   models, Jev, or the local playground gateway (see decisionRequest in
   fight-web.js). Each decision is one
   `choice` question whose options are the actions currently available to the
   fighter; the chosen option becomes a short executor plan that writes f.input
   the same way the keyboard does. Decisions are pipelined: exactly one request
   is in flight per CPU whenever it can act, and the current plan keeps running
   while the next decision is computed, so the fighter never idles waiting. */

const PL_NONE = 0, PL_APPROACH = 1, PL_RETREAT = 2, PL_BLOCK = 3, PL_WAIT = 4, PL_JUMPIN = 5,
  PL_JUMPBACK = 6, PL_DASHIN = 7, PL_DASHBACK = 8, PL_ACT = 9;
const PLAN_FRAMES = [0, 30, 24, 30, 16, 50, 50, 14, 14, 24];

const AI_INSTRUCTIONS = "Choose the best action for `you` right now against `opponent`. Every listed attack reaches "
  + "`opponent` right now. Punish an opponent who is recovering with an attack, block or dodge `threats`, and cancel "
  + "into a stronger move when `combo` is present. Waiting, retreating and blocking without attacking build a passivity "
  + "penalty; attack or advance to avoid it, especially when `you.passivity` is present.";

const PROJ_NAMES = ['', 'electric bolt', 'sword wave', 'virus spike', 'venom blob', 'napalm grenade', 'ground shockwave', 'drone bullet'];

const aiShared = { onDecision: null };

function aiSetup(f, model, mode) {
  f.ai = {
    model, mode, busy: false, retryAt: 0, since: 0, plan: PL_NONE, planT: 0, code: 0, started: false,
    decisions: 0, totalMs: 0, lastMs: 0, lastChoice: '', lastProbs: null, lastOptions: 0, error: '', status: 'esperando',
    matchId: game.matchId,
  };
  f.aiLabel = '';
}

/* Game event hook (hits, projectiles, round start). Pipelined decisions
   already re-query as soon as the previous answer arrives, so events need no
   extra scheduling. */
function aiNotify(f, kind) {}

function aiCanDecide(f) {
  if (isActionable(f) && f.jolt <= 0) return true;
  if (f.state === S_ATTACK) return true;
  return burstReady(f);
}

function aiTick(f, o) {
  const ai = f.ai;
  if (!ai) return;
  const inp = f.input;
  inp.left = false; inp.right = false; inp.block = false;
  const tw = o.x >= f.x ? 1 : -1;
  const dist = Math.abs(o.x - f.x);
  switch (ai.plan) {
    case PL_APPROACH:
      if (tw > 0) inp.right = true; else inp.left = true;
      if (dist < 26) ai.planT = 0;
      break;
    case PL_RETREAT:
      if (tw > 0) inp.left = true; else inp.right = true;
      break;
    case PL_BLOCK:
      inp.block = true;
      if (o.state === S_ATTACK && ai.planT < 4 && ai.planT > 0) ai.planT += 2;
      break;
    case PL_JUMPIN: case PL_JUMPBACK: {
      const d = ai.plan === PL_JUMPIN ? tw : -tw;
      if (d > 0) inp.right = true; else inp.left = true;
      if (!ai.started) { inp.jump = 3; ai.started = true; }
      else if (f.onGround && f.state !== S_JUMP && ai.planT < PLAN_FRAMES[ai.plan] - 6) ai.planT = 0;
      break;
    }
    case PL_DASHIN: case PL_DASHBACK: {
      const d = ai.plan === PL_DASHIN ? tw : -tw;
      if (!ai.started) {
        if (d > 0) inp.right = true; else inp.left = true;
        inp.dash = 3; ai.started = true;
      }
      break;
    }
    case PL_ACT:
      inp.act = ai.code; inp.actT = 2;
      if (ai.code === A_BURST ? !burstReady(f) : (f.state === S_ATTACK && f.move === f.moves[ai.code] && f.stateT <= 2)) ai.planT = 0;
      break;
  }
  if (ai.plan !== PL_NONE) {
    ai.planT--;
    if (ai.planT <= 0) {
      if (ai.plan === PL_ACT) { inp.act = 0; inp.actT = 0; }
      ai.plan = PL_NONE;
    }
  }
  if (!ai.busy && game.phase === "fight" && performance.now() >= ai.retryAt && aiCanDecide(f)) aiRequest(f, o);
}

function aiFighterState(x, other) {
  switch (x.state) {
    case S_IDLE: return 'standing idle';
    case S_WALK: return (x.vx > 0) === (other.x > x.x) ? 'walking forward' : 'walking backward';
    case S_JUMP: return 'airborne (jumping)';
    case S_DASH: return 'dashing';
    case S_BLOCK: return 'blocking';
    case S_BLOCKSTUN: return 'in blockstun';
    case S_HITSTUN: return 'in hitstun (being hit)';
    case S_AIRHIT: return 'launched into the air';
    case S_DOWN: return 'knocked down (invulnerable)';
    case S_GETUP: return 'getting up (invulnerable)';
    case S_STUN: return x.st[ST_FREEZE] > 0 ? 'frozen (cannot act)' : 'stunned (cannot act)';
    case S_KO: return 'knocked out';
    case S_WIN: return 'celebrating';
    case S_ATTACK: {
      const m = x.move;
      if (!m) return 'attacking';
      const name = m.name.toLowerCase();
      if (x.phase === PH_SU) return `starting ${name} (hits in ${Math.max(1, m.su - x.phaseT)} frames)`;
      if (x.phase === PH_AC) return `${name} is active right now`;
      return `recovering from ${name} for ${Math.max(1, m.re - x.phaseT)} frames (punishable)`;
    }
  }
  return 'unknown';
}

function aiThreats(f, o) {
  const out = [];
  for (let i = 0; i < MAX_PROJ; i++) {
    const p = projs[i];
    if (!p.on || p.owner !== o.side) continue;
    const incoming = (p.vx > 0) === (f.x > p.x);
    if (!incoming) continue;
    const dx = Math.round(Math.abs(p.x - f.x));
    out.push(`${PROJ_NAMES[p.kind]} projectile ${dx}px away, incoming${p.ground ? ' along the ground (jump over it)' : ''}`);
  }
  for (let i = 0; i < MAX_ZONES; i++) {
    const z = zones[i];
    if (!z.on || z.delay > 0) continue;
    if (z.owner === o.side) {
      const near = Math.abs(z.x - f.x) < z.w / 2 + 10;
      if (z.kind === Z_STRIKE && z.t < 22 && near) out.push('a lightning strike is about to hit your position (move away or block)');
      else if (z.kind === Z_COLUMN && z.t < 12 && near) out.push('a fire column is about to erupt under you (move away or block)');
      else if (z.kind === Z_FIRE && near) out.push('you are standing in burning napalm (leave it)');
      else if (z.kind === Z_CLOUD && near) out.push('you are inside a toxic cloud (leave it)');
      else if (z.kind === Z_FIELD && Math.abs(o.x - f.x) < 40) out.push('the opponent has an electric field around them (keep distance)');
      else if (z.kind === Z_WALL) out.push('an enemy firewall blocks your projectiles and your path');
      else if (z.kind === Z_DRONE) out.push('an enemy drone is shooting at you');
    } else if (z.kind === Z_DRONE) out.push('your drone is shooting the opponent');
    else if (z.kind === Z_WALL) out.push('your firewall protects you from projectiles');
  }
  if (o.move && o.move.id === 'orbital_drop' && o.phase === PH_AC) out.push('the opponent is about to crash down on your position (move away)');
  return out;
}

/* Short, literal option texts without numbers: System One models read
   criteria literally and handle numbers poorly, and prompt length sets latency.
   Range, energy and cooldown checks happen in code before options are listed. */
const MOVE_TAGS = {
  light: "fast jab; interrupts and starts combos",
  heavy: "strong kick; slower combo starter",
  grab: "throw; beats a blocking opponent",
  arc_bolt: "fast projectile; zones at mid or far range",
  rail_dash: "dash strike through the opponent and projectiles",
  static_field: "electric aura that hurts a close opponent",
  overcharge: "self buff: speed, energy and shocking normals",
  thunderdome: "ultimate: lightning strikes on the opponent, hard to escape",
  iaido: "lunging sword strike; punishes from mid range",
  mirror_parry: "counter stance; beats an incoming melee attack or projectile",
  phantom_step: "invulnerable teleport behind the opponent",
  neon_crescent: "sword wave projectile",
  thousand_cuts: "ultimate: invulnerable dash combo at close or mid range",
  piston_punch: "armored punch; beats attacks at close range",
  ground_quake: "ground shockwave; the opponent must jump",
  iron_hide: "shield and super armor for a few seconds",
  magnet_pull: "unblockable pull of a grounded opponent into a stun",
  orbital_drop: "ultimate: crash down on the opponent position",
  hack_spike: "virus projectile; disables the opponent skills",
  sentry_drone: "drone that shoots the opponent over time",
  firewall: "wall that stops projectiles and approach",
  data_leech: "short beam; steals energy and heals you",
  system_crash: "ultimate: freezes and hacks the opponent anywhere",
  toxic_spit: "arcing poison projectile",
  cloak: "turn invisible; your next hit is stronger",
  venom_lash: "mid-range whip that pulls the opponent in",
  serpent_rise: "invulnerable uppercut; beats jump-ins, punishable on miss",
  neurotoxin: "ultimate: toxic cloud on the opponent",
  flame_burst: "short flamethrower that burns",
  napalm: "arcing grenade that leaves fire on the floor",
  afterburner: "rocket dash up and forward; jumps over ground attacks",
  vent: "clear your debuffs, heal and push a close opponent away",
  inferno: "ultimate: fire columns across the stage",
};

function aiMoveTag(f, m) {
  const tag = MOVE_TAGS[m.id] || m.ai.split(/[,.]/)[0];
  return m.id === "heavy" && m.armor ? `${tag}; armored` : tag;
}

function aiStatusNames(f) {
  const out = [];
  for (let i = 0; i < NST; i++) if (f.st[i] > 0) out.push(ST_INFO[i].max > 1 ? `${ST_INFO[i].en} x${f.stk[i]}` : ST_INFO[i].en);
  return out;
}

function aiBuild(f, o) {
  const criteria = {}, map = {};
  const add = (key, desc, plan, code) => { criteria[key] = desc; map[key] = { plan, code }; };
  const hidden = o.st[ST_CLOAK] > 0;
  const dist = Math.round(Math.abs(o.x - f.x));
  const threats = aiThreats(f, o);
  /* Under the heavy passivity penalty, with nothing incoming, stalling options are withheld. */
  const forced = f.passiveLv === 2 && !threats.length && o.state !== S_ATTACK;
  if (inHitState(f)) {
    if (burstReady(f)) add("burst", "spend 1 super bar to break out of the combo", PL_ACT, A_BURST);
    add("wait", "take the hit and keep your super bar", PL_WAIT, 0);
  } else {
    if (f.onGround && f.state !== S_ATTACK) {
      add("approach", "walk closer; reduces passivity", PL_APPROACH, 0);
      if (!forced) add("retreat", Math.min(f.x, STAGE_W - f.x) < 50 ? "walk back (you are near the wall); builds passivity" : "walk back; builds passivity", PL_RETREAT, 0);
      add("jump_in", "jump at the opponent; avoids ground attacks", PL_JUMPIN, 0);
      if (!forced) add("jump_back", "jump away; builds passivity", PL_JUMPBACK, 0);
      if (f.energy >= 10 && f.dashCd <= 0) {
        add("dash_in", "fast dash in; reduces passivity", PL_DASHIN, 0);
        if (!forced) add("dash_back", "fast dash away; builds passivity", PL_DASHBACK, 0);
      }
      if (!forced) add("block", f.guard < 35 ? "hold guard (your guard is almost broken); loses to throws; builds passivity" : "hold guard; loses to throws; builds passivity", PL_BLOCK, 0);
    }
    if (!forced || f.state === S_ATTACK) add("wait", f.passiveT >= PASSIVE_WARN ? "stay neutral; makes your passivity penalty worse" : "stay neutral; builds passivity", PL_WAIT, 0);
    for (let code = A_LIGHT; code <= A_ULT; code++) {
      const m = f.moves[code];
      if (!m || (!f.onGround && !m.air)) continue;
      if (!canUse(f, o, m)) continue;
      if (f.state === S_ATTACK && !(f.hitConfirmed && m.level > f.move.level)) continue;
      if (m.range && !hidden && (dist < m.range[0] || dist > m.range[1])) continue;
      add(m.id, aiMoveTag(f, m), PL_ACT, code);
    }
  }
  const you = { fighter: f.def.name, hp_percent: Math.round((100 * f.hp) / f.hpMax), super_bars: Math.floor(f.meter / 100), state: aiFighterState(f, o) };
  const mine = aiStatusNames(f);
  if (mine.length) you.statuses = mine;
  if (f.passiveLv === 2) you.passivity = "heavy passivity penalty: you take 30% more damage and lose health and super until you attack or advance";
  else if (f.passiveLv === 1) you.passivity = "passivity penalty: you take 15% more damage and lose super until you attack or advance";
  else if (f.passiveT >= PASSIVE_WARN) you.passivity = "warning: you have been passive; attack or advance now to avoid a penalty";
  const them = {
    fighter: o.def.name, hp_percent: Math.round((100 * o.hp) / o.hpMax),
    state: hidden ? "cloaked: invisible, position unknown" : aiFighterState(o, f),
  };
  const theirs = aiStatusNames(o);
  if (theirs.length) them.statuses = theirs;
  if (o.passiveLv > 0) them.passivity = "penalized for passivity: takes extra damage, pressure them";
  if (o.meter >= ULT_COST) them.ultimate_ready = true;
  const state = {
    you, opponent: them,
    range: hidden ? "unknown" : dist < 40 ? "close" : dist < 120 ? "mid" : "far",
  };
  if (!hidden && !o.onGround) state.opponent_airborne = true;
  if (threats.length) state.threats = threats;
  if (f.state === S_ATTACK && f.hitConfirmed) state.combo = "your hit connected: cancel into a stronger move now";
  return { criteria, map, state };
}

function aiSample(probs) {
  let total = 0;
  for (const k in probs) total += probs[k];
  let r = Math.random() * total;
  let last = '';
  for (const k in probs) { last = k; r -= probs[k]; if (r <= 0) return k; }
  return last;
}

function aiApply(f, entry) {
  const ai = f.ai;
  if (ai.plan === entry.plan && ai.code === entry.code) {
    ai.planT = Math.max(ai.planT, PLAN_FRAMES[entry.plan]);
    return;
  }
  ai.plan = entry.plan; ai.code = entry.code; ai.started = false;
  ai.planT = PLAN_FRAMES[entry.plan];
}

async function aiRequest(f, o) {
  const ai = f.ai;
  const built = aiBuild(f, o);
  const keys = Object.keys(built.criteria);
  if (keys.length < 2) { ai.retryAt = performance.now() + 100; return; }
  ai.busy = true; ai.status = 'pensando';
  if (!ai.since) ai.since = performance.now();
  const body = {
    model: ai.model, state: built.state,
    questions: { action: { type: 'choice', instructions: AI_INSTRUCTIONS, criteria: built.criteria } },
  };
  const t0 = performance.now();
  try {
    const payload = await decisionRequest(ai.model, body);
    if (f.ai !== ai || ai.matchId !== game.matchId) return;
    const ans = payload.answers && payload.answers.action;
    if (!ans || !ans.probabilities) throw new Error('La respuesta no trae answers.action');
    const pick = ai.mode === 'sample' ? aiSample(ans.probabilities) : ans.choice;
    const entry = built.map[pick] || built.map[ans.choice];
    if (entry) aiApply(f, entry);
    const ms = performance.now() - t0;
    ai.decisions++; ai.totalMs += ms; ai.lastMs = ms; ai.lastChoice = pick; ai.lastProbs = ans.probabilities;
    ai.lastOptions = keys.length; ai.error = ''; ai.status = 'listo'; ai.tokens = payload.usage ? payload.usage.input_tokens : null;
    f.aiLabel = `${pick.replace(/_/g, ' ')} ${Math.round((ans.probabilities[pick] || 0) * 100)}%`.toUpperCase();
  } catch (err) {
    if (f.ai !== ai) return;
    ai.error = err.message || String(err); ai.status = 'error';
    ai.retryAt = performance.now() + 1500;
    ai.plan = PL_WAIT; ai.planT = 30;
    f.aiLabel = 'SIN RESPUESTA';
  } finally {
    ai.busy = false;
    if (aiShared.onDecision) aiShared.onDecision(f);
  }
}

const PICK_INSTRUCTIONS = "You are a CPU player in the fighter selection screen of a real-time 2D fighting game. "
  + "Every option lists a fighter's health, speed, damage, passive and moves. `opponent` is the rival's current pick: "
  + "when its `status` is tentative the rival may still switch before the timer ends. You may switch too while "
  + "`seconds_left` is above zero; `your_current_pick` is locked in when time runs out. Pick the fighter with the best "
  + "chance to beat `opponent`, comparing range, speed, health, damage and how the kits counter each other. If the "
  + "opponent has not picked yet, pick the strongest all-round fighter. Each option ends with how that fighter compares "
  + "with the rival's current pick. If `previous_match` is present, keep a pick that won and switch away from one that "
  + "lost; avoid repeating `your_recent_picks` unless they clearly counter the rival.";

function aiFighterKit(def) {
  const clause = (text) => text.replace(/^Ultimate:\s*/, "").split(/[,.]/)[0].trim();
  return [...def.skills.map((m) => `${m.name.toLowerCase()}: ${clause(m.ai)}`), `ultimate ${def.ult.name.toLowerCase()}: ${clause(def.ult.ai)}`];
}

function aiFighterProfile(def) {
  return {
    fighter: def.name, role: def.roleAi, hp: def.hp, speed: def.speed, damage_multiplier: def.pw,
    passive: def.passiveAi, moves: aiFighterKit(def),
  };
}

function aiCompare(a, b, more, less) {
  return a > b ? more : a < b ? less : null;
}

/* Objective comparison of `def` against the rival's pick, built from roster data. */
function aiMatchup(def, rival) {
  if (!rival) return "";
  if (def === rival) return ` Against ${rival.name}: mirror match.`;
  const facts = [
    aiCompare(def.speed, rival.speed, `faster (${def.speed} vs ${rival.speed})`, `slower (${def.speed} vs ${rival.speed})`),
    aiCompare(def.hp, rival.hp, `more health (${def.hp} vs ${rival.hp})`, `less health (${def.hp} vs ${rival.hp})`),
    aiCompare(def.pw, rival.pw, `more damage (x${def.pw} vs x${rival.pw})`, `less damage (x${def.pw} vs x${rival.pw})`),
    aiCompare(def.reach, rival.reach, "longer normals", "shorter normals"),
  ].filter(Boolean);
  return ` Against ${rival.name}: ${facts.length ? facts.join(", ") : "even stats"}.`;
}

function aiRosterDescription(def, rival) {
  return `${def.name}, ${def.roleAi}: ${def.hp} HP, speed ${def.speed}, damage x${def.pw}. ${def.passiveAi} Moves: ${aiFighterKit(def).join("; ")}.${aiMatchup(def, rival)}`;
}

/* Samples an option after flattening the distribution with p^(1/temperature). */
function aiSampleTemperature(probs, temperature) {
  const flat = {};
  for (const k in probs) flat[k] = Math.pow(Math.max(probs[k], 1e-12), 1 / temperature);
  return aiSample(flat);
}

/* Asks the CPU's model which fighter to play during the selection window.
   `q.opponent` is the rival's current pick (null if none yet), `q.opponentLocked`
   tells whether it can still change, `q.current` is this side's own tentative
   pick (null on the first query), `q.previous` summarizes the last match and
   `q.recent` lists this side's last locked picks. The pick is always sampled
   from the model distribution flattened by `q.temperature`. */
async function aiPickFighter(q) {
  const criteria = {};
  for (const def of FIGHTERS) criteria[def.id] = aiRosterDescription(def, q.opponent);
  const state = {
    you: `CPU player ${q.side + 1}`,
    your_current_pick: q.current ? q.current.name : "none yet",
    opponent: q.opponent
      ? { controller: q.opponentHuman ? "human" : "CPU", status: q.opponentLocked ? "locked, will not change" : "tentative, may still change", ...aiFighterProfile(q.opponent) }
      : "not chosen yet",
    seconds_left: Math.max(0, Math.round(q.secondsLeft * 10) / 10),
  };
  if (q.previous) state.previous_match = q.previous;
  if (q.recent && q.recent.length) state.your_recent_picks = q.recent;
  const body = { model: q.model, state, questions: { fighter: { type: "choice", instructions: PICK_INSTRUCTIONS, criteria } } };
  const t0 = performance.now();
  const payload = await decisionRequest(q.model, body);
  const ans = payload.answers && payload.answers.fighter;
  if (!ans || !ans.probabilities) throw new Error("La respuesta no trae answers.fighter");
  const pick = aiSampleTemperature(ans.probabilities, q.temperature || 1);
  const index = FIGHTERS.findIndex((def) => def.id === pick);
  if (index < 0) throw new Error(`El modelo eligió un luchador desconocido: ${pick}`);
  return {
    index, id: pick, probs: ans.probabilities, confidence: ans.confidence, ms: performance.now() - t0, model: q.model,
    tokens: payload.usage ? payload.usage.input_tokens : null,
  };
}

async function aiWarmup(model) {
  const body = { state: 'warmup', questions: { ready: { type: 'noul', instructions: 'Is this a warmup request?' } } };
  return decisionRequest(model, body);
}

async function aiHealth() {
  const res = await fetch('/health', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
