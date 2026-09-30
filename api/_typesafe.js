'use strict';

/* Forwards one request to TypeSafe's API with the visitor's own key from the
   X-Typesafe-Key header. The key is never stored or logged. */

const TYPESAFE_URL = 'https://api.typesafe.ai';
const MAX_BODY = 256 * 1024;

function visitorKey(req) {
  const key = req.headers['x-typesafe-key'];
  return typeof key === 'string' && key.trim() && key.length < 512 ? key.trim() : null;
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

module.exports = { MAX_BODY, visitorKey, forward };
