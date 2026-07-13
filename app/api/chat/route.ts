import { NextRequest, NextResponse } from "next/server";
import { loadCorpusConfig } from "../../../src/lib/config";
import { answerQuestion } from "../../../src/lib/answer";
import { corsHeaders } from "../../../src/lib/cors";
import {
  clientIp,
  MAX_QUESTION_CHARS,
  rateLimit,
  recordCost,
  reserveDailyBudget,
} from "../../../src/lib/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUDGET_EXHAUSTED_MESSAGE =
  "This demo's request budget for today is used up. Run it locally to keep asking — see the README.";

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}

/**
 * POST /api/chat  { "question": "..." }
 * -> { answer, grounded, citations[], retrieved[], usage } — grounded, cited,
 *    or an honest refusal. Guarded by per-IP rate limit + a global daily budget.
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request.headers.get("origin"));
  const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: cors });

  // 1. Per-IP rate limit (free, before any DB or model work).
  const limit = rateLimit(clientIp(request.headers));
  if (!limit.ok) {
    return json({ error: `Too many requests. Retry in ${limit.retryAfter}s.` }, 429);
  }

  // 2. Input validation.
  let question: unknown;
  let corpus: unknown;
  try {
    ({ question, corpus } = await request.json());
  } catch {
    return json({ error: 'Body must be JSON: { "question": "..." }' }, 400);
  }
  if (typeof question !== "string" || question.trim().length === 0) {
    return json({ error: '"question" must be a non-empty string' }, 400);
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return json({ error: `"question" is too long (max ${MAX_QUESTION_CHARS} chars)` }, 400);
  }

  // Optional corpus selector — lets one deployment serve several ingested
  // corpora (the demo's own docs, a client's docs). Allowlisted, not a tenancy
  // boundary: every corpus here is public demo data.
  const config = loadCorpusConfig();
  const allowedCorpora = new Set(
    [config.corpus, ...(process.env.ALLOWED_CORPORA ?? "").split(",")].map((c) => c.trim()).filter(Boolean)
  );
  const targetCorpus = typeof corpus === "string" && corpus.trim() ? corpus.trim() : config.corpus;
  if (!allowedCorpora.has(targetCorpus)) {
    return json({ error: `Unknown corpus "${targetCorpus}"` }, 400);
  }

  try {
    // 3. Global daily budget — the fuse. Counts before spending tokens.
    const budget = await reserveDailyBudget();
    if (!budget.ok) {
      return json({ answer: BUDGET_EXHAUSTED_MESSAGE, grounded: false, citations: [], budgetExhausted: true });
    }

    // 4. Answer.
    const result = await answerQuestion(targetCorpus, question.trim());
    void recordCost(result.usage.costUsd).catch(() => {});

    return json({
      answer: result.answer,
      grounded: result.grounded,
      citations: result.citations,
      retrieved: result.retrieved.map((chunk) => ({
        id: chunk.id,
        source: chunk.source,
        similarity: Number(chunk.similarity.toFixed(4)),
      })),
      usage: result.usage,
    });
  } catch (error) {
    console.error("chat error:", error);
    return json({ error: "Internal error" }, 500);
  }
}
