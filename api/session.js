// Cheap "am I still signed in?" check for app boot.
import { json, requireAuth } from '../lib/auth.js';

export default async function handler(req) {
  const denied = await requireAuth(req);
  return denied ? json({ authed: false }) : json({ authed: true });
}
