// Cheap "am I still signed in?" check for app boot.
import { json, requireAuth } from './_lib.js';

export default async (req) => {
  const denied = await requireAuth(req);
  return denied ? json({ authed: false }, 200) : json({ authed: true });
};

export const config = { path: '/api/session' };
