// GET /api/roster[?force=1] — every client, summarised.
import { json, requireAuth } from '../lib/auth.js';
import { cached } from '../lib/cache.js';
import { buildRoster, ROSTER_TTL } from '../lib/data.js';

export default async function handler(req) {
  const denied = await requireAuth(req);
  if (denied) return denied;

  const force = new URL(req.url).searchParams.get('force') === '1';
  try {
    const { value, at, stale, error } = await cached('roster', ROSTER_TTL, buildRoster, { force });
    // The detail route fetches the full timeline, so trim the heaviest field
    // here — 27 clients x 26 weeks is a lot of JSON to push to a phone.
    const clients = value.map((c) => ({ ...c, weeks: (c.weeks || []).slice(0, 12) }));
    return json({ clients, updatedAt: at, stale: !!stale, refreshError: error || null });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}
