import "dotenv/config";
import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { loadCorpusConfig } from "../src/lib/config";
import { answerQuestion, GENERATION_MODEL } from "../src/lib/answer";
import { EMBEDDING_MODEL } from "../src/lib/embeddings";
import { getPool } from "../src/lib/db";

/**
 * Eval harness. Runs every pair in eval/questions.json through the full
 * pipeline — either in-process or against a deployed endpoint — and reports a
 * metrics table. All numbers come from real API usage.
 *
 * Usage:
 *   npm run eval                                  # in-process, default corpus
 *   npm run eval -- --endpoint https://host       # against a deployed URL
 *   npm run eval -- --endpoint https://host --out docs/metrics.md
 *
 * Metrics: retrieval hit rate, citation rate, LLM-judged faithfulness,
 * refusal accuracy, false-refusal rate, latency p50/p95, cost per query.
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

const judge = new Anthropic();

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i > -1 ? args[i + 1] : undefined;
  };
  return { endpoint: get("--endpoint"), corpus: get("--corpus"), out: get("--out"), limit: get("--limit") };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getAnswer(corpus: string, question: string, endpoint?: string): Promise<Normalized> {
  if (endpoint) {
    // Respect the endpoint's own rate limit: on 429, wait out retry-after and
    // retry. Lets the eval run against the live, guarded endpoint unmodified.
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

  const result = await answerQuestion(corpus, question);
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
    model: GENERATION_MODEL,
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

const rate = (numerator: number, denominator: number) =>
  denominator === 0 ? { pct: 100, label: "n/a" } : { pct: (100 * numerator) / denominator, label: `${((100 * numerator) / denominator).toFixed(0)}% (${numerator}/${denominator})` };

async function main() {
  const { endpoint, corpus: corpusArg, out, limit } = parseArgs();
  const corpus = corpusArg ?? loadCorpusConfig().corpus;
  let pairs: QAPair[] = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "eval/questions.json"), "utf-8"));
  if (limit) pairs = pairs.slice(0, Number(limit));

  const target = endpoint ? `endpoint ${endpoint}` : "in-process";
  console.log(`Eval: ${pairs.length} questions · corpus "${corpus}" · ${target}\n`);

  const rows: Row[] = [];
  for (const pair of pairs) {
    const result = await getAnswer(corpus, pair.question, endpoint);

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

  const metrics = {
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

  console.log("\n=== Metrics ===");
  console.log(`Retrieval hit rate     ${metrics.hitRate.label}`);
  console.log(`Citation rate          ${metrics.citationRate.label}`);
  console.log(`Faithfulness (judge)   ${metrics.faithfulness.label}`);
  console.log(`Refusal accuracy       ${metrics.refusalAccuracy.label}`);
  console.log(`False refusals         ${metrics.falseRefusals.label}`);
  console.log(`Latency p50 / p95      ${metrics.p50}ms / ${metrics.p95}ms`);
  console.log(`Avg cost per query     $${metrics.costPerQuery.toFixed(4)} (total $${totalCost.toFixed(4)} for ${rows.length} queries)`);
  console.log(`Overall pass           ${metrics.overall.label}`);

  if (out) {
    fs.writeFileSync(path.resolve(process.cwd(), out), renderMetricsDoc({ metrics, pairs, corpus, endpoint, answerable, outOfCorpus }));
    console.log(`\nWrote ${out}`);
  }

  if (!endpoint) await getPool().end();
  if (rows.some((r) => !r.passed)) process.exitCode = 1;
}

interface Metric {
  pct: number;
  label: string;
}

function renderMetricsDoc(ctx: {
  metrics: {
    hitRate: Metric;
    citationRate: Metric;
    faithfulness: Metric;
    refusalAccuracy: Metric;
    falseRefusals: Metric;
    p50: number;
    p95: number;
    costPerQuery: number;
    overall: Metric;
  };
  pairs: QAPair[];
  corpus: string;
  endpoint?: string;
  answerable: Row[];
  outOfCorpus: Row[];
}): string {
  const { metrics, pairs, corpus, endpoint, answerable, outOfCorpus } = ctx;
  const date = new Date().toISOString().slice(0, 10);
  const where = endpoint ? `production endpoint (\`${endpoint}\`)` : "in-process pipeline";
  return `# Mimir — measured evaluation

_Run ${date} · ${pairs.length} Q&A pairs (${answerable.length} in-corpus, ${outOfCorpus.length} out-of-corpus) · corpus \`${corpus}\` · ${where}._

Every number below comes from a real run of the full pipeline — retrieval, grounded generation, and an independent LLM faithfulness judge — over a fixed question set. Nothing is estimated.

| Metric | Result | What it means |
| --- | --- | --- |
| Retrieval hit rate | **${metrics.hitRate.label}** | The expected source document was among the retrieved chunks |
| Citation rate | **${metrics.citationRate.label}** | Grounded answers carried at least one valid citation |
| Faithfulness | **${metrics.faithfulness.label}** | An LLM judge confirmed every claim is supported by the cited chunks |
| Refusal accuracy | **${metrics.refusalAccuracy.label}** | Out-of-corpus questions got the honest "not in the knowledge base" refusal |
| False refusals | **${metrics.falseRefusals.label}** | In-corpus questions wrongly refused (lower is better) |
| Latency p50 / p95 | **${metrics.p50}ms / ${metrics.p95}ms** | End-to-end pipeline time per query |
| Cost per query | **$${metrics.costPerQuery.toFixed(4)}** | Embeddings + generation, from real token usage |

**Models:** embeddings \`${EMBEDDING_MODEL}\`, generation \`${GENERATION_MODEL}\`.

**Methodology:** each question runs through the deployed pipeline; retrieval hit rate checks the expected source appears in the retrieved set; faithfulness is graded by a separate LLM judge against the cited chunks only; refusal accuracy and false refusals are measured against a labeled out-of-corpus set. Reproduce with \`npm run eval${endpoint ? ` -- --endpoint ${endpoint}` : ""}\`.
`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
