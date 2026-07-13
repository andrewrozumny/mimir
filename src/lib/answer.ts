import Anthropic from "@anthropic-ai/sdk";
import { EMBEDDING_PRICE_PER_MTOK } from "./embeddings";
import { retrieve, RetrievedChunk } from "./retrieve";

export const GENERATION_MODEL = "claude-opus-4-8";
/** USD per 1M tokens for claude-opus-4-8. */
export const INPUT_PRICE_PER_MTOK = 5.0;
export const OUTPUT_PRICE_PER_MTOK = 25.0;

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
export async function answerQuestion(corpus: string, question: string): Promise<Answer> {
  const started = Date.now();
  const { chunks, embeddingTokens } = await retrieve(corpus, question);

  const context = chunks
    .map((chunk) => `<chunk id="${chunk.id}">\n${chunk.content}\n</chunk>`)
    .join("\n\n");

  const response = await getClient().messages.create({
    model: GENERATION_MODEL,
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

  const costUsd =
    (embeddingTokens * EMBEDDING_PRICE_PER_MTOK +
      response.usage.input_tokens * INPUT_PRICE_PER_MTOK +
      response.usage.output_tokens * OUTPUT_PRICE_PER_MTOK) /
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
