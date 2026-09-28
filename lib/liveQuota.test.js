import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_SECONDS_LIMIT,
  BILLING_REASONS,
  todayString,
  normalizeQuota,
  clampBillableSeconds,
  billLiveSeconds,
  abandonedSessionSeconds,
  needsReset,
  buildResetUpdate,
} from './liveQuota.js';

test('todayString formats as YYYY-MM-DD', () => {
  assert.equal(todayString(new Date('2026-09-03T08:22:00Z')), '2026-09-03');
});

test('todayString cuts the day at Bangkok midnight, not UTC midnight', () => {
  // 23:59 ICT on the 3rd is still 16:59Z on the 3rd — same day either way.
  assert.equal(todayString(new Date('2026-09-03T16:59:00Z')), '2026-09-03');
  // 00:00 ICT on the 4th is 17:00Z on the 3rd. UTC would still say the 3rd and
  // hold the user's quota hostage until 07:00 ICT.
  assert.equal(todayString(new Date('2026-09-03T17:00:00Z')), '2026-09-04');
  // 06:59 ICT on the 4th — the old UTC rule only rolled over at 07:00 ICT.
  assert.equal(todayString(new Date('2026-09-03T23:59:00Z')), '2026-09-04');
});

test('normalizeQuota fills defaults for a brand new user', () => {
  const q = normalizeQuota(null, '2026-09-03');
  assert.equal(q.tokens_today, 0);
  assert.equal(q.daily_limit, 10000);
  assert.equal(q.live_seconds_today, 0);
  assert.equal(q.live_seconds_limit, LIVE_SECONDS_LIMIT);
  assert.equal(q.last_reset_date, '2026-09-03');
  assert.equal(q.wasReset, true);
});

test('normalizeQuota keeps counters when the date still matches', () => {
  const q = normalizeQuota(
    { tokens_today: 500, daily_limit: 10000, live_seconds_today: 90, live_seconds_limit: 600, last_reset_date: '2026-09-03' },
    '2026-09-03'
  );
  assert.equal(q.tokens_today, 500);
  assert.equal(q.live_seconds_today, 90);
  assert.equal(q.wasReset, false);
});

test('normalizeQuota zeroes both counters on a new day', () => {
  const q = normalizeQuota(
    { tokens_today: 9000, live_seconds_today: 600, last_reset_date: '2026-09-02' },
    '2026-09-03'
  );
  assert.equal(q.tokens_today, 0);
  assert.equal(q.live_seconds_today, 0);
  assert.equal(q.last_reset_date, '2026-09-03');
  assert.equal(q.wasReset, true);
});

test('normalizeQuota preserves a custom live limit', () => {
  const q = normalizeQuota({ live_seconds_limit: 1800, last_reset_date: '2026-09-03' }, '2026-09-03');
  assert.equal(q.live_seconds_limit, 1800);
});

// Setting a limit to 0 is how an operator suspends a user. It is the one value a
// `||` fallback turns into the full default, and every other test here only ever
// omits the field — which is why this needs to be spelled out separately.
test('normalizeQuota keeps an explicit live limit of 0 instead of granting the default', () => {
  const q = normalizeQuota({ live_seconds_limit: 0, last_reset_date: '2026-09-03' }, '2026-09-03');
  assert.equal(q.live_seconds_limit, 0, 'a suspended user must not be handed the 600s default');
});

test('normalizeQuota keeps an explicit daily limit of 0', () => {
  const q = normalizeQuota({ daily_limit: 0, last_reset_date: '2026-09-03' }, '2026-09-03');
  assert.equal(q.daily_limit, 0, 'a suspended user must not be handed the 10000-token default');
});

test('normalizeQuota still defaults a MISSING limit', () => {
  const q = normalizeQuota({ last_reset_date: '2026-09-03' }, '2026-09-03');
  assert.equal(q.live_seconds_limit, LIVE_SECONDS_LIMIT);
  assert.equal(q.daily_limit, 10000);
});

test('normalizeQuota treats a zeroed live limit as an exhausted bucket', () => {
  const q = normalizeQuota({ live_seconds_today: 0, live_seconds_limit: 0, last_reset_date: '2026-09-03' }, '2026-09-03');
  assert.ok(q.live_seconds_limit - q.live_seconds_today <= 0, 'remaining must be <= 0 so the mint is refused');
});

test('clampBillableSeconds trusts an honest report', () => {
  const billable = clampBillableSeconds({
    reported: 42, mintedAtMs: 1000, nowMs: 1000 + 60_000, ttlSeconds: 600, used: 0, limit: 600,
  });
  assert.equal(billable, 42);
});

test('clampBillableSeconds caps an over-report at real elapsed time', () => {
  const billable = clampBillableSeconds({
    reported: 9999, mintedAtMs: 1000, nowMs: 1000 + 30_000, ttlSeconds: 600, used: 0, limit: 600,
  });
  assert.equal(billable, 30);
});

test('clampBillableSeconds caps at the token TTL', () => {
  const billable = clampBillableSeconds({
    reported: 5000, mintedAtMs: 0, nowMs: 4_000_000, ttlSeconds: 600, used: 0, limit: 600,
  });
  assert.equal(billable, 600);
});

test('clampBillableSeconds caps at remaining daily quota', () => {
  const billable = clampBillableSeconds({
    reported: 120, mintedAtMs: 0, nowMs: 600_000, ttlSeconds: 600, used: 550, limit: 600,
  });
  assert.equal(billable, 50);
});

test('clampBillableSeconds returns 0 when the bucket is already empty', () => {
  const billable = clampBillableSeconds({
    reported: 120, mintedAtMs: 0, nowMs: 600_000, ttlSeconds: 600, used: 600, limit: 600,
  });
  assert.equal(billable, 0);
});

test('clampBillableSeconds returns 0 without a minted session', () => {
  const billable = clampBillableSeconds({
    reported: 120, mintedAtMs: null, nowMs: 600_000, ttlSeconds: 600, used: 0, limit: 600,
  });
  assert.equal(billable, 0);
});

test('clampBillableSeconds rejects junk reports', () => {
  for (const reported of [-5, 0, NaN, undefined, 'abc']) {
    assert.equal(
      clampBillableSeconds({ reported, mintedAtMs: 0, nowMs: 60_000, ttlSeconds: 600, used: 0, limit: 600 }),
      0
    );
  }
});

test('needsReset compares against the stored reset date', () => {
  assert.equal(needsReset({ last_reset_date: '2026-09-03' }, '2026-09-03'), false);
  assert.equal(needsReset({ last_reset_date: '2026-09-02' }, '2026-09-03'), true);
  assert.equal(needsReset(null, '2026-09-03'), true);
  assert.equal(needsReset({}, '2026-09-03'), true);
});

test('buildResetUpdate zeroes both buckets off one date', () => {
  assert.deepEqual(buildResetUpdate('2026-09-03'), {
    tokens_today: 0,
    live_seconds_today: 0,
    last_reset_date: '2026-09-03',
  });
});

test('billLiveSeconds agrees with clampBillableSeconds and names the outcome', () => {
  const args = { reported: 42, mintedAtMs: 1000, nowMs: 1000 + 60_000, ttlSeconds: 600, used: 0, limit: 600 };
  assert.deepEqual(billLiveSeconds(args), { billedSeconds: 42, reason: BILLING_REASONS.OK });
  assert.equal(billLiveSeconds(args).billedSeconds, clampBillableSeconds(args));
});

test('billLiveSeconds separates no_session from quota_exhausted from invalid_report', () => {
  const base = { nowMs: 600_000, ttlSeconds: 600 };

  assert.deepEqual(
    billLiveSeconds({ ...base, reported: 120, mintedAtMs: null, used: 0, limit: 600 }),
    { billedSeconds: 0, reason: BILLING_REASONS.NO_SESSION }
  );
  assert.deepEqual(
    billLiveSeconds({ ...base, reported: 120, mintedAtMs: 0, used: 600, limit: 600 }),
    { billedSeconds: 0, reason: BILLING_REASONS.QUOTA_EXHAUSTED }
  );
  assert.deepEqual(
    billLiveSeconds({ ...base, reported: 'abc', mintedAtMs: 0, used: 0, limit: 600 }),
    { billedSeconds: 0, reason: BILLING_REASONS.INVALID_REPORT }
  );
  assert.equal(
    billLiveSeconds({ ...base, reported: 120, mintedAtMs: 900_000, used: 0, limit: 600 }).reason,
    BILLING_REASONS.INVALID_REPORT,
    'mintedAt in the future is clock skew, not a free session'
  );
});

test('abandonedSessionSeconds charges elapsed time capped by TTL and remaining quota', () => {
  const nowMs = 1_000_000;

  assert.equal(
    abandonedSessionSeconds({ session: { mintedAt: nowMs - 90_000, ttlSeconds: 600 }, nowMs, used: 0, limit: 600 }),
    90
  );
  assert.equal(
    abandonedSessionSeconds({ session: { mintedAt: 0, ttlSeconds: 600 }, nowMs, used: 0, limit: 600 }),
    600
  );
  assert.equal(
    abandonedSessionSeconds({ session: { mintedAt: 0, ttlSeconds: 600 }, nowMs, used: 580, limit: 600 }),
    20
  );
});

test('abandonedSessionSeconds bills nothing without a usable session', () => {
  const nowMs = 1_000_000;

  for (const session of [null, undefined, {}, { ttlSeconds: 600 }, { mintedAt: 'soon' }]) {
    assert.equal(abandonedSessionSeconds({ session, nowMs, used: 0, limit: 600 }), 0);
  }
});

test('abandonedSessionSeconds falls back to the default TTL when the session omits one', () => {
  assert.equal(
    abandonedSessionSeconds({ session: { mintedAt: 0 }, nowMs: 86_400_000, used: 0, limit: 10_000 }),
    600
  );
});
