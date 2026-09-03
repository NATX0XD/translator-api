export const LIVE_SECONDS_LIMIT = 600;
export const DEFAULT_TOKEN_LIMIT = 10000;

export const DEFAULT_TTL_SECONDS = 600;

export const BILLING_REASONS = {
  OK: 'ok',
  NO_SESSION: 'no_session',
  QUOTA_EXHAUSTED: 'quota_exhausted',
  INVALID_REPORT: 'invalid_report',
};

export const todayString = (date) => date.toISOString().split('T')[0];

export const needsReset = (data, todayStr) => (data || {}).last_reset_date !== todayStr;

/**
 * The single daily-reset rule for BOTH buckets. Every handler that notices a new
 * day writes exactly this, so `last_reset_date` can never be consumed by one
 * endpoint while the other endpoint's counter stays stale.
 */
export const buildResetUpdate = (todayStr) => ({
  tokens_today: 0,
  live_seconds_today: 0,
  last_reset_date: todayStr,
});

export const normalizeQuota = (data, todayStr) => {
  const source = data || {};
  const isNewDay = source.last_reset_date !== todayStr;

  return {
    tokens_today: isNewDay ? 0 : (source.tokens_today || 0),
    daily_limit: source.daily_limit || DEFAULT_TOKEN_LIMIT,
    live_seconds_today: isNewDay ? 0 : (source.live_seconds_today || 0),
    live_seconds_limit: source.live_seconds_limit || LIVE_SECONDS_LIMIT,
    last_reset_date: todayStr,
    wasReset: isNewDay,
  };
};

export const clampBillableSeconds = ({ reported, mintedAtMs, nowMs, ttlSeconds, used, limit }) => {
  const asked = Number(reported);
  if (!Number.isFinite(asked) || asked <= 0) return 0;
  // No minted session (null/undefined) means nothing to bill against.
  // Number(null) is 0, so the type check has to come before the coercion.
  if (typeof mintedAtMs !== 'number' || !Number.isFinite(mintedAtMs)) return 0;

  const elapsed = Math.ceil((nowMs - mintedAtMs) / 1000);
  if (elapsed <= 0) return 0;

  const remaining = limit - used;
  if (remaining <= 0) return 0;

  return Math.max(0, Math.min(asked, elapsed, ttlSeconds, remaining));
};

/**
 * clampBillableSeconds with the reason a zero came back, so a session that bills
 * nothing is never mistaken for a session that was legitimately free.
 * Checks run input-first: a junk report is reported as junk even when there is
 * also no session to bill it against.
 */
export const billLiveSeconds = ({ reported, mintedAtMs, nowMs, ttlSeconds, used, limit }) => {
  const asked = Number(reported);
  if (!Number.isFinite(asked) || asked <= 0) {
    return { billedSeconds: 0, reason: BILLING_REASONS.INVALID_REPORT };
  }
  if (typeof mintedAtMs !== 'number' || !Number.isFinite(mintedAtMs)) {
    return { billedSeconds: 0, reason: BILLING_REASONS.NO_SESSION };
  }
  if (limit - used <= 0) {
    return { billedSeconds: 0, reason: BILLING_REASONS.QUOTA_EXHAUSTED };
  }

  const billedSeconds = clampBillableSeconds({ reported, mintedAtMs, nowMs, ttlSeconds, used, limit });

  // Only remaining path to zero here is a mintedAt in the future (clock skew).
  return billedSeconds > 0
    ? { billedSeconds, reason: BILLING_REASONS.OK }
    : { billedSeconds: 0, reason: BILLING_REASONS.INVALID_REPORT };
};

/**
 * A session that was minted but never reported — crashed tab, killed browser,
 * offline pagehide. Charged at the next mint for the wall-clock time it could
 * possibly have run: min(now - mintedAt, ttlSeconds, remaining).
 */
export const abandonedSessionSeconds = ({ session, nowMs, used, limit }) => {
  const mintedAtMs = (session || {}).mintedAt;
  if (typeof mintedAtMs !== 'number' || !Number.isFinite(mintedAtMs)) return 0;

  const ttlSeconds = typeof (session || {}).ttlSeconds === 'number'
    ? session.ttlSeconds
    : DEFAULT_TTL_SECONDS;

  const elapsed = Math.ceil((nowMs - mintedAtMs) / 1000);

  return clampBillableSeconds({ reported: elapsed, mintedAtMs, nowMs, ttlSeconds, used, limit });
};
