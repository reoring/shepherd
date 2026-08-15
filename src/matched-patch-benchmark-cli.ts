#!/usr/bin/env node
import {
  createCoreMatchedPatchCases,
  createSeededMatchedPatchCase,
  runMatchedPatchBenchmark,
  seededDefinitionFromEnvironment,
} from "./matched-patch-benchmark.ts";

function repeatCount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error("PI_RLM_MATCHED_REPEATS must be a positive integer");
  }
  return Number(value);
}

const seeded = seededDefinitionFromEnvironment();
const report = await runMatchedPatchBenchmark({
  packageRoot: process.cwd(),
  modelSpec: process.env.PI_RLM_MATCHED_MODEL,
  repeats: repeatCount(process.env.PI_RLM_MATCHED_REPEATS),
  outputPrefix: process.env.PI_RLM_MATCHED_OUTPUT_PREFIX,
  cases: seeded
    ? [...createCoreMatchedPatchCases(), createSeededMatchedPatchCase(seeded)]
    : createCoreMatchedPatchCases(),
});

process.exitCode = report.accepted ? 0 : 1;
