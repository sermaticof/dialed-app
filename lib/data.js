// Turning a folder of spreadsheets into the roster the app renders.
import { listClientSheets, sheetTabs, batchGet } from './google.js';
import { parse, clientName, RANGES, probeRange, PROBE_EXPECT } from './sheet.js';
import { cached, cacheGet, cacheSet, pool } from './cache.js';

export const ROSTER_TTL = 10 * 60 * 1000;     // summaries
export const CLIENT_TTL = 3 * 60 * 1000;      // one client's detail
export const DISCOVERY_TTL = 60 * 60 * 1000;  // the client list barely changes
const TAB_KEY = 'tabs';                       // spreadsheetId -> resolved tab title

const nameMatch = () => process.env.SHEET_NAME_MATCH || 'TBD Guide';

/**
 * Find the tab holding the check-in block. It is tab 1 for some clients and
 * tab 4 for others, so probe E21 on every tab in one batchGet and take the one
 * that says "Weight Log". The answer is cached per spreadsheet and re-checked
 * cheaply on each read, so a coach reordering tabs self-heals.
 */
export async function resolveTab(id, tabCache) {
  const known = tabCache[id];
  if (known) {
    const [probe] = await batchGet(id, [probeRange(known)]);
    if (String(probe?.[0]?.[0] || '').trim().toLowerCase() === PROBE_EXPECT) return known;
  }
  const tabs = await sheetTabs(id);
  if (!tabs.length) throw new Error('spreadsheet has no tabs');
  const probes = await batchGet(id, tabs.map(probeRange));
  const hit = tabs.findIndex((_, i) =>
    String(probes[i]?.[0]?.[0] || '').trim().toLowerCase() === PROBE_EXPECT);
  if (hit < 0) throw new Error('no tab with a "Weight Log" header at E21');
  tabCache[id] = tabs[hit];
  return tabs[hit];
}

export const sheetUrl = (f) =>
  f?.webViewLink || `https://docs.google.com/spreadsheets/d/${f?.id || f}/edit`;

export async function readClient(file, tabCache) {
  const tab = await resolveTab(file.id, tabCache);
  const [block, timeline] = await batchGet(file.id, RANGES(tab));
  return {
    id: file.id,
    name: clientName(file.name, nameMatch()),
    url: sheetUrl(file),
    modifiedTime: file.modifiedTime,
    tab,
    ...parse(block, timeline),
  };
}

export const discovery = () => cached('discovery', DISCOVERY_TTL, () =>
  listClientSheets({ match: nameMatch(), folderId: process.env.ACTIVE_FOLDER_ID || '' })
).then((r) => r.value);

export async function buildRoster() {
  const files = await discovery();
  const tabCache = (await cacheGet(TAB_KEY))?.value || {};

  const results = await pool(files, 6, async (f) => {
    try {
      return await readClient(f, tabCache);
    } catch (e) {
      // One unreadable sheet must not blank the whole roster.
      return {
        id: f.id,
        name: clientName(f.name, nameMatch()),
        url: sheetUrl(f),
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

export async function buildClient(id) {
  const tabCache = (await cacheGet(TAB_KEY))?.value || {};
  const tab = await resolveTab(id, tabCache);
  await cacheSet(TAB_KEY, tabCache);

  const [block, timeline] = await batchGet(id, RANGES(tab));
  // The detail route can run on a cold function, so re-derive the display name
  // from the cached discovery list rather than trusting the client to send it.
  const files = (await cacheGet('discovery'))?.value || [];
  const file = files.find((f) => f.id === id);
  return {
    id,
    tab,
    name: file ? clientName(file.name, nameMatch()) : 'Client',
    url: sheetUrl(file || id),
    modifiedTime: file?.modifiedTime || null,
    ...parse(block, timeline),
  };
}
