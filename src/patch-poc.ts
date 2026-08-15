#!/usr/bin/env node
import { appendFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { loadGitDirectoryContext } from "./file-context.ts";
import { captureHarnessSource } from "./harness-provenance.ts";
import {
  captureOriginalCheckoutState,
  hasExactDirtyHarnessSnapshot,
  hasStableHarnessProvenance,
  isCompleteHarnessProvenance,
  isOriginalCheckoutUnchanged,
  redactPatchPocFailure,
  summarizePatchPocPlannerTelemetry,
  type PatchPocPlannerTelemetry,
} from "./patch-poc-artifacts.ts";
import { PatchExecutor, type PatchReceipt } from "./patch-executor.ts";
import { executePatchPlanning } from "./patch-planner.ts";
import {
  createDefaultRepairFixture,
  createDefaultRepairVerificationProfiles,
} from "./patch-planning-fixture.ts";
import { DEFAULT_MUTATION_LIMITS } from "./patch-plan.ts";
import { DEFAULT_RLM_LIMITS } from "./rlm-defaults.ts";
import { PiRlmRunner, type PatchPlanningMode } from "./runner.ts";
import type { PiRlmUsage } from "./shared-limits.ts";

const DEFAULT_REPEATS = 5;
const DEFAULT_MODEL = "openai/gpt-5.6-luna";
const PATCH_POC_PLANNING_MODE = "native-replacement" satisfies PatchPlanningMode;

interface PatchPocRun {
  repeat: number;
  sourceRevision: string;
  state: string;
  accepted: boolean;
  correct: boolean;
  falseSuccess: boolean;
  originalCheckoutUnchanged: boolean;
  durationMs: number;
  executionCount: number;
  planSubmissionAttempts: number;
  planSubmissionRejections: number;
  toolTrace: PatchPocPlannerTelemetry["toolTrace"];
  usage?: PiRlmUsage;
  observedEvidenceIds: string[];
  receipt?: PatchReceipt;
  failureCode?: string;
  rejectionClass?: string;
  rejectionDigest?: string;
}

function modelParts(spec: string): { provider: string; modelId: string } {
  const separator = spec.indexOf("/");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error(`PI_RLM_PATCH_MODEL must be provider/model: ${spec}`);
  }
  return { provider: spec.slice(0, separator), modelId: spec.slice(separator + 1) };
}

function outputPrefix(): string {
  const value = process.env.PI_RLM_PATCH_OUTPUT_PREFIX ?? "patch-poc-luna";
  if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(value)) {
    throw new Error(`PI_RLM_PATCH_OUTPUT_PREFIX is invalid: ${value}`);
  }
  return value;
}

function repeatCount(): number {
  const value = process.env.PI_RLM_PATCH_REPEATS;
  if (value === undefined) return DEFAULT_REPEATS;
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(`PI_RLM_PATCH_REPEATS must be an integer from 1 to ${DEFAULT_REPEATS}`);
  }
  const repeats = Number(value);
  if (!Number.isSafeInteger(repeats) || repeats > DEFAULT_REPEATS) {
    throw new Error(`PI_RLM_PATCH_REPEATS must be an integer from 1 to ${DEFAULT_REPEATS}`);
  }
  return repeats;
}



function observedEvidenceIds(
  trace: {
    executions: readonly { depth: number; observedEvidenceIds: readonly string[] }[];
  },
  plan?: { edits: readonly { evidenceId: string }[] },
): string[] {
  return [
    ...new Set([
      ...trace.executions
        .filter((execution) => execution.depth === 0)
        .flatMap((execution) => execution.observedEvidenceIds),
      ...(plan?.edits.map((edit) => edit.evidenceId) ?? []),
    ]),
  ].sort();
}


const packageRoot = process.cwd();
const prefix = outputPrefix();
const outputPath = resolve(packageRoot, `${prefix}-results.json`);
const runsPath = resolve(packageRoot, `${prefix}-runs.jsonl`);
const modelSpec = process.env.PI_RLM_PATCH_MODEL ?? DEFAULT_MODEL;
const repeats = repeatCount();
const fixture = await createDefaultRepairFixture();
const originalCheckout = await captureOriginalCheckoutState(fixture.root, fixture.context);
const fixtureRevision = originalCheckout.head;
const profiles = createDefaultRepairVerificationProfiles();
const mutationLimits = { ...DEFAULT_MUTATION_LIMITS };
const runs: PatchPocRun[] = [];
const harnessCapture = await captureHarnessSource(packageRoot);
const harnessSnapshotPath = resolve(packageRoot, `${prefix}-harness-source.json`);
if (harnessCapture.identity.dirty) {
  harnessCapture.identity.snapshotFile = basename(harnessSnapshotPath);
  await writeFile(
    harnessSnapshotPath,
    `${JSON.stringify({ version: 1, files: harnessCapture.snapshot }, null, 2)}\n`,
    "utf8",
  );
}
const initialProvenanceComplete = isCompleteHarnessProvenance(harnessCapture.identity);
const initialSnapshotVerified = await hasExactDirtyHarnessSnapshot(
  packageRoot,
  harnessCapture.identity,
);

await writeFile(runsPath, "", "utf8");
try {
  const modelRuntime = await ModelRuntime.create();
  const { provider, modelId } = modelParts(modelSpec);
  const model = modelRuntime.getModel(provider, modelId);
  if (!model) throw new Error(`Patch PoC model is unavailable: ${modelSpec}`);
  if (!modelRuntime.hasConfiguredAuth(model.provider)) {
    throw new Error(`Patch PoC authentication is unavailable for ${model.provider}/${model.id}`);
  }

  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const startedAt = performance.now();
    const runner = new PiRlmRunner(model, {
      cwd: packageRoot,
      modelRuntime,
      limits: { ...DEFAULT_RLM_LIMITS },
      isolation: { mode: "docker" },
    });
    const executor = PatchExecutor.createRoot(profiles);
    const result = await executePatchPlanning({
      runner,
      executor,
      context: fixture.context,
      question: fixture.question,
      verificationProfile: fixture.verificationProfile,
      limits: mutationLimits,
      patchPlanningMode: PATCH_POC_PLANNING_MODE,
      nativeReplacementTarget: fixture.nativeReplacementTarget,
    });
    const afterContext = await loadGitDirectoryContext(fixture.root);
    const afterCheckout = await captureOriginalCheckoutState(fixture.root, afterContext);
    const originalCheckoutUnchanged = isOriginalCheckoutUnchanged(
      originalCheckout,
      afterCheckout,
    );
    const checksPassed = result.receipt?.checks.every((check) => check.status === "passed") ?? false;
    const correct = result.state === "ACCEPTED" && checksPassed && originalCheckoutUnchanged;
    const failureArtifact = result.accepted
      ? undefined
      : result.trace.failureClass && result.trace.failureDigest
        ? {
            failureClass: result.trace.failureClass,
            failureDigest: result.trace.failureDigest,
          }
        : redactPatchPocFailure(
            result.state,
            result.receipt?.failureCode,
            result.receipt?.failureCode ?? result.state,
          );
    const plannerTrace = result.trace.plannerTrace;
    const plannerTelemetry = summarizePatchPocPlannerTelemetry(
      plannerTrace,
      failureArtifact,
      result.planning?.executionCount,
    );
    const run: PatchPocRun = {
      repeat,
      sourceRevision: fixtureRevision,
      state: result.state,
      accepted: result.accepted,
      correct,
      falseSuccess: result.accepted && !correct,
      originalCheckoutUnchanged,
      durationMs: performance.now() - startedAt,
      ...plannerTelemetry,
      ...(result.usage ? { usage: result.usage } : {}),
      observedEvidenceIds: observedEvidenceIds(
        plannerTrace ?? { executions: [] },
        result.plan,
      ),
      ...(result.receipt ? { receipt: result.receipt } : {}),
      ...(result.receipt?.failureCode
        ? { failureCode: result.receipt.failureCode }
        : {}),
    };
    runs.push(run);
    await appendFile(runsPath, `${JSON.stringify(run)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      status: "run-complete",
      repeat,
      state: run.state,
      correct: run.correct,
      falseSuccess: run.falseSuccess,
      durationMs: Math.round(run.durationMs),
      modelCalls: run.usage?.modelCalls ?? 0,
      totalTokens: run.usage?.totalTokens ?? 0,
      costUsd: run.usage?.costUsd ?? 0,
    })}\n`);
  }

  const acceptedCorrect = runs.filter((run) => run.correct).length;
  const falseSuccesses = runs.filter((run) => run.falseSuccess).length;
  const immutableOriginals = runs.filter((run) => run.originalCheckoutUnchanged).length;
  const finalHarnessCapture = await captureHarnessSource(packageRoot);
  if (finalHarnessCapture.identity.dirty) {
    finalHarnessCapture.identity.snapshotFile = harnessCapture.identity.snapshotFile;
  }
  const finalProvenanceComplete = isCompleteHarnessProvenance(finalHarnessCapture.identity);
  const finalSnapshotVerified = await hasExactDirtyHarnessSnapshot(
    packageRoot,
    finalHarnessCapture.identity,
  );
  const provenanceStable = hasStableHarnessProvenance(harnessCapture, finalHarnessCapture);
  const provenanceComplete =
    initialProvenanceComplete &&
    finalProvenanceComplete &&
    initialSnapshotVerified &&
    finalSnapshotVerified &&
    provenanceStable;
  const accepted =
    acceptedCorrect === DEFAULT_REPEATS &&
    falseSuccesses === 0 &&
    immutableOriginals === DEFAULT_REPEATS;
  const gateAccepted = accepted && provenanceComplete;
  const report = {
    phase: "B",
    generatedAt: new Date().toISOString(),
    model: `${model.provider}/${model.id}`,
    thinking: "off",
    isolation: "docker",
    repeats,
    fixture: {
      sourceRevision: fixtureRevision,
      question: fixture.question,
      mutationLimits,
      rlmLimits: DEFAULT_RLM_LIMITS,
      patchPlanningMode: PATCH_POC_PLANNING_MODE,
      nativeReplacementTarget: fixture.nativeReplacementTarget,
    },
    harnessSource: harnessCapture.identity,
    finalHarnessSource: finalHarnessCapture.identity,
    provenanceComplete,
    provenanceStable,
    initialSnapshotVerified,
    finalSnapshotVerified,
    artifacts: { outputPath, runsPath },
    acceptance: {
      acceptedCorrect,
      falseSuccesses,
      immutableOriginals,
      requiredAcceptedCorrect: DEFAULT_REPEATS,
      initialProvenanceComplete,
      finalProvenanceComplete,
      provenanceStable,
      initialSnapshotVerified,
      finalSnapshotVerified,
      provenanceComplete,
    },
    accepted: gateAccepted,
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: "complete", accepted: gateAccepted, outputPath, runsPath })}\n`);
  process.exitCode = gateAccepted ? 0 : 1;
} finally {
  await fixture.cleanup();
}
