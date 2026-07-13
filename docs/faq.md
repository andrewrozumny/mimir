# FAQ

## What happens when I ask something outside the knowledge base?

Mimir replies with the exact string `"Not in the knowledge base."` and the API marks the response `"grounded": false` with an empty citations list. It does not guess, does not answer from the model's general knowledge, and does not pad the refusal with speculation. The refusal string is exact so that clients and the eval harness can detect it programmatically.

## How do I point Mimir at my own documents?

Edit `corpus.config.json` (or create a new config and pass it with `--config` or the `CORPUS_CONFIG` env var). List your markdown files and/or public URLs as sources, pick a corpus name, and run `npm run ingest`. That is the whole procedure — the pipeline code never changes when the corpus changes. Ingesting a typical documentation set takes seconds and costs fractions of a cent.

## Can it ingest a live website?

Yes. URL sources are fetched at ingest time and HTML is converted to text automatically, preserving headings and lists so the chunker can work with the page structure. This means you can point Mimir at a company's public help pages or documentation site and have their knowledge base answering questions minutes later, without exporting or copying any files.

## What does a query cost?

Cost is measured, not estimated: every API response includes the real token usage and the dollar cost of that specific query. With the default models, a typical query against this repo's corpus costs around one to two cents, dominated by generation input tokens. The eval report prints the average cost per query across the whole suite. Embedding costs are negligible — the entire seed corpus embeds for well under a cent.

## How fast is it?

The pipeline is two API calls (one embedding, one generation) plus one indexed SQL query. End-to-end latency is dominated by generation and typically lands in the low single-digit seconds; the eval report prints measured p50 and p95 across the suite. Streaming responses — which make perceived latency much lower in a chat UI — are on the roadmap.

## Why does it re-run ingest safely?

Chunk ids are stable (source path + position) and every chunk carries a content hash. On re-ingest, unchanged chunks are skipped, changed chunks are re-embedded and upserted in place, and chunks that disappeared from the source are deleted. There is no scenario where re-running ingest duplicates data.

## What guarantees that answers are actually grounded?

Three layers. The prompt restricts the model to the retrieved context and requires an inline chunk-id citation for every claim. The server validates every citation marker against the set of chunks that were actually retrieved — the model cannot cite a document it was not shown. And the eval harness measures faithfulness with an independent LLM judge that checks whether each answer is supported by its cited chunks.

## Which models does it use, and can I swap them?

Embeddings use OpenAI `text-embedding-3-small`; generation uses Anthropic Claude (`claude-opus-4-8`). Both sit behind one-file wrappers (`src/lib/embeddings.ts`, `src/lib/answer.ts`), so swapping providers or models is a local change that does not touch the pipeline.

## Is this production-ready?

It is production-shaped: idempotent ingestion, indexed vector search, validated citations, measured quality and cost. What it deliberately does not have yet — auth, multi-tenancy, streaming, hybrid search with a reranker, an admin UI — is listed on the README roadmap with a clear path for each. The single-table data model already carries a `corpus` column, so multi-tenancy is an addition, not a rewrite.

## Who is Mimir named after?

Mímir is the Norse figure who guards the well of wisdom. Odin gave an eye for a drink from it — a fair price for answers you can trust.
