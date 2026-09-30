/* Prompt builders for browser System One inference.

   tev1 follows Ollama's decision pipeline (decision/systemone.go Compile, as
   mirrored by playground/mlx_engine.py): the model's system prompt plus
   `{"context": <state>, "schema": [...]}` and `Requested field: "<name>"` in
   the Qwen3.5 chat template with thinking disabled, scored by the next-token
   logits of one-letter candidate codes.

   decider follows Mapika/decider (decider/prompt.py `build`, state-first
   layout, decider/systemone.py rendering): plain text `Context:` /
   `Question:` / `Options:` / `Answer: (` scored at the last position over its
   label tokens, softmax(logits / temperature).

   Both builders return one row per question: { name, kind, ids, cands,
   values, temperature }. */

const LETTERS26 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function encode(tok, text) {
  return tok.encode(text, { add_special_tokens: false }).ids;
}

/* Go json.Marshal string/object spelling: compact, with <, >, & and U+2028/9 escaped. */
export function goJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/* Python json.dumps(ensure_ascii=False) spelling: ", " and ": " separators. */
export function pyJson(value) {
  if (Array.isArray(value)) return `[${value.map(pyJson).join(', ')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${pyJson(v)}`).join(', ')}}`;
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return String(value);
  return JSON.stringify(value);
}

function content(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return JSON.stringify(value);
  throw new Error('must be a string, object, or array');
}

function tev1Choices(type, criteria, present) {
  const choices = [];
  const add = (value, description) => choices.push({ code: LETTERS26[choices.length], value, description });
  if (type === 'noul') {
    let no = 'No', yes = 'Yes';
    if (present && criteria) {
      if (typeof criteria.false === 'string') no = criteria.false;
      if (typeof criteria.true === 'string') yes = criteria.true;
    }
    add(false, no); add(true, yes);
  } else if (type === 'choice') {
    for (const [key, description] of Object.entries(criteria || {})) add(key, description == null ? key : description);
  } else if (type === 'score') {
    (criteria || []).forEach((description, level) => add(String(level), description));
  } else throw new Error('type must be choice, noul, or score');
  if (choices.length < 2 || choices.length > 26) throw new Error('criteria must contain 2-26 candidates');
  return choices;
}

/* Qwen3.5 chat template with a system message and enable_thinking=false; the template trims both contents. */
function qwenChat(system, user) {
  const sys = system && system.trim() ? `<|im_start|>system\n${system.trim()}<|im_end|>\n` : '';
  return `${sys}<|im_start|>user\n${user.trim()}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
}

export function tev1Letters(tok) {
  return Array.from(LETTERS26, (L) => {
    const ids = encode(tok, L);
    if (ids.length !== 1) throw new Error(`letter ${L} is not a single token`);
    return ids[0];
  });
}

export function buildTev1(tok, letterIds, system, body) {
  const context = content(body.state);
  const schema = [], kinds = [];
  for (const [name, q] of Object.entries(body.questions || {})) {
    const description = content(q.instructions);
    schema.push({ name, description, choices: tev1Choices(q.type, q.criteria, 'criteria' in q) });
    kinds.push(q.type);
  }
  const payload = goJson({ context, schema });
  return schema.map((field, i) => {
    const prompt = qwenChat(system, `${payload}\n\nRequested field: ${goJson(field.name)}`);
    return {
      name: field.name, kind: kinds[i], ids: encode(tok, prompt), temperature: 1,
      cands: field.choices.map((c, k) => letterIds[k]), values: field.choices.map((c) => c.value),
      legend: kinds[i] === 'score' ? field.choices.map((c) => c.description) : null,
    };
  });
}

function annotateIndices(x, minLen = 8) {
  if (Array.isArray(x)) {
    if (x.length >= minLen) return x.map((v, i) => (v && typeof v === 'object' && !Array.isArray(v) ? { _index: i, ...annotateIndices(v, minLen) } : { _index: i, value: annotateIndices(v, minLen) }));
    return x.map((v) => annotateIndices(v, minLen));
  }
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, annotateIndices(v, minLen)]));
  return x;
}

const txt = (v) => (typeof v === 'string' ? v : pyJson(v));

/* Label strings/ids as decider/prompt.py label_table: A..Z then AA..ZZ, single tokens only. */
export function deciderLabels(tok, max = 255) {
  const names = [...LETTERS26];
  for (const a of LETTERS26) for (const b of LETTERS26) names.push(a + b);
  const ids = [];
  for (const n of names) {
    const t = encode(tok, n);
    if (t.length === 1) ids.push(t[0]);
    if (ids.length === max) break;
  }
  return { ids, open: encode(tok, '\n(') };
}

/* `temperature` is a number or { default, choice, noul, score } (decider_config temperature_by_type). */
export function buildDecider(tok, labels, temperature, body) {
  const tempFor = (type) => (typeof temperature === 'object' ? (temperature[type] ?? temperature.default ?? 1) : temperature);
  const ctx = typeof body.state === 'string' ? body.state : pyJson(annotateIndices(body.state));
  const ctxIds = encode(tok, `Context:\n${ctx}`).slice(0, 32768);
  const rows = [];
  for (const [name, q] of Object.entries(body.questions || {})) {
    const question = txt(q.instructions);
    let values, options;
    if (q.type === 'choice') {
      values = Object.keys(q.criteria || {});
      options = values.map((n) => (q.criteria[n] == null || q.criteria[n] === '' ? n : `${n}: ${txt(q.criteria[n])}`));
    } else if (q.type === 'noul') {
      const c = q.criteria || {};
      values = [false, true];
      options = [c.false ? `no: ${txt(c.false)}` : 'no', c.true ? `yes: ${txt(c.true)}` : 'yes'];
    } else if (q.type === 'score') {
      values = (q.criteria || []).map((_, i) => String(i));
      options = (q.criteria || []).map((c, i) => `${i}: ${txt(c)}`);
    } else throw new Error(`unknown question type ${q.type}`);
    const head = `\n\nQuestion: ${question}\nOptions:`, tail = '\nAnswer: (';
    let piece;
    if (options.length <= 10) {
      piece = encode(tok, head + options.map((o, j) => `\n(${LETTERS26[j]}) ${o}`).join('') + tail);
    } else {
      piece = encode(tok, head);
      options.forEach((o, j) => { piece.push(...labels.open, labels.ids[j], ...encode(tok, `) ${o}`)); });
      piece.push(...encode(tok, tail));
    }
    rows.push({
      name, kind: q.type, ids: ctxIds.concat(piece), temperature: tempFor(q.type), cands: labels.ids.slice(0, options.length), values,
      legend: q.type === 'score' ? q.criteria : null,
    });
  }
  return rows;
}

/* System One answer from candidate logits (softmax at the row temperature). */
export function answerFrom(row, logits) {
  const v = logits.map((x) => x / row.temperature);
  const mx = Math.max(...v);
  const e = v.map((x) => Math.exp(x - mx));
  const s = e.reduce((a, b) => a + b, 0);
  const p = e.map((x) => x / s);
  if (row.kind === 'noul') return { type: 'noul', noul: p[1] };
  const h = -p.reduce((a, x) => a + (x > 0 ? x * Math.log(x) : 0), 0);
  const confidence = Math.max(0, Math.min(1, 1 - h / Math.log(p.length)));
  const probabilities = Object.fromEntries(row.values.map((k, i) => [k, p[i]]));
  if (row.kind === 'choice') return { type: 'choice', choice: row.values[p.indexOf(Math.max(...p))], probabilities, confidence };
  return {
    type: 'score', score: p.reduce((a, x, i) => a + i * x, 0), probabilities, confidence,
    legend: Object.fromEntries(row.values.map((k, i) => [k, row.legend ? row.legend[i] : k])),
  };
}
