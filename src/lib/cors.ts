/**
 * CORS for the public chat endpoint. Same-origin callers (the standalone demo
 * page) don't need it; the helpmybiz widget calls from another origin, so we
 * reflect the request origin when it's on the allowlist.
 *
 * ALLOWED_ORIGINS is a comma-separated list. "*" allows any origin (fine for a
 * public read-only demo behind the rate limit and daily budget).
 */
const ALLOWED = (process.env.ALLOWED_ORIGINS ?? "*")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export function corsHeaders(requestOrigin: string | null): Record<string, string> {
  const base: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
  };
  if (ALLOWED.includes("*")) {
    return { ...base, "Access-Control-Allow-Origin": "*" };
  }
  if (requestOrigin && ALLOWED.includes(requestOrigin)) {
    return { ...base, "Access-Control-Allow-Origin": requestOrigin, Vary: "Origin" };
  }
  return base;
}
