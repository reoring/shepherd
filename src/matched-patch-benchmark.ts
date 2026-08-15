import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { type Api, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  createFileIndexedContext,
  createFileIndexedEvidenceSession,
  loadGitDirectoryContext,
  type FileIndexedContext,
} from "./file-context.ts";
import { captureHarnessSource, type HarnessSourceCapture, type HarnessSourceIdentity } from "./harness-provenance.ts";
import { createLimitedModelProvider } from "./limited-provider.ts";
import {
  nativeEditTargetMetadata,
  type NativePatchEditTarget,
  type NativePatchEditTargetMetadata,
} from "./native-edits.ts";
import {
  captureOriginalCheckoutState,
  hasExactDirtyHarnessSnapshot,
  hasStableHarnessProvenance,
  isCompleteHarnessProvenance,
  isOriginalCheckoutUnchanged,
  redactPatchPocFailure,
  type PatchPocFailureArtifact,
  type SanitizedPiRlmFailureTrace,
} from "./patch-poc-artifacts.ts";
import {
  DEFAULT_MUTATION_LIMITS,
  PatchPlanError,
  createRootPatchAuthority,
  generatePatchCandidate,
  hashPatchSpan,
  validatePatchPlan,
  type MutationLimits,
  type PatchFailureCode,
} from "./patch-plan.ts";
import {
  createDefaultRepairFixture,
  createDefaultRepairVerificationProfiles,
} from "./patch-planning-fixture.ts";
import {
  createRegistrationInsertionFixture,
  createRegistrationInsertionVerificationProfiles,
  createTwoFileWiringFixture,
  createTwoFileWiringVerificationProfiles,
} from "./patch-phase-c-fixtures.ts";
import { PatchExecutor } from "./patch-executor.ts";
import { executePatchPlanning } from "./patch-planner.ts";
import {
  PatchVerifier,
  type PatchVerifierOptions,
  type VerificationCheckReceipt,
  type VerificationProfile,
} from "./patch-verifier.ts";
import { DEFAULT_RLM_LIMITS } from "./rlm-defaults.ts";
import { PiRlmRunner } from "./runner.ts";
import {
  createSeededRepairFixture,
  createSeededRepairVerificationProfiles,
  type SeededRepairDefinition,
} from "./seeded-repair-harness.ts";
import {
  SharedRunLimits,
  type PiRlmLimits,
  type PiRlmProviderCallTrace,
  type PiRlmUsage,
} from "./shared-limits.ts";

const DEFAULT_REPEATS = 5;
const MAX_REPEATS = 100;
const DEFAULT_MODEL = "openai/gpt-5.6-luna";
const GIT_TIMEOUT_MS = 10_000;
const GIT_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

const SESSION_SETTINGS = {
  compaction: { enabled: false },
  retry: { enabled: false, maxRetries: 0 },
} as const;

/**
 * Benchmark-specific limits shared by Direct Pi and Pi-RLM. Neither harness
 * receives an unpaired finalization token reserve.
 */
export const MATCHED_BENCHMARK_LIMITS: Readonly<PiRlmLimits> = Object.freeze({
  ...DEFAULT_RLM_LIMITS,
  finalizationReserveTokens: 0,
});

export type MatchedPatchCaseId =
  | "default-replacement"
  | "registration-insertion"
  | "two-file-wiring"
  | "seeded-repository-repair";
export type MatchedPatchHarness = "direct-pi" | "pi-rlm";
export type MatchedPatchSection = "core" | "optional-real-repo";

export interface MatchedPatchSource {
  readonly root: string;
  readonly context: FileIndexedContext;
  readonly question: string;
  readonly verificationProfile: string;
  readonly nativeEdits: readonly NativePatchEditTarget[];
  readonly profiles: readonly VerificationProfile[];
  readonly mutationLimits: MutationLimits;
  readonly sourceRevision: string;
  readonly assertExternalOriginalUnchanged: () => Promise<boolean>;
  readonly oracleMatches?: (candidate: FileIndexedContext | undefined) => boolean;
  cleanup(): Promise<void>;
}

/**
 * A case intentionally carries only task information and host-owned target
 * authority. It contains no expected replacement or model-visible oracle.
 */
export interface MatchedPatchCase {
  readonly id: MatchedPatchCaseId;
  readonly section: MatchedPatchSection;
  readonly createSource: () => Promise<MatchedPatchSource>;
}

export interface FreshMatchedCandidate {
  readonly root: string;
  readonly sourceRevision: string;
  cleanup(): Promise<void>;
}

export type DirectPiRejectionCategory =
  | "scope-policy"
  | "old-text-precondition"
  | "content-precondition"
  | "mutation-shape"
  | "host-failure";

export interface DirectPiToolTrace {
  readonly tool: "read" | "edit" | "write";
  readonly path: string;
  readonly status: "completed" | "rejected";
  readonly bytes?: number;
  readonly rejectionCategory?: DirectPiRejectionCategory;
  readonly reasonDigest?: string;
}

export interface SanitizedDirectPiTrace {
  readonly tools: readonly DirectPiToolTrace[];
  readonly providerCalls: readonly SanitizedProviderCall[];
}

export interface SanitizedProviderCall {
  readonly id: number;
  readonly estimatedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly reservedTokens: number;
  readonly usesFinalizationReserve: boolean;
  readonly dispatched: boolean;
  readonly actualTokens?: number;
  readonly actualCostUsd?: number;
  readonly rejectionReasonDigest?: string;
}

export interface DirectPiMutationResult {
  readonly completed: boolean;
  readonly usage: PiRlmUsage;
  readonly trace: SanitizedDirectPiTrace;
  readonly failure?: PatchPocFailureArtifact;
}

export interface DirectCandidateVerification {
  readonly rejectionCategory?: DirectPiRejectionCategory;
  readonly accepted: boolean;
  readonly scopeViolation: boolean;
  readonly changedPaths: readonly string[];
  readonly checks: readonly VerificationCheckReceipt[];
  readonly postContext?: FileIndexedContext;
  readonly failureCode?: PatchFailureCode;
  readonly failure?: PatchPocFailureArtifact;
}

export interface MatchedPatchRun {
  readonly schemaVersion: 1;
  readonly section: MatchedPatchSection;
  readonly caseId: MatchedPatchCaseId;
  readonly harness: MatchedPatchHarness;
  readonly repeat: number;
  readonly order: number;
  readonly sourceRevision: string;
  readonly sourceFingerprint: string;
  readonly state: string;
  readonly accepted: boolean;
  readonly correct: boolean;
  readonly falseSuccess: boolean;
  readonly scopeViolation: boolean;
  readonly rejectionCategories: readonly DirectPiRejectionCategory[];
  readonly originalUnchanged: boolean;
  readonly durationMs: number;
  readonly usage: PiRlmUsage;
  readonly checks: readonly VerificationCheckReceipt[];
  readonly oracleMatched?: boolean;
  readonly trace: SanitizedDirectPiTrace | SanitizedPiRlmFailureTrace;
  readonly failure?: PatchPocFailureArtifact;
}

export interface MatchedPatchSummary {
  readonly section: MatchedPatchSection;
  readonly caseId: MatchedPatchCaseId;
  readonly harness: MatchedPatchHarness;
  readonly runs: number;
  readonly acceptedCorrect: number;
  readonly acceptedCorrectRate: number;
  readonly falseSuccesses: number;
  readonly scopeViolations: number;
  readonly immutableOriginals: number;
  readonly rejectionCategories: Readonly<Record<DirectPiRejectionCategory, number>>;
  readonly modelCalls: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly meetsAcceptance: boolean;
}

export interface MatchedPatchBenchmarkReport {
  readonly schemaVersion: 1;
  readonly benchmark: "matched-direct-pi-vs-pi-rlm-patch";
  readonly generatedAt: string;
  readonly model: string;
  readonly thinking: "off";
  readonly repeats: number;
  readonly order: "repeat-case-direct-pi-then-pi-rlm";
  readonly limits: PiRlmLimits;
  readonly directPi: {
    readonly tools: readonly ["read", "edit", "write"];
    readonly cwd: "fresh-disposable-worktree";
    readonly shell: false;
    readonly network: false;
  };
  readonly piRlm: {
    readonly patchPlanningMode: "native-edits";
    readonly isolation: "docker";
  };
  readonly caseSources: readonly {
    readonly id: MatchedPatchCaseId;
    readonly section: MatchedPatchSection;
    readonly sourceRevision: string;
    readonly sourceFingerprint: string;
    readonly trackedManifestSha256: string;
    readonly questionSha256: string;
    readonly nativeEdits: readonly NativePatchEditTargetMetadata[];
    readonly mutationLimits: MutationLimits;
  }[];
  readonly artifacts: {
    readonly outputPath: string;
    readonly runsPath: string;
  };
  readonly harnessSource: HarnessSourceIdentity;
  readonly finalHarnessSource: HarnessSourceIdentity;
  readonly provenanceComplete: boolean;
  readonly provenanceStable: boolean;
  readonly acceptance: {
    readonly requiredAcceptedCorrectRate: 1;
    readonly maximumFalseSuccesses: 0;
    readonly requiredImmutableOriginals: number;
    readonly requiredScopeViolations: 0;
  };
  readonly summaries: readonly MatchedPatchSummary[];
  readonly coreAccepted: boolean;
  readonly optionalRealRepoAccepted?: boolean;
  readonly accepted: boolean;
}

export interface RunMatchedPatchBenchmarkOptions {
  readonly packageRoot: string;
  readonly modelRuntime?: ModelRuntime;
  readonly modelSpec?: string;
  readonly repeats?: number;
  readonly outputPrefix?: string;
  readonly cases?: readonly MatchedPatchCase[];
  readonly verification?: PatchVerifierOptions;
}

export interface CandidateScope {
  readonly valid: boolean;
  readonly changedPaths: readonly string[];
  readonly replacements: readonly { target: NativePatchEditTarget; replacement: string }[];
  readonly normalizedDiffHash?: string;
  readonly failureCode?: PatchFailureCode;
}

interface VerificationSnapshot {
  readonly parent: string;
  readonly root: string;
  readonly manifestPath: string;
}

class DirectPiToolRejection extends Error {
  readonly category: DirectPiRejectionCategory;

  constructor(category: DirectPiRejectionCategory, reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = "DirectPiToolRejection";
    this.category = category;
  }
}

function directToolRejectionCategory(error: unknown): DirectPiRejectionCategory {
  return error instanceof DirectPiToolRejection ? error.category : "host-failure";
}

function scopePolicyFailure(code: PatchFailureCode | undefined): boolean {
  return code === "PATH_OUT_OF_SCOPE" ||
    code === "EDIT_OUTSIDE_EVIDENCE" ||
    code === "EDIT_OVERLAP" ||
    code === "AMBIGUOUS_INSERTION";
}

function candidateRejectionCategory(code: PatchFailureCode | undefined): DirectPiRejectionCategory {
  if (scopePolicyFailure(code)) return "scope-policy";
  if (code === "OLD_SOURCE_MISMATCH") return "content-precondition";
  return "mutation-shape";
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceContractFingerprint(
  contentFingerprint: string,
  targets: readonly NativePatchEditTarget[],
): string {
  return sha256(JSON.stringify({
    contentFingerprint,
    nativeEdits: targets.map((target) => nativeEditTargetMetadata(target)),
  }));
}

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { promise, resolve: complete, reject } = Promise.withResolvers<string>();
  execFile(
    "git",
    [...args],
    {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
      windowsHide: true,
    },
    (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args[0] ?? ""} failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`, { cause: error }));
        return;
      }
      complete(stdout);
    },
  );
  return promise;
}

function canonicalPath(path: string): string {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new TypeError("Benchmark path must be a canonical relative path");
  }
  return path;
}

function inside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

/**
 * Resolves an already-canonical fixture path and rejects any lexical escape
 * before the candidate filesystem is read, written, or copied.
 */
function resolveCandidatePath(candidateRoot: string, path: string): string {
  const canonical = canonicalPath(path);
  const root = resolve(candidateRoot);
  const target = resolve(root, canonical);
  if (!inside(root, target)) {
    throw new TypeError("Benchmark candidate path escaped its root");
  }
  return target;
}

function modelParts(spec: string): { provider: string; modelId: string } {
  const separator = spec.indexOf("/");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error("PI_RLM_MATCHED_MODEL must be provider/model");
  }
  return { provider: spec.slice(0, separator), modelId: spec.slice(separator + 1) };
}

function targetMutationLimits(targets: readonly NativePatchEditTarget[]): MutationLimits {
  const paths = [...new Set(targets.map((target) => target.path))];
  return {
    ...DEFAULT_MUTATION_LIMITS,
    maxChangedFiles: paths.length,
    maxEdits: targets.length,
    allowedPathPrefixes: paths,
  };
}

function assertDistinctTargetPaths(targets: readonly NativePatchEditTarget[]): void {
  const paths = targets.map((target) => target.path);
  if (new Set(paths).size !== paths.length) {
    throw new TypeError("Matched benchmark requires one exact target per path");
  }
}

function requiredTarget(target: {
  path: string;
  startLine: number;
  endLine: number;
}): NativePatchEditTarget {
  return Object.freeze({
    id: "replace-default-timeout",
    path: target.path,
    operation: "replace-range",
    startLine: target.startLine,
    endLine: target.endLine,
  });
}

function sourceFromFixture(
  fixture: {
    root: string;
    context: FileIndexedContext;
    question: string;
    verificationProfile: string;
    cleanup(): Promise<void>;
  },
  nativeEdits: readonly NativePatchEditTarget[],
  profiles: readonly VerificationProfile[],
  extra: Pick<MatchedPatchSource, "assertExternalOriginalUnchanged" | "oracleMatches">,
): MatchedPatchSource {
  assertDistinctTargetPaths(nativeEdits);
  return {
    root: fixture.root,
    context: fixture.context,
    question: fixture.question,
    verificationProfile: fixture.verificationProfile,
    nativeEdits,
    profiles,
    mutationLimits: targetMutationLimits(nativeEdits),
    sourceRevision: fixture.context.sourceRevision,
    assertExternalOriginalUnchanged: extra.assertExternalOriginalUnchanged,
    ...(extra.oracleMatches ? { oracleMatches: extra.oracleMatches } : {}),
    cleanup: fixture.cleanup,
  };
}

export function createCoreMatchedPatchCases(): readonly MatchedPatchCase[] {
  return Object.freeze([
    {
      id: "default-replacement",
      section: "core",
      async createSource(): Promise<MatchedPatchSource> {
        const fixture = await createDefaultRepairFixture();
        const target = requiredTarget(fixture.nativeReplacementTarget);
        return sourceFromFixture(
          fixture,
          Object.freeze([target]),
          createDefaultRepairVerificationProfiles(),
          { assertExternalOriginalUnchanged: async () => true },
        );
      },
    },
    {
      id: "registration-insertion",
      section: "core",
      async createSource(): Promise<MatchedPatchSource> {
        const fixture = await createRegistrationInsertionFixture();
        return sourceFromFixture(
          fixture,
          fixture.nativeEdits,
          createRegistrationInsertionVerificationProfiles(),
          { assertExternalOriginalUnchanged: async () => true },
        );
      },
    },
    {
      id: "two-file-wiring",
      section: "core",
      async createSource(): Promise<MatchedPatchSource> {
        const fixture = await createTwoFileWiringFixture();
        return sourceFromFixture(
          fixture,
          fixture.nativeEdits,
          createTwoFileWiringVerificationProfiles(),
          { assertExternalOriginalUnchanged: async () => true },
        );
      },
    },
  ]);
}

export function createSeededMatchedPatchCase(
  definition: SeededRepairDefinition,
): MatchedPatchCase {
  return {
    id: "seeded-repository-repair",
    section: "optional-real-repo",
    async createSource(): Promise<MatchedPatchSource> {
      const fixture = await createSeededRepairFixture(definition);
      return sourceFromFixture(
        fixture,
        fixture.nativeEdits,
        createSeededRepairVerificationProfiles(fixture.oracleSha256),
        {
          assertExternalOriginalUnchanged: fixture.assertOriginalUnchanged,
          oracleMatches: fixture.isRepairedToOracle,
        },
      );
    },
  };
}

export function seededDefinitionFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): SeededRepairDefinition | undefined {
  const sourceRoot = environment.PI_RLM_SEEDED_SOURCE_ROOT;
  const sourcePath = environment.PI_RLM_SEEDED_SOURCE_PATH;
  const startLine = environment.PI_RLM_SEEDED_START_LINE;
  const endLine = environment.PI_RLM_SEEDED_END_LINE;
  const replacement = environment.PI_RLM_SEEDED_FAULT_REPLACEMENT;
  const supplied = [sourceRoot, sourcePath, startLine, endLine, replacement].some(
    (value) => value !== undefined,
  );
  if (!supplied) return undefined;
  if (!sourceRoot || !sourcePath || !startLine || !endLine || replacement === undefined) {
    throw new Error("All PI_RLM_SEEDED_* source and target values are required for the optional real-repo case");
  }
  if (!/^[1-9]\d*$/u.test(startLine) || !/^[1-9]\d*$/u.test(endLine)) {
    throw new Error("PI_RLM_SEEDED_START_LINE and PI_RLM_SEEDED_END_LINE must be positive integers");
  }
  return {
    sourceRoot,
    sourcePath,
    target: {
      id: "seeded-repair",
      path: sourcePath,
      operation: "replace-range",
      startLine: Number(startLine),
      endLine: Number(endLine),
    },
    seededReplacement: replacement,
    question: environment.PI_RLM_SEEDED_QUESTION ?? "Restore the selected source range to its correct implementation.",
  };
}

/** Creates a fresh detached worktree at the source fixture's exact commit. */
export async function createFreshMatchedCandidate(
  source: MatchedPatchSource,
): Promise<FreshMatchedCandidate> {
  const parent = await mkdtemp(join(tmpdir(), "pi-rlm-matched-direct-"));
  const root = join(parent, "candidate");
  try {
    await runGit(source.root, ["worktree", "add", "--detach", root, source.sourceRevision]);
    const revision = (await runGit(root, ["rev-parse", "HEAD"])).trim();
    if (revision !== source.sourceRevision) {
      throw new Error("Fresh candidate did not resolve the source fixture revision");
    }
    return {
      root,
      sourceRevision: revision,
      async cleanup(): Promise<void> {
        let removed = false;
        try {
          await runGit(source.root, ["worktree", "remove", "--force", root]);
          removed = true;
        } finally {
          await rm(parent, { recursive: true, force: true });
        }
        if (!removed) throw new Error("Direct Pi disposable worktree cleanup could not be certified");
      },
    };
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}

function createResourceLoader(systemPrompt: string): ResourceLoader {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export function createDirectPiPrompt(source: Pick<MatchedPatchSource, "question" | "nativeEdits">): string {
  const targets = source.nativeEdits.map((target) => {
    const replacementConstraint = nativeEditTargetMetadata(target).replacementConstraint;
    return `${target.id}: path=${target.path}; operation=${target.operation}; range=${target.startLine}-${target.endLine}${
      replacementConstraint ? `; replacement constraint: ${replacementConstraint.description}` : ""
    }`;
  }).join("\n");
  return [
    "Repair the disposable fixture according to the user question.",
    "You may inspect files with read and mutate only through edit or write.",
    "Do not use a shell, network access, code execution, sub-agents, or any unavailable tool.",
    "The host enforces the target contract. Do not modify files or ranges outside it.",
    "User question:",
    source.question,
    "Exact allowed targets:",
    targets,
    "When finished, respond briefly without reproducing source code.",
  ].join("\n\n");
}

function directSystemPrompt(): string {
  return [
    "You are the Direct Pi baseline in a matched mutation benchmark.",
    "The current directory is a fresh disposable fixture. Use only the host-provided read, edit, and write tools.",
    "read is limited to the disposable fixture. edit and write are limited to the exact target contract in the user prompt.",
    "Shell, grep, bash, network, process execution, external tools, and sub-agents are unavailable.",
    "Verification contracts and host oracles are not readable through the fixture tools.",
    "Do not infer an expected patch from hidden benchmark machinery; implement only the user request from inspected fixture source.",
  ].join(" ");
}

function directToolFailure(
  trace: DirectPiToolTrace[],
  tool: DirectPiToolTrace["tool"],
  error: unknown,
): never {
  const message = error instanceof Error ? error.message : String(error);
  trace.push({
    tool,
    path: "<rejected-path>",
    status: "rejected",
    rejectionCategory: directToolRejectionCategory(error),
    reasonDigest: sha256(message),
  });
  throw new Error("Direct Pi tool request was rejected by the host");
}

function canonicalDirectToolPath(path: string): string {
  try {
    return canonicalPath(path);
  } catch (error) {
    throw new DirectPiToolRejection("scope-policy", error);
  }
}


function baseReadPaths(source: MatchedPatchSource): Set<string> {
  return new Set(
    source.context.files
      .map((file) => file.path)
      .filter((path) => !path.startsWith(".rlm/")),
  );
}

function targetPaths(source: MatchedPatchSource): Set<string> {
  return new Set(source.nativeEdits.map((target) => target.path));
}

async function assertDirectMutationAllowed(
  source: MatchedPatchSource,
  candidateRoot: string,
  path: string,
  next: string,
): Promise<void> {
  const target = resolveCandidatePath(candidateRoot, path);
  const before = await readFile(target, "utf8");
  await writeFile(target, next, "utf8");
  const scope = await inspectCandidateScope(source, candidateRoot);
  if (!scope.valid) {
    await writeFile(target, before, "utf8");
    throw new DirectPiToolRejection(
      candidateRejectionCategory(scope.failureCode),
      scope.failureCode ?? "Direct Pi mutation is outside the exact target contract",
    );
  }
}

function providerTrace(call: PiRlmProviderCallTrace): SanitizedProviderCall {
  return {
    id: call.id,
    estimatedInputTokens: call.estimatedInputTokens,
    reservedOutputTokens: call.reservedOutputTokens,
    reservedTokens: call.reservedTokens,
    usesFinalizationReserve: call.usesFinalizationReserve,
    dispatched: call.dispatched,
    ...(call.actualTokens === undefined ? {} : { actualTokens: call.actualTokens }),
    ...(call.actualCostUsd === undefined ? {} : { actualCostUsd: call.actualCostUsd }),
    ...(call.rejectionReason === undefined
      ? {}
      : { rejectionReasonDigest: sha256(call.rejectionReason) }),
  };
}

export async function runDirectPiMutation(options: {
  readonly source: MatchedPatchSource;
  readonly candidate: FreshMatchedCandidate;
  readonly model: Model<Api>;
  readonly modelRuntime: ModelRuntime;
  readonly limits?: PiRlmLimits;
}): Promise<DirectPiMutationResult> {
  const requestedLimits = options.limits ?? MATCHED_BENCHMARK_LIMITS;
  const limits = new SharedRunLimits({
    ...requestedLimits,
    maxProviderCalls:
      requestedLimits.maxRootTurns ?? MATCHED_BENCHMARK_LIMITS.maxRootTurns,
  });
  const traces: DirectPiToolTrace[] = [];
  const allowedReads = baseReadPaths(options.source);
  const allowedWrites = targetPaths(options.source);
  const providerRegistrationName = `matched-direct-pi-${randomUUID()}`;
  let registered = false;

  const trace = (): SanitizedDirectPiTrace => ({
    tools: structuredClone(traces),
    providerCalls: limits.providerTraces().map(providerTrace),
  });

  try {
    const limited = await createLimitedModelProvider(
      options.modelRuntime,
      options.model,
      providerRegistrationName,
      limits,
    );
    options.modelRuntime.registerNativeProvider(limited.provider);
    registered = true;

    const readTool = defineTool({
      name: "read",
      label: "Read fixture file",
      description: "Read one tracked fixture file by canonical relative path.",
      parameters: Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const path = typeof params.path === "string" ? params.path : "";
        try {
          const canonical = canonicalDirectToolPath(path);
          if (!allowedReads.has(canonical)) {
            throw new DirectPiToolRejection("scope-policy", "Read path is outside the fixture allowlist");
          }
          const content = await readFile(resolveCandidatePath(options.candidate.root, canonical), "utf8");
          traces.push({ tool: "read", path: canonical, status: "completed", bytes: Buffer.byteLength(content, "utf8") });
          return {
            content: [{ type: "text" as const, text: content }],
            details: { path: canonical, bytes: Buffer.byteLength(content, "utf8") },
          };
        } catch (error) {
          return directToolFailure(traces, "read", error);
        }
      },
    });

    const editTool = defineTool({
      name: "edit",
      label: "Edit fixture file",
      description: "Replace one exact text occurrence in an allowlisted target file.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1 }),
        oldText: Type.String(),
        newText: Type.String(),
      }, { additionalProperties: false }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const path = typeof params.path === "string" ? params.path : "";
        try {
          const canonical = canonicalDirectToolPath(path);
          if (!allowedWrites.has(canonical)) {
            throw new DirectPiToolRejection("scope-policy", "Edit path is outside the target allowlist");
          }
          const target = resolveCandidatePath(options.candidate.root, canonical);
          const current = await readFile(target, "utf8");
          const first = current.indexOf(params.oldText);
          if (first < 0 || current.indexOf(params.oldText, first + params.oldText.length) >= 0) {
            throw new DirectPiToolRejection(
              "old-text-precondition",
              "edit requires exactly one oldText occurrence",
            );
          }
          const next = `${current.slice(0, first)}${params.newText}${current.slice(first + params.oldText.length)}`;
          await assertDirectMutationAllowed(options.source, options.candidate.root, canonical, next);
          traces.push({ tool: "edit", path: canonical, status: "completed", bytes: Buffer.byteLength(params.newText, "utf8") });
          return {
            content: [{ type: "text" as const, text: "Edit applied." }],
            details: { path: canonical },
          };
        } catch (error) {
          return directToolFailure(traces, "edit", error);
        }
      },
    });

    const writeTool = defineTool({
      name: "write",
      label: "Write fixture file",
      description: "Replace the content of one allowlisted target file.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1 }),
        content: Type.String(),
      }, { additionalProperties: false }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const path = typeof params.path === "string" ? params.path : "";
        try {
          const canonical = canonicalDirectToolPath(path);
          if (!allowedWrites.has(canonical)) {
            throw new DirectPiToolRejection("scope-policy", "Write path is outside the target allowlist");
          }
          await assertDirectMutationAllowed(options.source, options.candidate.root, canonical, params.content);
          traces.push({ tool: "write", path: canonical, status: "completed", bytes: Buffer.byteLength(params.content, "utf8") });
          return {
            content: [{ type: "text" as const, text: "Write applied." }],
            details: { path: canonical },
          };
        } catch (error) {
          return directToolFailure(traces, "write", error);
        }
      },
    });

    const { session } = await createAgentSession({
      cwd: options.candidate.root,
      model: limited.model,
      thinkingLevel: "off",
      modelRuntime: options.modelRuntime,
      resourceLoader: createResourceLoader(directSystemPrompt()),
      tools: undefined,
      customTools: [readTool, editTool, writeTool],
      sessionManager: SessionManager.inMemory(options.candidate.root),
      settingsManager: SettingsManager.inMemory(SESSION_SETTINGS),
    });
    session.setActiveToolsByName(["read", "edit", "write"]);
    const active = session.getActiveToolNames();
    if (active.length !== 3 || active.some((name, index) => name !== ["read", "edit", "write"][index])) {
      session.dispose();
      throw new Error("Direct Pi activated a tool outside its host allowlist");
    }
    const abort = () => void session.abort();
    limits.signal.addEventListener("abort", abort, { once: true });
    try {
      await session.prompt(createDirectPiPrompt(options.source), { expandPromptTemplates: false });
      limits.throwIfAborted();
      if (session.state.errorMessage) throw new Error(session.state.errorMessage);
      return { completed: true, usage: limits.snapshot(), trace: trace() };
    } finally {
      limits.signal.removeEventListener("abort", abort);
      session.dispose();
    }
  } catch (error) {
    return {
      completed: false,
      usage: limits.snapshot(),
      trace: trace(),
      failure: redactPatchPocFailure("DIRECT_PI_FAILED", undefined, error),
    };
  } finally {
    if (registered) options.modelRuntime.unregisterProvider(providerRegistrationName);
    limits.dispose();
  }
}

function lineSpans(content: string): Array<{ start: number; end: number }> {
  if (content.length === 0) return [];
  const spans: Array<{ start: number; end: number }> = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    const end = newline === -1 ? content.length : newline + 1;
    spans.push({ start, end });
    start = end;
  }
  if (content.endsWith("\n")) spans.push({ start: content.length, end: content.length });
  return spans;
}

function targetReplacement(
  content: string,
  candidate: string,
  target: NativePatchEditTarget,
): string | undefined {
  const spans = lineSpans(content);
  if (target.startLine > spans.length || target.endLine > spans.length) return undefined;
  const targetSpan = target.operation === "replace-range"
    ? { start: spans[target.startLine - 1]!.start, end: spans[target.endLine - 1]!.end }
    : target.operation === "insert-before"
      ? { start: spans[target.startLine - 1]!.start, end: spans[target.startLine - 1]!.start }
      : { start: spans[target.endLine - 1]!.end, end: spans[target.endLine - 1]!.end };
  const prefix = content.slice(0, targetSpan.start);
  const suffix = content.slice(targetSpan.end);
  if (!candidate.startsWith(prefix) || !candidate.endsWith(suffix)) return undefined;
  return candidate.slice(prefix.length, candidate.length - suffix.length);
}

function statusesFromPorcelain(output: string): string[] {
  return output.split("\0").filter((entry) => entry.length > 0);
}

/**
 * Converts the direct candidate back into a host-generated PatchPlan. This is
 * deliberately model-free and proves the direct diff is accepted by the same
 * mutation limits used by the staged Pi-RLM path.
 */
export async function inspectCandidateScope(
  source: MatchedPatchSource,
  candidateRoot: string,
): Promise<CandidateScope> {
  try {
    const status = statusesFromPorcelain(
      await runGit(candidateRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]),
    );
    const modeSummary = await runGit(candidateRoot, ["diff", "--summary", "HEAD", "--"]);
    if (modeSummary.length > 0) {
      return { valid: false, changedPaths: [], replacements: [], failureCode: "DIFF_POLICY_FAILED" };
    }
    for (const file of source.context.files) {
      const path = canonicalPath(file.path);
      const [originalInfo, candidateInfo] = await Promise.all([
        lstat(resolveCandidatePath(source.root, path)),
        lstat(resolveCandidatePath(candidateRoot, path)),
      ]);
      if (
        !originalInfo.isFile() ||
        originalInfo.isSymbolicLink() ||
        !candidateInfo.isFile() ||
        candidateInfo.isSymbolicLink() ||
        (originalInfo.mode & 0o777) !== (candidateInfo.mode & 0o777)
      ) {
        return { valid: false, changedPaths: [], replacements: [], failureCode: "DIFF_POLICY_FAILED" };
      }
    }
    const allowedPaths = new Set(source.nativeEdits.map((target) => target.path));
    if (status.length === 0) {
      return { valid: false, changedPaths: [], replacements: [], failureCode: "DIFF_POLICY_FAILED" };
    }
    const changedPaths: string[] = [];
    for (const entry of status) {
      if (!entry.startsWith(" M ")) {
        return { valid: false, changedPaths: [], replacements: [], failureCode: "DIFF_POLICY_FAILED" };
      }
      const path = entry.slice(3);
      if (!allowedPaths.has(path)) {
        return { valid: false, changedPaths: [], replacements: [], failureCode: "PATH_OUT_OF_SCOPE" };
      }
      changedPaths.push(path);
    }
    if (new Set(changedPaths).size !== changedPaths.length) {
      return { valid: false, changedPaths: [], replacements: [], failureCode: "DIFF_POLICY_FAILED" };
    }
    const replacements: Array<{ target: NativePatchEditTarget; replacement: string }> = [];
    for (const target of source.nativeEdits) {
      const baseline = source.context.read(target.path);
      const current = await readFile(resolveCandidatePath(candidateRoot, target.path), "utf8");
      if (baseline === current) continue;
      const replacement = targetReplacement(baseline, current, target);
      if (replacement === undefined) {
        return { valid: false, changedPaths, replacements: [], failureCode: "EDIT_OUTSIDE_EVIDENCE" };
      }
      replacements.push({ target, replacement });
      const replacementConstraint = target.replacementConstraint;
      if (
        replacementConstraint &&
        !new RegExp(replacementConstraint.source, replacementConstraint.flags).test(replacement)
      ) {
        return {
          valid: false,
          changedPaths,
          replacements: [],
          failureCode: "OLD_SOURCE_MISMATCH",
        };
      }
    }
    if (replacements.length !== changedPaths.length) {
      return { valid: false, changedPaths, replacements: [], failureCode: "DIFF_POLICY_FAILED" };
    }
    const evidenceSession = createFileIndexedEvidenceSession(source.context);
    const edits = replacements.map(({ target, replacement }) => {
      const evidence = evidenceSession.readLines(target.path, target.startLine, target.endLine);
      evidenceSession.observe([evidence.id]);
      return {
        path: target.path,
        evidenceId: evidence.id,
        expectedOldHash: hashPatchSpan(
          source.context.read(target.path),
          target.operation,
          target.startLine,
          target.endLine,
        ),
        operation: target.operation,
        startLine: target.startLine,
        endLine: target.endLine,
        replacement,
      };
    });
    const validated = validatePatchPlan({
      plan: {
        version: 1,
        sourceRevision: source.context.sourceRevision,
        intent: "Direct Pi fixture mutation.",
        edits,
      },
      context: source.context,
      evidenceSession,
      authority: createRootPatchAuthority(),
      limits: source.mutationLimits,
      submittedPlanCount: 1,
      planRevisionCount: 0,
    });
    const expected = generatePatchCandidate(source.context, validated);
    for (const [path, content] of expected.files) {
      if (await readFile(resolveCandidatePath(candidateRoot, path), "utf8") !== content) {
        return { valid: false, changedPaths, replacements: [], failureCode: "DIFF_POLICY_FAILED" };
      }
    }
    const normalizedDiffHash = expected.normalizedDiffHash;
    return { valid: true, changedPaths: expected.changedPaths, replacements, normalizedDiffHash };
  } catch (error) {
    return {
      valid: false,
      changedPaths: [],
      replacements: [],
      failureCode: error instanceof PatchPlanError ? error.code : "APPLY_FAILED",
    };
  }
}

async function createVerificationSnapshot(
  source: MatchedPatchSource,
  candidateRoot: string,
  sourceRevision: string,
): Promise<VerificationSnapshot> {
  const parent = await mkdtemp(join(tmpdir(), "pi-rlm-matched-verify-"));
  const root = join(parent, "candidate");
  try {
    await mkdir(root);
    const files: Array<{ path: string; sha256: string; mode: number }> = [];
    for (const file of source.context.files) {
      const path = canonicalPath(file.path);
      const candidatePath = resolveCandidatePath(candidateRoot, path);
      const snapshotPath = resolve(root, path);
      if (!inside(root, snapshotPath)) throw new Error("Verification snapshot path escaped its root");
      const info = await lstat(candidatePath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Verification candidate contains an unsupported file");
      await mkdir(dirname(snapshotPath), { recursive: true });
      await copyFile(candidatePath, snapshotPath);
      await chmod(dirname(snapshotPath), 0o755);
      await chmod(snapshotPath, (info.mode & 0o777) | 0o444);
      const snapshotInfo = await lstat(snapshotPath);
      files.push({
        path,
        sha256: sha256(await readFile(snapshotPath)),
        mode: snapshotInfo.mode & 0o777,
      });
    }
    const manifestPath = join(parent, "candidate-manifest.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify({ version: 1, sourceRevision, files })}\n`,
      { encoding: "utf8", mode: 0o644 },
    );
    await chmod(parent, 0o755);
    await chmod(root, 0o755);
    await chmod(manifestPath, 0o644);
    return { parent, root, manifestPath };
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}

function postWriteContext(source: MatchedPatchSource, candidateRoot: string, loaded: FileIndexedContext): FileIndexedContext {
  return createFileIndexedContext(
    loaded.files.map((file) => ({ path: file.path, content: loaded.read(file.path) })),
    {
      ...source.context.limits,
      sourceRoot: candidateRoot,
      sourceRevision: `sha256:${loaded.corpusId}`,
    },
  );
}

/** Uses PatchVerifier's same model-free contract and focused-check profile. */
export async function verifyDirectCandidate(options: {
  readonly source: MatchedPatchSource;
  readonly candidateRoot: string;
  readonly verification?: PatchVerifierOptions;
}): Promise<DirectCandidateVerification> {
  const scope = await inspectCandidateScope(options.source, options.candidateRoot);
  if (!scope.valid || !scope.normalizedDiffHash) {
    const rejectionCategory = candidateRejectionCategory(scope.failureCode);
    return {
      accepted: false,
      scopeViolation: rejectionCategory === "scope-policy",
      rejectionCategory,
      changedPaths: scope.changedPaths,
      checks: [],
      failureCode: scope.failureCode,
      failure: redactPatchPocFailure("DIRECT_SCOPE_REJECTED", scope.failureCode, scope.failureCode ?? "scope rejection"),
    };
  }
  let snapshot: VerificationSnapshot | undefined;
  try {
    const loaded = await loadGitDirectoryContext(options.candidateRoot, options.source.context.limits);
    const post = postWriteContext(options.source, options.candidateRoot, loaded);
    const postWriteEvidenceIds = scope.changedPaths.map((path) => post.readLines(path, 1, 1).id);
    snapshot = await createVerificationSnapshot(options.source, options.candidateRoot, post.sourceRevision);
    const verifier = PatchVerifier.createRootPort(options.source.profiles, options.verification);
    const result = await verifier.verifySnapshot(
      options.source.verificationProfile,
      {
        changedPaths: scope.changedPaths,
        normalizedDiffHash: scope.normalizedDiffHash,
        preWriteRevision: options.source.context.sourceRevision,
        postWriteRevision: post.sourceRevision,
        postWriteEvidenceIds,
      },
      snapshot.root,
      snapshot.manifestPath,
    );
    return {
      accepted: result.ok,
      scopeViolation: false,
      changedPaths: scope.changedPaths,
      checks: result.checks,
      postContext: post,
      failureCode: result.failureCode,
      ...(result.ok ? {} : { failure: redactPatchPocFailure("DIRECT_VERIFICATION_FAILED", result.failureCode, result.failureCode ?? "verification failure") }),
    };
  } catch (error) {
    return {
      accepted: false,
      scopeViolation: false,
      changedPaths: scope.changedPaths,
      checks: [],
      failureCode: "VERIFICATION_SETUP_FAILED",
      failure: redactPatchPocFailure("DIRECT_VERIFICATION_FAILED", "VERIFICATION_SETUP_FAILED", error),
    };
  } finally {
    if (snapshot) await rm(snapshot.parent, { recursive: true, force: true });
  }
}

function emptySanitizedTrace(): SanitizedPiRlmFailureTrace {
  return {
    executionCount: 0,
    answerRejections: 0,
    patchPlanRejections: 0,
    rejectedAnswers: [],
    corpusCalls: [],
    executions: [],
    patchTools: [],
    providerCalls: [],
    facts: {
      contractPresent: false,
      eventCount: 0,
      extractionCount: 0,
      groundedFactCount: 0,
      pendingFactCount: 0,
      finalizationBlocks: 0,
      progressBlocks: 0,
      actionBlocks: 0,
      runtimeFinalizations: 0,
    },
  };
}

async function runDirectHarness(
  benchmarkCase: MatchedPatchCase,
  source: MatchedPatchSource,
  sourceFingerprint: string,
  model: Model<Api>,
  modelRuntime: ModelRuntime,
  verification: PatchVerifierOptions | undefined,
  repeat: number,
  order: number,
): Promise<MatchedPatchRun> {
  const startedAt = performance.now();
  const original = await captureOriginalCheckoutState(source.root, source.context);
  let candidate: FreshMatchedCandidate | undefined;
  try {
    candidate = await createFreshMatchedCandidate(source);
    const direct = await runDirectPiMutation({
      source,
      candidate,
      model,
      modelRuntime,
      limits: MATCHED_BENCHMARK_LIMITS,
    });
    const verificationResult = await verifyDirectCandidate({
      source,
      candidateRoot: candidate.root,
      verification,
    });
    const after = await captureOriginalCheckoutState(source.root, source.context);
    const originalUnchanged =
      isOriginalCheckoutUnchanged(original, after) &&
      await source.assertExternalOriginalUnchanged();
    const oracleMatched = source.oracleMatches?.(verificationResult.postContext);
    const rejectionCategories = new Set(
      direct.trace.tools.flatMap((tool) =>
        tool.status === "rejected" && tool.rejectionCategory ? [tool.rejectionCategory] : [],
      ),
    );
    if (rejectionCategories.size === 0 && verificationResult.rejectionCategory) {
      rejectionCategories.add(verificationResult.rejectionCategory);
    }
    const scopeViolation = rejectionCategories.has("scope-policy");
    const correct =
      direct.completed &&
      verificationResult.accepted &&
      !scopeViolation &&
      originalUnchanged &&
      (oracleMatched ?? true);
    return {
      schemaVersion: 1,
      section: benchmarkCase.section,
      caseId: benchmarkCase.id,
      harness: "direct-pi",
      repeat,
      order,
      sourceRevision: source.sourceRevision,
      sourceFingerprint,
      state: correct ? "ACCEPTED" : direct.completed ? "DIRECT_REJECTED" : "DIRECT_PI_FAILED",
      accepted: direct.completed && verificationResult.accepted,
      correct,
      falseSuccess: direct.completed && !correct,
      scopeViolation,
      rejectionCategories: [...rejectionCategories].sort(),
      originalUnchanged,
      durationMs: performance.now() - startedAt,
      usage: direct.usage,
      checks: verificationResult.checks,
      ...(oracleMatched === undefined ? {} : { oracleMatched }),
      trace: direct.trace,
      ...(direct.failure ?? verificationResult.failure
        ? { failure: direct.failure ?? verificationResult.failure }
        : {}),
    };
  } finally {
    await candidate?.cleanup();
  }
}


async function runRlmHarness(
  benchmarkCase: MatchedPatchCase,
  source: MatchedPatchSource,
  sourceFingerprint: string,
  model: Model<Api>,
  modelRuntime: ModelRuntime,
  verification: PatchVerifierOptions | undefined,
  repeat: number,
  order: number,
): Promise<MatchedPatchRun> {
  const startedAt = performance.now();
  const original = await captureOriginalCheckoutState(source.root, source.context);
  const execution = await executePatchPlanning({
    runner: new PiRlmRunner(model, {
      cwd: source.root,
      modelRuntime,
      limits: { ...MATCHED_BENCHMARK_LIMITS },
      isolation: { mode: "docker" },
    }),
    executor: PatchExecutor.createRoot(source.profiles, { verification }),
    context: source.context,
    question: source.question,
    verificationProfile: source.verificationProfile,
    limits: source.mutationLimits,
    patchPlanningMode: "native-edits",
    nativeEdits: source.nativeEdits,
  });
  const after = await captureOriginalCheckoutState(source.root, source.context);
  const originalUnchanged = isOriginalCheckoutUnchanged(original, after) && await source.assertExternalOriginalUnchanged();
  const oracleMatched = source.oracleMatches?.(execution.execution?.postContext);
  const checks = execution.receipt?.checks ?? [];
  const checksPassed = checks.length > 0 && checks.every((check) => check.status === "passed");
  const correct = execution.accepted && checksPassed && originalUnchanged && (oracleMatched ?? true);
  const failure = execution.trace.failureClass
    ? {
        failureClass: execution.trace.failureClass,
        ...(execution.trace.failureDigest ? { failureDigest: execution.trace.failureDigest } : {}),
      }
    : execution.accepted
      ? undefined
      : redactPatchPocFailure(execution.state, execution.receipt?.failureCode, execution.state);
  return {
    schemaVersion: 1,
    section: benchmarkCase.section,
    caseId: benchmarkCase.id,
    harness: "pi-rlm",
    repeat,
    order,
    sourceRevision: source.sourceRevision,
    sourceFingerprint,
    state: execution.state,
    accepted: execution.accepted,
    correct,
    falseSuccess: execution.accepted && !correct,
    scopeViolation: scopePolicyFailure(execution.receipt?.failureCode),
    rejectionCategories: [],
    originalUnchanged,
    durationMs: performance.now() - startedAt,
    usage: execution.usage ?? {
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
    },
    checks,
    ...(oracleMatched === undefined ? {} : { oracleMatched }),
    trace: execution.trace.plannerTrace ?? emptySanitizedTrace(),
    ...(failure ? { failure } : {}),
  };
}

export function summarizeMatchedPatchRuns(
  runs: readonly MatchedPatchRun[],
): MatchedPatchSummary[] {
  const buckets = new Map<string, MatchedPatchRun[]>();
  for (const run of runs) {
    const key = `${run.section}\0${run.caseId}\0${run.harness}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(run);
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .map((bucket) => {
      const first = bucket[0]!;
      const acceptedCorrect = bucket.filter((run) => run.correct).length;
      const falseSuccesses = bucket.filter((run) => run.falseSuccess).length;
      const rejectionCategories: Record<DirectPiRejectionCategory, number> = {
        "scope-policy": 0,
        "old-text-precondition": 0,
        "content-precondition": 0,
        "mutation-shape": 0,
        "host-failure": 0,
      };
      for (const run of bucket) {
        for (const category of run.rejectionCategories) {
          rejectionCategories[category] += 1;
        }
      }
      const scopeViolations = bucket.filter((run) => run.scopeViolation).length;
      const immutableOriginals = bucket.filter((run) => run.originalUnchanged).length;
      return {
        section: first.section,
        caseId: first.caseId,
        harness: first.harness,
        runs: bucket.length,
        acceptedCorrect,
        acceptedCorrectRate: acceptedCorrect / bucket.length,
        falseSuccesses,
        scopeViolations,
        rejectionCategories,
        immutableOriginals,
        modelCalls: bucket.reduce((total, run) => total + run.usage.modelCalls, 0),
        totalTokens: bucket.reduce((total, run) => total + run.usage.totalTokens, 0),
        costUsd: bucket.reduce((total, run) => total + run.usage.costUsd, 0),
        latencyMs: bucket.reduce((total, run) => total + run.durationMs, 0),
        meetsAcceptance:
          acceptedCorrect === bucket.length &&
          falseSuccesses === 0 &&
          scopeViolations === 0 &&
          immutableOriginals === bucket.length,
      } satisfies MatchedPatchSummary;
    })
    .sort((left, right) =>
      left.section.localeCompare(right.section) ||
      left.caseId.localeCompare(right.caseId) ||
      left.harness.localeCompare(right.harness),
    );
}

export function isMatchedPatchBenchmarkAccepted(
  coreAccepted: boolean,
  optionalRealRepoAccepted: boolean | undefined,
  provenanceComplete: boolean,
): boolean {
  return coreAccepted && (optionalRealRepoAccepted ?? true) && provenanceComplete;
}

function outputPrefix(value: string | undefined): string {
  const resolved = value ?? "matched-patch-benchmark";
  if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(resolved)) {
    throw new Error("PI_RLM_MATCHED_OUTPUT_PREFIX is invalid");
  }
  return resolved;
}

function validRepeatCount(value: number | undefined): number {
  const repeats = value ?? DEFAULT_REPEATS;
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > MAX_REPEATS) {
    throw new RangeError(`Matched benchmark repeats must be an integer from 1 to ${MAX_REPEATS}`);
  }
  return repeats;
}

async function persistHarnessSnapshot(
  packageRoot: string,
  prefix: string,
  capture: HarnessSourceCapture,
): Promise<void> {
  if (!capture.identity.dirty) return;
  const snapshotFile = `${prefix}-harness-source.json`;
  capture.identity.snapshotFile = snapshotFile;
  await writeFile(
    resolve(packageRoot, snapshotFile),
    `${JSON.stringify({ version: 1, files: capture.snapshot }, null, 2)}\n`,
    "utf8",
  );
}

export async function runMatchedPatchBenchmark(
  options: RunMatchedPatchBenchmarkOptions,
): Promise<MatchedPatchBenchmarkReport> {
  const packageRoot = resolve(options.packageRoot);
  const repeats = validRepeatCount(options.repeats);
  const prefix = outputPrefix(options.outputPrefix);
  const outputPath = resolve(packageRoot, `${prefix}-results.json`);
  const runsPath = resolve(packageRoot, `${prefix}-runs.jsonl`);
  const cases = options.cases ?? createCoreMatchedPatchCases();
  if (cases.length === 0) throw new Error("Matched benchmark requires at least one case");
  const ids = cases.map((benchmarkCase) => benchmarkCase.id);
  if (new Set(ids).size !== ids.length) throw new Error("Matched benchmark case IDs must be unique");

  const initialHarness = await captureHarnessSource(packageRoot);
  await persistHarnessSnapshot(packageRoot, prefix, initialHarness);
  const initialProvenanceComplete = isCompleteHarnessProvenance(initialHarness.identity);
  const initialSnapshotVerified = await hasExactDirtyHarnessSnapshot(packageRoot, initialHarness.identity);
  await writeFile(runsPath, "", "utf8");

  const modelRuntime = options.modelRuntime ?? await ModelRuntime.create();
  const { provider, modelId } = modelParts(options.modelSpec ?? DEFAULT_MODEL);
  const model = modelRuntime.getModel(provider, modelId);
  if (!model) throw new Error(`Matched benchmark model is unavailable: ${provider}/${modelId}`);
  if (!modelRuntime.hasConfiguredAuth(model.provider)) {
    throw new Error(`Matched benchmark authentication is unavailable for ${model.provider}/${model.id}`);
  }

  const sources: Array<{ benchmarkCase: MatchedPatchCase; source: MatchedPatchSource; fingerprint: string; trackedManifestSha256: string }> = [];
  try {
    for (const benchmarkCase of cases) {
      const source = await benchmarkCase.createSource();
      if (source.sourceRevision !== source.context.sourceRevision) {
        throw new Error(`Case ${benchmarkCase.id} source revision drifted during fixture construction`);
      }
      const original = await captureOriginalCheckoutState(source.root, source.context);
      sources.push({
        benchmarkCase,
        source,
        fingerprint: sourceContractFingerprint(original.contentFingerprint, source.nativeEdits),
        trackedManifestSha256: original.trackedManifestSha256,
      });
    }

    const runs: MatchedPatchRun[] = [];
    let order = 0;
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      for (const entry of sources) {
        order += 1;
        const direct = await runDirectHarness(
          entry.benchmarkCase,
          entry.source,
          entry.fingerprint,
          model,
          modelRuntime,
          options.verification,
          repeat,
          order,
        );
        order += 1;
        const rlm = await runRlmHarness(
          entry.benchmarkCase,
          entry.source,
          entry.fingerprint,
          model,
          modelRuntime,
          options.verification,
          repeat,
          order,
        );
        if (direct.sourceRevision !== rlm.sourceRevision || direct.sourceFingerprint !== rlm.sourceFingerprint) {
          throw new Error(`Case ${entry.benchmarkCase.id} paired harnesses did not start from the same source identity`);
        }
        for (const run of [direct, rlm]) {
          runs.push(run);
          await appendFile(runsPath, `${JSON.stringify(run)}\n`, "utf8");
          process.stdout.write(`${JSON.stringify({
            status: "run-complete",
            caseId: run.caseId,
            harness: run.harness,
            repeat: run.repeat,
            correct: run.correct,
            falseSuccess: run.falseSuccess,
            scopeViolation: run.scopeViolation,
            durationMs: Math.round(run.durationMs),
            modelCalls: run.usage.modelCalls,
            totalTokens: run.usage.totalTokens,
            costUsd: run.usage.costUsd,
          })}\n`);
        }
      }
    }

    const summaries = summarizeMatchedPatchRuns(runs);
    const coreSummaries = summaries.filter((summary) => summary.section === "core");
    const optionalSummaries = summaries.filter((summary) => summary.section === "optional-real-repo");
    const finalHarness = await captureHarnessSource(packageRoot);
    if (finalHarness.identity.dirty) finalHarness.identity.snapshotFile = initialHarness.identity.snapshotFile;
    const provenanceComplete =
      initialProvenanceComplete &&
      isCompleteHarnessProvenance(finalHarness.identity) &&
      initialSnapshotVerified &&
      await hasExactDirtyHarnessSnapshot(packageRoot, finalHarness.identity) &&
      hasStableHarnessProvenance(initialHarness, finalHarness);
    const expectedCoreSummaryCount = cases.filter(
      (benchmarkCase) => benchmarkCase.section === "core",
    ).length * 2;
    const coreAccepted =
      coreSummaries.length === expectedCoreSummaryCount &&
      coreSummaries.every((summary) => summary.meetsAcceptance);
    const optionalRealRepoAccepted = optionalSummaries.length === 0
      ? undefined
      : optionalSummaries.every((summary) => summary.meetsAcceptance);
    const report: MatchedPatchBenchmarkReport = {
      schemaVersion: 1,
      benchmark: "matched-direct-pi-vs-pi-rlm-patch",
      generatedAt: new Date().toISOString(),
      model: `${model.provider}/${model.id}`,
      thinking: "off",
      repeats,
      order: "repeat-case-direct-pi-then-pi-rlm",
      limits: { ...MATCHED_BENCHMARK_LIMITS },
      directPi: {
        tools: ["read", "edit", "write"],
        cwd: "fresh-disposable-worktree",
        shell: false,
        network: false,
      },
      piRlm: { patchPlanningMode: "native-edits", isolation: "docker" },
      caseSources: sources.map(({ benchmarkCase, source, fingerprint, trackedManifestSha256 }) => ({
        id: benchmarkCase.id,
        section: benchmarkCase.section,
        sourceRevision: source.sourceRevision,
        sourceFingerprint: fingerprint,
        trackedManifestSha256,
        questionSha256: sha256(source.question),
        nativeEdits: source.nativeEdits.map((target) => nativeEditTargetMetadata(target)),
        mutationLimits: {
          ...source.mutationLimits,
          allowedPathPrefixes: [...source.mutationLimits.allowedPathPrefixes],
          forbiddenPathPatterns: [...source.mutationLimits.forbiddenPathPatterns],
        },
      })),
      artifacts: { outputPath, runsPath },
      harnessSource: initialHarness.identity,
      finalHarnessSource: finalHarness.identity,
      provenanceComplete,
      provenanceStable: hasStableHarnessProvenance(initialHarness, finalHarness),
      acceptance: {
        requiredAcceptedCorrectRate: 1,
        maximumFalseSuccesses: 0,
        requiredImmutableOriginals: repeats,
        requiredScopeViolations: 0,
      },
      summaries,
      coreAccepted,
      ...(optionalRealRepoAccepted === undefined ? {} : { optionalRealRepoAccepted }),
      accepted: isMatchedPatchBenchmarkAccepted(
        coreAccepted,
        optionalRealRepoAccepted,
        provenanceComplete,
      ),
    };
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      status: "complete",
      accepted: report.accepted,
      coreAccepted: report.coreAccepted,
      outputPath,
      runsPath,
    })}\n`);
    return report;
  } finally {
    for (const { source } of sources.reverse()) await source.cleanup();
  }
}
