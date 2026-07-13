import "dotenv/config";
import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { loadCorpusConfig } from "../src/lib/config";
import { answerQuestion, GENERATION_MODEL, JUDGE_MODEL, MODEL_PRICING, priceFor } from "../src/lib/answer";
import { EMBEDDING_MODEL } from "../src/lib/embeddings";
import { getPool } from "../src/lib/db";

/**
 * Eval harness. Runs every pair in eval/questions.json through the full
 * pipeline — either in-process or against a deployed endpoint — and reports a
 * metrics table. All numbers come from real API usage.
 *
 * Usage:
 *   npm run eval                                     # in-process, default model
 *   npm run eval -- --model claude-opus-4-8          # in-process, a specific model
 *   npm run eval -- --endpoint https://host          # against a deployed URL
 *   npm run eval -- --endpoint https://host --out docs/metrics.md
 *   npm run eval -- --compare claude-opus-4-8,claude-sonnet-5,claude-haiku-4-5 --out docs/metrics.md
 *
 * Metrics: retrieval hit rate, citation rate, LLM-judged faithfulness,
 * refusal accuracy, false-refusal rate, latency p50/p95, cost per query.
 * The faithfulness judge is always JUDGE_MODEL, independent of which model
 * generated the answer, so a cheaper generator can't grade its own tier.
 */

interface QAPair {
  question: string;
  expect: "answer" | "refusal";
  expected_sources?: string[];
}

interface Normalized {
  answer: string;
  grounded: boolean;
  citations: { id: string; source: string; content: string }[];
  retrievedSources: string[];
  usage: { costUsd: number; latencyMs: number };
}

interface Row {
  pair: QAPair;
  result: Normalized;
  hit: boolean | null;
  faithful: boolean | null;
  passed: boolean;
}

interface Metric {
  pct: number;
  label: string;
}

interface Metrics {
  hitRate: Metric;
  citationRate: Metric;
  faithfulness: Metric;
  refusalAccuracy: Metric;
  falseRefusals: Metric;
  p50: number;
  p95: number;
  costPerQuery: number;
  overall: Metric;
}

interface SuiteResult {
  model: string;
  metrics: Metrics;
  rows: Row[];
  answerable: Row[];
  outOfCorpus: Row[];
  passedAll: boolean;
}

const judge = new Anthropic();

const MODEL_DISPLAY: Record<string, string> = {
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-haiku-4-5": "Claude Haiku 4.5",
};
const display = (model: string) => MODEL_DISPLAY[model] ?? model;

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i > -1 ? args[i + 1] : undefined;
  };
  return {
    endpoint: get("--endpoint"),
    corpus: get("--corpus"),
    out: get("--out"),
    limit: get("--limit"),
    model: get("--model"),
    compare: get("--compare"),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getAnswer(
  corpus: string,
  question: string,
  endpoint?: string,
  model?: string
): Promise<Normalized> {
  if (endpoint) {
    // Respect the endpoint's own rate limit: on 429, wait out retry-after and
    // retry. Lets the eval run against the live, guarded endpoint unmodified.
    // (The deployed endpoint uses its own configured model — --model/--compare
    // only apply to in-process runs.)
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${endpoint.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, corpus }),
      });
      if (res.status !== 429 || attempt >= 6) break;
      const retryAfter = Number(res.headers.get("retry-after")) || 5;
      await sleep((retryAfter + 1) * 1000);
    }
    const data = await res.json();
    if (!res.ok) throw new Error(`Endpoint ${res.status}: ${data.error ?? "error"}`);
    if (data.budgetExhausted) throw new Error("Endpoint daily budget exhausted — raise DEMO_DAILY_BUDGET and retry");
    return {
      answer: data.answer,
      grounded: data.grounded,
      citations: data.citations ?? [],
      retrievedSources: (data.retrieved ?? []).map((r: { source: string }) => r.source),
      usage: { costUsd: data.usage?.costUsd ?? 0, latencyMs: data.usage?.latencyMs ?? 0 },
    };
  }

  const result = await answerQuestion(corpus, question, model);
  return {
    answer: result.answer,
    grounded: result.grounded,
    citations: result.citations.map((c) => ({ id: c.id, source: c.source, content: c.content })),
    retrievedSources: result.retrieved.map((c) => c.source),
    usage: { costUsd: result.usage.costUsd, latencyMs: result.usage.latencyMs },
  };
}

async function judgeFaithfulness(result: Normalized): Promise<boolean> {
  const citedContent = result.citations
    .map((c) => `<chunk id="${c.id}">\n${c.content}\n</chunk>`)
    .join("\n\n");

  const response = await judge.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 200,
    system:
      "You are grading a RAG system for faithfulness. Given source chunks and an answer, decide whether every factual claim in the answer is supported by the chunks. Reply with exactly one word: SUPPORTED or UNSUPPORTED.",
    messages: [{ role: "user", content: `Source chunks:\n\n${citedContent}\n\nAnswer to grade:\n${result.answer}` }],
  });

  const verdict = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
    .toUpperCase();
  return verdict.includes("SUPPORTED") && !verdict.includes("UNSUPPORTED");
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

const rate = (numerator: number, denominator: number): Metric =>
  denominator === 0 ? { pct: 100, label: "n/a" } : { pct: (100 * numerator) / denominator, label: `${((100 * numerator) / denominator).toFixed(0)}% (${numerator}/${denominator})` };

/** Runs the full suite once for a single configuration and prints its metrics block. */
async function runSuite(
  pairs: QAPair[],
  corpus: string,
  opts: { endpoint?: string; model: string }
): Promise<SuiteResult> {
  const { endpoint, model } = opts;
  const target = endpoint ? `endpoint ${endpoint}` : `in-process · generation ${model} · judge ${JUDGE_MODEL}`;
  console.log(`\nEval: ${pairs.length} questions · corpus "${corpus}" · ${target}\n`);

  const rows: Row[] = [];
  for (const pair of pairs) {
    const result = await getAnswer(corpus, pair.question, endpoint, model);

    let hit: boolean | null = null;
    let faithful: boolean | null = null;
    let passed: boolean;

    if (pair.expect === "answer") {
      hit = (pair.expected_sources ?? []).some((s) => result.retrievedSources.includes(s));
      if (result.grounded && result.citations.length > 0) faithful = await judgeFaithfulness(result);
      passed = result.grounded && result.citations.length > 0 && faithful === true && hit;
    } else {
      passed = !result.grounded;
    }

    rows.push({ pair, result, hit, faithful, passed });
    console.log(
      `  [${passed ? "PASS" : "FAIL"}] (${pair.expect === "answer" ? "answer " : "refusal"}) ` +
        `${pair.question.slice(0, 54).padEnd(54)} ${String(result.usage.latencyMs).padStart(5)}ms  $${result.usage.costUsd.toFixed(4)}` +
        (pair.expect === "answer"
          ? `  hit=${hit ? "y" : "N"} cited=${result.citations.length} faithful=${faithful === null ? "-" : faithful ? "y" : "N"}`
          : `  refused=${result.grounded ? "N" : "y"}`)
    );
  }

  const answerable = rows.filter((r) => r.pair.expect === "answer");
  const outOfCorpus = rows.filter((r) => r.pair.expect === "refusal");
  const grounded = answerable.filter((r) => r.result.grounded);
  const judged = answerable.filter((r) => r.faithful !== null);
  const latencies = rows.map((r) => r.result.usage.latencyMs);
  const totalCost = rows.reduce((sum, r) => sum + r.result.usage.costUsd, 0);

  const metrics: Metrics = {
    hitRate: rate(answerable.filter((r) => r.hit).length, answerable.length),
    citationRate: rate(grounded.filter((r) => r.result.citations.length > 0).length, grounded.length),
    faithfulness: rate(judged.filter((r) => r.faithful).length, judged.length),
    refusalAccuracy: rate(outOfCorpus.filter((r) => !r.result.grounded).length, outOfCorpus.length),
    falseRefusals: rate(answerable.filter((r) => !r.result.grounded).length, answerable.length),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    costPerQuery: totalCost / rows.length,
    overall: rate(rows.filter((r) => r.passed).length, rows.length),
  };

  console.log(`\n=== Metrics (${endpoint ? "endpoint" : display(model)}) ===`);
  console.log(`Retrieval hit rate     ${metrics.hitRate.label}`);
  console.log(`Citation rate          ${metrics.citationRate.label}`);
  console.log(`Faithfulness (judge)   ${metrics.faithfulness.label}`);
  console.log(`Refusal accuracy       ${metrics.refusalAccuracy.label}`);
  console.log(`False refusals         ${metrics.falseRefusals.label}`);
  console.log(`Latency p50 / p95      ${metrics.p50}ms / ${metrics.p95}ms`);
  console.log(`Avg cost per query     $${metrics.costPerQuery.toFixed(4)} (total $${totalCost.toFixed(4)} for ${rows.length} queries)`);
  console.log(`Overall pass           ${metrics.overall.label}`);

  return { model, metrics, rows, answerable, outOfCorpus, passedAll: !rows.some((r) => !r.passed) };
}

async function main() {
  const { endpoint, corpus: corpusArg, out, limit, model: modelArg, compare } = parseArgs();
  const corpus = corpusArg ?? loadCorpusConfig().corpus;
  let pairs: QAPair[] = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "eval/questions.json"), "utf-8"));
  if (limit) pairs = pairs.slice(0, Number(limit));

  if (compare) {
    if (endpoint) console.error("Note: --compare runs in-process (one endpoint serves one model) — ignoring --endpoint.");
    const models = compare.split(",").map((m) => m.trim()).filter(Boolean);
    models.forEach((m) => priceFor(m)); // fail fast on an unpriced model, before spending tokens

    const results: SuiteResult[] = [];
    for (const model of models) results.push(await runSuite(pairs, corpus, { model }));

    printComparison(results);
    if (out) {
      fs.writeFileSync(path.resolve(process.cwd(), out), renderComparisonDoc({ results, pairs, corpus }));
      console.log(`\nWrote ${out}`);
    }
    await getPool().end();
    if (results.some((r) => !r.passedAll)) process.exitCode = 1;
    return;
  }

  const model = modelArg ?? GENERATION_MODEL;
  const result = await runSuite(pairs, corpus, { endpoint, model });

  if (out) {
    fs.writeFileSync(
      path.resolve(process.cwd(), out),
      renderMetricsDoc({ metrics: result.metrics, pairs, corpus, endpoint, answerable: result.answerable, outOfCorpus: result.outOfCorpus, model })
    );
    console.log(`\nWrote ${out}`);
  }

  if (!endpoint) await getPool().end();
  if (!result.passedAll) process.exitCode = 1;
}

/** The label that identifies a model's role in the comparison table. */
function roleSuffix(model: string): string {
  if (model === GENERATION_MODEL) return " (production)";
  if (model === "claude-opus-4-8") return " (baseline)";
  return "";
}

function printComparison(results: SuiteResult[]) {
  console.log("\n=== Model comparison ===");
  console.log("model                 faithful  refusal  cost/q    p50");
  for (const r of results) {
    console.log(
      `${display(r.model).padEnd(20)}  ${r.metrics.faithfulness.label.padEnd(8)}  ` +
        `${r.metrics.refusalAccuracy.label.padEnd(7)}  $${r.metrics.costPerQuery.toFixed(4)}  ${r.metrics.p50}ms` +
        roleSuffix(r.model)
    );
  }
}

/** The single-model headline table rows (shared by both renderers). */
function headlineTable(metrics: Metrics): string {
  return `| Metric | Result | What it means |
| --- | --- | --- |
| Retrieval hit rate | **${metrics.hitRate.label}** | The expected source document was among the retrieved chunks |
| Citation rate | **${metrics.citationRate.label}** | Grounded answers carried at least one valid citation |
| Faithfulness | **${metrics.faithfulness.label}** | An LLM judge confirmed every claim is supported by the cited chunks |
| Refusal accuracy | **${metrics.refusalAccuracy.label}** | Out-of-corpus questions got the honest "not in the knowledge base" refusal |
| False refusals | **${metrics.falseRefusals.label}** | In-corpus questions wrongly refused (lower is better) |
| Latency p50 / p95 | **${metrics.p50}ms / ${metrics.p95}ms** | End-to-end pipeline time per query |
| Cost per query | **$${metrics.costPerQuery.toFixed(4)}** | Embeddings + generation, from real token usage |`;
}

function renderMetricsDoc(ctx: {
  metrics: Metrics;
  pairs: QAPair[];
  corpus: string;
  endpoint?: string;
  answerable: Row[];
  outOfCorpus: Row[];
  model: string;
}): string {
  const { metrics, pairs, corpus, endpoint, answerable, outOfCorpus, model } = ctx;
  const date = new Date().toISOString().slice(0, 10);
  const where = endpoint ? `production endpoint (\`${endpoint}\`)` : "in-process pipeline";
  return `# Mimir — measured evaluation

_Run ${date} · ${pairs.length} Q&A pairs (${answerable.length} in-corpus, ${outOfCorpus.length} out-of-corpus) · corpus \`${corpus}\` · ${where}._

Every number below comes from a real run of the full pipeline — retrieval, grounded generation, and an independent LLM faithfulness judge — over a fixed question set. Nothing is estimated.

${headlineTable(metrics)}

**Models:** embeddings \`${EMBEDDING_MODEL}\`, generation \`${model}\`, faithfulness judge \`${JUDGE_MODEL}\`.

**Methodology:** each question runs through the deployed pipeline; retrieval hit rate checks the expected source appears in the retrieved set; faithfulness is graded by a separate LLM judge against the cited chunks only; refusal accuracy and false refusals are measured against a labeled out-of-corpus set. Reproduce with \`npm run eval${endpoint ? ` -- --endpoint ${endpoint}` : ""}\`.
`;
}

function renderComparisonDoc(ctx: { results: SuiteResult[]; pairs: QAPair[]; corpus: string }): string {
  const { results, pairs, corpus } = ctx;
  const date = new Date().toISOString().slice(0, 10);
  const answerable = results[0].answerable.length;
  const outOfCorpus = results[0].outOfCorpus.length;
  const prod = results.find((r) => r.model === GENERATION_MODEL) ?? results[results.length - 1];

  const priceLine = Object.entries(MODEL_PRICING)
    .map(([m, p]) => `${display(m).replace("Claude ", "")} ${p.input} / ${p.output}`)
    .join(", ");

  const comparisonRows = results
    .map((r) => {
      const name = `${display(r.model)}${roleSuffix(r.model)}`;
      const cells = [
        r.metrics.faithfulness.label,
        r.metrics.refusalAccuracy.label,
        r.metrics.falseRefusals.label,
        r.metrics.hitRate.label,
        `$${r.metrics.costPerQuery.toFixed(4)}`,
        `${r.metrics.p50}ms`,
        r.metrics.overall.label,
      ];
      const cols = r.model === GENERATION_MODEL ? [`**${name}**`, ...cells.map((c) => `**${c}**`)] : [name, ...cells];
      return `| ${cols.join(" | ")} |`;
    })
    .join("\n");

  return `# Mimir — measured evaluation

_Run ${date} · ${pairs.length} Q&A pairs (${answerable} in-corpus, ${outOfCorpus} out-of-corpus) · corpus \`${corpus}\` · in-process pipeline · faithfulness judged by \`${JUDGE_MODEL}\`._

Every number below comes from a real run of the full pipeline — retrieval, grounded generation, and an independent LLM faithfulness judge — over a fixed question set. Nothing is estimated.

## Production model: ${display(prod.model)}

${headlineTable(prod.metrics)}

## Cost-tuned via eval

Same suite, same corpus, same \`${JUDGE_MODEL}\` faithfulness judge — only the generation model changes. **${display(prod.model)}** is the production default; the table below is the full measured comparison behind that choice. Every figure is from a real run — read the numbers, they are not asserted.

| Model | Faithfulness | Refusal acc. | False refusals | Retrieval hit | Cost / query | Latency p50 | Overall |
| --- | --- | --- | --- | --- | --- | --- | --- |
${comparisonRows}

**Models:** embeddings \`${EMBEDDING_MODEL}\`, generation \`${prod.model}\`, faithfulness judge \`${JUDGE_MODEL}\`. Costs use standard per-model list pricing ($/1M tokens in / out): ${priceLine}.

**Methodology:** each question runs through the full in-process pipeline; retrieval hit rate checks the expected source appears in the retrieved set; faithfulness is graded by a separate judge — pinned to \`${JUDGE_MODEL}\` regardless of the generation model — against the cited chunks only; refusal accuracy and false refusals are measured against a labeled out-of-corpus set. Latency is measured in-process (no network or cold-start), so it reflects relative model speed rather than production wall-clock. Reproduce with \`npm run eval -- --compare ${results.map((r) => r.model).join(",")} --out docs/metrics.md\`.
`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
