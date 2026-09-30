'use strict';

const { visitorKey, forward } = require('./_typesafe');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ detail: 'Método no permitido' });
  const key = visitorKey(req);
  if (!key) return res.status(401).json({ detail: 'Falta la API key de Jev' });
  const out = await forward(res, '/v1/models', key, { method: 'GET' });
  if (!out) return undefined;
  if (out.status === 401 || out.status === 403) return res.status(401).json({ detail: 'Jev rechazó la API key' });
  if (out.status >= 400) return res.status(502).json({ detail: `Jev: ${out.payload.detail || out.status}` });
  const listed = out.payload.data || out.payload.models || [];
  const names = (Array.isArray(listed) ? listed : [])
    .map((e) => (typeof e === 'string' ? e : e && (e.id || e.name)))
    .filter((n) => typeof n === 'string' && n.startsWith('jev'));
  return res.status(200).json({ models: names.length ? names : ['jev-latest', 'jev-preview'] });
};
