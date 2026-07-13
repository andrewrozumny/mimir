import { Pool } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set — see .env.example");
    }
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  }
  return pool;
}

/** Idempotent schema bootstrap — safe to run on every ingest. */
export async function ensureSchema(): Promise<void> {
  const db = getPool();
  await db.query("CREATE EXTENSION IF NOT EXISTS vector");
  await db.query(`
    CREATE TABLE IF NOT EXISTS chunks (
      id         text PRIMARY KEY,
      corpus     text NOT NULL,
      source     text NOT NULL,
      heading    text,
      content    text NOT NULL,
      hash       text NOT NULL,
      embedding  vector(1536) NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.query("CREATE INDEX IF NOT EXISTS chunks_corpus_source_idx ON chunks (corpus, source)");
  await db.query(
    "CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops)"
  );
  // Global daily budget counter — the demo runs on paid keys, so this is the
  // fuse that stops answering once the day's request budget is spent.
  await db.query(`
    CREATE TABLE IF NOT EXISTS daily_usage (
      day       date PRIMARY KEY,
      requests  integer NOT NULL DEFAULT 0,
      cost_usd  numeric NOT NULL DEFAULT 0
    )
  `);
}

/** pgvector accepts a JSON-array-shaped literal: "[0.1,0.2,...]". */
export function toVectorLiteral(embedding: number[]): string {
  return JSON.stringify(embedding);
}
