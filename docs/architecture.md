# Architecture

Mimir is a deliberately small, readable RAG pipeline: four library modules, two scripts, one API route. No agent framework, no orchestration layer — every step is plain TypeScript you can read in one sitting.

## Components

| Component | File | Responsibility |
| --- | --- | --- |
| Corpus config | `src/lib/config.ts` | Loads the JSON config that names the corpus and lists its sources |
| Chunker | `src/lib/chunk.ts` | Markdown-aware splitting, HTML-to-text conversion, stable chunk ids, content hashes |
| Embeddings | `src/lib/embeddings.ts` | OpenAI `text-embedding-3-small`, 1536 dimensions |
| Vector store | `src/lib/db.ts` | Postgres + pgvector schema and connection pool |
| Retrieval | `src/lib/retrieve.ts` | Cosine top-k search over the corpus |
| Generation | `src/lib/answer.ts` | Grounded Claude prompt, citation extraction, refusal detection, cost accounting |
| Ingest script | `scripts/ingest.ts` | Config → chunks → embeddings → idempotent upsert |
| Eval script | `scripts/eval.ts` | Runs the Q&A suite and prints the metrics table |
| Chat API | `app/api/chat/route.ts` | `POST /api/chat` — question in, cited answer out |

## Data model

One table holds everything. Each row is a chunk of a source document with its embedding:

```sql
CREATE TABLE chunks (
  id         text PRIMARY KEY,     -- "docs/faq.md#2" — what answers cite
  corpus     text NOT NULL,        -- corpus name from the config
  source     text NOT NULL,        -- file path or URL
  heading    text,                 -- nearest markdown heading, for display
  content    text NOT NULL,        -- the chunk text sent to the model
  hash       text NOT NULL,        -- sha256 of content, for idempotent ingest
  embedding  vector(1536) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

Retrieval uses an HNSW index with cosine distance (`vector_cosine_ops`). At demo scale a sequential scan would be fine; the index is there because it is what you would run in production and it costs nothing to have.

## Retrieval

The question is embedded with the same model as the corpus, then:

```sql
SELECT id, source, heading, content, 1 - (embedding <=> $query) AS similarity
FROM chunks WHERE corpus = $corpus
ORDER BY embedding <=> $query
LIMIT 6;
```

Top-k is 6 by default. There is no similarity threshold: deciding whether the context actually answers the question is delegated to the generation step, which is much better at it than a scalar cutoff.

## Grounding and refusal

The generation prompt enforces three rules: answer only from the provided chunks, cite chunk ids inline in square brackets, and reply with the exact string `"Not in the knowledge base."` when the context does not contain the answer. Because the refusal string is exact, the API and the eval harness can detect it programmatically — refusal is a first-class, measurable outcome, not a vibe.

Citations are validated server-side: the answer text is scanned for `[chunk-id]` markers and only ids that match actually-retrieved chunks are returned as citations. The model cannot cite something it was not shown.

## Model choices

- **Embeddings: OpenAI `text-embedding-3-small`** — strong retrieval quality at $0.02 per million tokens; embedding this repo's entire documentation costs a fraction of a cent.
- **Generation: Claude `claude-opus-4-8`** — instruction-following strong enough to hold the grounding contract (cite everything, refuse honestly) without elaborate prompt gymnastics.

Both are behind small wrappers, so swapping either is a one-file change.

## Scaling path

The current design is single-corpus and synchronous, on purpose. The production extensions are documented in the README roadmap: hybrid search (BM25 + vector) with a reranker for recall-critical corpora, streaming responses for the widget, multi-tenant corpora keyed by the existing `corpus` column, and auth in front of the API. None of them require changing the data model — `corpus` is already in every query.
