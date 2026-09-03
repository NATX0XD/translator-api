import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installFakeAdmin,
  useStore,
  acceptToken,
  rejectToken,
  makeReq,
  makeRes,
  stubTokenMint,
  TODAY,
} from '../test/harness.js';

installFakeAdmin();

const handler = (await import('./live-token.js')).default;

const run = ({ headers = {}, body = {} } = {}) => {
  const res = makeRes();
  return handler(makeReq({ headers, body }), res).then(() => res);
};

const bearer = { authorization: 'Bearer some.id.token' };

// --- H3: the gate is in the handler, so test the handler --------------------

test('no Authorization header: 401 before any Firestore read or Gemini mint', async () => {
  const store = useStore({ 'users_quota/attacker': { live_seconds_today: 0, last_reset_date: TODAY() } });
  const mints = stubTokenMint();

  const res = await run({ body: { uid: 'attacker' } });

  assert.equal(res.statusCode, 401);
  assert.equal(store.touched, 0, 'an unauthenticated caller must not reach Firestore');
  assert.equal(mints.length, 0, 'and must never be handed a Gemini credential');
});

test('an unverifiable token: 401 before any Firestore read or Gemini mint', async () => {
  const store = useStore({ 'users_quota/victim': { live_seconds_today: 0, last_reset_date: TODAY() } });
  const mints = stubTokenMint();
  rejectToken();

  const res = await run({ headers: bearer, body: { uid: 'victim' } });

  assert.equal(res.statusCode, 401);
  assert.equal(store.touched, 0);
  assert.equal(mints.length, 0);
});

test('a malformed Authorization header is refused too', async () => {
  const store = useStore({});
  const mints = stubTokenMint();
  acceptToken('user-1');

  for (const authorization of ['Basic abc', 'Bearer', 'Bearer   ', 'some.id.token']) {
    const res = await run({ headers: { authorization }, body: {} });
    assert.equal(res.statusCode, 401, `expected 401 for "${authorization}"`);
  }

  assert.equal(store.touched, 0);
  assert.equal(mints.length, 0);
});

test('the verified uid wins over a conflicting body uid', async () => {
  const store = useStore({
    'users_quota/user-1': { live_seconds_today: 0, live_seconds_limit: 600, last_reset_date: TODAY() },
    'users_quota/victim': { live_seconds_today: 0, live_seconds_limit: 600, last_reset_date: TODAY() },
  });
  stubTokenMint();
  acceptToken('user-1');

  const res = await run({ headers: bearer, body: { uid: 'victim' } });

  assert.equal(res.statusCode, 200);
  assert.ok(store.raw('users_quota/user-1').live_session, 'the session belongs to the token holder');
  assert.equal(
    store.raw('users_quota/victim').live_session,
    undefined,
    'a body uid must never steer the write at another account'
  );
});

// --- quota gate and abandoned billing, through the handler ------------------

test('an exhausted bucket is refused without minting', async () => {
  useStore({
    'users_quota/user-1': { live_seconds_today: 600, live_seconds_limit: 600, last_reset_date: TODAY() },
  });
  const mints = stubTokenMint();
  acceptToken('user-1');

  const res = await run({ headers: bearer });

  assert.equal(res.statusCode, 429);
  assert.equal(mints.length, 0);
});

test('a session left behind by a crashed tab is billed at the next mint', async () => {
  const store = useStore({
    'users_quota/user-1': {
      tokens_today: 2000,
      live_seconds_today: 100,
      live_seconds_limit: 600,
      last_reset_date: TODAY(),
      live_session: { mintedAt: Date.now() - 120_000, ttlSeconds: 600, confirmed: true },
    },
  });
  stubTokenMint();
  acceptToken('user-1');

  const res = await run({ headers: bearer });

  assert.equal(res.statusCode, 200);
  const doc = store.raw('users_quota/user-1');
  assert.equal(doc.live_seconds_today, 220, '100 already used plus the 120s the abandoned session could have run');
  assert.equal(doc.tokens_today, 2000, 'the mint must not touch the text bucket');
});

test('an UNCONFIRMED stale session bills nothing and does not 429 the user', async () => {
  const store = useStore({
    'users_quota/user-1': {
      live_seconds_today: 100,
      live_seconds_limit: 600,
      last_reset_date: TODAY(),
      // Minted, then the response was lost or the socket never opened.
      live_session: { mintedAt: Date.now() - 600_000, ttlSeconds: 600, confirmed: false },
    },
  });
  stubTokenMint();
  acceptToken('user-1');

  const res = await run({ headers: bearer });

  assert.equal(res.statusCode, 200, 'a stranded mint must not lock the user out for the day');
  assert.equal(res.body.remainingSeconds, 500);
  assert.equal(
    store.raw('users_quota/user-1').live_seconds_today,
    100,
    'zero audio was produced, so nothing may be billed'
  );
});

test('a fresh mint records the session as unconfirmed', async () => {
  const store = useStore({
    'users_quota/user-1': { live_seconds_today: 0, live_seconds_limit: 600, last_reset_date: TODAY() },
  });
  stubTokenMint();
  acceptToken('user-1');

  await run({ headers: bearer });

  assert.equal(
    store.raw('users_quota/user-1').live_session.confirmed,
    false,
    'until /api/live-confirm lands, the session cannot be billed as abandoned'
  );
});

test('a zeroed live limit is a suspension, not a licence to mint', async () => {
  const store = useStore({
    'users_quota/susp': { live_seconds_today: 0, live_seconds_limit: 0, last_reset_date: TODAY() },
  });
  const mints = stubTokenMint();
  acceptToken('susp');

  const res = await run({ headers: bearer });

  assert.equal(res.statusCode, 429, 'live_seconds_limit: 0 must refuse, not fall back to 600');
  assert.equal(mints.length, 0, 'a suspended account must never be handed a Gemini credential');
  assert.equal(store.raw('users_quota/susp').live_session, undefined);
});

test('a failed mint leaves no session behind to be billed later', async () => {
  const store = useStore({
    'users_quota/user-1': { live_seconds_today: 0, live_seconds_limit: 600, last_reset_date: TODAY() },
  });
  stubTokenMint({ ok: false, status: 502 });
  acceptToken('user-1');

  const res = await run({ headers: bearer });

  assert.equal(res.statusCode, 502);
  assert.equal(store.raw('users_quota/user-1').live_session, undefined);
});
