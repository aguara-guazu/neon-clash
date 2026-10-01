'use strict';

const { MAX_BODY, resolveKey, forward } = require('./_typesafe');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ detail: 'Método no permitido' });
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  if (body.length > MAX_BODY) return res.status(413).json({ detail: 'Request demasiado grande' });
  let model;
  try { model = JSON.parse(body).model; } catch (err) { return res.status(400).json({ detail: 'JSON inválido' }); }
  if (typeof model !== 'string' || !model.startsWith('jev')) return res.status(400).json({ detail: 'Solo se aceptan modelos jev' });
  const auth = resolveKey(req);
  if (!auth.key) return res.status(auth.status).json({ detail: auth.detail });
  const out = await forward(res, '/v1/systemone', auth.key, { method: 'POST', body });
  if (!out) return undefined;
  res.setHeader('X-Jev-Key-Source', auth.source);
  if (out.status >= 400) return res.status(out.status).json({ detail: `Jev: ${out.payload.detail || out.payload.error || out.status}` });
  return res.status(200).json(out.payload);
};
