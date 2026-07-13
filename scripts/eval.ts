import "dotenv/config";
import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { loadCorpusConfig } from "../src/lib/config";
import { answerQuestion, Answer, GENERATION_MODEL } from "../src/lib/answer";
import { getPool } from "../src/lib/db";

/**
 * Eval harness: runs every pair in eval/questions.json through the full
 * pipeline and prints a metrics table. All numbers come from real API usage.
 *
 * Metrics:
 *  - retrieval hit rate  (answerable Qs: expected source present in top-k)
 *  - citation rate       (grounded answers that carry >= 1 valid citation)
 *  - faithfulness        (LLM judge: answer supported by its cited chunks)
 *  - refusal accuracy    (out-of-corpus Qs answered with the exact refusal)
 *  - false refusal rate  (answerable Qs wrongly refused)
 *  - latency p50 / p95, average cost per query
 */

interface QAPair {
  question: string;
  expect: "answer" | "refusal";
  expected_sources?: string[];
}

interface Row {
  pair: QAPair;
  result: Answer;
  hit: boolean | null;
  faithful: boolean | null;
  passed: boolean;
}

const judge = new Anthropic();

async function judgeFaithfulness(result: Answer): Promise<boolean> {
  const citedContent = result.retrieved
    .filter((chunk) => result.citations.some((c) => c.id === chunk.id))
    .map((chunk) => `<chunk id="${chunk.id}">\n${chunk.content}\n</chunk>`)
    .join("\n\n");

  const response = await judge.messages.create({
    model: GENERATION_MODEL,
    max_tokens: 200,
    system:
      "You are grading a RAG system for faithfulness. Given source chunks and an answer, decide whether every factual claim in the answer is supported by the chunks. Reply with exactly one word: SUPPORTED or UNSUPPORTED.",
    messages: [
      {
        role: "user",
        content: `Source chunks:\n\n${citedContent}\n\nAnswer to grade:\n${result.answer}`,
      },
    ],
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

const pct = (numerator: number, denominator: number) =>
  denominator === 0 ? "n/a" : `${((100 * numerator) / denominator).toFixed(0)}% (${numerator}/${denominator})`;

async function main() {
  const config = loadCorpusConfig();
  const pairs: QAPair[] = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "eval/questions.json"), "utf-8")
  );

  console.log(`Eval: ${pairs.length} questions against corpus "${config.corpus}"\n`);

  const rows: Row[] = [];
  for (const pair of pairs) {
    const result = await answerQuestion(config.corpus, pair.question);

    let hit: boolean | null = null;
    let faithful: boolean | null = null;
    let passed: boolean;

    if (pair.expect === "answer") {
      hit = (pair.expected_sources ?? []).some((source) =>
        result.retrieved.some((chunk) => chunk.source === source)
      );
      if (result.grounded && result.citations.length > 0) {
        faithful = await judgeFaithfulness(result);
      }
      passed = result.grounded && result.citations.length > 0 && faithful === true && hit;
    } else {
      passed = !result.grounded;
    }

    rows.push({ pair, result, hit, faithful, passed });

    const status = passed ? "PASS" : "FAIL";
    const kind = pair.expect === "answer" ? "answer " : "refusal";
    console.log(
      `  [${status}] (${kind}) ${pair.question.slice(0, 58).padEnd(58)} ` +
        `${String(result.usage.latencyMs).padStart(5)}ms  $${result.usage.costUsd.toFixed(4)}` +
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

  console.log("\n=== Metrics ===");
  console.log(`Retrieval hit rate     ${pct(answerable.filter((r) => r.hit).length, answerable.length)}`);
  console.log(`Citation rate          ${pct(grounded.filter((r) => r.result.citations.length > 0).length, grounded.length)}`);
  console.log(`Faithfulness (judge)   ${pct(judged.filter((r) => r.faithful).length, judged.length)}`);
  console.log(`Refusal accuracy       ${pct(outOfCorpus.filter((r) => !r.result.grounded).length, outOfCorpus.length)}`);
  console.log(`False refusals         ${pct(answerable.filter((r) => !r.result.grounded).length, answerable.length)}`);
  console.log(`Latency p50 / p95      ${percentile(latencies, 50)}ms / ${percentile(latencies, 95)}ms`);
  console.log(`Avg cost per query     $${(totalCost / rows.length).toFixed(4)} (total $${totalCost.toFixed(4)} for ${rows.length} queries)`);
  console.log(`Overall pass           ${pct(rows.filter((r) => r.passed).length, rows.length)}`);

  await getPool().end();
  if (rows.some((r) => !r.passed)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
