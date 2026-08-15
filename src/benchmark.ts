import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  type HarnessObservation,
  createExactAnswerValidator,
  observeHarness,
  runDirectPi,
} from "./benchmark-harness.ts";
import {
  createMatchedBenchmarkCases,
  isExactBenchmarkAnswer,
} from "./benchmark-cases.ts";
import { PiRlmRunner } from "./runner.ts";
import type { ReplIsolationMode } from "./repl-client.ts";
import type {
  PiRlmLimits,
  PiRlmUsage,
} from "./shared-limits.ts";


interface CaseObservation {
  name: string;
  contextCharacters: number;
  expected: string;
  directPi: HarnessObservation;
  piRlm: HarnessObservation;
}

interface BenchmarkReport {
  timestamp: string;
  model: string;
  isolationMode: ReplIsolationMode;
  limits: PiRlmLimits;
  semantics: string;
  cases: CaseObservation[];
}


function resolveModelSpec(): { provider: string; modelId: string } {
  const spec = process.env.PI_RLM_BENCH_MODEL ?? "openai/gpt-5.6-luna";
  const separator = spec.indexOf("/");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error(`PI_RLM_BENCH_MODEL must be provider/model: ${spec}`);
  }
  return { provider: spec.slice(0, separator), modelId: spec.slice(separator + 1) };
}

function resolveIsolationMode(): ReplIsolationMode {
  const value = process.env.PI_RLM_BENCH_ISOLATION ?? "subprocess";
  if (value !== "subprocess" && value !== "docker") {
    throw new Error(`Unsupported PI_RLM_BENCH_ISOLATION: ${value}`);
  }
  return value;
}


function createLimits(): PiRlmLimits {
  return {
    maxDepth: 2,
    maxConcurrentModelCalls: 4,
    maxSubcallInputTokens: 8_000,
    timeoutMs: 90_000,
    maxTokens: 20_000,
    maxCostUsd: 0.1,
  };
}


const modelRuntime = await ModelRuntime.create();
const modelSpec = resolveModelSpec();
const model = modelRuntime.getModel(modelSpec.provider, modelSpec.modelId);
if (!model) throw new Error(`Benchmark model is unavailable: ${modelSpec.provider}/${modelSpec.modelId}`);
if (!modelRuntime.hasConfiguredAuth(model.provider)) {
  throw new Error(`Benchmark authentication is unavailable: ${model.provider}/${model.id}`);
}

const isolationMode = resolveIsolationMode();
const limits = createLimits();
const workspace = await mkdtemp(join(tmpdir(), "pi-rlm-benchmark-"));
const observations: CaseObservation[] = [];

try {
  for (const benchmarkCase of createMatchedBenchmarkCases()) {
    const filePath = join(workspace, benchmarkCase.fileName);
    await writeFile(filePath, benchmarkCase.content, "utf8");

    console.log(JSON.stringify({ status: "starting", case: benchmarkCase.name, harness: "direct-pi" }));
    const directPi = await observeHarness(
      benchmarkCase.expected,
      isExactBenchmarkAnswer,
      () =>
        runDirectPi({
          model,
          modelRuntime,
          cwd: workspace,
          fileName: basename(filePath),
          question: benchmarkCase.question,
          limits,
          profile: "read-only",
        }),
    );

    console.log(JSON.stringify({ status: "starting", case: benchmarkCase.name, harness: "pi-rlm" }));
    const piRlm = await observeHarness(
      benchmarkCase.expected,
      isExactBenchmarkAnswer,
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
            isExactBenchmarkAnswer,
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

    const observation: CaseObservation = {
      name: benchmarkCase.name,
      contextCharacters: benchmarkCase.content.length,
      expected: benchmarkCase.expected,
      directPi,
      piRlm,
    };
    observations.push(observation);
    console.log(JSON.stringify({ status: "case-complete", ...observation }));
  }

  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    model: `${model.provider}/${model.id}`,
    isolationMode,
    limits,
    semantics:
      "Same model, question, context bytes, limits, and thinking=off. Direct Pi receives the file through its read-only read tool; Pi-RLM receives it as external REPL context.",
    cases: observations,
  };
  const outputPath = resolve(process.cwd(), "benchmark-results.json");
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ status: "complete", outputPath, cases: observations.length }));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
