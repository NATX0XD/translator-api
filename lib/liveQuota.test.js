import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_SECONDS_LIMIT,
  todayString,
  normalizeQuota,
  clampBillableSeconds,
} from './liveQuota.js';

test('todayString formats as YYYY-MM-DD', () => {
  assert.equal(todayString(new Date('2026-09-03T18:22:00Z')), '2026-09-03');
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
