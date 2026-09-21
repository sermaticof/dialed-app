// GET /api/client?id=<spreadsheetId>[&force=1]
// One client, always read fresh-ish and with the full 26-week timeline.
import { json, requireAuth, cached, cacheGet, cacheSet } from './_lib.js';
import { batchGet, sheetTabs } from './_google.js';
import { parse, clientName, RANGES, probeRange, PROBE_EXPECT } from './_sheet.js';

const TTL = 3 * 60 * 1000;
const TAB_KEY = 'tabs';

async function resolveTab(id, tabCache) {
  const known = tabCache[id];
  if (known) {
    const [probe] = await batchGet(id, [probeRange(known)]);
    if (String(probe?.[0]?.[0] || '').trim().toLowerCase() === PROBE_EXPECT) return known;
  }
  const tabs = await sheetTabs(id);
  const probes = await batchGet(id, tabs.map(probeRange));
  const hit = tabs.findIndex((_, i) =>
    String(probes[i]?.[0]?.[0] || '').trim().toLowerCase() === PROBE_EXPECT
  );
  if (hit < 0) throw new Error('no tab with a "Weight Log" header at E21');
  tabCache[id] = tabs[hit];
  return tabs[hit];
}

export default async (req) => {
  const denied = await requireAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  const force = url.searchParams.get('force') === '1';
  if (!id || !/^[A-Za-z0-9_-]{20,}$/.test(id)) return json({ error: 'bad id' }, 400);

  try {
    const { value, at, stale } = await cached(`client:${id}`, TTL, async () => {
      const tabCache = (await cacheGet(TAB_KEY))?.value || {};
      const tab = await resolveTab(id, tabCache);
      await cacheSet(TAB_KEY, tabCache);

      const [block, timeline] = await batchGet(id, RANGES(tab));
      // The roster already knows the display name; re-derive it from the
      // cached discovery list so the detail view works on a cold function too.
      const files = (await cacheGet('discovery'))?.value || [];
      const file = files.find((f) => f.id === id);
      return {
        id,
        tab,
        name: file ? clientName(file.name, process.env.SHEET_NAME_MATCH || 'TBD Guide') : 'Client',
        url: file?.webViewLink || `https://docs.google.com/spreadsheets/d/${id}/edit`,
        modifiedTime: file?.modifiedTime || null,
        ...parse(block, timeline),
      };
    }, { force });

    return json({ client: value, updatedAt: at, stale: !!stale });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
};

export const config = { path: '/api/client' };
