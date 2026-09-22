// GET /api/client?id=<spreadsheetId>[&force=1] — one client, full timeline.
import { json, requireAuth } from '../lib/auth.js';
import { cached } from '../lib/cache.js';
import { buildClient, CLIENT_TTL } from '../lib/data.js';

export default async function handler(req) {
  const denied = await requireAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  const force = url.searchParams.get('force') === '1';
  if (!id || !/^[A-Za-z0-9_-]{20,}$/.test(id)) return json({ error: 'bad id' }, 400);

  try {
    const { value, at, stale } = await cached(
      `client:${id}`, CLIENT_TTL, () => buildClient(id), { force }
    );
    return json({ client: value, updatedAt: at, stale: !!stale });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}
