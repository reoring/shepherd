import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type {
  HarnessSnapshotEntry,
  HarnessSourceCapture,
  HarnessSourceIdentity,
} from "./harness-provenance.ts";
import type { FileIndexedContext } from "./file-context.ts";
import type { PiRlmFailureTrace } from "./runner.ts";

const GIT_COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface PatchPocFailureArtifact {
  failureClass: string;
  failureDigest?: string;
}

export interface PatchPocPlannerTelemetry {
  executionCount: number;
  planSubmissionAttempts: number;
  planSubmissionRejections: number;
  toolTrace: SanitizedPiRlmFailureTrace["patchTools"];
  rejectionClass?: string;
  rejectionDigest?: string;
}

export type PatchPhaseCScenario =
  | "registration-insertion"
  | "two-file-wiring"
  | "seeded-repository-repair";

export interface PatchPhaseCMachineTarget {
  id: string;
  path: string;
  operation: "replace-range" | "insert-before" | "insert-after";
  startLine: number;
  endLine: number;
  replacementConstraint?: {
    description: string;
    digest: string;
  };
}

export interface PatchPhaseCMachineRun {
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
  observedEvidenceIds: string[];
  oracleMatched?: boolean;
  failureCode?: string;
  rejectionClass?: string;
  rejectionDigest?: string;
}

export interface PatchPhaseCMachineArtifact {
  schemaVersion: 1;
  phase: "C";
  scenario: PatchPhaseCScenario;
  generatedAt: string;
  model: string;
  thinking: "off";
  isolation: "docker";
  repeats: number;
  fixture: {
    sourceRevision: string;
    question: string;
    patchPlanningMode: "native-edits";
    nativeEdits: PatchPhaseCMachineTarget[];
  };
  artifacts: { outputPath: string; runsPath: string };
  harnessSource: HarnessSourceIdentity;
  finalHarnessSource: HarnessSourceIdentity;
  provenanceComplete: boolean;
  provenanceStable: boolean;
  acceptance: {
    acceptedCorrect: number;
    falseSuccesses: number;
    immutableOriginals: number;
    oracleMatches?: number;
    requiredAcceptedCorrect: number;
    provenanceComplete: boolean;
  };
  accepted: boolean;
}

/** JSON-Schema-shaped contracts for consumers that cannot load TypeScript types. */
export const PATCH_PHASE_C_RUN_SCHEMA = Object.freeze({
  type: "object",
  required: [
    "repeat",
    "sourceRevision",
    "state",
    "accepted",
    "correct",
    "falseSuccess",
    "originalCheckoutUnchanged",
    "durationMs",
    "executionCount",
    "planSubmissionAttempts",
    "planSubmissionRejections",
    "toolTrace",
    "observedEvidenceIds",
  ],
  properties: {
    repeat: { type: "integer", minimum: 1 },
    sourceRevision: { type: "string" },
    state: { type: "string" },
    accepted: { type: "boolean" },
    correct: { type: "boolean" },
    falseSuccess: { type: "boolean" },
    originalCheckoutUnchanged: { type: "boolean" },
    durationMs: { type: "number", minimum: 0 },
    executionCount: { type: "integer", minimum: 0 },
    planSubmissionAttempts: { type: "integer", minimum: 0 },
    planSubmissionRejections: { type: "integer", minimum: 0 },
    toolTrace: { type: "array" },
    observedEvidenceIds: { type: "array", items: { type: "string" } },
    oracleMatched: { type: "boolean" },
  },
} as const);

export const PATCH_PHASE_C_RESULT_SCHEMA = Object.freeze({
  type: "object",
  required: [
    "schemaVersion",
    "phase",
    "scenario",
    "generatedAt",
    "model",
    "thinking",
    "isolation",
    "repeats",
    "fixture",
    "artifacts",
    "harnessSource",
    "finalHarnessSource",
    "provenanceComplete",
    "provenanceStable",
    "acceptance",
    "accepted",
  ],
  properties: {
    schemaVersion: { const: 1 },
    phase: { const: "C" },
    scenario: {
      enum: ["registration-insertion", "two-file-wiring", "seeded-repository-repair"],
    },
    fixture: {
      type: "object",
      required: ["sourceRevision", "question", "patchPlanningMode", "nativeEdits"],
      properties: {
        nativeEdits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              replacementConstraint: {
                type: "object",
                required: ["description", "digest"],
                properties: {
                  description: { type: "string" },
                  digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
                },
              },
            },
          },
        },
      },
    },
    acceptance: { type: "object" },
  },
} as const);

export interface SanitizedPiRlmFailureTrace {
  executionCount: number;
  answerRejections: number;
  patchPlanRejections: number;
  rejectedAnswers: Array<{
    depth: number;
    candidateDefined: boolean;
    candidateLength: number;
    reasonDigest: string;
  }>;
  corpusCalls: Array<{ depth: number; operation: string }>;
  executions: Array<{
    depth: number;
    execution: number;
    stdoutCharacters: number;
    searchResultCount: number;
    observationCharacters: number;
    compactedToolResults: number;
    corpusHistoryEntries: number;
    corpusCacheHits: number;
    observedEvidenceIds: string[];
    budgetBefore: {
      remainingTokens?: number;
      remainingCostUsd?: number;
      remainingRootTurns?: number;
      maxObservationCharacters: number;
      finalizationReserveTokens: number;
    };
    errorDigest?: string;
    factFinalizationBlocked: boolean;
    patchSubmitAttempts?: number;
    patchSubmitRejections?: number;
    patchSubmitAttemptDelta?: number;
    patchSubmitRejectionDelta?: number;
  }>;
  patchTools: Array<{
    tool:
      | "prepare_patch_replace"
      | "submit_patch_replacement"
      | "prepare_native_edits"
      | "submit_native_edits";
    status: "prepared" | "submitted" | "rejected";
    startLine?: number;
    endLine?: number;
    currentTextCharacters?: number;
    targets?: Array<{
      id: string;
      path: string;
      operation: "replace-range" | "insert-before" | "insert-after";
      startLine: number;
      endLine: number;
      evidenceId?: string;
      currentTextCharacters?: number;
    }>;
    reasonDigest?: string;
  }>;
  providerCalls: Array<{
    id: number;
    estimatedInputTokens: number;
    reservedOutputTokens: number;
    reservedTokens: number;
    usesFinalizationReserve: boolean;
    remainingTokensBefore?: number;
    remainingTokensAfter?: number;
    remainingCostAfterUsd?: number;
    remainingCostBeforeUsd?: number;
    dispatched: boolean;
    actualTokens?: number;
    actualCostUsd?: number;
    rejectionReasonDigest?: string;
  }>;
  facts: {
    contractPresent: boolean;
    eventCount: number;
    extractionCount: number;
    groundedFactCount: number;
    pendingFactCount: number;
    finalizationBlocks: number;
    progressBlocks: number;
    actionBlocks: number;
    runtimeFinalizations: number;
  };
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function errorText(error: unknown): string {
  try {
    if (error instanceof Error) return error.message;
    return String(error);
  } catch {
    return "unavailable-error-detail";
  }
}

function numberOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function optionalNumber(value: number | undefined): number | undefined {
  return value === undefined ? undefined : numberOrZero(value);
}

/** A dirty harness is reproducible only when its complete snapshot is retained. */
export function isCompleteHarnessProvenance(identity: HarnessSourceIdentity): boolean {
  return (
    GIT_COMMIT_PATTERN.test(identity.gitCommit) &&
    SHA256_PATTERN.test(identity.manifestSha256) &&
    SHA256_PATTERN.test(identity.packageLockSha256) &&
    SHA256_PATTERN.test(identity.snapshotSha256) &&
    (!identity.dirty || (identity.snapshotFile?.length ?? 0) > 0)
  );
}

/** Compares every captured harness input, not only its convenient summary hash. */
export function hasStableHarnessProvenance(
  initial: HarnessSourceCapture,
  current: HarnessSourceCapture,
): boolean {
  return (
    initial.identity.gitCommit === current.identity.gitCommit &&
    initial.identity.dirty === current.identity.dirty &&
    initial.identity.manifestSha256 === current.identity.manifestSha256 &&
    initial.identity.packageLockSha256 === current.identity.packageLockSha256 &&
    initial.identity.snapshotSha256 === current.identity.snapshotSha256 &&
    initial.identity.snapshotFile === current.identity.snapshotFile &&
    JSON.stringify(initial.manifest) === JSON.stringify(current.manifest) &&
    JSON.stringify(initial.snapshot) === JSON.stringify(current.snapshot)
  );
}

const GIT_INSPECTION_TIMEOUT_MS = 5_000;
const GIT_INSPECTION_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

export interface OriginalCheckoutState {
  head: string;
  contentFingerprint: string;
  trackedManifestSha256: string;
  clean: boolean;
}

function contextFingerprint(context: FileIndexedContext): string {
  const digest = createHash("sha256");
  for (const file of context.files) {
    digest.update(file.path, "utf8");
    digest.update("\0", "utf8");
    digest.update(context.read(file.path), "utf8");
    digest.update("\0", "utf8");
  }
  return digest.digest("hex");
}

function runBoundedGit(cwd: string, args: readonly string[]): Promise<Buffer> {
  const { promise, resolve: resolveResult, reject } = Promise.withResolvers<Buffer>();
  execFile(
    "git",
    [...args],
    {
      cwd,
      encoding: "buffer",
      maxBuffer: GIT_INSPECTION_OUTPUT_LIMIT_BYTES,
      timeout: GIT_INSPECTION_TIMEOUT_MS,
      windowsHide: true,
    },
    (error, stdout) => {
      if (error) {
        reject(new Error("Could not inspect the original checkout"));
        return;
      }
      resolveResult(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, "utf8"));
    },
  );
  return promise;
}

/**
 * Captures every Git state that can make the original fixture non-pristine:
 * HEAD, selected source content, index modes/blob IDs, and all worktree paths.
 */
export async function captureOriginalCheckoutState(
  root: string,
  context: FileIndexedContext,
): Promise<OriginalCheckoutState> {
  const [head, status, trackedManifest] = await Promise.all([
    runBoundedGit(root, ["rev-parse", "HEAD"]),
    runBoundedGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    runBoundedGit(root, ["ls-files", "--stage", "-z"]),
  ]);
  return {
    head: head.toString("utf8").trim(),
    contentFingerprint: contextFingerprint(context),
    trackedManifestSha256: createHash("sha256").update(trackedManifest).digest("hex"),
    clean: status.length === 0,
  };
}

export function isOriginalCheckoutUnchanged(
  initial: OriginalCheckoutState,
  current: OriginalCheckoutState,
): boolean {
  return (
    initial.clean &&
    current.clean &&
    initial.head === current.head &&
    initial.contentFingerprint === current.contentFingerprint &&
    initial.trackedManifestSha256 === current.trackedManifestSha256
  );
}

function isCanonicalPackageRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    return false;
  }
  return path.split("/").every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isValidSnapshotEntry(value: unknown): value is HarnessSnapshotEntry {
  if (!isExactObject(value, ["path", "bytes", "sha256", "content"])) return false;
  const { path, bytes, sha256, content } = value;
  return (
    typeof path === "string" &&
    isCanonicalPackageRelativePath(path) &&
    typeof bytes === "number" &&
    Number.isSafeInteger(bytes) &&
    bytes >= 0 &&
    typeof sha256 === "string" &&
    SHA256_PATTERN.test(sha256) &&
    typeof content === "string" &&
    Buffer.byteLength(content, "utf8") === bytes &&
    createHash("sha256").update(content, "utf8").digest("hex") === sha256
  );
}

/**
 * A dirty harness snapshot is an artifact capability, not a filename claim.
 * It must remain a regular file under the package root and match the exact
 * source snapshot hash without exposing captured source in diagnostics.
 */
export async function hasExactDirtyHarnessSnapshot(
  packageRoot: string,
  identity: HarnessSourceIdentity,
): Promise<boolean> {
  if (!identity.dirty) return true;
  if (
    !SHA256_PATTERN.test(identity.snapshotSha256) ||
    !isCanonicalPackageRelativePath(identity.snapshotFile ?? "")
  ) {
    return false;
  }
  try {
    const root = await realpath(packageRoot);
    const snapshotPath = resolve(root, identity.snapshotFile!);
    const info = await lstat(snapshotPath);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    const resolvedSnapshotPath = await realpath(snapshotPath);
    const pathWithinRoot = relative(root, resolvedSnapshotPath);
    if (
      pathWithinRoot.length === 0 ||
      pathWithinRoot === ".." ||
      pathWithinRoot.startsWith("../") ||
      isAbsolute(pathWithinRoot)
    ) {
      return false;
    }
    const parsed: unknown = JSON.parse(await readFile(resolvedSnapshotPath, "utf8"));
    if (!isExactObject(parsed, ["version", "files"]) || parsed.version !== 1) return false;
    if (!Array.isArray(parsed.files) || !parsed.files.every(isValidSnapshotEntry)) return false;
    return (
      createHash("sha256").update(JSON.stringify(parsed.files), "utf8").digest("hex") ===
      identity.snapshotSha256
    );
  } catch {
    return false;
  }
}

/**
 * Copies only aggregation-safe counters and hashes every trace string that can
 * carry an error. The returned object shares no mutable trace structures.
 */
export function sanitizePiRlmFailureTrace(
  trace: PiRlmFailureTrace,
): SanitizedPiRlmFailureTrace {
  return {
    executionCount: numberOrZero(trace.executionCount),
    answerRejections: numberOrZero(trace.answerRejections),
    patchPlanRejections: numberOrZero(trace.patchPlanRejections),
    rejectedAnswers: trace.rejectedAnswers.map((rejection) => ({
      depth: numberOrZero(rejection.depth),
      candidateDefined: rejection.candidateDefined === true,
      candidateLength: numberOrZero(rejection.candidateLength),
      reasonDigest: digestText(rejection.reason),
    })),
    corpusCalls: trace.corpusCalls.map((call) => ({
      depth: numberOrZero(call.depth),
      operation: call.request.operation,
    })),
    executions: trace.executions.map((execution) => ({
      depth: numberOrZero(execution.depth),
      execution: numberOrZero(execution.execution),
      stdoutCharacters: numberOrZero(execution.stdoutCharacters),
      searchResultCount: numberOrZero(execution.searchResultCount),
      observationCharacters: numberOrZero(execution.observationCharacters),
      compactedToolResults: numberOrZero(execution.compactedToolResults),
      corpusHistoryEntries: numberOrZero(execution.corpusHistoryEntries),
      corpusCacheHits: numberOrZero(execution.corpusCacheHits),
      observedEvidenceIds: [...execution.observedEvidenceIds],
      budgetBefore: {
        remainingTokens: optionalNumber(execution.budgetBefore.remainingTokens),
        remainingCostUsd: optionalNumber(execution.budgetBefore.remainingCostUsd),
        remainingRootTurns: optionalNumber(execution.budgetBefore.remainingRootTurns),
        maxObservationCharacters: numberOrZero(execution.budgetBefore.maxObservationCharacters),
        finalizationReserveTokens: numberOrZero(execution.budgetBefore.finalizationReserveTokens),
      },
      ...(execution.error !== undefined
        ? { errorDigest: digestText(execution.error) }
        : {}),
      factFinalizationBlocked: execution.factFinalizationBlocked === true,
      ...(execution.patchSubmitAttempts !== undefined
        ? { patchSubmitAttempts: numberOrZero(execution.patchSubmitAttempts) }
        : {}),
      ...(execution.patchSubmitRejections !== undefined
        ? { patchSubmitRejections: numberOrZero(execution.patchSubmitRejections) }
        : {}),
      ...(execution.patchSubmitAttemptDelta !== undefined
        ? { patchSubmitAttemptDelta: numberOrZero(execution.patchSubmitAttemptDelta) }
        : {}),
      ...(execution.patchSubmitRejectionDelta !== undefined
        ? { patchSubmitRejectionDelta: numberOrZero(execution.patchSubmitRejectionDelta) }
        : {}),
    })),
    patchTools: (trace.patchTools ?? []).map((tool) => ({
      tool: tool.tool,
      status: tool.status,
      ...(tool.startLine !== undefined ? { startLine: numberOrZero(tool.startLine) } : {}),
      ...(tool.endLine !== undefined ? { endLine: numberOrZero(tool.endLine) } : {}),
      ...(tool.currentTextCharacters !== undefined
        ? { currentTextCharacters: numberOrZero(tool.currentTextCharacters) }
        : {}),
      ...(tool.targets
        ? {
            targets: tool.targets.map((target) => ({
              id: `${target.id}`,
              path: `${target.path}`,
              operation: target.operation,
              startLine: numberOrZero(target.startLine),
              endLine: numberOrZero(target.endLine),
              ...(target.evidenceId !== undefined ? { evidenceId: `${target.evidenceId}` } : {}),
              ...(target.currentTextCharacters !== undefined
                ? { currentTextCharacters: numberOrZero(target.currentTextCharacters) }
                : {}),
            })),
          }
        : {}),
      ...(tool.reason !== undefined ? { reasonDigest: digestText(tool.reason) } : {}),
    })),
    providerCalls: trace.providerCalls.map((call) => ({
      id: numberOrZero(call.id),
      estimatedInputTokens: numberOrZero(call.estimatedInputTokens),
      reservedOutputTokens: numberOrZero(call.reservedOutputTokens),
      reservedTokens: numberOrZero(call.reservedTokens),
      usesFinalizationReserve: call.usesFinalizationReserve === true,
      remainingTokensBefore: optionalNumber(call.remainingTokensBefore),
      remainingTokensAfter: optionalNumber(call.remainingTokensAfter),
      remainingCostAfterUsd: optionalNumber(call.remainingCostAfterUsd),
      remainingCostBeforeUsd: optionalNumber(call.remainingCostBeforeUsd),
      dispatched: call.dispatched === true,
      actualTokens: optionalNumber(call.actualTokens),
      actualCostUsd: optionalNumber(call.actualCostUsd),
      ...(call.rejectionReason !== undefined
        ? { rejectionReasonDigest: digestText(call.rejectionReason) }
        : {}),
    })),
    facts: {
      contractPresent: trace.facts.contractPresent === true,
      eventCount: trace.facts.events.length,
      extractionCount: trace.facts.extractions.length,
      groundedFactCount: trace.facts.finalState?.facts.filter((fact) => fact.status === "grounded").length ?? 0,
      pendingFactCount: trace.facts.finalState?.pendingFactIds.length ?? 0,
      finalizationBlocks: numberOrZero(trace.facts.finalizationBlocks),
      progressBlocks: numberOrZero(trace.facts.progressBlocks),
      actionBlocks: numberOrZero(trace.facts.actionBlocks),
      runtimeFinalizations: numberOrZero(trace.facts.runtimeFinalizations),
    },
  };
}

/** Builds JSONL-safe root retry counters from a sanitized planner trace. */
export function summarizePatchPocPlannerTelemetry(
  trace: SanitizedPiRlmFailureTrace | undefined,
  failure: PatchPocFailureArtifact | undefined,
  rootExecutionCount?: number,
): PatchPocPlannerTelemetry {
  const rootExecution = trace?.executions
    .filter((execution) => execution.depth === 0)
    .at(-1);
  const nativeSubmissions = trace?.patchTools.filter(
    (tool) =>
      tool.tool === "submit_patch_replacement" ||
      tool.tool === "submit_native_edits",
  ) ?? [];
  return {
    executionCount: rootExecutionCount ?? trace?.executionCount ?? 0,
    planSubmissionAttempts:
      nativeSubmissions.length > 0
        ? nativeSubmissions.length
        : rootExecution?.patchSubmitAttempts ?? 0,
    planSubmissionRejections:
      nativeSubmissions.length > 0
        ? nativeSubmissions.filter((tool) => tool.status === "rejected").length
        : rootExecution?.patchSubmitRejections ?? 0,
    toolTrace: structuredClone(trace?.patchTools ?? []),
    ...(failure
      ? {
          rejectionClass: failure.failureClass,
          ...(failure.failureDigest ? { rejectionDigest: failure.failureDigest } : {}),
        }
      : {}),
  };
}

/**
 * Retain a stable failure class and digest for benchmark aggregation without
 * serializing provider or runtime error text into a benchmark artifact.
 */
export function redactPatchPocFailure(
  state: string,
  failureCode: string | undefined,
  error: unknown,
): PatchPocFailureArtifact {
  const failureClass = failureCode ?? state;
  const text = errorText(error);
  return {
    failureClass,
    ...(text.length > 0 ? { failureDigest: digestText(text) } : {}),
  };
}
