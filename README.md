# Mimir

**A grounded RAG knowledge base that cites its sources — and refuses when it doesn't know.**

**[Live demo →](https://mimir-five-bice.vercel.app)** · [measured metrics →](docs/metrics.md)

Mimir turns a set of documents into an API that answers questions with inline citations to the exact chunks the answer came from. When the answer is not in the corpus, it says so — `"Not in the knowledge base."` — instead of hallucinating. That honesty, plus a measured evaluation harness, is the point: this is a production-shaped RAG pipeline, not a demo that dumps everything into a prompt.

## What it does

- **Config-driven ingestion** — a JSON config lists the corpus sources (local markdown files or live URLs). Swapping the entire knowledge base is a config change, zero code changes.
- **Chunking + embeddings** — markdown-aware chunking along heading boundaries, embedded with OpenAI `text-embedding-3-small`.
- **Vector retrieval** — chunks live in Postgres with [pgvector](https://github.com/pgvector/pgvector) (hosted on Neon); queries run cosine top-k over an HNSW index.
- **Grounded generation** — Claude (`claude-haiku-4-5` by default, set via `GENERATION_MODEL`) answers strictly from the retrieved context and cites chunk ids inline, like `[docs/faq.md#2]`.
- **Honest refusal** — questions outside the corpus get an exact, machine-detectable refusal instead of a guess.
- **Idempotent re-ingestion** — stable chunk ids and content hashes: re-running ingest never duplicates rows, skips unchanged chunks, and cleans up deleted ones.
- **Measured eval** — a Q&A suite reports retrieval hit rate, faithfulness, refusal accuracy, latency, and cost per query.

## Try it

```bash
curl -s localhost:3000/api/chat \
  -H 'content-type: application/json' \
  -d '{"question": "How does Mimir avoid hallucinations?"}'
```

```json
{
  "answer": "Mimir answers strictly from retrieved context chunks and cites them inline [docs/how-it-works.md#4]. When the context does not contain the answer, it replies with an exact refusal string instead of guessing [docs/faq.md#1].",
  "grounded": true,
  "citations": [
    { "id": "docs/how-it-works.md#4", "source": "docs/how-it-works.md", "snippet": "..." }
  ],
  "usage": { "inputTokens": 2841, "outputTokens": 74, "costUsd": 0.003, "latencyMs": 1500 }
}
```

The seed corpus is Mimir's own documentation — ask Mimir about Mimir. Clone the repo and you have a working, self-contained example with no third-party content.

## Stack

Plain, readable code — no framework lock-in:

- **Next.js + TypeScript** — HTTP API (and the future embeddable chat widget)
- **Postgres + pgvector on Neon** — vector store
- **OpenAI `text-embedding-3-small`** — embeddings
- **Anthropic Claude (`claude-haiku-4-5`, cost-tuned via eval)** — grounded generation

## Quick start

1. **Environment** — copy `.env.example` to `.env` and fill in:
   - `DATABASE_URL` — a Postgres database with the pgvector extension available (Neon free tier works)
   - `OPENAI_API_KEY` — for embeddings (a full ingest of this repo's docs costs well under a cent)
   - `ANTHROPIC_API_KEY` — for generation

2. **Install and ingest**

   ```bash
   npm install
   npm run ingest        # chunks + embeds the corpus from corpus.config.json
   ```

3. **Ask**

   ```bash
   npm run dev
   curl -s localhost:3000/api/chat -H 'content-type: application/json' \
     -d '{"question": "What is Mimir?"}'
   ```

4. **Measure**

   ```bash
   npm run eval          # runs the Q&A suite, prints the metrics table
   ```

## Swapping the corpus

The pipeline never hardcodes content. `corpus.config.json` defines a named corpus and its sources:

```json
{
  "corpus": "my-product-docs",
  "sources": [
    { "type": "file", "path": "docs/guide.md" },
    { "type": "url", "url": "https://example.com/help" }
  ]
}
```

`url` sources are fetched live and HTML is converted to text automatically — pointing Mimir at a client's public help pages and re-ingesting takes minutes. Use a different config file via `npm run ingest -- --config my.config.json` or the `CORPUS_CONFIG` env var (the API serves whichever corpus the active config names).

## Evaluation

`npm run eval` runs every pair in `eval/questions.json` through the full pipeline and prints:

| Metric | Meaning |
| --- | --- |
| Retrieval hit rate | expected source document appears in the retrieved top-k |
| Citation rate | grounded answers actually carry citations |
| Faithfulness | an LLM judge confirms every claim is supported by the cited chunks |
| Refusal accuracy | out-of-corpus questions get the exact refusal, in-corpus ones don't |
| Latency p50 / p95 | end-to-end pipeline time per query |
| Cost per query | embeddings + generation, from real token usage |

Numbers are printed from real API usage on every run — nothing is estimated. The latest measured run is captured in [docs/metrics.md](docs/metrics.md); regenerate it with `npm run eval -- --out docs/metrics.md` (add `--endpoint <url>` to measure a deployed instance).

## Architecture

Question → embed → pgvector top-k → Claude with a strict grounding prompt → cited answer or refusal. Details, schema, and design decisions: [docs/architecture.md](docs/architecture.md) and [docs/how-it-works.md](docs/how-it-works.md). Common questions: [docs/faq.md](docs/faq.md).

## Roadmap

Deliberately not built yet — each is a straightforward extension of the current design:

- Embeddable chat widget (React) + streaming responses
- Hybrid search (BM25 + vector) and a reranker stage
- Multi-tenant corpora with per-tenant auth
- Admin UI for corpus management

## License

Mimir is released under the MIT License — free to use, modify, and distribute, including commercially. See [LICENSE](LICENSE) for the full text.
