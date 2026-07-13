# Mimir — measured evaluation

_Run 2026-07-13 · 28 Q&A pairs (22 in-corpus, 6 out-of-corpus) · corpus `mimir-docs` · production endpoint (`https://mimir-five-bice.vercel.app`)._

Every number below comes from a real run of the full pipeline — retrieval, grounded generation, and an independent LLM faithfulness judge — over a fixed question set. Nothing is estimated.

| Metric | Result | What it means |
| --- | --- | --- |
| Retrieval hit rate | **100% (22/22)** | The expected source document was among the retrieved chunks |
| Citation rate | **100% (22/22)** | Grounded answers carried at least one valid citation |
| Faithfulness | **100% (22/22)** | An LLM judge confirmed every claim is supported by the cited chunks |
| Refusal accuracy | **100% (6/6)** | Out-of-corpus questions got the honest "not in the knowledge base" refusal |
| False refusals | **0% (0/22)** | In-corpus questions wrongly refused (lower is better) |
| Latency p50 / p95 | **2865ms / 5719ms** | End-to-end pipeline time per query |
| Cost per query | **$0.0100** | Embeddings + generation, from real token usage |

**Models:** embeddings `text-embedding-3-small`, generation `claude-opus-4-8`.

**Methodology:** each question runs through the deployed pipeline; retrieval hit rate checks the expected source appears in the retrieved set; faithfulness is graded by a separate LLM judge against the cited chunks only; refusal accuracy and false refusals are measured against a labeled out-of-corpus set. Reproduce with `npm run eval -- --endpoint https://mimir-five-bice.vercel.app`.
