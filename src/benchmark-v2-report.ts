import type {
  BenchmarkV2Family,
  BenchmarkV2Tier,
} from "./benchmark-v2-cases.ts";
import type { PiRlmUsage } from "./shared-limits.ts";

export type BenchmarkV2Harness = "direct-pi-standard" | "pi-rlm";
export type BenchmarkV2FailureClass =
  | "timeout"
  | "budget-preflight"
  | "token-limit"
  | "cost-limit"
  | "answer-contract"
  | "provider"
  | "other";

export interface BenchmarkV2Run {
  caseId: string;
  family: BenchmarkV2Family;
  tier: BenchmarkV2Tier;
  seed: number;
  harness: BenchmarkV2Harness;
  repeat: number;
  answer?: string;
  error?: string;
  failureClass?: BenchmarkV2FailureClass;
  correct: boolean;
  durationMs: number;
  usage: PiRlmUsage;
  executionCount?: number;
  answerRejections?: number;
}

export interface BenchmarkV2Summary {
  caseId: string;
  family: BenchmarkV2Family;
  tier: BenchmarkV2Tier;
  seed: number;
  harness: BenchmarkV2Harness;
  attempts: number;
  correct: number;
  successRate: number;
  medianDurationMs: number;
  p95DurationMs: number;
  medianTotalTokens: number;
  medianCostUsd: number;
  costPerCorrectUsd: number | null;
  medianModelCalls: number;
  medianAnswerRejections: number;
  failureClasses: Partial<Record<BenchmarkV2FailureClass, number>>;
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

export function classifyBenchmarkV2Failure(error: unknown): BenchmarkV2FailureClass {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|deadline|timed out|exceeded \d+ms/iu.test(message)) return "timeout";
  if (/budget preflight|preflight rejected/iu.test(message)) return "budget-preflight";
  if (/token limit/iu.test(message)) return "token-limit";
  if (/cost limit/iu.test(message)) return "cost-limit";
  if (/answer|rlm_exec|requested token|exact/iu.test(message)) return "answer-contract";
  if (/provider|authentication|model|api|rate limit/iu.test(message)) return "provider";
  return "other";
}

export function summarizeBenchmarkV2Runs(
  runs: readonly BenchmarkV2Run[],
): BenchmarkV2Summary[] {
  const groups = new Map<string, BenchmarkV2Run[]>();
  for (const run of runs) {
    const key = `${run.caseId}\0${run.harness}`;
    const group = groups.get(key);
    if (group) group.push(run);
    else groups.set(key, [run]);
  }

  return [...groups.values()]
    .map((group): BenchmarkV2Summary => {
      const first = group[0]!;
      const correct = group.filter((run) => run.correct).length;
      const totalCost = group.reduce((sum, run) => sum + run.usage.costUsd, 0);
      const failureClasses: BenchmarkV2Summary["failureClasses"] = {};
      for (const run of group) {
        if (!run.failureClass) continue;
        failureClasses[run.failureClass] = (failureClasses[run.failureClass] ?? 0) + 1;
      }
      return {
        caseId: first.caseId,
        family: first.family,
        tier: first.tier,
        seed: first.seed,
        harness: first.harness,
        attempts: group.length,
        correct,
        successRate: correct / group.length,
        medianDurationMs: median(group.map((run) => run.durationMs)),
        p95DurationMs: percentile(group.map((run) => run.durationMs), 0.95),
        medianTotalTokens: median(group.map((run) => run.usage.totalTokens)),
        medianCostUsd: median(group.map((run) => run.usage.costUsd)),
        costPerCorrectUsd: correct === 0 ? null : totalCost / correct,
        medianModelCalls: median(group.map((run) => run.usage.modelCalls)),
        medianAnswerRejections: median(group.map((run) => run.answerRejections ?? 0)),
        failureClasses,
      };
    })
    .sort(
      (left, right) =>
        left.caseId.localeCompare(right.caseId) || left.harness.localeCompare(right.harness),
    );
}
