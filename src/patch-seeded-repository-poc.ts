#!/usr/bin/env node
import {
  createSeededRepairFixture,
  createSeededRepairVerificationProfiles,
} from "./seeded-repair-harness.ts";
import type { SeededRepairDefinition } from "./seeded-repair-harness.ts";
import { runPhaseCNativeEditsPoc } from "./patch-phase-c-runner.ts";
import { DEFAULT_MUTATION_LIMITS } from "./patch-plan.ts";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function lineEnvironment(name: string): number {
  const value = requiredEnvironment(name);
  if (!/^[1-9]\d*$/u.test(value)) throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

const sourcePath = requiredEnvironment("PI_RLM_SEEDED_SOURCE_PATH");
const definition: SeededRepairDefinition = {
  sourceRoot: requiredEnvironment("PI_RLM_SEEDED_SOURCE_ROOT"),
  sourcePath,
  target: {
    id: "seeded-repair",
    path: sourcePath,
    operation: "replace-range",
    startLine: lineEnvironment("PI_RLM_SEEDED_START_LINE"),
    endLine: lineEnvironment("PI_RLM_SEEDED_END_LINE"),
  },
  seededReplacement: requiredEnvironment("PI_RLM_SEEDED_FAULT_REPLACEMENT"),
  question: process.env.PI_RLM_SEEDED_QUESTION ?? "Restore the selected source range to its correct implementation.",
};

await runPhaseCNativeEditsPoc({
  scenario: "seeded-repository-repair",
  defaultOutputPrefix: "patch-poc-seeded-repository-repair",
  createFixture: () => createSeededRepairFixture(definition),
  createProfiles: (fixture) => createSeededRepairVerificationProfiles(fixture.oracleSha256),
  mutationLimits: (fixture) => ({
    ...DEFAULT_MUTATION_LIMITS,
    allowedPathPrefixes: [fixture.nativeEdits[0]!.path],
    maxChangedFiles: 1,
    maxEdits: 1,
  }),
  validateCandidate: (fixture, result) => fixture.isRepairedToOracle(result.execution?.postContext),
  assertOriginalUnchanged: (fixture) => fixture.assertOriginalUnchanged(),
});
