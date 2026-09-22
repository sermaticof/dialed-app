// Local dev server: serves the app with synthetic client data, so the UI can
// be worked on without Google credentials or a deploy.
//
//   node dev/server.mjs   ->   http://localhost:8787   (passcode: dev)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../lib/sheet.js';
import authHandler from '../api/auth.js';
import sessionHandler from '../api/session.js';
import { requireAuth } from '../lib/auth.js';

// Real auth, mocked Google. The passcode path is the easiest thing to get
// subtly wrong, so dev runs the same code production does.
process.env.DIALED_PASSCODE ||= 'dev';
process.env.DIALED_SESSION_SECRET ||= 'dev-only-not-a-secret';

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const PORT = process.env.PORT || 8787;
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.js': 'text/javascript' };

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

/* --------------------------------------------------- synthetic fixtures -- */

function grid(from, to, cells) {
  const out = [];
  for (let r = from; r <= to; r++) {
    const row = new Array(17).fill('');
    for (const [ref, val] of Object.entries(cells)) {
      const m = /^([A-R])(\d+)$/.exec(ref);
      if (Number(m[2]) === r) row[m[1].charCodeAt(0) - 66] = val;
    }
    out.push(row);
  }
  return out;
}

/** Deterministic pseudo-random so the dev roster looks the same every reload. */
function rng(seed) {
  let s = [...String(seed)].reduce((a, c) => a + c.charCodeAt(0), 0);
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

function makeClient(name, { checkInDay, phase, base, drift, weeksOut, showDay, missing = [] }) {
  const rnd = rng(name);
  const start = DAYS.indexOf(checkInDay);
  const todayIdx = new Date().getDay();
  const due = ((todayIdx - start + 7) % 7) + 1;

  const block = {
    B21: 'Protocol Summary', E21: 'Weight Log', G21: 'Date', H21: 'Cardio Log', J21: 'Step Log',
    B22: 'Water intake:', C22: '1-1.5 gal/day',
    B23: 'Baseline Diet:', C23: 'Everyday',
    B25: 'Free meal:', C25: phase === 'PREP' ? 'NONE' : 'Saturday',
    B26: 'Check-in Day:', C26: checkInDay,
    B27: 'Show Day:', C27: showDay || '',
    B28: 'Weeks out:', C28: weeksOut || '',
    B29: 'Next Payment:', E29: '7-day AVG', J29: '7-day AVG',
  };

  const weights = [];
  for (let i = 0; i < 7; i++) {
    const row = 22 + i;
    block[`E${row}`] = DAYS[(start + i) % 7];
    block[`G${row}`] = `9/${15 + i}`;
    if (i < due && !missing.includes(i)) {
      const w = base + drift * i + (rnd() - 0.5) * 1.6;
      weights.push(w);
      block[`F${row}`] = w.toFixed(2);
      block[`I${row}`] = rnd() > 0.35 ? 'TRUE' : 'FALSE';
      block[`K${row}`] = (8000 + Math.round(rnd() * 6000)).toLocaleString('en-US', { minimumFractionDigits: 2 });
    } else if (i < due) {
      block[`I${row}`] = 'FALSE';
    }
  }
  if (weights.length) {
    block.F29 = (weights.reduce((a, b) => a + b, 0) / weights.length).toFixed(2);
    block.K29 = (9000 + Math.round(rnd() * 3000)).toLocaleString('en-US', { minimumFractionDigits: 2 });
  }

  const NOTES = [
    'weight stabilizing. no changes needed this week',
    'bumped cardio. no other changes',
    'missed some cardio. moving this weekend. no changes',
    'weight down. look is improving. no changes for now',
    'entering growth phase. bumped food back up to maintenance',
  ];
  const tl = { B33: 'Week of:', C33: 'Phase', D33: 'AVG Weight', E33: 'Activity', G33: 'FOOD', I33: 'Training', K33: 'Supps', M33: 'Coach Notes / Updates' };
  let prev = base - drift * 3.2;
  for (let i = 0; i < 14; i++) {
    const row = 34 + i;
    const d = new Date(Date.now() - (i + 1) * 7 * 864e5);
    tl[`B${row}`] = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
    tl[`C${row}`] = phase;
    tl[`D${row}`] = (prev + i * drift * 3.4 + (rnd() - 0.5) * 0.7).toFixed(2);
    tl[`E${row}`] = '10k (9,412) no changes';
    tl[`G${row}`] = i % 3 ? 'No changes' : 'H: 230P/300C/70F  L: 230P/180C/70F';
    tl[`I${row}`] = 'No changes';
    tl[`K${row}`] = 'no changes';
    tl[`M${row}`] = NOTES[i % NOTES.length];
  }

  const id = 'dev' + name.replace(/\W/g, '').padEnd(22, 'x');
  return {
    id,
    name,
    url: 'https://docs.google.com/spreadsheets/d/' + id,
    tab: 'Check-in',
    modifiedTime: new Date().toISOString(),
    ...parse(grid(21, 29, block), grid(33, 60, tl)),
  };
}

// Fictional names on purpose — this repository is public and the real roster
// is not ours to publish.
const CLIENTS = [
  makeClient('Avery',   { checkInDay: 'Tuesday',  phase: 'GROWTH',  base: 167.4, drift:  0.12, missing: [1] }),
  makeClient('Bo',     { checkInDay: 'Thursday', phase: 'CUT',     base: 155.8, drift: -0.08, weeksOut: '6',  showDay: '10/31/2026' }),
  makeClient('Cass',   { checkInDay: 'Thursday', phase: 'PREP',    base: 160.7, drift: -0.34, weeksOut: '9',  showDay: '11/21/2026', missing: [0] }),
  makeClient('Dane',    { checkInDay: 'Monday',   phase: 'PRIMING', base: 182.2, drift:  0.02 }),
  makeClient('Emery <3',  { checkInDay: 'Monday',   phase: 'CUT',     base: 134.5, drift: -0.22 }),
  makeClient('Frankie',   { checkInDay: 'Wednesday',phase: 'GROWTH',  base: 201.9, drift:  0.31 }),
  makeClient('Gray',      { checkInDay: 'Tuesday',  phase: 'CUT',     base: 224.0, drift:  0.18, missing: [2, 3] }),
  makeClient('Harper',    { checkInDay: 'Friday',   phase: 'PREP',    base: 148.3, drift: -0.19, weeksOut: '3', showDay: '10/10/2026' }),
  makeClient('Indigo',     { checkInDay: 'Wednesday',phase: 'GROWTH',  base: 171.6, drift:  0.09 }),
  makeClient('Jules', { checkInDay: 'Monday',   phase: 'PRIMING', base: 193.4, drift: -0.05 }),
];

const badSheet = {
  id: 'devBroken' + 'x'.repeat(16),
  name: 'Kai',
  url: 'https://docs.google.com/spreadsheets/d/devBroken',
  error: 'no tab with a "Weight Log" header at E21',
  days: [], weeks: [],
};

/* ------------------------------------------------------------- routing -- */

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

/** Adapt a Node request into the web Request the real handlers expect. */
async function toRequest(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).filter(([, v]) => v != null),
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
  });
}

async function relay(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  // Secure cookies never come back over plain http://localhost.
  if (headers['set-cookie']) headers['set-cookie'] = headers['set-cookie'].replace(/;\s*Secure/gi, '');
  res.writeHead(response.status, headers);
  res.end(await response.text());
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/auth') return relay(res, await authHandler(await toRequest(req)));
  if (url.pathname === '/api/session') return relay(res, await sessionHandler(await toRequest(req)));

  if (url.pathname.startsWith('/api/')) {
    const denied = await requireAuth(await toRequest(req));
    if (denied) return relay(res, denied);
    if (url.pathname === '/api/roster') {
      return send(res, 200, { clients: [...CLIENTS, badSheet], updatedAt: Date.now(), stale: false });
    }
    if (url.pathname === '/api/client') {
      const c = CLIENTS.find((x) => x.id === url.searchParams.get('id'));
      return c ? send(res, 200, { client: c, updatedAt: Date.now() }) : send(res, 404, { error: 'not found' });
    }
    return send(res, 404, { error: 'not found' });
  }

  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const abs = path.join(ROOT, file);
  if (!abs.startsWith(path.resolve(ROOT)) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    return send(res, 404, 'not found', { 'Content-Type': 'text/plain' });
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(abs)] || 'application/octet-stream' });
  fs.createReadStream(abs).pipe(res);
}).listen(PORT, () => console.log(`dialed dev server → http://localhost:${PORT}  (passcode: dev)`));
