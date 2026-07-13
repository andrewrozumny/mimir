import Anthropic from "@anthropic-ai/sdk";
import { EMBEDDING_PRICE_PER_MTOK } from "./embeddings";
import { retrieve, RetrievedChunk } from "./retrieve";

/**
 * Standard (sticker) price per 1M tokens for each supported generation model.
 * Deliberately the durable list rates, not any temporary introductory pricing, so
 * the measured cost figures in docs/metrics.md stay defensible over time.
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
  "claude-sonnet-5": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
};

export function priceFor(model: string): { input: number; output: number } {
  const price = MODEL_PRICING[model];
  if (!price) {
    throw new Error(`No pricing for model "${model}". Add it to MODEL_PRICING in src/lib/answer.ts.`);
  }
  return price;
}

/**
 * Generation model. Configurable via GENERATION_MODEL so the same pipeline can be
 * cost-tuned without code changes (see docs/metrics.md). Defaults to Haiku 4.5: on the
 * eval it holds retrieval, citation, refusal, and faithfulness on par with the Opus
 * baseline at ~5x lower cost per query and lower latency.
 */
export const GENERATION_MODEL = process.env.GENERATION_MODEL?.trim() || "claude-haiku-4-5";

/**
 * The eval's faithfulness judge stays pinned to the strongest model no matter which
 * model generated the answer — a judge on the answer's own tier would grade itself.
 */
export const JUDGE_MODEL = "claude-opus-4-8";

export const REFUSAL_TEXT = "Not in the knowledge base.";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export interface Citation {
  id: string;
  source: string;
  heading: string | null;
  /** Short preview for compact UIs. */
  snippet: string;
  /** Full cited chunk text — lets clients show the source and evals judge faithfulness. */
  content: string;
}

export interface Answer {
  question: string;
  answer: string;
  /** false when the answer is the refusal — the question is outside the corpus. */
  grounded: boolean;
  citations: Citation[];
  retrieved: RetrievedChunk[];
  usage: {
    embeddingTokens: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    latencyMs: number;
  };
}

const SYSTEM_PROMPT = `You are Mimir, a knowledge-base assistant. Answer questions using ONLY the context chunks provided in the user message. Rules:
- Every factual claim in your answer must come from the context. Cite the supporting chunk inline by putting its id in square brackets, e.g. [docs/faq.md#2]. Cite every claim; multiple citations per sentence are fine.
- Never use outside knowledge, even when you are confident. If the context does not contain the information needed to answer, reply with exactly: "${REFUSAL_TEXT}" and nothing else.
- Be concise and direct. Answer in the language of the question.`;

/**
 * The full query pipeline: embed question -> retrieve top-k from pgvector ->
 * grounded Claude answer with inline chunk citations (or an honest refusal).
 */
export async function answerQuestion(
  corpus: string,
  question: string,
  model: string = GENERATION_MODEL
): Promise<Answer> {
  const started = Date.now();
  const { chunks, embeddingTokens } = await retrieve(corpus, question);

  const context = chunks
    .map((chunk) => `<chunk id="${chunk.id}">\n${chunk.content}\n</chunk>`)
    .join("\n\n");

  const response = await getClient().messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Context chunks:\n\n${context}\n\nQuestion: ${question}`,
      },
    ],
  });

  const answerText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  // Exact match: grounded answers may legitimately QUOTE the refusal string
  // (e.g. when asked how Mimir handles unknown questions).
  const grounded = answerText.trim() !== REFUSAL_TEXT;
  const citations = grounded ? extractCitations(answerText, chunks) : [];
  const latencyMs = Date.now() - started;

  const price = priceFor(model);
  const costUsd =
    (embeddingTokens * EMBEDDING_PRICE_PER_MTOK +
      response.usage.input_tokens * price.input +
      response.usage.output_tokens * price.output) /
    1_000_000;

  return {
    question,
    answer: answerText,
    grounded,
    citations,
    retrieved: chunks,
    usage: {
      embeddingTokens,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      costUsd,
      latencyMs,
    },
  };
}

/** Resolves [chunk-id] markers in the answer to the retrieved chunks they point at. */
function extractCitations(answer: string, retrieved: RetrievedChunk[]): Citation[] {
  const byId = new Map(retrieved.map((chunk) => [chunk.id, chunk]));
  const cited = new Map<string, Citation>();

  for (const match of answer.matchAll(/\[([^\[\]]+?)\]/g)) {
    const chunk = byId.get(match[1].trim());
    if (chunk && !cited.has(chunk.id)) {
      cited.set(chunk.id, {
        id: chunk.id,
        source: chunk.source,
        heading: chunk.heading,
        snippet: chunk.content.slice(0, 200),
        content: chunk.content,
      });
    }
  }
  return [...cited.values()];
}
