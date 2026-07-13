import { getPool } from "./db";

/**
 * Abuse guards for the public chat endpoint. The widget answers on paid API
 * keys, so an unprotected endpoint is a way to run up someone else's bill.
 * Two layers:
 *   - per-IP rate limit (in-memory, per serverless instance — cheap first guard)
 *   - global daily budget (DB-backed, so it holds across instances — the fuse)
 */

export const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN ?? 10);
export const DAILY_REQUEST_BUDGET = Number(process.env.DEMO_DAILY_BUDGET ?? 500);
export const MAX_QUESTION_CHARS = Number(process.env.MAX_QUESTION_CHARS ?? 600);

// --- per-IP rate limit (in-memory) ---

type Hit = { count: number; reset: number };
const hits = new Map<string, Hit>();

export function rateLimit(ip: string): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const windowMs = 60_000;

  if (hits.size > 5000) {
    for (const [key, hit] of hits) if (now > hit.reset) hits.delete(key);
  }

  const current = hits.get(ip);
  if (!current || now > current.reset) {
    hits.set(ip, { count: 1, reset: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  current.count += 1;
  if (current.count > RATE_LIMIT_PER_MIN) {
    return { ok: false, retryAfter: Math.ceil((current.reset - now) / 1000) };
  }
  return { ok: true, retryAfter: 0 };
}

// --- global daily budget (DB-backed) ---

/**
 * Atomically counts today's request and reports whether the daily budget is
 * still open. Runs before any model call, so a spent budget costs nothing.
 * `UTC` day boundary keeps it deterministic regardless of server timezone.
 */
export async function reserveDailyBudget(): Promise<{ ok: boolean; used: number; limit: number }> {
  const result = await getPool().query(
    `INSERT INTO daily_usage (day, requests) VALUES ((now() AT TIME ZONE 'utc')::date, 1)
     ON CONFLICT (day) DO UPDATE SET requests = daily_usage.requests + 1
     RETURNING requests`
  );
  const used = Number(result.rows[0].requests);
  return { ok: used <= DAILY_REQUEST_BUDGET, used, limit: DAILY_REQUEST_BUDGET };
}

/** Records the dollar cost of an answered request against today's counter. */
export async function recordCost(costUsd: number): Promise<void> {
  await getPool().query(
    `UPDATE daily_usage SET cost_usd = cost_usd + $1 WHERE day = (now() AT TIME ZONE 'utc')::date`,
    [costUsd]
  );
}

/** Best-effort client IP from proxy headers (Vercel sets x-forwarded-for). */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return headers.get("x-real-ip") ?? "unknown";
}
