// Auth route tests. These run the real handlers — no Google, no network.
//
//   node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DIALED_PASSCODE = 'correct-horse';
process.env.DIALED_SESSION_SECRET = 'test-secret';

const authHandler = (await import('../api/auth.js')).default;
const sessionHandler = (await import('../api/session.js')).default;
const rosterHandler = (await import('../api/roster.js')).default;
const { safeEqual } = await import('../lib/auth.js');

const post = (passcode) => new Request('http://x/api/auth', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ passcode }),
});

const withCookie = (path, cookie) =>
  new Request(`http://x${path}`, { headers: cookie ? { cookie } : {} });

/** Pull the bare "name=value" out of a Set-Cookie header. */
const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];

test('the right passcode issues a session cookie', async () => {
  const res = await authHandler(post('correct-horse'));
  assert.equal(res.status, 200);
  const sc = res.headers.get('set-cookie');
  assert.match(sc, /^dialed_session=/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /Secure/);
  assert.match(sc, /SameSite=Lax/);
});

test('a wrong passcode is rejected', async () => {
  const res = await authHandler(post('nope'));
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('an empty passcode is rejected', async () => {
  assert.equal((await authHandler(post(''))).status, 401);
});

test('a malformed body is a 400, not a crash', async () => {
  const res = await authHandler(new Request('http://x/api/auth', { method: 'POST', body: 'not json' }));
  assert.equal(res.status, 400);
});

test('GET is not allowed on the auth route', async () => {
  assert.equal((await authHandler(new Request('http://x/api/auth'))).status, 405);
});

test('a valid cookie authenticates', async () => {
  const cookie = cookieOf(await authHandler(post('correct-horse')));
  const res = await sessionHandler(withCookie('/api/session', cookie));
  assert.deepEqual(await res.json(), { authed: true });
});

test('no cookie does not authenticate', async () => {
  assert.deepEqual(await (await sessionHandler(withCookie('/api/session'))).json(), { authed: false });
});

test('a tampered signature is rejected', async () => {
  const cookie = cookieOf(await authHandler(post('correct-horse')));
  const [name, value] = cookie.split('=');
  const [exp] = value.split('.');
  const forged = `${name}=${exp}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
  assert.deepEqual(await (await sessionHandler(withCookie('/api/session', forged))).json(), { authed: false });
});

test('an expired cookie is rejected even though its signature is valid', async () => {
  // Signature is over the expiry itself, so a past expiry is genuinely signed.
  const cookie = cookieOf(await authHandler(post('correct-horse')));
  const sig = cookie.split('=')[1].split('.')[1];
  const forged = `dialed_session=1.${sig}`;
  assert.deepEqual(await (await sessionHandler(withCookie('/api/session', forged))).json(), { authed: false });
});

test('a signature from a different secret is rejected', async () => {
  const cookie = cookieOf(await authHandler(post('correct-horse')));
  process.env.DIALED_SESSION_SECRET = 'rotated';
  const res = await sessionHandler(withCookie('/api/session', cookie));
  process.env.DIALED_SESSION_SECRET = 'test-secret';
  assert.deepEqual(await res.json(), { authed: false });
});

test('data routes refuse an unauthenticated caller', async () => {
  const res = await rosterHandler(withCookie('/api/roster'));
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthorized' });
});

test('data routes are never stored in a shared cache', async () => {
  const res = await rosterHandler(withCookie('/api/roster'));
  assert.match(res.headers.get('cache-control'), /no-store/);
  assert.match(res.headers.get('cache-control'), /private/);
});

test('a bad spreadsheet id is rejected before any Google call', async () => {
  const clientHandler = (await import('../api/client.js')).default;
  const cookie = cookieOf(await authHandler(post('correct-horse')));
  const res = await clientHandler(withCookie('/api/client?id=../../etc/passwd', cookie));
  assert.equal(res.status, 400);
});

test('safeEqual compares correctly regardless of length', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
});
