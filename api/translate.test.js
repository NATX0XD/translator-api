import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installFakeAdmin,
  useStore,
  makeReq,
  makeRes,
  stubGemini,
  TODAY,
  YESTERDAY,
} from '../test/harness.js';

installFakeAdmin();

const handler = (await import('./translate.js')).default;

const target = (lang) => ({ lang, objective: 'general', formality: 50 });

const run = (body) => {
  const res = makeRes();
  return handler(makeReq({ body }), res).then(() => res);
};

// --- H1: the shared daily reset lives HERE, and nothing else tested it -------

test('the daily reset zeroes the live bucket, not just the token bucket', async () => {
  const store = useStore({
    'users_quota/user-1': {
      tokens_today: 9000,
      daily_limit: 10000,
      live_seconds_today: 600,
      live_seconds_limit: 600,
      last_reset_date: YESTERDAY(),
    },
  });
  stubGemini();

  const res = await run({ uid: 'user-1', sourceText: 'hello', targets: [target('Thai')] });

  assert.equal(res.statusCode, 200);
  const doc = store.raw('users_quota/user-1');
  assert.equal(doc.last_reset_date, TODAY());
  assert.equal(
    doc.live_seconds_today,
    0,
    'resetting tokens_today while consuming last_reset_date locks the user out of Live for good'
  );
});

test('a same-day request leaves the live bucket alone', async () => {
  const store = useStore({
    'users_quota/user-1': {
      tokens_today: 100,
      daily_limit: 10000,
      live_seconds_today: 240,
      live_seconds_limit: 600,
      last_reset_date: TODAY(),
    },
  });
  stubGemini({ totalTokenCount: 42 });

  await run({ uid: 'user-1', sourceText: 'hello', targets: [target('Thai')] });

  const doc = store.raw('users_quota/user-1');
  assert.equal(doc.live_seconds_today, 240, 'a text translation must never spend live seconds');
  assert.equal(doc.tokens_today, 142, 'and tokens are added, not overwritten');
});

test('a brand new user is created without clobbering a doc written concurrently', async () => {
  const store = useStore({});
  stubGemini({ totalTokenCount: 10 });

  // /api/live-token creates the doc (with a live session) in the window between
  // this handler's read and its write.
  store.onNextRead = () => {
    store.commitExternal('users_quota/user-1', {
      live_seconds_today: 30,
      live_seconds_limit: 600,
      last_reset_date: TODAY(),
      live_session: { mintedAt: 1, ttlSeconds: 600 },
    });
  };

  await run({ uid: 'user-1', sourceText: 'hello', targets: [target('Thai')] });

  const doc = store.raw('users_quota/user-1');
  assert.equal(doc.live_session?.ttlSeconds, 600, 'a non-merge set would have deleted the live session');
  assert.equal(doc.live_seconds_today, 30);
});

// --- N2: the reset must not wipe a charge committed in the same window ------

test('a live charge committed mid-request survives the daily reset', async () => {
  const store = useStore({
    'users_quota/user-1': {
      tokens_today: 500,
      daily_limit: 10000,
      live_seconds_today: 0,
      live_seconds_limit: 600,
      last_reset_date: YESTERDAY(),
    },
  });
  stubGemini({ totalTokenCount: 20 });

  // The day rolls over between this handler's read and its write, and
  // /api/live-usage gets its reset-plus-charge in first.
  store.onNextRead = () => {
    store.commitExternal('users_quota/user-1', {
      tokens_today: 0,
      live_seconds_today: 45,
      last_reset_date: TODAY(),
    });
  };

  const res = await run({ uid: 'user-1', sourceText: 'hello', targets: [target('Thai')] });

  assert.equal(res.statusCode, 200);
  assert.equal(
    store.raw('users_quota/user-1').live_seconds_today,
    45,
    'an absolute reset written from a stale read refunds seconds the live endpoint just billed'
  );
  assert.ok(store.transactionAttempts > 1, 'the reset must run in a transaction that notices the conflict');
});

// --- M4 leftover: the response schema must bound twoWay results -------------

test('twoWay pins the model to exactly one translation', async () => {
  useStore({ 'users_quota/user-1': { tokens_today: 0, daily_limit: 10000, last_reset_date: TODAY() } });
  const calls = stubGemini();

  await run({
    uid: 'user-1',
    sourceText: 'hello',
    twoWay: true,
    targets: [target('Thai'), target('English')],
  });

  const translations = calls[0].request.generationConfig.response_schema.properties.translations;
  assert.equal(translations.minItems, 1);
  assert.equal(translations.maxItems, 1, 'without this the model may answer with both targets');
});

test('the one-way schema stays unbounded', async () => {
  useStore({ 'users_quota/user-1': { tokens_today: 0, daily_limit: 10000, last_reset_date: TODAY() } });
  const calls = stubGemini();

  await run({ uid: 'user-1', sourceText: 'hello', targets: [target('Thai'), target('Japanese')] });

  const translations = calls[0].request.generationConfig.response_schema.properties.translations;
  assert.equal('maxItems' in translations, false);
});

test('twoWay with the wrong target count is refused before Firestore or the model', async () => {
  const store = useStore({ 'users_quota/user-1': { tokens_today: 0, daily_limit: 10000, last_reset_date: TODAY() } });
  const calls = stubGemini();

  const res = await run({ uid: 'user-1', sourceText: 'hello', twoWay: true, targets: [target('Thai')] });

  assert.equal(res.statusCode, 400);
  assert.equal(store.touched, 0);
  assert.equal(calls.length, 0);
});
