import assert from "node:assert/strict";
import test from "node:test";

import {
  BENCHMARK_V2_FAMILIES,
  BENCHMARK_V2_TIER_CHARACTERS,
  createBenchmarkV2Cases,
  isExactBenchmarkV2Answer,
} from "../src/benchmark-v2-cases.ts";
import {
  type BenchmarkV2Run,
  summarizeBenchmarkV2Runs,
} from "../src/benchmark-v2-report.ts";
import type { PiRlmUsage } from "../src/shared-limits.ts";

const EMPTY_USAGE: PiRlmUsage = {
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  peakConcurrentModelCalls: 0,
  rlmNodes: 0,
  llmSubcalls: 0,
  rlmSubcalls: 0,
  preflightRejectedSubcalls: 0,
  preflightRejectedProviderCalls: 0,
  peakReservedSubcallInputTokens: 0,
  peakReservedProviderTokens: 0,
  postHocLimitViolations: 0,
};

test("benchmark v2 creates deterministic matched task families at each tier", () => {
  const tiers = ["small", "large"] as const;
  const cases = createBenchmarkV2Cases(tiers);

  assert.equal(cases.length, BENCHMARK_V2_FAMILIES.length * tiers.length);
  assert.deepEqual(cases, createBenchmarkV2Cases(tiers));
  assert.deepEqual(new Set(cases.map((benchmarkCase) => benchmarkCase.family)), new Set(BENCHMARK_V2_FAMILIES));

  for (const benchmarkCase of cases) {
    assert.ok(benchmarkCase.content.length >= BENCHMARK_V2_TIER_CHARACTERS[benchmarkCase.tier]);
    assert.ok(benchmarkCase.expected.length > 0);
    assert.equal(benchmarkCase.question.includes(benchmarkCase.expected), false);
    assert.equal(isExactBenchmarkV2Answer(`${benchmarkCase.expected}\n`, benchmarkCase.expected), true);
    assert.equal(isExactBenchmarkV2Answer(`Answer: ${benchmarkCase.expected}`, benchmarkCase.expected), false);
  }
});

test("benchmark v2 expands deterministic unique cases across explicit seeds", () => {
  const tiers = ["small", "large"] as const;
  const seeds = [0, 17, 42] as const;
  const cases = createBenchmarkV2Cases(tiers, seeds);

  assert.equal(cases.length, BENCHMARK_V2_FAMILIES.length * tiers.length * seeds.length);
  assert.equal(new Set(cases.map((benchmarkCase) => benchmarkCase.id)).size, cases.length);
  assert.deepEqual(new Set(cases.map((benchmarkCase) => benchmarkCase.seed)), new Set(seeds));
  assert.deepEqual(cases, createBenchmarkV2Cases(tiers, seeds));

  const semanticCases = cases.filter(
    (benchmarkCase) =>
      benchmarkCase.family === "semantic-aggregation" && benchmarkCase.tier === "small",
  );
  assert.equal(new Set(semanticCases.map((benchmarkCase) => benchmarkCase.content)).size, seeds.length);
  assert.deepEqual(
    createBenchmarkV2Cases(tiers),
    cases.filter((benchmarkCase) => benchmarkCase.seed === 0),
  );
});

test("semantic aggregation ground truth accounts for every generated record", () => {
  const benchmarkCase = createBenchmarkV2Cases(["small"]).find(
    (candidate) => candidate.family === "semantic-aggregation",
  );
  assert.ok(benchmarkCase);

  const counts = Object.fromEntries(
    benchmarkCase.expected.split(";").map((entry) => {
      const [label, count] = entry.split("=");
      return [label, Number(count)];
    }),
  );
  const recordCount = benchmarkCase.content.split("\n").filter((line) => line.startsWith("REC ")).length;
  assert.equal(Object.values(counts).reduce((total, count) => total + count, 0), recordCount);
});

function fakeRun(
  harness: BenchmarkV2Run["harness"],
  repeat: number,
  correct: boolean,
  durationMs: number,
  totalTokens: number,
  failureClass?: BenchmarkV2Run["failureClass"],
): BenchmarkV2Run {
  return {
    caseId: "retrieval-small",
    family: "retrieval",
    tier: "small",
    seed: 0,
    harness,
    repeat,
    correct,
    durationMs,
    usage: { ...EMPTY_USAGE, totalTokens },
    failureClass,
  };
}

test("benchmark v2 summaries report stability, p95, and failure classes", () => {
  const summaries = summarizeBenchmarkV2Runs([
    fakeRun("direct-pi-standard", 1, true, 10, 100),
    fakeRun("direct-pi-standard", 2, true, 20, 200),
    fakeRun("direct-pi-standard", 3, false, 30, 300, "token-limit"),
    fakeRun("pi-rlm", 1, true, 40, 400),
    fakeRun("pi-rlm", 2, true, 50, 500),
    fakeRun("pi-rlm", 3, true, 60, 600),
  ]);

  const direct = summaries.find((summary) => summary.harness === "direct-pi-standard");
  const rlm = summaries.find((summary) => summary.harness === "pi-rlm");
  assert.ok(direct);
  assert.ok(rlm);
  assert.equal(direct.attempts, 3);
  assert.equal(direct.correct, 2);
  assert.equal(direct.successRate, 2 / 3);
  assert.equal(direct.medianDurationMs, 20);
  assert.equal(direct.p95DurationMs, 30);
  assert.equal(direct.medianTotalTokens, 200);
  assert.equal(direct.medianAnswerRejections, 0);
  assert.deepEqual(direct.failureClasses, { "token-limit": 1 });
  assert.equal(rlm.successRate, 1);
  assert.equal(rlm.medianDurationMs, 50);
  assert.equal(rlm.p95DurationMs, 60);
});
