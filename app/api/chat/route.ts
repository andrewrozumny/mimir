import { NextRequest, NextResponse } from "next/server";
import { loadCorpusConfig } from "../../../src/lib/config";
import { answerQuestion } from "../../../src/lib/answer";

/**
 * POST /api/chat  { "question": "..." }
 * -> { answer, grounded, citations[], usage } — grounded, cited, or an honest refusal.
 */
export async function POST(request: NextRequest) {
  let question: unknown;
  try {
    ({ question } = await request.json());
  } catch {
    return NextResponse.json({ error: "Body must be JSON: { \"question\": \"...\" }" }, { status: 400 });
  }
  if (typeof question !== "string" || question.trim().length === 0) {
    return NextResponse.json({ error: "\"question\" must be a non-empty string" }, { status: 400 });
  }
  if (question.length > 2000) {
    return NextResponse.json({ error: "\"question\" is too long (max 2000 chars)" }, { status: 400 });
  }

  try {
    const config = loadCorpusConfig();
    const result = await answerQuestion(config.corpus, question.trim());
    return NextResponse.json({
      answer: result.answer,
      grounded: result.grounded,
      citations: result.citations,
      usage: result.usage,
    });
  } catch (error) {
    console.error("chat error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
