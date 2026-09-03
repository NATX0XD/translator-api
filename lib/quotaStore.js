import {
  BILLING_REASONS,
  DEFAULT_TTL_SECONDS,
  abandonedSessionSeconds,
  billLiveSeconds,
  buildResetUpdate,
  needsReset,
  normalizeQuota,
} from './liveQuota.js';

/**
 * A write plan the handlers translate into a Firestore update:
 *
 *   { set: { field: value }, increment: { field: n }, delete: [field] }
 *
 * Absolute values only appear in `set` for fields this handler owns outright
 * (its own counter after a reset, or a default being backfilled). Anything that
 * another endpoint also mutates goes through `increment`, so a stale read can
 * never clobber a concurrent write. Keeping FieldValue out of this module is
 * what makes the billing math testable without firebase-admin.
 */
const emptyPlan = () => ({ set: {}, increment: {}, delete: [] });

/**
 * Pre-mint step for /api/live-token. Applies the shared daily reset, bills any
 * abandoned prior session, and clears live_session so a crash between this write
 * and the mint cannot double-charge.
 */
export const planTokenMint = ({ data, todayStr, nowMs }) => {
  const quota = normalizeQuota(data, todayStr);
  const isNewDay = needsReset(data, todayStr);
  const plan = emptyPlan();

  // On a new day the stale session belongs to a bucket that no longer exists —
  // charging it against today's fresh allowance would bill the user twice over.
  const abandonedSeconds = isNewDay
    ? 0
    : abandonedSessionSeconds({
        session: (data || {}).live_session,
        nowMs,
        used: quota.live_seconds_today,
        limit: quota.live_seconds_limit,
      });

  if (isNewDay) {
    Object.assign(plan.set, buildResetUpdate(todayStr));
  } else if (abandonedSeconds > 0) {
    plan.increment.live_seconds_today = abandonedSeconds;
  }

  if ((data || {}).live_seconds_limit === undefined) {
    plan.set.live_seconds_limit = quota.live_seconds_limit;
  }

  if ((data || {}).live_session !== undefined) {
    plan.delete.push('live_session');
  }

  const liveSecondsToday = (isNewDay ? 0 : quota.live_seconds_today) + abandonedSeconds;

  return {
    plan,
    abandonedSeconds,
    liveSecondsToday,
    liveSecondsLimit: quota.live_seconds_limit,
    remainingSeconds: quota.live_seconds_limit - liveSecondsToday,
  };
};

/**
 * /api/live-usage. Bills the clamped report and always clears live_session, so a
 * replayed report finds no session and bills zero.
 */
export const planUsageReport = ({ data, todayStr, nowMs, reported }) => {
  const quota = normalizeQuota(data, todayStr);
  const isNewDay = needsReset(data, todayStr);
  const session = (data || {}).live_session || {};
  const plan = emptyPlan();

  const { billedSeconds, reason } = billLiveSeconds({
    reported,
    mintedAtMs: typeof session.mintedAt === 'number' ? session.mintedAt : null,
    nowMs,
    ttlSeconds: typeof session.ttlSeconds === 'number' ? session.ttlSeconds : DEFAULT_TTL_SECONDS,
    used: quota.live_seconds_today,
    limit: quota.live_seconds_limit,
  });

  if (isNewDay) {
    // Reset and bill in one atomic write: the absolute value is safe here
    // because this same update is what zeroed the counter.
    Object.assign(plan.set, buildResetUpdate(todayStr), { live_seconds_today: billedSeconds });
  } else if (billedSeconds > 0) {
    plan.increment.live_seconds_today = billedSeconds;
  }

  if ((data || {}).live_seconds_limit === undefined) {
    plan.set.live_seconds_limit = quota.live_seconds_limit;
  }

  if ((data || {}).live_session !== undefined) {
    plan.delete.push('live_session');
  }

  return {
    plan,
    billedSeconds,
    reason,
    liveSecondsToday: quota.live_seconds_today + billedSeconds,
    liveSecondsLimit: quota.live_seconds_limit,
  };
};

/** Nothing to write when a plan is empty — lets handlers skip the round trip. */
export const isEmptyPlan = (plan) =>
  Object.keys(plan.set).length === 0 &&
  Object.keys(plan.increment).length === 0 &&
  plan.delete.length === 0;

export { BILLING_REASONS };
