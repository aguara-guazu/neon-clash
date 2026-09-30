/* Module worker running System One decision models with ONNX Runtime Web
   (WebGPU EP). One queue serializes all GPU work. Model files are fetched
   once with progress and kept in Cache Storage (CACHE_NAME) across visits.

   Messages in:  {type:'caps'} | {type:'load', id, spec} | {type:'decide', rid, id, body} | {type:'unload', id}
   Messages out: {type:'caps', webgpu, adapter} | {type:'progress', id, loaded, total}
                 {type:'loaded', id, ms, prefix} | {type:'result', rid, payload} | {type:'error', rid?, id?, error} */

import * as ort from './vendor/ort/ort.webgpu.bundle.min.mjs';
import { Tokenizer } from './vendor/tokenizers.min.mjs';
import { answerFrom, buildDecider, buildTev1, deciderLabels, tev1Letters } from './decision-prompts.mjs';

ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

const CACHE_NAME = 'neon-clash-models-v1';
const models = new Map();
let queue = Promise.resolve();

function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function fileUrl(spec, name) {
  return `https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${name}`;
}

async function openCache() {
  try { return await caches.open(CACHE_NAME); } catch (err) { return null; }
}

/* Streams url into one Uint8Array (preallocated from Content-Length) and stores it in Cache Storage. */
async function fetchBytes(url, expected, onBytes) {
  const cache = await openCache();
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      const buf = new Uint8Array(await hit.arrayBuffer());
      onBytes(buf.length);
      return buf;
    }
  }
  const res = await fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`HTTP ${res.status} al descargar ${url.split('/').pop()}`);
  const total = Number(res.headers.get('content-length')) || expected || 0;
  const reader = res.body.getReader();
  let buf = new Uint8Array(total || 1 << 20), used = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (used + value.length > buf.length) {
      const grown = new Uint8Array(Math.max(buf.length * 2, used + value.length));
      grown.set(buf.subarray(0, used)); buf = grown;
    }
    buf.set(value, used); used += value.length;
    onBytes(value.length);
  }
  if (used !== buf.length) buf = buf.slice(0, used);
  if (cache) { try { await cache.put(url, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } })); } catch (err) { /* quota: keep in memory only */ } }
  return buf;
}

function stateFeeds(m, pastLen) {
  const feeds = {};
  for (const i of m.spec.inputs) {
    if (i.name === 'input_ids' || i.name === 'attention_mask' || i.name === 'position_ids') continue;
    const shape = i.shape.map((d) => (d === 'batch_size' ? 1 : d === 'past_sequence_length' ? pastLen : d));
    const n = shape.reduce((a, b) => a * b, 1);
    feeds[i.name] = new ort.Tensor(i.type, i.type === 'float16' ? new Uint16Array(n) : new Float32Array(n), shape);
  }
  return feeds;
}

function tokenFeeds(ids, start) {
  const t = ids.length, total = start + t;
  const pos = new BigInt64Array(3 * t);
  for (let k = 0; k < 3; k++) for (let j = 0; j < t; j++) pos[k * t + j] = BigInt(start + j);
  return {
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, t]),
    attention_mask: new ort.Tensor('int64', new BigInt64Array(total).fill(1n), [1, total]),
    position_ids: new ort.Tensor('int64', pos, [3, 1, t]),
  };
}

function pastName(present) {
  return present.replace(/^present\.(\d+)\.(key|value)$/, 'past_key_values.$1.$2').replace(/^present\.(\d+)\.(conv|recurrent)$/, 'past.$1.$2');
}

function half(h) {
  const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/* Reads candidate logits; float16 data arrives as Uint16Array (bits) or Float16Array (values) depending on the browser. */
function readLogits(t, cands) {
  const d = t.data, off = d.length - t.dims[t.dims.length - 1];
  return cands.map((c) => (d instanceof Uint16Array ? half(d[off + c]) : Number(d[off + c])));
}

function disposeOutputs(out) {
  for (const k in out) if (k !== 'logits' && out[k].dispose) out[k].dispose();
}

async function forward(m, ids) {
  let start = 0, past, seq = ids;
  const p = m.prefix;
  if (p && ids.length > p.ids.length && p.ids.every((x, i) => ids[i] === x)) {
    start = p.ids.length; seq = ids.slice(start); past = p.cache;
  } else past = stateFeeds(m, 0);
  const out = await m.sess.run({ ...tokenFeeds(seq, start), ...past });
  return out;
}

function rowsFor(m, body) {
  return m.spec.format === 'decider'
    ? buildDecider(m.tok, m.labels, m.spec.temperature_by_type ? { default: m.spec.temperature || 1, ...m.spec.temperature_by_type } : (m.spec.temperature || 1), body)
    : buildTev1(m.tok, m.letters, m.spec.system || '', body);
}

async function decide(m, body) {
  const rows = rowsFor(m, body);
  const answers = {};
  let tokens = 0;
  for (const row of rows) {
    if (row.ids.length + 2 > (m.spec.max_tokens || 8192)) throw new Error(`el prompt usa ${row.ids.length} tokens; el modelo admite ${m.spec.max_tokens}`);
    const out = await forward(m, row.ids);
    answers[row.name] = answerFrom(row, readLogits(out.logits, row.cands));
    disposeOutputs(out);
    tokens += row.ids.length;
  }
  return { model: m.spec.id, answers, usage: { input_tokens: tokens, output_tokens: 0 } };
}

/* Caches the recurrent/KV state of the token prefix shared by every request of this format. */
async function buildPrefix(m) {
  const probe = (state) => rowsFor(m, { state, questions: { q: { type: 'noul', instructions: 'Is this a probe?' } } })[0].ids;
  const a = probe({ you: { fighter: 'VOLT' } }), b = probe('plain text state');
  let n = 0;
  while (n < a.length - 1 && n < b.length - 1 && a[n] === b[n]) n++;
  if (n < 2) return null;
  const ids = a.slice(0, n - 1);
  const out = await m.sess.run({ ...tokenFeeds(ids, 0), ...stateFeeds(m, 0) });
  const cache = {};
  for (const k in out) if (k !== 'logits') cache[pastName(k)] = out[k];
  return { ids, cache };
}

async function load(id, spec) {
  if (models.has(id)) return models.get(id).ready;
  const entry = { spec, ready: null };
  models.set(id, entry);
  entry.ready = (async () => {
    const t0 = performance.now();
    const f = spec.files;
    const names = [f.tokenizer, f.tokenizer_config, f.onnx, ...f.data];
    const total = spec.bytes || 0;
    let loaded = 0, last = 0;
    const onBytes = (n) => {
      loaded += n;
      const now = performance.now();
      if (now - last > 150 || loaded >= total) { last = now; postMessage({ type: 'progress', id, loaded, total }); }
    };
    const bufs = [];
    for (const name of names) bufs.push(await fetchBytes(fileUrl(spec, name), (spec.sizes || {})[name], onBytes));
    const dec = new TextDecoder();
    const tok = new Tokenizer(JSON.parse(dec.decode(bufs[0])), JSON.parse(dec.decode(bufs[1])));
    const outLoc = { logits: 'cpu' };
    for (const i of spec.inputs) {
      const mm = i.name.match(/^past_key_values\.(\d+)\.(key|value)$/) || i.name.match(/^past\.(\d+)\.(conv|recurrent)$/);
      if (mm) outLoc[`present.${mm[1]}.${mm[2]}`] = 'gpu-buffer';
    }
    const sess = await serial(() => ort.InferenceSession.create(bufs[2], {
      executionProviders: ['webgpu'],
      externalData: f.data.map((path, i) => ({ path, data: bufs[3 + i] })),
      graphOptimizationLevel: 'all',
      logSeverityLevel: 3,
      preferredOutputLocation: outLoc,
    }));
    bufs.length = 0;
    const m = { spec, sess, tok };
    if (spec.format === 'decider') m.labels = deciderLabels(tok);
    else m.letters = tev1Letters(tok);
    await serial(async () => {
      m.prefix = await buildPrefix(m);
      disposeOutputs(await forward(m, rowsFor(m, { state: 'warmup', questions: { w: { type: 'noul', instructions: 'Is this a warmup?' } } })[0].ids));
    });
    entry.model = m;
    return { ms: performance.now() - t0, prefix: m.prefix ? m.prefix.ids.length : 0 };
  })();
  entry.ready.catch(() => models.delete(id));
  return entry.ready;
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'caps') {
      let adapter = null;
      try { adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null; } catch (err) { adapter = null; }
      postMessage({ type: 'caps', webgpu: !!adapter, adapter: adapter && adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture } : null });
    } else if (msg.type === 'load') {
      const r = await load(msg.id, msg.spec);
      postMessage({ type: 'loaded', id: msg.id, ...r });
    } else if (msg.type === 'decide') {
      const entry = models.get(msg.id);
      if (!entry) throw new Error('modelo no cargado');
      await entry.ready;
      const t0 = performance.now();
      const payload = await serial(() => decide(entry.model, msg.body));
      payload.diagnostics = { timing: { total_seconds: (performance.now() - t0) / 1000 } };
      postMessage({ type: 'result', rid: msg.rid, payload });
    } else if (msg.type === 'unload') {
      const entry = models.get(msg.id);
      models.delete(msg.id);
      if (entry && entry.model) await serial(() => entry.model.sess.release());
    }
  } catch (err) {
    postMessage({ type: 'error', rid: msg.rid, id: msg.id, error: String(err && err.message || err) });
  }
};
