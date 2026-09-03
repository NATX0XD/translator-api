/**
 * Pull the Firebase ID token out of `Authorization: Bearer <token>`.
 * Returns null for anything malformed — the caller turns that into a 401.
 * Header names are case-insensitive on the wire but not on a plain object, so
 * both spellings are checked.
 */
export const extractBearerToken = (req) => {
  const headers = (req || {}).headers || {};
  const raw = headers.authorization || headers.Authorization || '';
  const match = /^Bearer[ \t]+(\S.*)$/i.exec(String(raw).trim());
  return match ? match[1].trim() : null;
};
