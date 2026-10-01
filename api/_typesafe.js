'use strict';

/* Forwards requests to TypeSafe's API. A visitor key from the X-Typesafe-Key
   header is used as is (billed to the visitor). Without it, the site key from
   the TYPESAFE_API_KEY environment variable is used, but only for same-origin
   browser requests and within a per-IP rate limit kept in this function
   instance (best effort: limits reset on cold starts and are per instance).
   No key is ever stored, logged or returned. */

const TYPESAFE_URL = 'https://api.typesafe.ai';
const MAX_BODY = 256 * 1024;
const SITE_WINDOW_MS = 10_000;
const SITE_MAX_PER_WINDOW = 60;
const hits = new Map();

function visitorKey(req) {
  const key = req.headers['x-typesafe-key'];
  return typeof key === 'string' && key.trim() && key.length < 512 ? key.trim() : null;
}

function siteKey() {
  const key = process.env.TYPESAFE_API_KEY;
  return typeof key === 'string' && key.trim() ? key.trim() : null;
}

function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'same-origin') return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; } catch (err) { return false; }
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.socket?.remoteAddress || 'unknown';
}

function underLimit(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < SITE_WINDOW_MS);
  if (list.length >= SITE_MAX_PER_WINDOW) { hits.set(ip, list); return false; }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > SITE_WINDOW_MS) hits.delete(k);
  return true;
}

/* Resolves which key serves this request: { key, source: 'visitor' | 'site' } or an error { status, detail }. */
function resolveKey(req, { countUse = true } = {}) {
  const own = visitorKey(req);
  if (own) return { key: own, source: 'visitor' };
  const site = siteKey();
  if (!site) return { status: 401, detail: 'Falta la API key de Jev' };
  if (!sameOrigin(req)) return { status: 403, detail: 'La key del sitio solo se usa desde el juego' };
  if (countUse && !underLimit(clientIp(req))) return { status: 429, detail: 'Demasiadas decisiones con la key del sitio; espera unos segundos o usa tu propia key' };
  return { key: site, source: 'site' };
}

async function forward(res, path, key, init) {
  try {
    const upstream = await fetch(`${TYPESAFE_URL}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    const text = await upstream.text();
    let payload;
    try { payload = JSON.parse(text); } catch (err) { payload = { detail: text.slice(0, 300) }; }
    return { status: upstream.status, payload };
  } catch (err) {
    res.status(502).json({ detail: `TypeSafe no responde: ${err.message}` });
    return null;
  }
}

module.exports = { MAX_BODY, resolveKey, forward };
