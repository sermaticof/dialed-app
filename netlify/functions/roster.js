// GET /api/roster[?force=1]
// Every client, summarised: current 7-day average, last week's average, the
// delta between them, this week's daily weights, and compliance.
import { json, requireAuth, cached, cacheGet, cacheSet, pool } from './_lib.js';
import { listClientSheets, sheetTabs, batchGet } from './_google.js';
import { parse, clientName, RANGES, probeRange, PROBE_EXPECT } from './_sheet.js';

const ROSTER_TTL = 10 * 60 * 1000;      // summaries: cheap to refresh, often stale-tolerable
const DISCOVERY_TTL = 60 * 60 * 1000;   // the client list barely changes
const TAB_KEY = 'tabs';                 // spreadsheetId -> resolved tab title

/**
 * Find the tab holding the check-in block. It is tab 1 for some clients and
 * tab 4 for others, so probe E21 on every tab in one batchGet and take the
 * one that says "Weight Log".
 */
async function resolveTab(id, tabCache) {
  const known = tabCache[id];
  if (known) {
    const [probe] = await batchGet(id, [probeRange(known)]);
    if (String(probe?.[0]?.[0] || '').trim().toLowerCase() === PROBE_EXPECT) return known;
  }
  const tabs = await sheetTabs(id);
  if (!tabs.length) throw new Error('spreadsheet has no tabs');
  const probes = await batchGet(id, tabs.map(probeRange));
  const hit = tabs.findIndex((_, i) =>
    String(probes[i]?.[0]?.[0] || '').trim().toLowerCase() === PROBE_EXPECT
  );
  if (hit < 0) throw new Error('no tab with a "Weight Log" header at E21');
  tabCache[id] = tabs[hit];
  return tabs[hit];
}

async function readClient(file, tabCache) {
  const tab = await resolveTab(file.id, tabCache);
  const [block, timeline] = await batchGet(file.id, RANGES(tab));
  const d = parse(block, timeline);
  return {
    id: file.id,
    name: clientName(file.name, process.env.SHEET_NAME_MATCH || 'TBD Guide'),
    url: file.webViewLink || `https://docs.google.com/spreadsheets/d/${file.id}/edit`,
    modifiedTime: file.modifiedTime,
    tab,
    ...d,
  };
}

async function build() {
  const files = await cached(
    'discovery',
    DISCOVERY_TTL,
    () => listClientSheets({
      match: process.env.SHEET_NAME_MATCH || 'TBD Guide',
      folderId: process.env.ACTIVE_FOLDER_ID || '',
    })
  ).then((r) => r.value);

  const tabCache = (await cacheGet(TAB_KEY))?.value || {};

  const results = await pool(files, 6, async (f) => {
    try {
      return await readClient(f, tabCache);
    } catch (e) {
      // One unreadable sheet must not blank the whole roster.
      return {
        id: f.id,
        name: clientName(f.name, process.env.SHEET_NAME_MATCH || 'TBD Guide'),
        url: f.webViewLink || `https://docs.google.com/spreadsheets/d/${f.id}/edit`,
        modifiedTime: f.modifiedTime,
        error: e.message,
        days: [],
        weeks: [],
      };
    }
  });

  await cacheSet(TAB_KEY, tabCache);
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

export default async (req) => {
  const denied = await requireAuth(req);
  if (denied) return denied;

  const force = new URL(req.url).searchParams.get('force') === '1';
  try {
    const { value, at, stale, error } = await cached('roster', ROSTER_TTL, build, { force });
    // The detail view reads the same payload, so trim the heaviest field here.
    const clients = value.map((c) => ({ ...c, weeks: (c.weeks || []).slice(0, 12) }));
    return json({ clients, updatedAt: at, stale: !!stale, refreshError: error || null });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
};

export const config = { path: '/api/roster' };
