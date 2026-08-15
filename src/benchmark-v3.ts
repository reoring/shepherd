import { execFile } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyBenchmarkV2Failure } from "./benchmark-v2-report.ts";
import {
  isErrorLikeAnswer,
  summarizeBenchmarkV3Runs,
  type BenchmarkV3Run,
  type BenchmarkV3Scenario,
} from "./benchmark-v3-report.ts";
import type { PiRlmUsage } from "./shared-limits.ts";

interface BenchmarkScenario {
  id: BenchmarkV3Scenario;
  contextPath: string;
  question: string;
  expected: string;
}

interface CliSuccess {
  status: "passed";
  answer: string;
  executionCount: number;
  answerRejections: number;
  usage: PiRlmUsage;
}

interface CliFailure {
  status: "failed";
  error: string;
  usage?: PiRlmUsage;
  executionCount?: number;
}

interface CliExecution {
  exitCode: number;
  stdout: string;
  stderr: string;
  processError?: string;
}

const SHEPHERD_ENTRYPOINT = fileURLToPath(
  new URL("./shepherd-cli.ts", import.meta.url),
);
const SCENARIOS: readonly BenchmarkScenario[] = [
  {
    id: "plain-file",
    contextPath: "src/rlm-defaults.ts",
    question: "What numeric value is assigned to maxDepth? Return only the number.",
    expected: "2",
  },
  {
    id: "directory-contract-free",
    contextPath: "test/fixtures",
    question: "What exact value follows MAGIC= in contractless.txt? Return only the value.",
    expected: "FALLBACK_OK",
  },
];

function resolveRepeats(): number {
  const value = Number.parseInt(process.env.PI_RLM_BENCHMARK_REPEATS ?? "10", 10);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error(`PI_RLM_BENCHMARK_REPEATS must be 1-100: ${value}`);
  }
  return value;
}

function resolveIsolationMode(): "subprocess" | "docker" {
  const value = process.env.SHEPHERD_ISOLATION ?? "subprocess";
  if (value !== "subprocess" && value !== "docker") {
    throw new Error(`Unsupported SHEPHERD_ISOLATION: ${value}`);
  }
  return value;
}

function resolveOutputPrefix(): string {
  const value = process.env.PI_RLM_BENCHMARK_OUTPUT_PREFIX ?? "benchmark-v3-core";
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(value)) {
    throw new Error(`Invalid benchmark v3 output prefix: ${value}`);
  }
  return value;
}

function emptyUsage(): PiRlmUsage {
  return {
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
}

function executeQuery(args: readonly string[], cwd: string): Promise<CliExecution> {
  const { promise, resolve: complete, reject } = Promise.withResolvers<CliExecution>();
  execFile(
    process.execPath,
    [SHEPHERD_ENTRYPOINT, ...args],
    { cwd, maxBuffer: 4 * 1024 * 1024, timeout: 200_000 },
    (error, stdout, stderr) => {
      if (!error) {
        complete({ exitCode: 0, stdout, stderr });
        return;
      }
      if (error.code === 1 || error.killed) {
        complete({
          exitCode: error.killed ? 124 : 1,
          stdout,
          stderr,
          processError: error.message,
        });
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || error.message, { cause: error }));
    },
  );
  return promise;
}

function parseObject(value: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseSuccess(value: string): CliSuccess {
  const output = parseObject(value, "Shepherd query success output");
  if (
    output.status !== "passed" ||
    typeof output.answer !== "string" ||
    typeof output.executionCount !== "number" ||
    typeof output.answerRejections !== "number" ||
    !output.usage ||
    typeof output.usage !== "object"
  ) {
    throw new Error("Shepherd query returned an invalid success payload");
  }
  return output as unknown as CliSuccess;
}

function parseFailure(execution: CliExecution): CliFailure {
  if (execution.stderr.trim()) {
    try {
      const output = parseObject(execution.stderr, "Shepherd query failure output");
      if (output.status === "failed" && typeof output.error === "string") {
        return output as unknown as CliFailure;
      }
    } catch {
      // Preserve the process error below when stderr is not the CLI JSON envelope.
    }
  }
  return {
    status: "failed",
    error: (execution.processError ?? execution.stderr.trim()) || "Shepherd query failed",
  };
}

const packageRoot = process.cwd();
const repeats = resolveRepeats();
const isolationMode = resolveIsolationMode();
const model = process.env.SHEPHERD_MODEL ?? "openai/gpt-5.6-luna";
const outputPrefix = resolveOutputPrefix();
const outputPath = resolve(packageRoot, `${outputPrefix}-results.json`);
const runsPath = resolve(packageRoot, `${outputPrefix}-runs.jsonl`);
const runs: BenchmarkV3Run[] = [];
await writeFile(runsPath, "", "utf8");

for (const scenario of SCENARIOS) {
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const startedAt = performance.now();
    const execution = await executeQuery(
      [
        "query",
        scenario.contextPath,
        "--question",
        scenario.question,
        "--model",
        model,
        "--isolation",
        isolationMode,
        "--json",
      ],
      packageRoot,
    );
    const durationMs = performance.now() - startedAt;
    let run: BenchmarkV3Run;
    if (execution.exitCode === 0) {
      const output = parseSuccess(execution.stdout);
      const correct = output.answer.trim() === scenario.expected;
      run = {
        scenario: scenario.id,
        repeat,
        expected: scenario.expected,
        passed: true,
        answer: output.answer,
        correct,
        falsePass: !correct,
        errorLikePass: isErrorLikeAnswer(output.answer),
        durationMs,
        usage: output.usage,
        executionCount: output.executionCount,
        answerRejections: output.answerRejections,
      };
    } else {
      const output = parseFailure(execution);
      run = {
        scenario: scenario.id,
        repeat,
        expected: scenario.expected,
        passed: false,
        error: output.error,
        failureClass: classifyBenchmarkV2Failure(output.error),
        correct: false,
        falsePass: false,
        errorLikePass: false,
        durationMs,
        usage: output.usage ?? emptyUsage(),
        executionCount: output.executionCount,
      };
    }
    runs.push(run);
    await appendFile(runsPath, `${JSON.stringify(run)}\n`, "utf8");
    process.stdout.write(
      `${JSON.stringify({
        status: "run-complete",
        scenario: run.scenario,
        repeat: run.repeat,
        correct: run.correct,
        falsePass: run.falsePass,
        durationMs: Math.round(run.durationMs),
        modelCalls: run.usage.modelCalls,
        totalTokens: run.usage.totalTokens,
        costUsd: run.usage.costUsd,
        failureClass: run.failureClass,
      })}\n`,
    );
  }
}

const summaries = summarizeBenchmarkV3Runs(runs);
const acceptance = {
  minimumContractFreeSuccessRate: 0.9,
  maximumFalsePasses: 0,
  maximumErrorLikePasses: 0,
};
const accepted = summaries.every(
  (summary) =>
    summary.successRate >= acceptance.minimumContractFreeSuccessRate &&
    summary.falsePasses <= acceptance.maximumFalsePasses &&
    summary.errorLikePasses <= acceptance.maximumErrorLikePasses,
);
const report = {
  benchmark: "shepherd-v3-core-stability",
  generatedAt: new Date().toISOString(),
  model,
  isolationMode,
  repeats,
  acceptance,
  accepted,
  summaries,
  runs,
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ status: "complete", accepted, outputPath, runsPath, summaries })}\n`);
process.exitCode = accepted ? 0 : 1;
