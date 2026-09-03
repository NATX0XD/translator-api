import test from 'node:test';
import assert from 'node:assert/strict';
import { planTokenMint, planUsageReport, isEmptyPlan } from './quotaStore.js';
import { BILLING_REASONS } from './liveQuota.js';

const TODAY = '2026-09-03';
const NOW = 1_700_000_000_000;

// --- H1: one reset rule, both buckets -------------------------------------

test('minting on a new day resets BOTH counters, not just live seconds', () => {
  const { plan, remainingSeconds } = planTokenMint({
    data: { tokens_today: 9000, live_seconds_today: 600, last_reset_date: '2026-09-02' },
    todayStr: TODAY,
    nowMs: NOW,
  });

  assert.equal(plan.set.tokens_today, 0);
  assert.equal(plan.set.live_seconds_today, 0);
  assert.equal(plan.set.last_reset_date, TODAY);
  assert.equal(remainingSeconds, 600);
});

test('reporting usage on a new day resets both counters in the same write', () => {
  const { plan } = planUsageReport({
    data: {
      tokens_today: 9000,
      live_seconds_today: 600,
      last_reset_date: '2026-09-02',
      live_session: { mintedAt: NOW - 30_000, ttlSeconds: 600 },
    },
    todayStr: TODAY,
    nowMs: NOW,
    reported: 30,
  });

  assert.equal(plan.set.tokens_today, 0);
  assert.equal(plan.set.last_reset_date, TODAY);
  assert.equal(plan.set.live_seconds_today, 30, 'reset and the new charge land atomically');
  assert.equal(plan.increment.live_seconds_today, undefined);
});

// --- H2: never clobber a counter another endpoint owns ---------------------

test('a same-day mint never writes tokens_today', () => {
  const { plan } = planTokenMint({
    data: { tokens_today: 2000, live_seconds_today: 100, live_seconds_limit: 600, last_reset_date: TODAY },
    todayStr: TODAY,
    nowMs: NOW,
  });

  assert.equal('tokens_today' in plan.set, false);
  assert.equal('tokens_today' in plan.increment, false);
});

test('a same-day usage report never writes tokens_today and increments live seconds', () => {
  const { plan, billedSeconds } = planUsageReport({
    data: {
      tokens_today: 2000,
      live_seconds_today: 100,
      live_seconds_limit: 600,
      last_reset_date: TODAY,
      live_session: { mintedAt: NOW - 42_000, ttlSeconds: 600 },
    },
    todayStr: TODAY,
    nowMs: NOW,
    reported: 42,
  });

  assert.equal('tokens_today' in plan.set, false);
  assert.equal('tokens_today' in plan.increment, false);
  assert.equal(billedSeconds, 42);
  assert.equal(plan.increment.live_seconds_today, 42, 'relative, so a concurrent write is not lost');
  assert.equal('live_seconds_today' in plan.set, false);
});

test('a zero bill writes no counter at all', () => {
  const { plan, billedSeconds } = planUsageReport({
    data: { live_seconds_today: 10, live_seconds_limit: 600, last_reset_date: TODAY },
    todayStr: TODAY,
    nowMs: NOW,
    reported: 30,
  });

  assert.equal(billedSeconds, 0);
  assert.equal('live_seconds_today' in plan.increment, false);
  assert.equal('live_seconds_today' in plan.set, false);
});

// --- M1: a zero bill says why ---------------------------------------------

test('usage report reasons distinguish the three ways to bill zero', () => {
  const base = { todayStr: TODAY, nowMs: NOW };

  assert.equal(
    planUsageReport({ ...base, data: { live_seconds_today: 0, last_reset_date: TODAY }, reported: 30 }).reason,
    BILLING_REASONS.NO_SESSION
  );

  assert.equal(
    planUsageReport({
      ...base,
      data: { live_seconds_today: 600, live_seconds_limit: 600, last_reset_date: TODAY, live_session: { mintedAt: NOW - 30_000, ttlSeconds: 600 } },
      reported: 30,
    }).reason,
    BILLING_REASONS.QUOTA_EXHAUSTED
  );

  assert.equal(
    planUsageReport({
      ...base,
      data: { last_reset_date: TODAY, live_session: { mintedAt: NOW - 30_000, ttlSeconds: 600 } },
      reported: -5,
    }).reason,
    BILLING_REASONS.INVALID_REPORT
  );

  assert.equal(
    planUsageReport({
      ...base,
      data: { last_reset_date: TODAY, live_session: { mintedAt: NOW - 30_000, ttlSeconds: 600 } },
      reported: 30,
    }).reason,
    BILLING_REASONS.OK
  );
});

// --- M2: abandoned sessions get billed at the next mint --------------------

test('minting bills a prior session that was never reported', () => {
  const { plan, abandonedSeconds, remainingSeconds, liveSecondsToday } = planTokenMint({
    data: {
      live_seconds_today: 100,
      live_seconds_limit: 600,
      last_reset_date: TODAY,
      live_session: { mintedAt: NOW - 120_000, ttlSeconds: 600 },
    },
    todayStr: TODAY,
    nowMs: NOW,
  });

  assert.equal(abandonedSeconds, 120);
  assert.equal(plan.increment.live_seconds_today, 120);
  assert.equal(liveSecondsToday, 220);
  assert.equal(remainingSeconds, 380);
});

test('an abandoned session is capped by its TTL, not by wall clock', () => {
  const { abandonedSeconds } = planTokenMint({
    data: {
      live_seconds_today: 0,
      live_seconds_limit: 600,
      last_reset_date: TODAY,
      live_session: { mintedAt: NOW - 86_400_000, ttlSeconds: 600 },
    },
    todayStr: TODAY,
    nowMs: NOW,
  });

  assert.equal(abandonedSeconds, 600, 'a tab left open overnight bills the token TTL, not a full day');
});

test('an abandoned session cannot push the bucket past its limit', () => {
  const { abandonedSeconds, remainingSeconds } = planTokenMint({
    data: {
      live_seconds_today: 550,
      live_seconds_limit: 600,
      last_reset_date: TODAY,
      live_session: { mintedAt: NOW - 600_000, ttlSeconds: 600 },
    },
    todayStr: TODAY,
    nowMs: NOW,
  });

  assert.equal(abandonedSeconds, 50);
  assert.equal(remainingSeconds, 0, 'so the mint that follows is refused with 429');
});

test('minting with no prior session bills nothing and touches no counter', () => {
  const { plan, abandonedSeconds } = planTokenMint({
    data: { live_seconds_today: 100, live_seconds_limit: 600, last_reset_date: TODAY },
    todayStr: TODAY,
    nowMs: NOW,
  });

  assert.equal(abandonedSeconds, 0);
  assert.equal(isEmptyPlan(plan), true);
});

test('a session left over from a previous day is dropped, not charged to today', () => {
  const { plan, abandonedSeconds, remainingSeconds } = planTokenMint({
    data: {
      live_seconds_today: 400,
      live_seconds_limit: 600,
      last_reset_date: '2026-09-02',
      live_session: { mintedAt: NOW - 600_000, ttlSeconds: 600 },
    },
    todayStr: TODAY,
    nowMs: NOW,
  });

  assert.equal(abandonedSeconds, 0);
  assert.equal(plan.set.live_seconds_today, 0);
  assert.equal(remainingSeconds, 600);
  assert.ok(plan.delete.includes('live_session'));
});

// --- session lifecycle ------------------------------------------------------

test('both handlers clear live_session so a replay finds nothing to bill', () => {
  const data = {
    live_seconds_today: 0,
    live_seconds_limit: 600,
    last_reset_date: TODAY,
    live_session: { mintedAt: NOW - 10_000, ttlSeconds: 600 },
  };

  assert.ok(planTokenMint({ data, todayStr: TODAY, nowMs: NOW }).plan.delete.includes('live_session'));
  assert.ok(planUsageReport({ data, todayStr: TODAY, nowMs: NOW, reported: 10 }).plan.delete.includes('live_session'));
});

test('a brand new user gets the live limit backfilled', () => {
  const { plan } = planTokenMint({ data: null, todayStr: TODAY, nowMs: NOW });
  assert.equal(plan.set.live_seconds_limit, 600);
  assert.equal(plan.delete.includes('live_session'), false, 'nothing to clear on a doc that does not exist');
});

test('a custom live limit is never overwritten by the default', () => {
  const { plan, remainingSeconds } = planTokenMint({
    data: { live_seconds_today: 0, live_seconds_limit: 1800, last_reset_date: TODAY },
    todayStr: TODAY,
    nowMs: NOW,
  });

  assert.equal('live_seconds_limit' in plan.set, false);
  assert.equal(remainingSeconds, 1800);
});
