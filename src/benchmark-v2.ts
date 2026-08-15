import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  BENCHMARK_V2_FAMILIES,
  type BenchmarkV2Family,
  type BenchmarkV2Tier,
  createBenchmarkV2Cases,
  isExactBenchmarkV2Answer,
} from "./benchmark-v2-cases.ts";
import {
  createExactAnswerValidator,
  observeHarness,
  runDirectPi,
} from "./benchmark-harness.ts";
import {
  type BenchmarkV2Harness,
  type BenchmarkV2Run,
  classifyBenchmarkV2Failure,
  summarizeBenchmarkV2Runs,
} from "./benchmark-v2-report.ts";
import { PiRlmRunner } from "./runner.ts";
import type { ReplIsolationMode } from "./repl-client.ts";
import type { PiRlmLimits } from "./shared-limits.ts";

interface BenchmarkV2Report {
  version: 2;
  timestamp: string;
  model: string;
  isolationMode: ReplIsolationMode;
  repeats: number;
  tiers: BenchmarkV2Tier[];
  families: BenchmarkV2Family[];
  seeds: number[];
  limits: PiRlmLimits;
  semantics: string;
  directPiProfile: {
    name: "standard";
    tools: ["read", "grep", "bash"];
  };
  cases: Array<{
    id: string;
    family: BenchmarkV2Family;
    tier: BenchmarkV2Tier;
    seed: number;
    fileName: string;
    contextCharacters: number;
    estimatedContextTokens: number;
    expected: string;
  }>;
  runs: BenchmarkV2Run[];
  summaries: ReturnType<typeof summarizeBenchmarkV2Runs>;
}

const ALL_TIERS: BenchmarkV2Tier[] = ["small", "medium", "large"];
const HARNESSES: BenchmarkV2Harness[] = ["direct-pi-standard", "pi-rlm"];

function resolveModelSpec(): { provider: string; modelId: string } {
  const spec =
    process.env.PI_RLM_BENCH_V2_MODEL ??
    process.env.PI_RLM_BENCH_MODEL ??
    "openai/gpt-5.6-luna";
  const separator = spec.indexOf("/");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error(`PI_RLM_BENCH_V2_MODEL must be provider/model: ${spec}`);
  }
  return { provider: spec.slice(0, separator), modelId: spec.slice(separator + 1) };
}

function resolveIsolationMode(): ReplIsolationMode {
  const value =
    process.env.PI_RLM_BENCH_V2_ISOLATION ??
    process.env.PI_RLM_BENCH_ISOLATION ??
    "subprocess";
  if (value !== "subprocess" && value !== "docker") {
    throw new Error(`Unsupported PI_RLM_BENCH_V2_ISOLATION: ${value}`);
  }
  return value;
}

function resolveRepeats(): number {
  const raw = process.env.PI_RLM_BENCH_V2_REPEATS ?? "3";
  const repeats = Number(raw);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) {
    throw new Error(`PI_RLM_BENCH_V2_REPEATS must be an integer from 1 to 10: ${raw}`);
  }
  return repeats;
}

function resolveTiers(): BenchmarkV2Tier[] {
  const raw = process.env.PI_RLM_BENCH_V2_TIERS ?? "small,large";
  const tiers = raw.split(",").map((tier) => tier.trim()).filter(Boolean);
  if (tiers.length === 0 || tiers.some((tier) => !ALL_TIERS.includes(tier as BenchmarkV2Tier))) {
    throw new Error(`PI_RLM_BENCH_V2_TIERS must contain small, medium, or large: ${raw}`);
  }
  return [...new Set(tiers)] as BenchmarkV2Tier[];
}

function resolveFamilies(): BenchmarkV2Family[] {
  const raw = process.env.PI_RLM_BENCH_V2_FAMILIES;
  if (!raw) return [...BENCHMARK_V2_FAMILIES];
  const families = raw.split(",").map((family) => family.trim()).filter(Boolean);
  if (
    families.length === 0 ||
    families.some((family) => !BENCHMARK_V2_FAMILIES.includes(family as BenchmarkV2Family))
  ) {
    throw new Error(
      `PI_RLM_BENCH_V2_FAMILIES must contain ${BENCHMARK_V2_FAMILIES.join(", ")}: ${raw}`,
    );
  }
  return [...new Set(families)] as BenchmarkV2Family[];
}

function resolveSeeds(): number[] {
  const raw = process.env.PI_RLM_BENCH_V2_SEEDS ?? "0";
  const seeds = raw.split(",").map((seed) => Number(seed.trim()));
  if (
    seeds.length === 0 ||
    seeds.some((seed) => !Number.isInteger(seed) || seed < 0)
  ) {
    throw new Error(
      `PI_RLM_BENCH_V2_SEEDS must contain non-negative integers: ${raw}`,
    );
  }
  return [...new Set(seeds)];
}

function resolveOutputPrefix(): string {
  const prefix = process.env.PI_RLM_BENCH_V2_OUTPUT_PREFIX ?? "benchmark-v2";
  if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(prefix)) {
    throw new Error(
      `PI_RLM_BENCH_V2_OUTPUT_PREFIX must be a safe file prefix: ${prefix}`,
    );
  }
  return prefix;
}

function createLimits(): PiRlmLimits {
  return {
    maxDepth: 2,
    maxConcurrentModelCalls: 4,
    maxSubcallInputTokens: 8_000,
    timeoutMs: 90_000,
    maxTokens: 20_000,
    maxCostUsd: 0.05,
  };
}

const modelRuntime = await ModelRuntime.create();
const modelSpec = resolveModelSpec();
const model = modelRuntime.getModel(modelSpec.provider, modelSpec.modelId);
if (!model) {
  throw new Error(`Benchmark v2 model is unavailable: ${modelSpec.provider}/${modelSpec.modelId}`);
}
if (!modelRuntime.hasConfiguredAuth(model.provider)) {
  throw new Error(`Benchmark v2 authentication is unavailable: ${model.provider}/${model.id}`);
}

const isolationMode = resolveIsolationMode();
const repeats = resolveRepeats();
const tiers = resolveTiers();
const families = resolveFamilies();
const seeds = resolveSeeds();
const outputPrefix = resolveOutputPrefix();
const limits = createLimits();
const cases = createBenchmarkV2Cases(tiers, seeds).filter((benchmarkCase) =>
  families.includes(benchmarkCase.family),
);
const workspace = await mkdtemp(join(tmpdir(), "pi-rlm-benchmark-v2-"));
const runs: BenchmarkV2Run[] = [];
const outputPath = resolve(process.cwd(), `${outputPrefix}-results.json`);
const runsPath = resolve(process.cwd(), `${outputPrefix}-runs.jsonl`);
await writeFile(runsPath, "", "utf8");

try {
  for (const [caseIndex, benchmarkCase] of cases.entries()) {
    const filePath = join(workspace, benchmarkCase.fileName);
    await writeFile(filePath, benchmarkCase.content, "utf8");

    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const harnessOrder =
        (caseIndex + repeat) % 2 === 0 ? HARNESSES : [...HARNESSES].reverse();
      for (const harness of harnessOrder) {
        console.log(
          JSON.stringify({
            status: "starting",
            caseId: benchmarkCase.id,
            family: benchmarkCase.family,
            tier: benchmarkCase.tier,
            seed: benchmarkCase.seed,
            harness,
            repeat,
            repeats,
          }),
        );

        const observation =
          harness === "direct-pi-standard"
            ? await observeHarness(
                benchmarkCase.expected,
                isExactBenchmarkV2Answer,
                () =>
                  runDirectPi({
                    model,
                    modelRuntime,
                    cwd: workspace,
                    fileName: basename(filePath),
                    question: benchmarkCase.question,
                    limits,
                    profile: "standard",
                  }),
              )
            : await observeHarness(
                benchmarkCase.expected,
                isExactBenchmarkV2Answer,
                async () => {
                  const rawContext = await readFile(filePath, "utf8");
                  const result = await new PiRlmRunner(model, {
                    cwd: workspace,
                    modelRuntime,
                    limits,
                    isolation: { mode: isolationMode },
                  }).run(rawContext, benchmarkCase.question, {
                    validateAnswer: createExactAnswerValidator(
                      benchmarkCase.expected,
                      isExactBenchmarkV2Answer,
                    ),
                  });
                  return {
                    answer: result.response.trim(),
                    usage: result.usage,
                    executionCount: result.executionCount,
                    answerRejections: result.answerRejections,
                  };
                },
              );

        const failureClass = observation.correct
          ? undefined
          : observation.error
            ? classifyBenchmarkV2Failure(observation.error)
            : "answer-contract";
        const run: BenchmarkV2Run = {
          caseId: benchmarkCase.id,
          family: benchmarkCase.family,
          tier: benchmarkCase.tier,
          seed: benchmarkCase.seed,
          harness,
          repeat,
          answer: observation.answer,
          error: observation.error,
          failureClass,
          correct: observation.correct,
          durationMs: observation.durationMs,
          usage: observation.usage,
          executionCount: observation.executionCount,
          answerRejections: observation.answerRejections,
        };
        runs.push(run);
        await appendFile(runsPath, `${JSON.stringify(run)}\n`, "utf8");
        console.log(JSON.stringify({ status: "run-complete", ...run }));
      }
    }

    await rm(filePath, { force: true });
  }

  const report: BenchmarkV2Report = {
    version: 2,
    timestamp: new Date().toISOString(),
    model: `${model.provider}/${model.id}`,
    isolationMode,
    repeats,
    tiers,
    families,
    seeds,
    limits,
    semantics:
      "Matched model, question, context bytes, limits, and thinking=off. Direct Pi uses its standard read/grep/bash tools; Pi-RLM uses external REPL context and recursive model calls. Harness order alternates by case and repeat.",
    directPiProfile: {
      name: "standard",
      tools: ["read", "grep", "bash"],
    },
    cases: cases.map((benchmarkCase) => ({
      id: benchmarkCase.id,
      family: benchmarkCase.family,
      tier: benchmarkCase.tier,
      seed: benchmarkCase.seed,
      fileName: benchmarkCase.fileName,
      contextCharacters: benchmarkCase.contextCharacters,
      estimatedContextTokens: benchmarkCase.estimatedContextTokens,
      expected: benchmarkCase.expected,
    })),
    runs,
    summaries: summarizeBenchmarkV2Runs(runs),
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify({
      status: "complete",
      outputPath,
      runsPath,
      cases: cases.length,
      runs: runs.length,
    }),
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
