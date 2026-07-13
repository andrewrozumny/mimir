import "dotenv/config";
import fs from "fs";
import path from "path";
import { loadCorpusConfig, CorpusSource } from "../src/lib/config";
import { chunkMarkdown, htmlToText, Chunk } from "../src/lib/chunk";
import { embed } from "../src/lib/embeddings";
import { ensureSchema, getPool, toVectorLiteral } from "../src/lib/db";

/**
 * Ingest: config-driven corpus -> chunk -> embed -> upsert into pgvector.
 *
 * Idempotent by design: chunk ids are stable, unchanged chunks (same content
 * hash) are skipped without re-embedding, and chunks that no longer exist in
 * the source are deleted. Re-running is always safe and never duplicates rows.
 *
 * Usage: npm run ingest [-- --config corpus.config.json]
 */
async function main() {
  const configFlag = process.argv.indexOf("--config");
  const configPath = configFlag > -1 ? process.argv[configFlag + 1] : undefined;
  const config = loadCorpusConfig(configPath);

  console.log(`Corpus: ${config.corpus} (${config.sources.length} sources)`);
  await ensureSchema();
  const db = getPool();

  let totalChunks = 0;
  let embedded = 0;
  let skipped = 0;
  let deleted = 0;
  let embeddingTokens = 0;

  for (const source of config.sources) {
    const { sourceId, chunks } = await loadSource(source);
    totalChunks += chunks.length;

    // Existing state for this source: id -> content hash.
    const existing = await db.query(
      "SELECT id, hash FROM chunks WHERE corpus = $1 AND source = $2",
      [config.corpus, sourceId]
    );
    const existingHashes = new Map<string, string>(existing.rows.map((r) => [r.id, r.hash]));

    const changed = chunks.filter((chunk) => existingHashes.get(chunk.id) !== chunk.hash);
    skipped += chunks.length - changed.length;

    if (changed.length > 0) {
      const { embeddings, tokens } = await embed(changed.map((c) => c.embeddingInput));
      embeddingTokens += tokens;

      for (let i = 0; i < changed.length; i++) {
        const chunk = changed[i];
        await db.query(
          `INSERT INTO chunks (id, corpus, source, heading, content, hash, embedding, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::vector, now())
           ON CONFLICT (id) DO UPDATE SET
             corpus = EXCLUDED.corpus, source = EXCLUDED.source, heading = EXCLUDED.heading,
             content = EXCLUDED.content, hash = EXCLUDED.hash,
             embedding = EXCLUDED.embedding, updated_at = now()`,
          [chunk.id, config.corpus, sourceId, chunk.heading, chunk.content, chunk.hash, toVectorLiteral(embeddings[i])]
        );
      }
      embedded += changed.length;
    }

    // Remove chunks that disappeared from the source (e.g. the doc got shorter).
    const currentIds = new Set(chunks.map((c) => c.id));
    const stale = [...existingHashes.keys()].filter((id) => !currentIds.has(id));
    if (stale.length > 0) {
      await db.query("DELETE FROM chunks WHERE corpus = $1 AND id = ANY($2)", [config.corpus, stale]);
      deleted += stale.length;
    }

    console.log(`  ${sourceId}: ${chunks.length} chunks (${changed.length} embedded, ${stale.length} removed)`);
  }

  const count = await db.query("SELECT count(*) FROM chunks WHERE corpus = $1", [config.corpus]);
  console.log(
    `\nDone. ${totalChunks} chunks in corpus "${config.corpus}" ` +
      `(embedded ${embedded}, unchanged ${skipped}, deleted ${deleted}). ` +
      `Rows in DB: ${count.rows[0].count}. Embedding tokens: ${embeddingTokens} ` +
      `(~$${((embeddingTokens * 0.02) / 1_000_000).toFixed(5)}).`
  );
  await db.end();
}

async function loadSource(source: CorpusSource): Promise<{ sourceId: string; chunks: Chunk[] }> {
  if (source.type === "file") {
    const sourceId = source.path!;
    const text = fs.readFileSync(path.resolve(process.cwd(), sourceId), "utf-8");
    return { sourceId, chunks: chunkMarkdown(sourceId, text) };
  }

  const sourceId = source.url!;
  const response = await fetch(sourceId, { headers: { "user-agent": "mimir-ingest/0.1" } });
  if (!response.ok) throw new Error(`Failed to fetch ${sourceId}: HTTP ${response.status}`);
  const body = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const isHtml = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(body);
  const text = isHtml ? htmlToText(body) : body;
  return { sourceId, chunks: chunkMarkdown(sourceId, text) };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
