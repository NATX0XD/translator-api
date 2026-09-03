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

const handler = (await import('./live-usage.js')).default;

const run = ({ headers = {}, body = {} } = {}) => {
  const res = makeRes();
  return handler(makeReq({ headers, body }), res).then(() => res);
};

const bearer = { authorization: 'Bearer some.id.token' };

const session = (agoMs = 60_000) => ({ mintedAt: Date.now() - agoMs, ttlSeconds: 600 });

// --- H3 at the handler ------------------------------------------------------

test('no Authorization header: 401 before Firestore', async () => {
  const store = useStore({
    'users_quota/victim': { live_seconds_today: 0, live_seconds_limit: 600, last_reset_date: TODAY() },
  });

  const res = await run({ body: { uid: 'victim', seconds: 600 } });

  assert.equal(res.statusCode, 401);
  assert.equal(store.touched, 0, 'draining a stranger\'s bucket must not even reach the database');
});

test('an unverifiable token: 401 before Firestore', async () => {
  const store = useStore({});
  rejectToken();

  const res = await run({ headers: bearer, body: { uid: 'victim', seconds: 600 } });

  assert.equal(res.statusCode, 401);
  assert.equal(store.touched, 0);
});

test('the bill lands on the verified uid, not the body uid', async () => {
  const store = useStore({
    'users_quota/user-1': {
      live_seconds_today: 10,
      live_seconds_limit: 600,
      last_reset_date: TODAY(),
      live_session: session(),
    },
    'users_quota/victim': {
      live_seconds_today: 0,
      live_seconds_limit: 600,
      last_reset_date: TODAY(),
      live_session: session(),
    },
  });
  acceptToken('user-1');

  const res = await run({ headers: bearer, body: { uid: 'victim', seconds: 30 } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.billedSeconds, 30);
  assert.equal(store.raw('users_quota/user-1').live_seconds_today, 40);
  assert.equal(store.raw('users_quota/victim').live_seconds_today, 0, 'the body uid must be inert');
});

// --- H2 at the handler: the increment must survive a concurrent write -------

test('a concurrent text-token increment is not refunded by the usage report', async () => {
  const store = useStore({
    'users_quota/user-1': {
      tokens_today: 2000,
      live_seconds_today: 0,
      live_seconds_limit: 600,
      last_reset_date: TODAY(),
      live_session: session(),
    },
  });
  acceptToken('user-1');

  // Two /api/translate calls land between this handler's read and its write.
  store.onNextRead = () => {
    store.commitExternal('users_quota/user-1', { tokens_today: 2600 });
  };

  const res = await run({ headers: bearer, body: { seconds: 30 } });

  assert.equal(res.statusCode, 200);
  const doc = store.raw('users_quota/user-1');
  assert.equal(doc.tokens_today, 2600, 'an absolute write here refunds text quota on demand');
  assert.equal(doc.live_seconds_today, 30);
});

test('a replayed report finds no session and bills nothing', async () => {
  const store = useStore({
    'users_quota/user-1': {
      live_seconds_today: 0,
      live_seconds_limit: 600,
      last_reset_date: TODAY(),
      live_session: session(),
    },
  });
  acceptToken('user-1');

  const first = await run({ headers: bearer, body: { seconds: 30 } });
  const second = await run({ headers: bearer, body: { seconds: 30 } });

  assert.equal(first.body.billedSeconds, 30);
  assert.equal(second.body.billedSeconds, 0);
  assert.equal(second.body.reason, 'no_session');
  assert.equal(store.raw('users_quota/user-1').live_seconds_today, 30);
});

test('a request with no body is a 400, not an unhandled crash', async () => {
  const store = useStore({});
  acceptToken('user-1');

  const res = makeRes();
  await handler({ method: 'POST', headers: bearer }, res);

  assert.equal(res.statusCode, 400, 'destructuring req.body outside the try turns this into an opaque 500');
  assert.equal(store.touched, 0);
});
