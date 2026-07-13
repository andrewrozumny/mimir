import { getPool, toVectorLiteral } from "./db";
import { embed } from "./embeddings";

export interface RetrievedChunk {
  id: string;
  source: string;
  heading: string | null;
  content: string;
  similarity: number;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  embeddingTokens: number;
}

export const DEFAULT_TOP_K = 6;

/** Embeds the question and returns the top-k nearest chunks by cosine similarity. */
export async function retrieve(
  corpus: string,
  question: string,
  topK: number = DEFAULT_TOP_K
): Promise<RetrievalResult> {
  const { embeddings, tokens } = await embed([question]);
  const result = await getPool().query(
    `SELECT id, source, heading, content, 1 - (embedding <=> $1::vector) AS similarity
     FROM chunks
     WHERE corpus = $2
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [toVectorLiteral(embeddings[0]), corpus, topK]
  );
  return {
    chunks: result.rows.map((row) => ({
      id: row.id,
      source: row.source,
      heading: row.heading,
      content: row.content,
      similarity: Number(row.similarity),
    })),
    embeddingTokens: tokens,
  };
}
