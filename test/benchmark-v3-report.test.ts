import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  summarizeBenchmarkV3Runs,
  type BenchmarkV3Run,
} from "../src/benchmark-v3-report.ts";
import type { PiRlmUsage } from "../src/shared-limits.ts";

function usage(totalTokens: number, costUsd: number, modelCalls: number): PiRlmUsage {
  return {
    modelCalls,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens,
    costUsd,
    peakConcurrentModelCalls: 1,
    rlmNodes: 1,
    llmSubcalls: 0,
    rlmSubcalls: 0,
    preflightRejectedSubcalls: 0,
    preflightRejectedProviderCalls: 0,
    peakReservedSubcallInputTokens: 0,
    peakReservedProviderTokens: 0,
    postHocLimitViolations: 0,
  };
}

function run(overrides: Partial<BenchmarkV3Run>): BenchmarkV3Run {
  return {
    scenario: "plain-file",
    repeat: 1,
    expected: "2",
    passed: true,
    answer: "2",
    correct: true,
    falsePass: false,
    errorLikePass: false,
    durationMs: 100,
    usage: usage(100, 0.001, 1),
    ...overrides,
  };
}

test("benchmark v3 summary exposes false passes and p95 resource use", () => {
  const [summary] = summarizeBenchmarkV3Runs([
    run({ repeat: 1 }),
    run({
      repeat: 2,
      answer: "3",
      correct: false,
      falsePass: true,
      durationMs: 200,
      usage: usage(200, 0.002, 2),
    }),
    run({
      repeat: 3,
      answer: "Unable to inspect context",
      correct: false,
      falsePass: true,
      errorLikePass: true,
      durationMs: 300,
      usage: usage(300, 0.003, 3),
    }),
    run({
      repeat: 4,
      passed: false,
      answer: undefined,
      error: "deadline exceeded",
      failureClass: "timeout",
      correct: false,
      durationMs: 400,
      usage: usage(400, 0.004, 4),
    }),
  ]);

  assert.deepEqual(summary, {
    scenario: "plain-file",
    attempts: 4,
    passed: 3,
    correct: 1,
    successRate: 0.25,
    falsePasses: 2,
    errorLikePasses: 1,
    medianDurationMs: 250,
    p95DurationMs: 400,
    medianTotalTokens: 250,
    p95TotalTokens: 400,
    medianCostUsd: 0.0025,
    p95CostUsd: 0.004,
    totalCostUsd: 0.01,
    medianModelCalls: 2.5,
    p95ModelCalls: 4,
    failureClasses: { timeout: 1 },
  });
});

test("ships the contract-free directory benchmark fixture", async () => {
  const fixture = await readFile(
    new URL("fixtures/contractless.txt", import.meta.url),
    "utf8",
  );
  assert.match(fixture, /^MAGIC=FALLBACK_OK$/mu);
});
