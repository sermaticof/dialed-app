// Google service-account auth + thin Drive/Sheets clients.
// The JWT signing is the same approach gideon-dashboard/netlify/functions/drive.js
// uses, lifted here and widened to cover the Sheets API.

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
].join(' ');

let cachedToken = null; // { token, exp } — survives warm invocations only

function b64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function importKey(pem) {
  const clean = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const bin = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', bin, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

async function sign(input, key) {
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function creds() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT is not set');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT is not valid JSON');
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT is missing client_email or private_key');
  }
  return parsed;
}

export async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp > now + 60) return cachedToken.token;

  const c = creds();
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: c.client_email,
    scope: SCOPES,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const sigInput = `${header}.${payload}`;
  const jwt = `${sigInput}.${await sign(sigInput, await importKey(c.private_key))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error(`Google auth failed: ${d.error_description || d.error || res.status}`);

  cachedToken = { token: d.access_token, exp: now + (d.expires_in || 3600) };
  return cachedToken.token;
}

async function api(url) {
  const token = await accessToken();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Google API ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Every spreadsheet the service account can see whose name matches the convention. */
export async function listClientSheets({ match = 'TBD Guide', folderId = '' } = {}) {
  const clauses = [
    "mimeType = 'application/vnd.google-apps.spreadsheet'",
    'trashed = false',
    `name contains '${match.replace(/'/g, "\\'")}'`,
  ];
  if (folderId) clauses.push(`'${folderId.replace(/'/g, "\\'")}' in parents`);
  const q = clauses.join(' and ');

  const files = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q,
      fields: 'nextPageToken, files(id,name,modifiedTime,webViewLink)',
      orderBy: 'name',
      pageSize: '200',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const d = await api(`https://www.googleapis.com/drive/v3/files?${params}`);
    files.push(...(d.files || []));
    pageToken = d.nextPageToken || '';
  } while (pageToken);

  return files;
}

/** Tab titles, in order. */
export async function sheetTabs(spreadsheetId) {
  const d = await api(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}` +
    `?fields=${encodeURIComponent('sheets.properties(title,index)')}`
  );
  return (d.sheets || [])
    .map((s) => s.properties)
    .sort((a, b) => a.index - b.index)
    .map((p) => p.title);
}

/**
 * Read several A1 ranges in one round trip.
 * FORMATTED_VALUE keeps "9/15" a date and "9,940.00" readable; numbers are
 * parsed downstream, which also lets us swallow "#DIV/0!" without special cases.
 */
export async function batchGet(spreadsheetId, ranges) {
  const params = new URLSearchParams({
    valueRenderOption: 'FORMATTED_VALUE',
    majorDimension: 'ROWS',
  });
  for (const r of ranges) params.append('ranges', r);
  const d = await api(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet?${params}`
  );
  return (d.valueRanges || []).map((v) => v.values || []);
}
