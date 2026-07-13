# How it works

This is the life of a document and the life of a question, end to end.

## Ingestion: from source to vector store

1. **Load the config.** `corpus.config.json` names the corpus and lists its sources. A source is either a local file (`{"type": "file", "path": "docs/faq.md"}`) or a live URL (`{"type": "url", "url": "https://..."}`). URL sources are fetched at ingest time; HTML pages are converted to text with headings and list structure preserved, so web content goes through the same chunker as markdown files.

2. **Chunk.** Documents are split along markdown heading boundaries, keeping each section together. Sections longer than ~1600 characters are further split by paragraph. Each chunk gets a stable positional id — `docs/faq.md#2` is the third chunk of that file — and a sha256 hash of its content.

3. **Diff against the database.** For each source, the ingest script compares the fresh chunks with what is already stored. Chunks whose hash is unchanged are skipped entirely — no re-embedding, no API cost. Only new or modified chunks are embedded.

4. **Embed and upsert.** Changed chunks are embedded with `text-embedding-3-small` in a single batched API call per source, then upserted by chunk id. Chunks that no longer exist in the source (a section was deleted, a doc got shorter) are removed from the database.

The result: running `npm run ingest` twice in a row does zero embedding work the second time and the row count does not change. Ingestion is idempotent — safe to run on every deploy, on a schedule, or live during a demo.

## Query: from question to cited answer

1. **Embed the question** with the same embedding model as the corpus.

2. **Retrieve.** pgvector returns the 6 nearest chunks by cosine similarity, scoped to the active corpus.

3. **Generate, grounded.** The retrieved chunks are wrapped in `<chunk id="...">` tags and sent to Claude with a strict system prompt: use only this context, cite the chunk id for every claim, and if the context does not answer the question, reply with exactly `"Not in the knowledge base."` — nothing else.

4. **Validate citations.** The answer text is scanned for `[chunk-id]` markers. Each marker is resolved against the retrieved set; the API response includes the full citation list (chunk id, source document, snippet) so a UI can render "sources" under every answer. Markers that don't match a retrieved chunk are ignored rather than trusted.

5. **Account for it.** Every response carries its own real usage numbers: embedding tokens, input/output tokens, dollar cost computed from current per-token pricing, and end-to-end latency. The eval harness aggregates the same numbers — there is one source of truth for cost.

## The refusal path

If someone asks about something the corpus does not cover — the weather, a competitor, the meaning of life — retrieval still returns the 6 nearest chunks, because vector search always returns *something*. The grounding prompt is what stops the nonsense: the model sees that none of the context answers the question and emits the exact refusal string. The API marks these responses `"grounded": false` and returns an empty citations list.

This is the behavior that separates a knowledge base you can trust from a chatbot that always has an opinion. It is also exactly what the eval suite measures: out-of-corpus questions must produce the refusal, in-corpus questions must not.

## The API

One endpoint:

```
POST /api/chat
{ "question": "How does ingestion stay idempotent?" }
```

Response:

```
{
  "answer": "...with inline [chunk-id] citations...",
  "grounded": true,
  "citations": [{ "id": "...", "source": "...", "heading": "...", "snippet": "..." }],
  "usage": { "embeddingTokens": 9, "inputTokens": 2841, "outputTokens": 74, "costUsd": 0.016, "latencyMs": 2900 }
}
```

No auth, no streaming, no sessions — those are roadmap items. The endpoint is intentionally the smallest thing that demonstrates the full grounded loop over HTTP.
