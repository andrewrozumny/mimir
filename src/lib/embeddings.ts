import OpenAI from "openai";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;
/** USD per 1M tokens for text-embedding-3-small. */
export const EMBEDDING_PRICE_PER_MTOK = 0.02;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) client = new OpenAI();
  return client;
}

export interface EmbeddingResult {
  embeddings: number[][];
  tokens: number;
}

export async function embed(texts: string[]): Promise<EmbeddingResult> {
  if (texts.length === 0) return { embeddings: [], tokens: 0 };
  const response = await getClient().embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  return {
    embeddings: response.data.map((d) => d.embedding),
    tokens: response.usage.total_tokens,
  };
}
