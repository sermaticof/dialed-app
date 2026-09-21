// Shared helpers: JSON responses, the passcode gate, and the Blobs cache.
import { getStore } from '@netlify/blobs';

export const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

export const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });

export const COOKIE = 'dialed_session';

/* ------------------------------------------------------------------ auth --
 * A single shared passcode, exchanged for a signed cookie. This guards real
 * client bodyweight data, so every data endpoint calls requireAuth() first.
 * Rotating DIALED_SESSION_SECRET invalidates every outstanding session.
 */

const enc = new TextEncoder();

async function hmac(value) {
  const secret = process.env.DIALED_SESSION_SECRET;
  if (!secret) throw new Error('DIALED_SESSION_SECRET is not set');
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Constant-time-ish compare, so a wrong passcode leaks no timing signal. */
export function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] || 0) ^ (y[i] || 0);
  }
  return diff === 0;
}

const MAX_AGE = 60 * 60 * 24 * 30; // 30 days — it's a phone, re-typing is friction

export async function makeCookie() {
  const exp = Date.now() + MAX_AGE * 1000;
  const value = `${exp}.${await hmac(String(exp))}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`;
}

export const clearCookie = () =>
  `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

async function isAuthed(req) {
  const raw = req.headers.get('cookie') || '';
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(raw);
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.');
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(exp));
}

/** Returns a 401 Response when the caller is not signed in, else null. */
export async function requireAuth(req) {
  if (!process.env.DIALED_PASSCODE || !process.env.DIALED_SESSION_SECRET) {
    return json({ error: 'Server is missing DIALED_PASSCODE or DIALED_SESSION_SECRET' }, 500);
  }
  return (await isAuthed(req)) ? null : json({ error: 'unauthorized' }, 401);
}

/* ----------------------------------------------------------------- cache --
 * Reading ~27 spreadsheets takes seconds, which is far too slow to do on every
 * phone page load. Results go in Netlify Blobs with a TTL; a stale entry is
 * still served (with stale:true) if a refresh fails, so a Google hiccup
 * degrades to slightly-old numbers rather than an error screen.
 */

const store = () => getStore({ name: 'dialed', consistency: 'strong' });

export async function cacheGet(key) {
  try {
    const v = await store().get(key, { type: 'json' });
    return v || null;
  } catch {
    return null;
  }
}

export async function cacheSet(key, value) {
  try {
    await store().set(key, JSON.stringify({ at: Date.now(), value }));
    return true;
  } catch {
    return false; // a cache write failing must never fail the request
  }
}

export const isFresh = (entry, ttlMs) => !!entry && Date.now() - entry.at < ttlMs;

/**
 * Serve from cache, refresh when stale. On a refresh error, fall back to the
 * stale value rather than surfacing the failure.
 */
export async function cached(key, ttlMs, produce, { force = false } = {}) {
  const entry = await cacheGet(key);
  if (!force && isFresh(entry, ttlMs)) {
    return { value: entry.value, at: entry.at, stale: false };
  }
  try {
    const value = await produce();
    await cacheSet(key, value);
    return { value, at: Date.now(), stale: false };
  } catch (e) {
    if (entry) return { value: entry.value, at: entry.at, stale: true, error: e.message };
    throw e;
  }
}

/** Run tasks with bounded concurrency so we don't open 27 sockets at once. */
export async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await worker(items[idx], idx);
      }
    })
  );
  return out;
}
