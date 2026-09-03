import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installFakeAdmin,
  useStore,
  acceptToken,
  rejectToken,
  makeReq,
  makeRes,
  TODAY,
} from '../test/harness.js';

installFakeAdmin();

const handler = (await import('./live-confirm.js')).default;

const run = ({ headers = {}, body = {} } = {}) => {
  const res = makeRes();
  return handler(makeReq({ headers, body }), res).then(() => res);
};

const bearer = { authorization: 'Bearer some.id.token' };
const session = () => ({ mintedAt: Date.now() - 1000, ttlSeconds: 600, confirmed: false });

// --- same auth gate as the other two live endpoints -------------------------

test('no Authorization header: 401 before Firestore', async () => {
  const store = useStore({
    'users_quota/victim': { last_reset_date: TODAY(), live_session: session() },
  });

  const res = await run({ body: { uid: 'victim' } });

  assert.equal(res.statusCode, 401);
  assert.equal(store.touched, 0);
});

test('an unverifiable token: 401 before Firestore', async () => {
  const store = useStore({});
  rejectToken();

  const res = await run({ headers: bearer });

  assert.equal(res.statusCode, 401);
  assert.equal(store.touched, 0);
});

test('a malformed Authorization header is refused too', async () => {
  const store = useStore({});
  acceptToken('user-1');

  for (const authorization of ['Basic abc', 'Bearer', 'Bearer   ', 'some.id.token']) {
    const res = await run({ headers: { authorization } });
    assert.equal(res.statusCode, 401, `expected 401 for "${authorization}"`);
  }

  assert.equal(store.touched, 0);
});

// --- the contract -----------------------------------------------------------

test('confirming flips the flag and keeps the rest of the session intact', async () => {
  const mintedAt = Date.now() - 1000;
  const store = useStore({
    'users_quota/user-1': {
      live_seconds_today: 0,
      live_seconds_limit: 600,
      last_reset_date: TODAY(),
      live_session: { mintedAt, ttlSeconds: 600, confirmed: false },
    },
  });
  acceptToken('user-1');

  const res = await run({ headers: bearer });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { confirmed: true });

  const stored = store.raw('users_quota/user-1').live_session;
  assert.equal(stored.confirmed, true);
  assert.equal(stored.mintedAt, mintedAt, 'the mint time drives billing and must survive');
  assert.equal(stored.ttlSeconds, 600);
});

test('confirming with no live session answers false instead of inventing one', async () => {
  const store = useStore({
    'users_quota/user-1': { live_seconds_today: 0, live_seconds_limit: 600, last_reset_date: TODAY() },
  });
  acceptToken('user-1');

  const res = await run({ headers: bearer });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { confirmed: false });
  assert.equal(store.raw('users_quota/user-1').live_session, undefined);
});

test('confirming against a document that does not exist answers false', async () => {
  const store = useStore({});
  acceptToken('ghost');

  const res = await run({ headers: bearer });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { confirmed: false });
  assert.equal(store.raw('users_quota/ghost'), null, 'and must not create a document');
});

test('the confirmation lands on the verified uid, not a body uid', async () => {
  const store = useStore({
    'users_quota/user-1': { last_reset_date: TODAY(), live_session: session() },
    'users_quota/victim': { last_reset_date: TODAY(), live_session: session() },
  });
  acceptToken('user-1');

  const res = await run({ headers: bearer, body: { uid: 'victim' } });

  assert.equal(res.statusCode, 200);
  assert.equal(store.raw('users_quota/user-1').live_session.confirmed, true);
  assert.equal(store.raw('users_quota/victim').live_session.confirmed, false, 'the body uid must be inert');
});

test('confirming twice is harmless', async () => {
  const store = useStore({
    'users_quota/user-1': { last_reset_date: TODAY(), live_session: session() },
  });
  acceptToken('user-1');

  await run({ headers: bearer });
  const second = await run({ headers: bearer });

  assert.deepEqual(second.body, { confirmed: true });
  assert.equal(store.raw('users_quota/user-1').live_session.confirmed, true);
});

test('a missing body is fine — the uid comes from the token', async () => {
  const store = useStore({
    'users_quota/user-1': { last_reset_date: TODAY(), live_session: session() },
  });
  acceptToken('user-1');

  const res = makeRes();
  await handler({ method: 'POST', headers: bearer }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { confirmed: true });
});

test('OPTIONS preflight advertises Authorization', async () => {
  useStore({});
  const res = makeRes();
  await handler({ method: 'OPTIONS', headers: {}, body: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Access-Control-Allow-Headers'], /Authorization/);
});

test('a non-POST is refused', async () => {
  useStore({});
  acceptToken('user-1');
  const res = makeRes();
  await handler({ method: 'GET', headers: bearer, body: {} }, res);

  assert.equal(res.statusCode, 405);
});
