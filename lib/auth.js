// One shared passcode, exchanged for an HMAC-signed cookie.
// This guards real client bodyweight data, so every data route calls
// requireAuth() first. Rotating DIALED_SESSION_SECRET signs everyone out.

export const JSON_HEADERS = {
  'Content-Type': 'application/json',
  // Never let a CDN or browser hold on to client data.
  'Cache-Control': 'private, no-store',
};

export const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });

export const COOKIE = 'dialed_session';

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

/** Length-independent compare, so a wrong passcode leaks no timing signal. */
export function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

const MAX_AGE = 60 * 60 * 24 * 30; // 30 days — it's a phone, re-typing is friction

export async function makeCookie() {
  const exp = Date.now() + MAX_AGE * 1000;
  return `${COOKIE}=${exp}.${await hmac(String(exp))}` +
    `; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`;
}

export const clearCookie = () =>
  `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

async function isAuthed(req) {
  const raw = req.headers.get('cookie') || '';
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(raw);
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(exp));
}

/** Returns a 401 Response when the caller is not signed in, else null. */
export async function requireAuth(req) {
  if (!process.env.DIALED_PASSCODE || !process.env.DIALED_SESSION_SECRET) {
    return json({ error: 'Server is missing DIALED_PASSCODE or DIALED_SESSION_SECRET' }, 500);
  }
  return (await isAuthed(req)) ? null : json({ error: 'unauthorized' }, 401);
}
