export const LIVE_SECONDS_LIMIT = 600;
export const DEFAULT_TOKEN_LIMIT = 10000;

export const todayString = (date) => date.toISOString().split('T')[0];

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
