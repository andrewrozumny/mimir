# Mimir — measured evaluation

_Run 2026-07-13 · 28 Q&A pairs (22 in-corpus, 6 out-of-corpus) · corpus `mimir-docs` · in-process pipeline · faithfulness judged by `claude-opus-4-8`._

Every number below comes from a real run of the full pipeline — retrieval, grounded generation, and an independent LLM faithfulness judge — over a fixed question set. Nothing is estimated.

## Production model: Claude Haiku 4.5

| Metric | Result | What it means |
| --- | --- | --- |
| Retrieval hit rate | **100% (22/22)** | The expected source document was among the retrieved chunks |
| Citation rate | **100% (22/22)** | Grounded answers carried at least one valid citation |
| Faithfulness | **95% (21/22)** | An LLM judge confirmed every claim is supported by the cited chunks |
| Refusal accuracy | **100% (6/6)** | Out-of-corpus questions got the honest "not in the knowledge base" refusal |
| False refusals | **0% (0/22)** | In-corpus questions wrongly refused (lower is better) |
| Latency p50 / p95 | **1498ms / 3063ms** | End-to-end pipeline time per query |
| Cost per query | **$0.0015** | Embeddings + generation, from real token usage |

## Cost-tuned via eval

Same suite, same corpus, same `claude-opus-4-8` faithfulness judge — only the generation model changes. **Claude Haiku 4.5** is the production default; the table below is the full measured comparison behind that choice. Every figure is from a real run — read the numbers, they are not asserted.

| Model | Faithfulness | Refusal acc. | False refusals | Retrieval hit | Cost / query | Latency p50 | Overall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Opus 4.8 (baseline) | 100% (22/22) | 100% (6/6) | 0% (0/22) | 100% (22/22) | $0.0099 | 2261ms | 100% (28/28) |
| Claude Sonnet 5 | 95% (21/22) | 100% (6/6) | 0% (0/22) | 100% (22/22) | $0.0060 | 2150ms | 96% (27/28) |
| **Claude Haiku 4.5 (production)** | **95% (21/22)** | **100% (6/6)** | **0% (0/22)** | **100% (22/22)** | **$0.0015** | **1498ms** | **96% (27/28)** |

**Models:** embeddings `text-embedding-3-small`, generation `claude-haiku-4-5`, faithfulness judge `claude-opus-4-8`. Costs use standard per-model list pricing ($/1M tokens in / out): Opus 4.8 5 / 25, Sonnet 5 3 / 15, Haiku 4.5 1 / 5.

**Methodology:** each question runs through the full in-process pipeline; retrieval hit rate checks the expected source appears in the retrieved set; faithfulness is graded by a separate judge — pinned to `claude-opus-4-8` regardless of the generation model — against the cited chunks only; refusal accuracy and false refusals are measured against a labeled out-of-corpus set. Latency is measured in-process (no network or cold-start), so it reflects relative model speed rather than production wall-clock. Reproduce with `npm run eval -- --compare claude-opus-4-8,claude-sonnet-5,claude-haiku-4-5 --out docs/metrics.md`.
