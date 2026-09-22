// A tiny TTL cache with a pluggable backend, chosen from the environment:
//
//   1. Upstash Redis  — if UPSTASH_REDIS_REST_URL (or KV_REST_API_URL) is set.
//      One click from the Vercel Marketplace; it injects these itself.
//   2. In-memory      — always available, needs no setup. Survives warm
//      invocations only, so a cold start pays the full read.
//
// Deliberately NOT Vercel Blob: its objects are publicly readable by URL, and
// this cache holds client bodyweight data.
//
// TTL is carried in the stored payload rather than delegated to the backend,
// because an expired entry is still useful — if a refresh from Google fails we
// serve the stale copy instead of an error.

const memory = new Map();

const upstash = () => {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
};

export function backendName() {
  return upstash() ? 'upstash' : 'memory';
}

const KEY = (k) => `dialed:${k}`;

export async function cacheGet(key) {
  const up = upstash();
  if (up) {
    try {
      const res = await fetch(`${up.url}/get/${encodeURIComponent(KEY(key))}`, {
        headers: { Authorization: `Bearer ${up.token}` },
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`upstash ${res.status}`);
      const { result } = await res.json();
      return result ? JSON.parse(result) : null;
    } catch {
      // fall through to memory — a cache outage must not take the app down
    }
  }
  return memory.get(key) || null;
}

export async function cacheSet(key, value) {
  const entry = { at: Date.now(), value };
  memory.set(key, entry); // always keep a local copy for the warm path
  const up = upstash();
  if (up) {
    try {
      await fetch(`${up.url}/set/${encodeURIComponent(KEY(key))}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${up.token}`, 'Content-Type': 'text/plain' },
        body: JSON.stringify(entry),
      });
    } catch {
      // a cache write failing must never fail the request
    }
  }
  return true;
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
