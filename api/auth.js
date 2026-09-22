// POST { passcode } -> sets the session cookie.  DELETE -> signs out.
import { json, makeCookie, clearCookie, safeEqual } from '../lib/auth.js';

export default async function handler(req) {
  if (req.method === 'DELETE') {
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
  }
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const expected = process.env.DIALED_PASSCODE;
  if (!expected || !process.env.DIALED_SESSION_SECRET) {
    return json({ error: 'Server is missing DIALED_PASSCODE or DIALED_SESSION_SECRET' }, 500);
  }

  let passcode = '';
  try {
    ({ passcode } = await req.json());
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  if (!passcode || !safeEqual(passcode, expected)) {
    // A small delay blunts online guessing without needing a rate limiter.
    await new Promise((r) => setTimeout(r, 600));
    return json({ error: 'Wrong passcode' }, 401);
  }

  return json({ ok: true }, 200, { 'Set-Cookie': await makeCookie() });
}
