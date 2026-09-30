'use strict';

/* Menu, side panels, keyboard input and the fixed-timestep main loop. */

const STORE_KEY = 'neon-clash-v1';
const SKILL_KEYS = ['U', 'I', 'O', 'P', 'Espacio'];
const ACT_KEYS = { KeyJ: A_LIGHT, KeyK: A_HEAVY, KeyL: A_GRAB, KeyU: A_S1, KeyI: A_S2, KeyO: A_S3, KeyP: A_S4, Space: A_ULT, KeyE: A_BURST };
const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

const $ = (sel, root = document) => root.querySelector(sel);
const ui = {
  menu: $('#menu'), pause: $('#pause'), result: $('#result'),
  start: $('#start'), resume: $('#resume'), quit: $('#quit'), rematch: $('#rematch'), toMenu: $('#to-menu'),
  decision: $('#decision-mode'), status: $('#ollama-status'),
  jevKey: $("#jev-key"), jevConnect: $("#jev-connect"), jevClear: $("#jev-clear"), jevStatus: $("#jev-status"),
  resultTitle: $('#result-title'), resultSub: $('#result-sub'),
  modeBtns: Array.from(document.querySelectorAll('[data-mode]')),
  sides: [0, 1].map((i) => {
    const root = $(`#side-${i}`);
    return {
      root, roster: $('.roster', root), model: $('.model', root), modelRow: $('.model-row', root), detail: $('.detail', root), who: $('.who', root),
      pickRow: $(".pick-row", root), pickToggle: $(".cpu-picks", root),
    };
  }),
  panels: [$('#panel-0'), $('#panel-1')],
  optSfx: $("#opt-sfx"), optMusic: $("#opt-music"), optVolume: $("#opt-volume"), optTouch: $("#opt-touch"),
  btnPause: $("#btn-pause"), btnSfx: $("#btn-sfx"), btnMusic: $("#btn-music"), btnFull: $("#btn-full"), btnPanel: $("#btn-panel"),
  touch: $("#touch"),
  loading: $("#loading"), loadingList: $("#loading-list"), loadingError: $("#loading-error"), loadingBack: $("#loading-back"),
  select: $("#select"), selectTimer: $("#select-timer"), selectSides: [$("#sel-0"), $("#sel-1")], selectLock: $("#select-lock"),
};

const cfg = loadConfig();
let models = [];
let healthTimer = null;
const cpuPick = [null, null];
let lastMatch = null;
let picking = false;
const PORTRAITS = [];
const SELECT_SECONDS = 30;
const REQUERY_MS = 3000;
const PICK_TEMPERATURE = 1.6;
const recentPicks = [[], []];

function loadConfig() {
  const base = { mode: 'hvc', pick: [0, 3], model: ['', ''], decision: 'argmax', cpuPicks: [true, true], touch: 'auto' };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      if (saved.mode === 'hvc' || saved.mode === 'cvc') base.mode = saved.mode;
      if (Array.isArray(saved.pick)) base.pick = saved.pick.map((v, i) => (Number.isInteger(v) && v >= 0 && v < FIGHTERS.length ? v : base.pick[i])).slice(0, 2);
      if (Array.isArray(saved.model)) base.model = saved.model.map((v) => (typeof v === 'string' ? v : '')).slice(0, 2);
      if (saved.decision === 'sample' || saved.decision === 'argmax') base.decision = saved.decision;
      if (saved.touch === 'auto' || saved.touch === 'on' || saved.touch === 'off') base.touch = saved.touch;
      if (Array.isArray(saved.cpuPicks)) base.cpuPicks = [0, 1].map((i) => (typeof saved.cpuPicks[i] === "boolean" ? saved.cpuPicks[i] : true));
    }
  } catch (err) { /* storage unavailable: defaults */ }
  return base;
}
function saveConfig() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (err) { /* storage unavailable */ }
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

/* Renders one fighter in its stance into a small canvas using the game renderer. */
function renderPortrait(def, canvas) {
  const pw = 80, ph = 78;
  const f = makeFighter(0, def, false);
  f.x = 40; f.y = 70;
  clear(C.SKY1);
  setOffset(0, 0);
  rect(0, 70, pw, 8, C.MET0);
  hline(0, 70, pw, C.MET1);
  drawFighter(f);
  canvas.width = pw; canvas.height = ph;
  const c2 = canvas.getContext('2d');
  const data = c2.createImageData(pw, ph);
  const view = new Uint32Array(data.data.buffer);
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) view[y * pw + x] = LUT[fb[y * W + x]];
  c2.putImageData(data, 0, 0);
}

function buildRosters() {
  for (let side = 0; side < 2; side++) {
    const roster = ui.sides[side].roster;
    roster.replaceChildren();
    FIGHTERS.forEach((def, i) => {
      const canvas = document.createElement('canvas');
      renderPortrait(def, canvas);
      if (side === 0) PORTRAITS[i] = canvas;
      const btn = el('button', {
        type: 'button', class: 'fighter', role: 'option', 'aria-label': `${def.name}: ${def.role}`,
        onclick: () => { if (cpuChooses(side)) return; cfg.pick[side] = i; saveConfig(); refreshMenu(); preview(); },
      }, [canvas, el('span', { text: def.name })]);
      roster.append(btn);
    });
  }
}

function renderDetail(side) {
  const def = FIGHTERS[cfg.pick[side]];
  const items = def.skills.map((m, k) => el('li', {}, [
    el('span', { class: 'k', text: SKILL_KEYS[k] }),
    el('span', {}, [el('span', { class: 'n', text: m.name }), ' ', el('span', { class: 'c', text: `${m.cost} en · ${m.cd}s` }), el('br'), el('span', { class: 'd', text: m.es })]),
  ]));
  items.push(el('li', {}, [
    el('span', { class: 'k', text: 'Esp' }),
    el('span', {}, [el('span', { class: 'n', text: def.ult.name }), ' ', el('span', { class: 'c', text: '2 barras' }), el('br'), el('span', { class: 'd', text: def.ult.es })]),
  ]));
  const pick = cpuPick[side];
  const note = !cpuChooses(side) ? null
    : pick && pick.index === cfg.pick[side]
      ? `Última elección de la CPU con ${pick.model} (${Math.round((pick.probs[pick.id] || 0) * 100)}%). En la próxima pelea elige de nuevo en la pantalla de selección.`
      : `La CPU elegirá en la pantalla de selección (${SELECT_SECONDS} s), viendo la elección del rival.`;
  ui.sides[side].detail.replaceChildren(
    ...(note ? [el("p", { class: "pick-note", text: note })] : []),
    el('p', { class: 'role', text: `${def.name} · ${def.role}` }),
    el('div', { class: 'stats' }, [
      el('span', {}, ['Vida ', el('b', { text: String(def.hp) })]),
      el('span', {}, ['Velocidad ', el('b', { text: def.speed.toFixed(2) })]),
      el('span', {}, ['Daño ', el('b', { text: `x${def.pw}` })]),
    ]),
    el('p', { class: 'passive', text: def.passive }),
    el('ul', {}, items),
  );
}

function isCpu(side) { return side === 1 || cfg.mode === 'cvc'; }
function cpuChooses(side) { return isCpu(side) && cfg.cpuPicks[side]; }

function mb(bytes) { return `${Math.round(bytes / 1e6)} MB`; }

function fillModelSelect(side) {
  const sel = ui.sides[side].model;
  const option = (m) => el("option", {
    value: m.name,
    text: m.backend === "web"
      ? [m.label, m.parameter_size, m.quantization_level, m.cached ? "cargado" : `descarga ${mb(m.size_bytes)}`].filter(Boolean).join(" · ")
      : [m.name, m.parameter_size, m.quantization_level, m.loaded ? "cargado" : null].filter(Boolean).join(" · "),
  });
  const groups = [["web", "Navegador · WebGPU (se descarga una vez)"], ["ollama", "Ollama · GGUF (servidor local)"], ["mlx", "MLX · en el playground"], ["jev", "Jev · TypeSafe (nube)"]]
    .map(([backend, label]) => [label, models.filter((m) => m.backend === backend)])
    .filter(([, items]) => items.length)
    .map(([label, items]) => el("optgroup", { label }, items.map(option)));
  sel.replaceChildren(...(groups.length ? groups : [el("option", { value: "", text: "Sin modelos de decisión" })]));
  const names = models.map((m) => m.name);
  if (!names.includes(cfg.model[side])) {
    const webNames = models.filter((m) => m.backend === "web").sort((x, y) => x.size_bytes - y.size_bytes).map((m) => m.name);
    cfg.model[side] = webNames[side % Math.max(webNames.length, 1)] || names[0] || '';
  }
  sel.value = cfg.model[side];
  sel.disabled = models.length === 0;
}

function refreshMenu() {
  for (const b of ui.modeBtns) b.setAttribute('aria-checked', String(b.dataset.mode === cfg.mode));
  for (let side = 0; side < 2; side++) {
    const s = ui.sides[side], cpu = isCpu(side);
    s.who.textContent = cpu ? 'CPU' : 'Humano';
    s.who.classList.toggle('human', !cpu);
    s.modelRow.hidden = !cpu;
    s.pickRow.hidden = !cpu;
    s.pickToggle.checked = cfg.cpuPicks[side];
    const locked = cpuChooses(side);
    s.roster.classList.toggle("locked", locked);
    Array.from(s.roster.children).forEach((btn, i) => {
      btn.setAttribute('aria-selected', String(i === cfg.pick[side]));
      btn.setAttribute("aria-disabled", String(locked));
      btn.title = locked ? "La CPU elige su luchador" : "";
    });
    renderDetail(side);
  }
  ui.decision.value = cfg.decision;
  const needModel = [0, 1].some((side) => isCpu(side) && !cfg.model[side]);
  ui.start.disabled = needModel || picking;
}

async function refreshHealth() {
  const parts = [];
  let local = [];
  try {
    if (!backend.probe) throw new Error('sin servidor local');
    const h = await aiHealth();
    backend.local = true;
    const ollama = h.ollama && h.ollama.reachable ? h.ollama.models || [] : [];
    const mlx = ((h.mlx && h.mlx.models) || []).filter((m) => m.available);
    backend.localJev = !!(h.jev && h.jev.configured);
    const jev = backend.localJev ? h.jev.models : [];
    local = [
      ...ollama.map((m) => ({ ...m, backend: "ollama" })),
      ...mlx.map((m) => ({ ...m, backend: "mlx" })),
      ...jev.map((name) => ({ name, backend: "jev", quantization_level: "nube" })),
    ];
    parts.push(h.ollama && h.ollama.reachable
      ? `Ollama ${h.ollama.version || ""} · ${ollama.length} modelo(s)`
      : `Ollama no responde en ${(h.ollama && h.ollama.url) || "http://127.0.0.1:11434"}`);
    if (mlx.length) parts.push(`MLX · ${mlx.length} modelo(s)`);
    renderJevStatus(h.jev);
  } catch (err) {
    if (/HTTP 40[45]/.test(err.message)) backend.probe = false;
    backend.local = false; backend.localJev = false;
    renderJevStatus(null);
  }
  const gpu = !!(web.caps && web.caps.webgpu);
  const webList = gpu ? web.specs.map((spec) => ({
    name: spec.id, backend: "web", label: spec.label, parameter_size: spec.params, quantization_level: spec.quant,
    size_bytes: spec.bytes, cached: web.loaded.has(spec.id),
  })) : [];
  const jevBrowser = backend.local ? [] : backend.jevModels.map((name) => ({ name, backend: "jev", quantization_level: "nube" }));
  models = [...webList, ...local, ...jevBrowser];
  parts.unshift(gpu ? `Navegador (WebGPU) · ${webList.length} modelo(s)` : "Este navegador no tiene WebGPU: los modelos en el navegador no están disponibles (usa Chrome, Edge, Safari o Firefox reciente)");
  ui.status.textContent = models.length ? `${parts.join(" | ")}: ${models.map((m) => m.label || m.name).join(", ")}` : `${parts.join(" | ")}. No hay modelos de decisión.`;
  ui.status.className = models.length ? "status ok" : "status bad";
  fillModelSelect(0); fillModelSelect(1);
  refreshMenu();
}

function renderJevStatus(jev) {
  if (jev) {
    ui.jevKey.placeholder = "Queda solo en la memoria del servidor local";
    ui.jevStatus.textContent = jev.configured
      ? `Jev conectado (${jev.source === "env" ? "desde TYPESAFE_API_KEY" : "key cargada en esta sesión"}): ${jev.models.join(", ")}. Cada decisión se factura según TypeSafe.`
      : jev.error ? `Jev: ${jev.error}` : "Sin API key: Jev no participa.";
    ui.jevStatus.className = `status ${jev.configured ? "ok" : jev.error ? "bad" : ""}`;
    return;
  }
  ui.jevKey.placeholder = "Se guarda solo en este navegador";
  ui.jevStatus.textContent = backend.jevModels.length
    ? `Jev conectado con tu key (guardada solo en este navegador): ${backend.jevModels.join(", ")}. Cada decisión se factura a tu cuenta de TypeSafe.`
    : backend.jevError ? `Jev: ${backend.jevError}` : "Sin API key: Jev no participa. Si cargas tu key, se guarda solo en este navegador.";
  ui.jevStatus.className = `status ${backend.jevModels.length ? "ok" : backend.jevError ? "bad" : ""}`;
}

async function setJevKey(apiKey) {
  ui.jevConnect.disabled = true; ui.jevClear.disabled = true;
  ui.jevStatus.textContent = apiKey ? "Validando la API key con TypeSafe…" : "Quitando la API key…";
  try {
    if (backend.local) {
      const res = await fetch("/v1/jev/key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: apiKey }) });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.detail || `HTTP ${res.status}`);
    } else if (apiKey) {
      backend.jevModels = await jevValidate(apiKey);
      backend.jevError = "";
      setJevKeyLocal(apiKey);
    } else {
      backend.jevModels = []; backend.jevError = "";
      setJevKeyLocal("");
    }
    ui.jevKey.value = "";
  } catch (err) {
    backend.jevError = err.message;
    ui.jevStatus.textContent = `No se pudo configurar Jev: ${err.message}`;
    ui.jevStatus.className = "status bad";
  } finally {
    ui.jevConnect.disabled = false; ui.jevClear.disabled = false;
  }
  await refreshHealth();
}

/* Downloads and initializes every browser model a CPU side uses, with a progress overlay. */
function loadWebModels(names) {
  if (!names.length) return Promise.resolve(true);
  ui.loading.hidden = false; ui.loadingError.textContent = ""; ui.loadingBack.hidden = true;
  const rows = new Map();
  ui.loadingList.replaceChildren(...names.map((name) => {
    const spec = webSpec(name);
    const fill = el("span", { class: "fill" });
    const info = el("span", { class: "pct", text: web.loaded.has(name) ? "listo" : "…" });
    rows.set(name, { fill, info, spec });
    return el("div", { class: "load-row" }, [el("span", { class: "name", text: spec ? spec.label : name }), el("span", { class: "track" }, fill), info]);
  }));
  web.onProgress = (m) => {
    const r = rows.get(m.id);
    if (!r) return;
    const frac = m.total ? Math.min(1, m.loaded / m.total) : 0;
    r.fill.style.width = `${(frac * 100).toFixed(1)}%`;
    r.info.textContent = frac >= 1 ? "iniciando…" : `${mb(m.loaded)} / ${mb(m.total)}`;
  };
  return Promise.all(names.map((name) => webLoad(name).then((res) => {
    const r = rows.get(name);
    r.fill.style.width = "100%";
    r.info.textContent = `listo en ${(res.ms / 1000).toFixed(1)} s`;
  }))).then(() => {
    web.onProgress = null;
    ui.loading.hidden = true;
    return true;
  }).catch((err) => {
    web.onProgress = null;
    ui.loadingError.textContent = `No se pudo cargar el modelo: ${err.message}`;
    ui.loadingBack.hidden = false;
    return false;
  });
}

function preview() {
  setupFighters(FIGHTERS[cfg.pick[0]], FIGHTERS[cfg.pick[1]], false, false);
  clearPools();
  game.phase = 'attract'; game.phaseT = 0; game.announceT = 0; game.superT = 0; game.glitchT = 0;
  renderPanels();
}

function setInMatch(on) {
  document.body.classList.toggle('in-match', on);
  document.body.classList.toggle('human-p1', on && !isCpu(0));
  if (!on) document.body.classList.remove('panel-open');
}

function showMenu() {
  setInMatch(false);
  playMusic(0);
  game.paused = false;
  ui.pause.hidden = true; ui.result.hidden = true; ui.menu.hidden = false;
  game.matchId++;
  preview();
  refreshHealth();
  clearInterval(healthTimer);
  healthTimer = setInterval(refreshHealth, 10000);
}

function previousMatch(side) {
  if (!lastMatch) return null;
  const outcome = lastMatch.winner < 0 ? "draw" : lastMatch.winner === side ? "you won" : "you lost";
  return {
    your_fighter: lastMatch.fighters[side], opponent_fighter: lastMatch.fighters[1 - side],
    result: outcome, score: `${lastMatch.wins[side]}-${lastMatch.wins[1 - side]}`,
  };
}

/* Fighter selection window. Every CPU side that picks its own fighter queries
   its model in parallel; each answer becomes that side's tentative pick and is
   shown to the rival in its next query. A side re-queries at once when the
   rival's pick changed and otherwise every REQUERY_MS. The countdown starts once
   every side has a first answer (so model loading does not eat the window); the
   picks lock at zero or on "Bloquear ya", and later answers are discarded. */
function runSelection() {
  const choosers = [0, 1].filter(cpuChooses);
  if (!choosers.length) return Promise.resolve();
  const sel = {
    deadline: 0, locked: false, force: false,
    sides: [0, 1].map((side) => ({
      chooses: cpuChooses(side), busy: false, answered: !cpuChooses(side), revisions: 0,
      seenOpp: -2, retryAt: 0, answeredAt: 0, error: "", dirty: true, history: [],
    })),
  };
  ui.selectLock.onclick = () => { sel.force = true; };
  for (const side of choosers) cpuPick[side] = null;
  ui.select.hidden = false;
  const query = (side) => {
    const s = sel.sides[side], other = 1 - side, o = sel.sides[other];
    const oppPick = o.answered ? cfg.pick[other] : -1;
    s.busy = true; s.seenOpp = oppPick; s.dirty = true;
    const secondsLeft = sel.deadline ? (sel.deadline - performance.now()) / 1000 : SELECT_SECONDS;
    aiPickFighter({
      model: cfg.model[side], side, opponent: oppPick >= 0 ? FIGHTERS[oppPick] : null, opponentHuman: !isCpu(other),
      opponentLocked: !o.chooses, current: s.revisions ? FIGHTERS[cfg.pick[side]] : null, secondsLeft,
      previous: previousMatch(side), recent: recentPicks[side], temperature: PICK_TEMPERATURE,
    }).then((r) => {
      if (sel.locked) return;
      cpuPick[side] = r; cfg.pick[side] = r.index; s.revisions++; s.error = "";
      if (!s.history.length || s.history[s.history.length - 1] !== r.index) s.history.push(r.index);
    }).catch((err) => {
      if (sel.locked) return;
      s.error = err.message || String(err); s.retryAt = performance.now() + 1000; s.seenOpp = -2;
      if (!cpuPick[side]) cpuPick[side] = { error: s.error, model: cfg.model[side], index: cfg.pick[side] };
    }).finally(() => {
      s.busy = false; s.answered = true; s.answeredAt = performance.now();
      for (const x of sel.sides) x.dirty = true;
    });
  };
  return new Promise((resolve) => {
    const step = () => {
      const now = performance.now();
      if (!sel.deadline && sel.sides.every((x) => x.answered)) sel.deadline = now + SELECT_SECONDS * 1000;
      if (sel.deadline && !sel.force) {
        const left = Math.ceil((sel.deadline - now) / 1000);
        if (left <= 5 && left > 0 && left !== sel.lastTick) { sel.lastTick = left; sfx('tick'); }
      }
      if (sel.force || (sel.deadline && now >= sel.deadline)) {
        sel.locked = true;
        sfx('lock');
        for (const x of sel.sides) x.dirty = true;
        renderSelect(sel);
        saveConfig();
        setTimeout(() => { ui.select.hidden = true; resolve(); }, 900);
        return;
      }
      for (const side of choosers) {
        const s = sel.sides[side], other = 1 - side;
        if (s.busy || now < s.retryAt) continue;
        const oppPick = sel.sides[other].answered ? cfg.pick[other] : -1;
        if (s.revisions > 0 && oppPick === s.seenOpp && now - s.answeredAt < REQUERY_MS) continue;
        query(side);
      }
      renderSelect(sel);
      setTimeout(step, 100);
    };
    step();
  });
}

function renderSelect(sel) {
  ui.selectTimer.textContent = sel.locked ? "¡Luchadores bloqueados!"
    : sel.deadline ? `Bloqueo en ${Math.max(0, (sel.deadline - performance.now()) / 1000).toFixed(1)} s`
      : "Esperando la primera elección de cada modelo…";
  ui.selectTimer.classList.toggle("locked", sel.locked);
  for (let side = 0; side < 2; side++) {
    const s = sel.sides[side];
    if (!s.dirty) continue;
    s.dirty = false;
    const def = FIGHTERS[cfg.pick[side]], cpu = isCpu(side), pick = cpuPick[side];
    const big = document.createElement("canvas");
    big.width = 80; big.height = 78;
    big.getContext("2d").drawImage(PORTRAITS[cfg.pick[side]], 0, 0);
    let line;
    if (!s.chooses) line = cpu ? "Luchador fijo: elegido en el menú" : "Humano: elegido en el menú";
    else if (!s.answered) line = s.busy ? "Pensando la primera elección…" : "Esperando…";
    else line = `${s.revisions} respuesta(s)${pick && pick.ms ? ` · última ${Math.round(pick.ms)} ms` : ""}${s.busy && !sel.locked ? " · pensando…" : ""}`;
    const nodes = [
      el("h3", {}, [`P${side + 1} · ${cpu ? "CPU" : "Humano"}`, cpu ? el("span", { class: "badge cpu", text: cfg.model[side] }) : null,
        sel.locked ? el("span", { class: "badge locked", text: "BLOQUEADO" }) : null]),
      el("div", { class: "sel-main" }, [big, el("div", {}, [
        el("div", { class: "sel-name", text: def.name }),
        el("div", { class: "kv", text: def.role }),
        el("div", { class: "kv", text: `Vida ${def.hp} · Velocidad ${def.speed.toFixed(2)} · Daño x${def.pw}` }),
        el("div", { class: "kv", text: line }),
      ])]),
    ];
    if (s.history.length > 1) nodes.push(el("div", { class: "kv", text: `Cambios: ${s.history.map((i) => FIGHTERS[i].name).join(" → ")}` }));
    if (s.error) nodes.push(el("div", { class: "kv error", text: s.error }));
    if (pick && pick.probs) {
      const entries = Object.entries(pick.probs).sort((a, b) => b[1] - a[1]);
      nodes.push(el("div", { class: "bars" }, entries.map(([k, v]) => {
        const fill = el("span", { class: "fill" });
        fill.style.width = `${(v * 100).toFixed(1)}%`;
        const name = FIGHTERS.find((d) => d.id === k).name;
        return el("div", { class: `bar${k === pick.id ? " top" : ""}` }, [
          el("span", { class: "name", text: name }),
          el("span", { class: "track", role: "img", "aria-label": `${name}: ${(v * 100).toFixed(1)}%` }, fill),
          el("span", { class: "pct", text: `${(v * 100).toFixed(1)}%` }),
        ]);
      })));
    }
    ui.selectSides[side].replaceChildren(...nodes);
  }
}

async function beginMatch() {
  if (picking) return;
  picking = true;
  clearInterval(healthTimer);
  ui.start.disabled = true; ui.rematch.disabled = true;
  ui.menu.hidden = true; ui.result.hidden = true; ui.pause.hidden = true;
  const needed = [...new Set([0, 1].filter(isCpu).map((side) => cfg.model[side]).filter(isWebModel))];
  if (!(await loadWebModels(needed))) {
    picking = false; ui.rematch.disabled = false;
    return;
  }
  try {
    await runSelection();
  } finally {
    picking = false;
    ui.rematch.disabled = false;
    refreshMenu();
  }
  clearInterval(healthTimer);
  ui.menu.hidden = true; ui.result.hidden = true; ui.pause.hidden = true;
  game.paused = false;
  startMatch(FIGHTERS[cfg.pick[0]], FIGHTERS[cfg.pick[1]], isCpu(0), isCpu(1));
  setInMatch(true);
  playMusic(1);
  labelTouchButtons();
  const warm = new Set();
  for (let side = 0; side < 2; side++) {
    const f = game.fighters[side];
    if (!f.cpu) continue;
    aiSetup(f, cfg.model[side], cfg.decision);
    f.ai.status = 'cargando modelo';
    warm.add(cfg.model[side]);
  }
  for (const model of warm) {
    aiWarmup(model).then(() => {
      for (const f of game.fighters) if (f.cpu && f.ai && f.ai.model === model && f.ai.status === 'cargando modelo') f.ai.status = 'listo';
      renderPanels();
    }).catch((err) => {
      for (const f of game.fighters) if (f.cpu && f.ai && f.ai.model === model) { f.ai.status = 'error'; f.ai.error = err.message; }
      renderPanels();
    });
  }
  renderPanels();
  screenEl.focus();
}

function renderPanel(side) {
  const f = game.fighters[side], root = ui.panels[side];
  if (!f) { root.replaceChildren(); return; }
  const label = `P${side + 1} · ${f.def.name}`;
  if (!f.cpu) {
    root.replaceChildren(
      el('h3', {}, [label, el('span', { class: 'badge human', text: 'HUMANO' })]),
      el('div', { class: 'kv', text: f.def.role }),
      el('div', { class: 'kv', text: f.def.passive }),
    );
    return;
  }
  const ai = f.ai;
  const nodes = [el('h3', {}, [label, el('span', { class: 'badge cpu', text: 'CPU' })])];
  if (!ai) {
    nodes.push(el('div', { class: 'kv', text: 'Vista previa del menú.' }));
    root.replaceChildren(...nodes);
    return;
  }
  nodes.push(el('div', { class: 'kv' }, ['Modelo: ', el('strong', { text: ai.model })]));
  const pick = cpuPick[side];
  if (pick && pick.error) nodes.push(el("div", { class: "kv error", text: `No pudo elegir luchador: ${pick.error}` }));
  else if (pick && pick.index === FIGHTERS.indexOf(f.def)) {
    const others = Object.entries(pick.probs).filter(([k]) => k !== pick.id).sort((a, b) => b[1] - a[1]).slice(0, 2)
      .map(([k, v]) => `${FIGHTERS.find((d) => d.id === k).name} ${Math.round(v * 100)}%`).join(", ");
    nodes.push(el("div", { class: "kv" }, ["Eligió ", el("strong", { text: `${f.def.name} ${Math.round((pick.probs[pick.id] || 0) * 100)}%` }), ` en ${Math.round(pick.ms)} ms · siguen ${others}`]));
  }
  nodes.push(el('div', { class: 'kv' }, ['Decisión: ', el('strong', { text: ai.mode === 'sample' ? 'muestreo' : 'más probable' }), ' · estado: ', el('strong', { text: ai.status })]));
  if (ai.decisions) {
    const avg = ai.totalMs / ai.decisions;
    const rate = ai.since ? ai.decisions / Math.max((performance.now() - ai.since) / 1000, 0.001) : 0;
    nodes.push(el('div', { class: 'kv', text: `${ai.decisions} decisiones · ${rate.toFixed(1)} por segundo · última ${Math.round(ai.lastMs)} ms · media ${Math.round(avg)} ms · ${ai.lastOptions} opciones${ai.tokens ? ` · ${ai.tokens} tokens` : ''}` }));
  }
  if (ai.error) nodes.push(el('div', { class: 'kv error', text: ai.error }));
  if (ai.lastChoice) nodes.push(el('div', { class: 'choice' }, ['Elección: ', el('strong', { text: ai.lastChoice })]));
  if (ai.lastProbs) {
    const entries = Object.entries(ai.lastProbs).sort((a, b) => b[1] - a[1]).slice(0, 7);
    nodes.push(el('div', { class: 'bars' }, entries.map(([k, v]) => {
      const fill = el('span', { class: 'fill' });
      fill.style.width = `${(v * 100).toFixed(1)}%`;
      return el('div', { class: `bar${k === ai.lastChoice ? ' top' : ''}` }, [
        el('span', { class: 'name', text: k, title: k }),
        el('span', { class: 'track', role: 'img', 'aria-label': `${k}: ${(v * 100).toFixed(1)}%` }, fill),
        el('span', { class: 'pct', text: `${(v * 100).toFixed(1)}%` }),
      ]);
    })));
  }
  root.replaceChildren(...nodes);
}
function renderPanels() { renderPanel(0); renderPanel(1); }

let panelQueued = false;
aiShared.onDecision = () => {
  if (panelQueued) return;
  panelQueued = true;
  requestAnimationFrame(() => { panelQueued = false; renderPanels(); });
};

game.onMatchEnd = (winner) => {
  const a = game.fighters[0], b = game.fighters[1];
  lastMatch = { fighters: [a.def.name, b.def.name], wins: [a.wins, b.wins], winner };
  for (let side = 0; side < 2; side++) {
    const outcome = winner < 0 ? "draw" : winner === side ? "won" : "lost";
    recentPicks[side].unshift(`${lastMatch.fighters[side]} (${outcome} ${lastMatch.wins[side]}-${lastMatch.wins[1 - side]} vs ${lastMatch.fighters[1 - side]})`);
    recentPicks[side].length = Math.min(recentPicks[side].length, 3);
  }
  const who = (f) => (f.cpu ? `CPU ${f.ai ? f.ai.model : ''}` : 'Humano');
  ui.resultTitle.textContent = winner < 0 ? 'Empate' : `Gana ${game.fighters[winner].def.name}`;
  ui.resultSub.textContent = `P1 ${a.def.name} (${who(a)}) ${a.wins} – ${b.wins} P2 ${b.def.name} (${who(b)})`;
  setTimeout(() => { if (game.phase === 'matchend') ui.result.hidden = false; }, 900);
};

function setPaused(on) {
  if (game.phase === 'attract' || !ui.menu.hidden || !ui.result.hidden) return;
  game.paused = on;
  ui.pause.hidden = !on;
  if (audio.ctx) { if (on) audio.ctx.suspend(); else audio.ctx.resume(); }
  if (!on) screenEl.focus();
}

/* ---------- Input ---------- */
const screenEl = document.getElementById('screen');
function humanFighter() {
  const f = game.fighters[0];
  if (!f || f.cpu || game.phase === 'attract' || game.paused || !ui.menu.hidden) return null;
  return f;
}
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') { if (ui.menu.hidden && ui.result.hidden) setPaused(!game.paused); return; }
  const f = humanFighter();
  if (!f) return;
  if (PREVENT.has(e.code)) e.preventDefault();
  const inp = f.input;
  switch (e.code) {
    case 'KeyA': case 'ArrowLeft': inp.left = true; return;
    case 'KeyD': case 'ArrowRight': inp.right = true; return;
    case 'KeyS': case 'ArrowDown': inp.block = true; return;
  }
  if (e.repeat) return;
  if (e.code === 'KeyW' || e.code === 'ArrowUp') { inp.jump = 6; return; }
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { inp.dash = 6; return; }
  const act = ACT_KEYS[e.code];
  if (act) { inp.act = act; inp.actT = 8; }
});
window.addEventListener('keyup', (e) => {
  const f = game.fighters[0];
  if (!f || f.cpu) return;
  const inp = f.input;
  switch (e.code) {
    case 'KeyA': case 'ArrowLeft': inp.left = false; break;
    case 'KeyD': case 'ArrowRight': inp.right = false; break;
    case 'KeyS': case 'ArrowDown': inp.block = false; break;
  }
});
window.addEventListener('blur', () => {
  const f = game.fighters[0];
  if (f && !f.cpu) { f.input.left = false; f.input.right = false; f.input.block = false; }
});

/* ---------- Menu wiring ---------- */
for (const b of ui.modeBtns) b.addEventListener('click', () => { cfg.mode = b.dataset.mode; saveConfig(); refreshMenu(); });
ui.sides.forEach((s, side) => s.model.addEventListener('change', () => { cfg.model[side] = s.model.value; saveConfig(); refreshMenu(); }));
ui.decision.addEventListener('change', () => { cfg.decision = ui.decision.value; saveConfig(); });
ui.sides.forEach((s, side) => s.pickToggle.addEventListener("change", () => { cfg.cpuPicks[side] = s.pickToggle.checked; saveConfig(); refreshMenu(); }));
ui.start.addEventListener('click', beginMatch);
ui.loadingBack.addEventListener('click', () => { ui.loading.hidden = true; showMenu(); });
ui.jevConnect.addEventListener("click", () => { if (ui.jevKey.value.trim()) setJevKey(ui.jevKey.value.trim()); });
ui.jevKey.addEventListener("keydown", (e) => { if (e.key === "Enter" && ui.jevKey.value.trim()) setJevKey(ui.jevKey.value.trim()); });
ui.jevClear.addEventListener("click", () => setJevKey(null));
ui.resume.addEventListener('click', () => setPaused(false));
ui.quit.addEventListener('click', showMenu);
ui.rematch.addEventListener('click', beginMatch);
ui.toMenu.addEventListener('click', showMenu);

/* ---------- Audio wiring ---------- */
window.addEventListener('pointerdown', audioUnlock, true);
window.addEventListener('keydown', audioUnlock, true);
document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && !b.closest('#touch')) sfx('ui');
});
function refreshAudioUi() {
  ui.optSfx.checked = audio.sfxOn; ui.optMusic.checked = audio.musicOn; ui.optVolume.value = String(audio.volume);
  ui.btnSfx.setAttribute('aria-pressed', String(audio.sfxOn));
  ui.btnMusic.setAttribute('aria-pressed', String(audio.musicOn));
}
ui.optSfx.addEventListener('change', () => { setSfxOn(ui.optSfx.checked); refreshAudioUi(); });
ui.optMusic.addEventListener('change', () => { setMusicOn(ui.optMusic.checked); refreshAudioUi(); });
ui.optVolume.addEventListener('input', () => setAudioVolume(Number(ui.optVolume.value)));
ui.btnSfx.addEventListener('click', () => { setSfxOn(!audio.sfxOn); refreshAudioUi(); });
ui.btnMusic.addEventListener('click', () => { setMusicOn(!audio.musicOn); refreshAudioUi(); });
ui.btnPause.addEventListener('click', () => setPaused(!game.paused));
ui.btnPanel.addEventListener('click', () => document.body.classList.toggle('panel-open'));
ui.btnFull.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) { await document.exitFullscreen(); return; }
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape').catch(() => {});
  } catch (err) { /* fullscreen unsupported (e.g. iPhone Safari) */ }
});

/* ---------- Touch controls ---------- */
const coarse = window.matchMedia('(pointer: coarse)');
function applyTouchMode() {
  const on = cfg.touch === 'on' || (cfg.touch === 'auto' && coarse.matches);
  document.body.classList.toggle('touch-ui', on);
  ui.optTouch.value = cfg.touch;
}
ui.optTouch.addEventListener('change', () => { cfg.touch = ui.optTouch.value; saveConfig(); applyTouchMode(); });
if (coarse.addEventListener) coarse.addEventListener('change', applyTouchMode);

const touchActs = Array.from(ui.touch.querySelectorAll('[data-act]'));
function labelTouchButtons() {
  const f = game.fighters[0];
  if (!f) return;
  for (const b of touchActs) {
    const code = Number(b.dataset.act);
    const m = f.moves[code];
    if (m && code >= A_S1 && code <= A_ULT) b.querySelector('.lbl').textContent = m.name;
  }
}
function holdOn(btn, on) {
  const f = humanFighter();
  btn.classList.toggle('on', on);
  if (!f) return;
  const key = btn.dataset.hold;
  if (key) f.input[key] = on;
  if (!on) return;
  if (navigator.vibrate) navigator.vibrate(8);
  if (btn.dataset.press === 'jump') f.input.jump = 6;
  else if (btn.dataset.press === 'dash') f.input.dash = 6;
  else if (btn.dataset.act) { f.input.act = Number(btn.dataset.act); f.input.actT = 8; }
}
for (const btn of ui.touch.querySelectorAll('button')) {
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); btn.setPointerCapture(e.pointerId); holdOn(btn, true); });
  const release = () => { if (btn.classList.contains('on')) holdOn(btn, false); };
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('lostpointercapture', release);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}
setInterval(() => {
  const f = game.fighters[0];
  if (!f || f.cpu || !document.body.classList.contains('touch-ui') || !document.body.classList.contains('in-match')) return;
  const o = game.fighters[1];
  for (const b of touchActs) {
    const code = Number(b.dataset.act);
    if (code === A_BURST) { b.classList.toggle('off', !burstReady(f)); continue; }
    const m = f.moves[code];
    if (!m) continue;
    const cd = m.cd > 0 ? f.cds[m.slot] / m.cd : 0;
    b.style.setProperty('--cd', cd.toFixed(3));
    b.classList.toggle('off', !canUse(f, o, m));
  }
}, 100);

/* ---------- Loop ---------- */
let acc = 0, last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  let d = (now - last) / 1000;
  last = now;
  if (d > 0.25) d = 0.25;
  if (!game.paused && !document.hidden) {
    acc += d;
    while (acc >= DT) { tickGame(); acc -= DT; }
  } else acc = 0;
  renderGame();
  present();
}
if ('ResizeObserver' in window) new ResizeObserver(fit).observe(FIT_TARGET);
window.addEventListener('resize', fit);

buildRosters();
webInit().then(async () => {
  const key = jevKey();
  if (key) {
    try { await aiHealth(); } catch (err) {
      if (/HTTP 40[45]/.test(err.message)) backend.probe = false;
      try { backend.jevModels = await jevValidate(key); } catch (e) { backend.jevError = e.message; }
    }
  }
  refreshHealth();
});
applyTouchMode();
refreshAudioUi();
fit();
showMenu();
requestAnimationFrame(frame);
