'use strict';

/* Decision backends shared by the CPU controller:
   - "web/*" models run in decision-worker.mjs (ONNX Runtime Web, WebGPU),
   - "jev-*" models go to TypeSafe through the local playground server or,
     when there is none, through the /api/jev-* functions with the visitor's
     own API key (kept in this browser's localStorage only),
   - any other name goes to the local playground server (/v1/systemone). */

const JEV_KEY_STORE = 'neon-clash-jev-key';
const web = {
  worker: null, caps: null, capsWaiters: [], specs: [], loaded: new Map(), progress: new Map(),
  pending: new Map(), nextRid: 1, onProgress: null,
};
const backend = { local: false, localJev: false, probe: true, jevModels: [], jevError: '' };

function isWebModel(name) { return typeof name === 'string' && name.startsWith('web/'); }
function isJevModel(name) { return typeof name === 'string' && name.startsWith('jev-'); }
function webSpec(name) { return web.specs.find((s) => s.id === name) || null; }

function jevKey() {
  try { return localStorage.getItem(JEV_KEY_STORE) || ''; } catch (err) { return ''; }
}
function setJevKeyLocal(key) {
  try { if (key) localStorage.setItem(JEV_KEY_STORE, key); else localStorage.removeItem(JEV_KEY_STORE); } catch (err) { /* storage unavailable */ }
}

function webWorker() {
  if (web.worker) return web.worker;
  const w = new Worker('decision-worker.mjs', { type: 'module' });
  w.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'caps') { web.caps = m; web.capsWaiters.splice(0).forEach((fn) => fn(m)); }
    else if (m.type === 'progress') { web.progress.set(m.id, m); if (web.onProgress) web.onProgress(m); }
    else if (m.type === 'loaded') { const p = web.pending.get(`load:${m.id}`); web.pending.delete(`load:${m.id}`); web.loaded.set(m.id, m); if (p) p.resolve(m); }
    else if (m.type === 'result') { const p = web.pending.get(m.rid); web.pending.delete(m.rid); if (p) p.resolve(m.payload); }
    else if (m.type === 'error') {
      const key = m.rid ? m.rid : `load:${m.id}`;
      const p = web.pending.get(key); web.pending.delete(key);
      if (p) p.reject(new Error(m.error));
    }
  };
  w.onerror = (e) => {
    const err = new Error(e.message || 'el worker de inferencia falló');
    for (const p of web.pending.values()) p.reject(err);
    web.pending.clear();
    web.capsWaiters.splice(0).forEach((fn) => fn({ webgpu: false, error: err.message }));
  };
  web.worker = w;
  return w;
}

function webCaps() {
  if (web.caps) return Promise.resolve(web.caps);
  if (!('gpu' in navigator)) { web.caps = { webgpu: false }; return Promise.resolve(web.caps); }
  return new Promise((resolve) => { web.capsWaiters.push(resolve); webWorker().postMessage({ type: 'caps' }); });
}

async function webInit() {
  try {
    const res = await fetch('models.json', { cache: 'no-cache' });
    web.specs = res.ok ? (await res.json()).models || [] : [];
  } catch (err) { web.specs = []; }
  await webCaps();
  return web;
}

function webLoad(name) {
  if (web.loaded.has(name)) return Promise.resolve(web.loaded.get(name));
  const key = `load:${name}`;
  if (web.pending.has(key)) return web.pending.get(key).promise;
  const spec = webSpec(name);
  if (!spec) return Promise.reject(new Error(`modelo web desconocido: ${name}`));
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  web.pending.set(key, { resolve, reject, promise });
  webWorker().postMessage({ type: 'load', id: name, spec });
  return promise;
}

function webDecide(name, body) {
  const rid = web.nextRid++;
  return new Promise((resolve, reject) => {
    web.pending.set(rid, { resolve, reject });
    webWorker().postMessage({ type: 'decide', rid, id: name, body });
  });
}

async function postJson(url, body, headers) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body) });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.detail || payload.error || `HTTP ${res.status}`);
  return payload;
}

/* One System One request on the backend that owns `model`; resolves to the response payload. */
async function decisionRequest(model, body) {
  const req = { ...body, model };
  if (isWebModel(model)) {
    await webLoad(model);
    return webDecide(model, req);
  }
  if (isJevModel(model) && !backend.localJev) {
    const key = jevKey();
    if (!key) throw new Error('Falta la API key de Jev');
    return postJson('/api/jev-systemone', req, { 'X-Typesafe-Key': key });
  }
  return postJson('/v1/systemone', req);
}

/* Validates a visitor key against TypeSafe through /api/jev-models; returns the jev model names. */
async function jevValidate(key) {
  const res = await fetch('/api/jev-models', { headers: { 'X-Typesafe-Key': key } });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.detail || `HTTP ${res.status}`);
  return payload.models || [];
}
