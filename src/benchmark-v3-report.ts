import type { BenchmarkV2FailureClass } from "./benchmark-v2-report.ts";
import type { PiRlmUsage } from "./shared-limits.ts";

export type BenchmarkV3Scenario = "plain-file" | "directory-contract-free";
export type BenchmarkV3FailureClass = BenchmarkV2FailureClass;

export interface BenchmarkV3Run {
  scenario: BenchmarkV3Scenario;
  repeat: number;
  expected: string;
  passed: boolean;
  answer?: string;
  error?: string;
  failureClass?: BenchmarkV3FailureClass;
  correct: boolean;
  falsePass: boolean;
  errorLikePass: boolean;
  durationMs: number;
  usage: PiRlmUsage;
  executionCount?: number;
  answerRejections?: number;
}

export interface BenchmarkV3Summary {
  scenario: BenchmarkV3Scenario;
  attempts: number;
  passed: number;
  correct: number;
  successRate: number;
  falsePasses: number;
  errorLikePasses: number;
  medianDurationMs: number;
  p95DurationMs: number;
  medianTotalTokens: number;
  p95TotalTokens: number;
  medianCostUsd: number;
  p95CostUsd: number;
  totalCostUsd: number;
  medianModelCalls: number;
  p95ModelCalls: number;
  failureClasses: Partial<Record<BenchmarkV3FailureClass, number>>;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index]!;
}

export function isErrorLikeAnswer(answer: string): boolean {
  return /\b(?:unable|error|failed|failure|cannot|requires|required|unavailable)\b/iu.test(
    answer,
  );
}

export function summarizeBenchmarkV3Runs(
  runs: readonly BenchmarkV3Run[],
): BenchmarkV3Summary[] {
  const groups = new Map<BenchmarkV3Scenario, BenchmarkV3Run[]>();
  for (const run of runs) {
    const group = groups.get(run.scenario);
    if (group) group.push(run);
    else groups.set(run.scenario, [run]);
  }

  return [...groups.entries()]
    .map(([scenario, group]): BenchmarkV3Summary => {
      const failureClasses: BenchmarkV3Summary["failureClasses"] = {};
      for (const run of group) {
        if (!run.failureClass) continue;
        failureClasses[run.failureClass] =
          (failureClasses[run.failureClass] ?? 0) + 1;
      }
      return {
        scenario,
        attempts: group.length,
        passed: group.filter((run) => run.passed).length,
        correct: group.filter((run) => run.correct).length,
        successRate: group.filter((run) => run.correct).length / group.length,
        falsePasses: group.filter((run) => run.falsePass).length,
        errorLikePasses: group.filter((run) => run.errorLikePass).length,
        medianDurationMs: median(group.map((run) => run.durationMs)),
        p95DurationMs: percentile(group.map((run) => run.durationMs), 0.95),
        medianTotalTokens: median(group.map((run) => run.usage.totalTokens)),
        p95TotalTokens: percentile(group.map((run) => run.usage.totalTokens), 0.95),
        medianCostUsd: median(group.map((run) => run.usage.costUsd)),
        p95CostUsd: percentile(group.map((run) => run.usage.costUsd), 0.95),
        totalCostUsd: group.reduce((sum, run) => sum + run.usage.costUsd, 0),
        medianModelCalls: median(group.map((run) => run.usage.modelCalls)),
        p95ModelCalls: percentile(group.map((run) => run.usage.modelCalls), 0.95),
        failureClasses,
      };
    })
    .sort((left, right) => left.scenario.localeCompare(right.scenario));
}
