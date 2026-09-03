/**
 * The H1 failure sequence, end to end across both handlers. This is the case
 * the original review found and the case nothing covered: /api/translate used to
 * consume `last_reset_date` while zeroing only `tokens_today`, so the live
 * bucket never reset and /api/live-token 429'd forever after.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installFakeAdmin,
  useStore,
  acceptToken,
  makeReq,
  makeRes,
  stubGemini,
  stubTokenMint,
  TODAY,
  YESTERDAY,
} from '../test/harness.js';

installFakeAdmin();

const translate = (await import('./translate.js')).default;
const liveToken = (await import('./live-token.js')).default;

const call = (handler, { headers = {}, body = {} } = {}) => {
  const res = makeRes();
  return handler(makeReq({ headers, body }), res).then(() => res);
};

test('day 2: a text translation before the first mint does not lock Live out', async () => {
  // Day 1 ended with the whole live allowance spent.
  const store = useStore({
    'users_quota/user-1': {
      tokens_today: 4200,
      daily_limit: 10000,
      live_seconds_today: 600,
      live_seconds_limit: 600,
      last_reset_date: YESTERDAY(),
    },
  });
  stubGemini({ totalTokenCount: 50 });
  stubTokenMint();
  acceptToken('user-1');

  // Day 2, step one: an ordinary text translation, before the mic is touched.
  const translated = await call(translate, {
    body: { uid: 'user-1', sourceText: 'good morning', targets: [{ lang: 'Thai', objective: 'general', formality: 50 }] },
  });
  assert.equal(translated.statusCode, 200);

  const afterTranslate = store.raw('users_quota/user-1');
  assert.equal(afterTranslate.last_reset_date, TODAY());
  assert.equal(afterTranslate.tokens_today, 50);
  assert.equal(afterTranslate.live_seconds_today, 0, 'both buckets reset off the one date');

  // Day 2, step two: press the mic.
  const minted = await call(liveToken, { headers: { authorization: 'Bearer some.id.token' } });

  assert.equal(minted.statusCode, 200, 'the mint must succeed — 429 here is the permanent lockout');
  assert.equal(minted.body.remainingSeconds, 600);
});

test('the same sequence in the other order also works', async () => {
  const store = useStore({
    'users_quota/user-1': {
      tokens_today: 9000,
      daily_limit: 10000,
      live_seconds_today: 600,
      live_seconds_limit: 600,
      last_reset_date: YESTERDAY(),
    },
  });
  stubGemini({ totalTokenCount: 50 });
  stubTokenMint();
  acceptToken('user-1');

  const minted = await call(liveToken, { headers: { authorization: 'Bearer some.id.token' } });
  assert.equal(minted.statusCode, 200);
  assert.equal(store.raw('users_quota/user-1').tokens_today, 0, 'the mint reset the text bucket too');

  const translated = await call(translate, {
    body: { uid: 'user-1', sourceText: 'good morning', targets: [{ lang: 'Thai', objective: 'general', formality: 50 }] },
  });

  assert.equal(translated.statusCode, 200, 'a 429 here would mean the text bucket never reset');
  assert.equal(store.raw('users_quota/user-1').tokens_today, 50);
});
