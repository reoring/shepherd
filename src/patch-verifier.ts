import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PatchFailureCode } from "./patch-plan.ts";

export interface DiffPolicyVerificationStep {
  kind: "diff-policy";
}

export interface PostWriteEvidenceVerificationStep {
  kind: "post-write-evidence";
}

export interface RlmContractVerificationStep {
  kind: "rlm-contract";
  name: string;
  /** Canonical path to a contract tracked in the verification snapshot. */
  contractPath: string;
  /** Exact answer finalized by the trusted rlm-check runtime. */
  expectedAnswer: string;
  timeoutMs: number;
  outputLimitBytes: number;
}

export interface FocusedCheckVerificationStep {
  kind: "focused-check";
  name: string;
  /** Canonical path inside the host-owned trusted runtime. */
  trustedScript: string;
  timeoutMs: number;
  outputLimitBytes: number;
}

export type HostVerificationStep =
  | DiffPolicyVerificationStep
  | PostWriteEvidenceVerificationStep
  | RlmContractVerificationStep
  | FocusedCheckVerificationStep;

export interface VerificationProfile {
  name: string;
  steps: readonly [
    DiffPolicyVerificationStep,
    PostWriteEvidenceVerificationStep,
    RlmContractVerificationStep,
    FocusedCheckVerificationStep,
  ];
}

export interface VerificationCheckReceipt {
  name: string;
  kind: HostVerificationStep["kind"];
  status: "passed" | "failed";
  durationMs: number;
  exitCode?: number;
  outputDigest?: string;
  outputBytes?: number;
  outputTruncated?: boolean;
  failureCode?: PatchFailureCode;
}

export interface PatchVerificationInput {
  changedPaths: readonly string[];
  normalizedDiffHash: string;
  postWriteRevision: string;
  preWriteRevision: string;
  postWriteEvidenceIds: readonly string[];
}

export interface PatchVerificationResult {
  ok: boolean;
  checks: readonly VerificationCheckReceipt[];
  failureCode?: PatchFailureCode;
  primaryFailureCode?: PatchFailureCode;
}

export interface PatchVerifierOptions {
  dockerImage?: string;
  /**
   * Host-owned pi-rlm runtime, including its dependency tree. It is never
   * sourced from the generated candidate and is mounted read-only.
   */
  trustedRuntimePath?: string;
  /** Host-only deterministic seam for Docker lifecycle receipt regressions. */
  dockerCommandRunner?: DockerCommandRunner;
  /** Host-only test seam for observing exact, generated container names. */
  containerNameFactory?: () => string;
}

interface SandboxedCommand {
  argv: readonly [string, ...string[]];
  stdin?: Buffer;
}

interface FocusedCheckCommand extends SandboxedCommand {
  expectedProof: Buffer;
}

export interface DockerCommandResult {
  exitCode: number;
  output: Buffer;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  outputTruncated: boolean;
  startError?: Error;
  aborted?: boolean;
}

export type DockerCommandRunner = (
  args: readonly string[],
  timeoutMs: number,
  outputLimitBytes: number,
  stdin?: Buffer,
  signal?: AbortSignal,
) => Promise<DockerCommandResult>;

interface CommandResult extends DockerCommandResult {}

interface ProcessResult extends CommandResult {
  startError?: Error;
}

interface VerificationCandidate {
  readonly opaque: "verification-candidate";
}

interface CandidateRegistration {
  snapshotPath: string;
  manifestPath: string;
  consumed: boolean;
}

interface ContractCheckOutput {
  status?: unknown;
  modelCalls?: unknown;
  runtimeFinalized?: unknown;
  answer?: unknown;
}

export class DockerCleanupError extends Error {
  readonly primaryFailure?: Error;
  readonly primaryResult?: CommandResult;

  constructor(primaryFailure?: Error, primaryResult?: CommandResult) {
    super("Docker verification container cleanup could not be certified");
    this.name = "DockerCleanupError";
    this.primaryFailure = primaryFailure;
    this.primaryResult = primaryResult;
  }
}

class DockerSetupError extends Error {
  readonly result?: CommandResult;

  constructor(result?: CommandResult) {
    super("Docker verification setup failed");
    this.name = "DockerSetupError";
    this.result = result;
  }
}

class VerificationAbortedError extends Error {
  constructor() {
    super("Patch verification aborted");
    this.name = "VerificationAbortedError";
  }
}

const DEFAULT_DOCKER_IMAGE = "node:24-alpine";
const DEFAULT_TRUSTED_RUNTIME_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const CANDIDATE_MOUNT_PATH = "/workspace";
const MANIFEST_MOUNT_PATH = "/candidate-manifest.json";
const TRUSTED_RUNTIME_MOUNT_PATH = "/opt/pi-rlm";
const DOCKER_LIFECYCLE_TIMEOUT_MS = 5_000;
const DOCKER_LIFECYCLE_OUTPUT_LIMIT_BYTES = 16 * 1024;

function sandboxUserIdentity(): string {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    return "65534:65534";
  }
  const uid = process.getuid();
  const gid = process.getgid();
  return uid !== 0 && gid !== 0 ? `${uid}:${gid}` : "65534:65534";
}

function outputDigest(output: Buffer): string {
  return createHash("sha256").update(output).digest("hex");
}

function commandFailureCode(kind: "rlm-contract" | "focused-check"): PatchFailureCode {
  return kind === "rlm-contract" ? "CONTRACT_CHECK_FAILED" : "FOCUSED_CHECK_FAILED";
}

function canonicalRelativePath(path: string, subject: string): string {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    throw new TypeError(`${subject} must be a canonical relative path`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new TypeError(`${subject} must be a canonical relative path`);
  }
  return path;
}

function validateCommandStep(
  step: RlmContractVerificationStep | FocusedCheckVerificationStep,
): void {
  if (step.name.length === 0 || step.name.includes("\0")) {
    throw new TypeError("Verification commands require a non-empty name");
  }
  if (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 1) {
    throw new TypeError("Verification command timeout must be a positive integer");
  }
  if (!Number.isInteger(step.outputLimitBytes) || step.outputLimitBytes < 1) {
    throw new TypeError("Verification command output limit must be a positive integer");
  }
  if (step.kind === "rlm-contract") {
    canonicalRelativePath(step.contractPath, "RLM contract path");
    if (
      step.expectedAnswer.length === 0 ||
      step.expectedAnswer.includes("\0") ||
      Buffer.byteLength(step.expectedAnswer, "utf8") > step.outputLimitBytes
    ) {
      throw new TypeError("RLM contract checks require a bounded expected answer");
    }
    return;
  }
  canonicalRelativePath(step.trustedScript, "Focused verification trusted script");
}

function validateProfile(profile: VerificationProfile): void {
  if (profile.name.length === 0 || profile.name.includes("\0")) {
    throw new TypeError("Verification profile name must not be empty");
  }
  const [diffPolicy, postWriteEvidence, contract, focusedCheck] = profile.steps;
  if (
    diffPolicy?.kind !== "diff-policy" ||
    postWriteEvidence?.kind !== "post-write-evidence" ||
    contract?.kind !== "rlm-contract" ||
    focusedCheck?.kind !== "focused-check"
  ) {
    throw new TypeError("Verification profiles require diff-policy, post-write-evidence, rlm-contract, and focused-check in that order");
  }
  validateCommandStep(contract);
  validateCommandStep(focusedCheck);
}

function freezeProfile(profile: VerificationProfile): VerificationProfile {
  const [diffPolicy, postWriteEvidence, contract, focusedCheck] = profile.steps;
  const steps = Object.freeze([
    Object.freeze({ kind: diffPolicy.kind }),
    Object.freeze({ kind: postWriteEvidence.kind }),
    Object.freeze({
      kind: contract.kind,
      name: `${contract.name}`,
      contractPath: `${contract.contractPath}`,
      expectedAnswer: `${contract.expectedAnswer}`,
      timeoutMs: contract.timeoutMs,
      outputLimitBytes: contract.outputLimitBytes,
    }),
    Object.freeze({
      kind: focusedCheck.kind,
      name: `${focusedCheck.name}`,
      trustedScript: `${focusedCheck.trustedScript}`,
      timeoutMs: focusedCheck.timeoutMs,
      outputLimitBytes: focusedCheck.outputLimitBytes,
    }),
  ]) as unknown as VerificationProfile["steps"];
  return Object.freeze({ name: `${profile.name}`, steps });
}

function appendBounded(
  chunks: Buffer[],
  length: number,
  chunk: Buffer,
  limit: number,
): { length: number; truncated: boolean } {
  const remaining = Math.max(0, limit - length);
  if (remaining === 0) return { length, truncated: chunk.length > 0 };
  if (chunk.length <= remaining) {
    chunks.push(chunk);
    return { length: length + chunk.length, truncated: false };
  }
  chunks.push(chunk.subarray(0, remaining));
  return { length: length + remaining, truncated: true };
}

function executeBoundedProcess(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  outputLimitBytes: number,
  stdin?: Buffer,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  const { promise, resolve: complete } = Promise.withResolvers<ProcessResult>();
  const child = spawn(command, [...args], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill("SIGKILL");
    complete({
      exitCode: -1,
      output: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      timedOut: false,
      outputTruncated: false,
      startError: new Error("Sandboxed verification process did not expose standard streams"),
    });
    return promise;
  }
  child.stdin.once("error", () => undefined);
  child.stdin.end(stdin);
  const stdout = child.stdout;
  const stderr = child.stderr;
  const outputChunks: Buffer[] = [];
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let outputBytes = 0;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputTruncated = false;
  let timedOut = false;
  let settled = false;
  let aborted = signal?.aborted ?? false;
  let killTimer: NodeJS.Timeout | undefined;

  const appendOutput = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
    const outputResult = appendBounded(outputChunks, outputBytes, chunk, outputLimitBytes);
    outputBytes = outputResult.length;
    outputTruncated ||= outputResult.truncated;
    const streamChunks = stream === "stdout" ? stdoutChunks : stderrChunks;
    const streamBytes = stream === "stdout" ? stdoutBytes : stderrBytes;
    const streamResult = appendBounded(streamChunks, streamBytes, chunk, outputLimitBytes);
    outputTruncated ||= streamResult.truncated;
    if (stream === "stdout") stdoutBytes = streamResult.length;
    else stderrBytes = streamResult.length;
  };

  stdout.on("data", (chunk: Buffer) => appendOutput(chunk, "stdout"));
  stderr.on("data", (chunk: Buffer) => appendOutput(chunk, "stderr"));

  const finish = (result: ProcessResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    clearTimeout(killTimer);
    complete(result);
    signal?.removeEventListener("abort", onAbort);
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
  }, timeoutMs);
  const onAbort = () => {
    aborted = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (aborted) onAbort();

  child.once("error", (error) => {
    finish({
      exitCode: -1,
      output: Buffer.concat(outputChunks),
      stdout: Buffer.concat(stdoutChunks),
      stderr: Buffer.concat(stderrChunks),
      timedOut,
      outputTruncated,
      startError: error,
      aborted,
    });
  });
  child.once("close", (code) => {
    finish({
      exitCode: code ?? -1,
      output: Buffer.concat(outputChunks),
      stdout: Buffer.concat(stdoutChunks),
      stderr: Buffer.concat(stderrChunks),
      timedOut,
      outputTruncated,
      aborted,
    });
  });
  return promise;
}

function executeDockerCommand(
  args: readonly string[],
  timeoutMs: number,
  outputLimitBytes: number,
  stdin: Buffer | undefined,
  dockerCommandRunner: DockerCommandRunner | undefined,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return dockerCommandRunner
    ? dockerCommandRunner(args, timeoutMs, outputLimitBytes, stdin, signal)
    : executeBoundedProcess("docker", args, timeoutMs, outputLimitBytes, stdin, signal);
}

function exactOwnedNotFoundStderr(identity: string): string[] {
  return [
    `Error: No such container: ${identity}\n`,
    `Error response from daemon: No such container: ${identity}\n`,
  ];
}

export function isExactOwnedContainerNotFound(
  result: DockerCommandResult,
  identity: string,
  expectedStdout: string,
): boolean {
  return (
    result.exitCode !== 0 &&
    !result.timedOut &&
    !result.outputTruncated &&
    result.stdout.toString("utf8") === expectedStdout &&
    exactOwnedNotFoundStderr(identity).includes(result.stderr.toString("utf8"))
  );
}

async function removeContainerAndCertifyAbsent(
  name: string,
  containerId: string | undefined,
  dockerCommandRunner: DockerCommandRunner | undefined,
): Promise<void> {
  const identity = containerId ?? name;
  const removal = await executeDockerCommand(
    ["rm", "--force", identity],
    DOCKER_LIFECYCLE_TIMEOUT_MS,
    DOCKER_LIFECYCLE_OUTPUT_LIMIT_BYTES,
    undefined,
    dockerCommandRunner,
  );
  if (removal.startError || removal.timedOut) throw new DockerCleanupError();
  if (removal.exitCode !== 0 && !isExactOwnedContainerNotFound(removal, identity, "")) {
    throw new DockerCleanupError();
  }
  const inspection = await executeDockerCommand(
    ["container", "inspect", identity],
    DOCKER_LIFECYCLE_TIMEOUT_MS,
    DOCKER_LIFECYCLE_OUTPUT_LIMIT_BYTES,
    undefined,
    dockerCommandRunner,
  );
  if (
    inspection.startError ||
    inspection.timedOut ||
    !isExactOwnedContainerNotFound(inspection, identity, "[]\n")
  ) {
    throw new DockerCleanupError();
  }
}

function contractCommand(step: RlmContractVerificationStep): SandboxedCommand {
  return {
    argv: [
      "node",
      `${TRUSTED_RUNTIME_MOUNT_PATH}/src/patch-contract-check-cli.ts`,
      CANDIDATE_MOUNT_PATH,
      MANIFEST_MOUNT_PATH,
      `${CANDIDATE_MOUNT_PATH}/${step.contractPath}`,
    ],
  };
}

function focusedProofPayload(profileName: string, stepName: string): string {
  return `focused-proof\0${profileName}\0${stepName}`;
}

function focusedCheckCommand(
  profileName: string,
  step: FocusedCheckVerificationStep,
): FocusedCheckCommand {
  const secret = randomBytes(32).toString("base64url");
  const proof = createHmac("sha256", secret)
    .update(focusedProofPayload(profileName, step.name), "utf8")
    .digest("hex");
  return {
    argv: ["node", `${TRUSTED_RUNTIME_MOUNT_PATH}/${step.trustedScript}`],
    stdin: Buffer.from(
      `${JSON.stringify({ secret, profile: profileName, step: step.name })}\n`,
      "utf8",
    ),
    expectedProof: Buffer.from(`${JSON.stringify({ proof })}\n`, "utf8"),
  };
}

async function assertTrustedRuntimeScript(
  runtimePath: string,
  trustedScript: string | undefined,
): Promise<void> {
  if (!trustedScript) return;
  const scriptPath = await realpath(join(runtimePath, trustedScript));
  const runtimePrefix = runtimePath.endsWith("/") ? runtimePath : `${runtimePath}/`;
  if (!scriptPath.startsWith(runtimePrefix) || !(await stat(scriptPath)).isFile()) {
    throw new Error("Focused verification script must resolve to a file inside the trusted runtime");
  }
}

function focusedOutputMatches(result: CommandResult, expectedProof: Buffer): boolean {
  return (
    !result.outputTruncated &&
    result.stdout.equals(expectedProof) &&
    result.output.equals(expectedProof)
  );
}

function commandResultFailureCode(
  result: CommandResult,
  step: RlmContractVerificationStep | FocusedCheckVerificationStep,
  expectedFocusedProof: Buffer | undefined,
): PatchFailureCode | undefined {
  if (result.timedOut) return "VERIFICATION_TIMEOUT";
  const outputMatches = step.kind === "rlm-contract"
    ? !result.outputTruncated && contractOutputMatches(result.stdout, step)
    : expectedFocusedProof !== undefined && focusedOutputMatches(result, expectedFocusedProof);
  return result.exitCode === 0 && outputMatches
    ? undefined
    : commandFailureCode(step.kind);
}

function setupFailureCode(error: unknown): PatchFailureCode {
  return error instanceof DockerSetupError && error.result?.timedOut
    ? "VERIFICATION_TIMEOUT"
    : "VERIFICATION_SETUP_FAILED";
}

async function executeSandboxedCommand(
  command: SandboxedCommand,
  trustedScript: string | undefined,
  candidateSnapshotPath: string,
  candidateManifestPath: string,
  trustedRuntimePath: string,
  dockerImage: string,
  timeoutMs: number,
  outputLimitBytes: number,
  containerNameFactory: () => string,
  dockerCommandRunner: DockerCommandRunner | undefined,
  signal?: AbortSignal,
): Promise<CommandResult> {
  signal?.throwIfAborted();
  const candidatePath = await realpath(candidateSnapshotPath);
  const manifestPath = await realpath(candidateManifestPath);
  const runtimePath = await realpath(trustedRuntimePath);
  await assertTrustedRuntimeScript(runtimePath, trustedScript);
  const lifecycleParent = await mkdtemp(join(tmpdir(), "pi-rlm-patch-docker-"));
  const cidFile = join(lifecycleParent, "cid");
  const containerName = containerNameFactory();
  if (!containerName || containerName.includes("\0")) {
    await rm(lifecycleParent, { recursive: true, force: true });
    throw new Error("Docker verification container name must not be empty");
  }

  let containerId: string | undefined;
  let result: CommandResult | undefined;
  let primaryFailure: Error | undefined;
  let cleanupFailure: Error | undefined;
  const deadline = Date.now() + timeoutMs;
  try {
    const create = await executeDockerCommand(
      [
        "create",
        "--pull=never",
        "--name",
        containerName,
        "--cidfile",
        cidFile,
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=64",
        "--memory=256m",
        "--cpus=1",
        `--user=${sandboxUserIdentity()}`,
        "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
        "--mount",
        `type=bind,source=${candidatePath},target=${CANDIDATE_MOUNT_PATH},readonly`,
        "--mount",
        `type=bind,source=${manifestPath},target=${MANIFEST_MOUNT_PATH},readonly`,
        "--mount",
        `type=bind,source=${runtimePath},target=${TRUSTED_RUNTIME_MOUNT_PATH},readonly`,
        `--workdir=${CANDIDATE_MOUNT_PATH}`,
        ...(command.stdin ? ["--interactive"] : []),
        dockerImage,
        ...command.argv,
      ],
      Math.min(timeoutMs, DOCKER_LIFECYCLE_TIMEOUT_MS),
      DOCKER_LIFECYCLE_OUTPUT_LIMIT_BYTES,
      undefined,
      dockerCommandRunner,
      signal,
    );
    if (create.aborted || signal?.aborted) throw new VerificationAbortedError();
    if (create.startError || create.timedOut || create.exitCode !== 0) {
      throw new DockerSetupError(create);
    }
    containerId = (await readFile(cidFile, "utf8")).trim();
    if (!/^[a-f0-9]{64}$/u.test(containerId)) {
      throw new DockerSetupError();
    }
    const remainingTimeoutMs = deadline - Date.now();
    if (remainingTimeoutMs < 1) {
      throw new DockerSetupError({
        exitCode: -1,
        output: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        timedOut: true,
        outputTruncated: false,
      });
    }
    const started = await executeDockerCommand(
      command.stdin
        ? ["start", "--attach", "--interactive", containerId]
        : ["start", "--attach", containerId],
      remainingTimeoutMs,
      outputLimitBytes,
      command.stdin,
      dockerCommandRunner,
      signal,
    );
    if (started.aborted || signal?.aborted) throw new VerificationAbortedError();
    if (started.startError) throw new DockerSetupError(started);
    result = started;
  } catch (error) {
    primaryFailure = error instanceof Error ? error : new Error(String(error));
  } finally {
    try {
      await removeContainerAndCertifyAbsent(containerName, containerId, dockerCommandRunner);
    } catch (error) {
      cleanupFailure = error instanceof Error ? error : new Error(String(error));
    }
    try {
      await rm(lifecycleParent, { recursive: true, force: true });
    } catch (error) {
      cleanupFailure ??= error instanceof Error ? error : new Error(String(error));
    }
  }
  if (cleanupFailure) throw new DockerCleanupError(primaryFailure, result);
  if (primaryFailure) throw primaryFailure;
  if (!result) throw new Error("Sandboxed verification did not return a result");
  return result;
}

function contractOutputMatches(
  stdout: Buffer,
  step: RlmContractVerificationStep,
): boolean {
  let parsed: ContractCheckOutput;
  try {
    parsed = JSON.parse(stdout.toString("utf8")) as ContractCheckOutput;
  } catch {
    return false;
  }
  return (
    parsed.status === "passed" &&
    parsed.modelCalls === 0 &&
    parsed.runtimeFinalized === true &&
    parsed.answer === step.expectedAnswer
  );
}


/**
 * Immutable verification profiles and the private candidate-capability store.
 * Candidate ports can only be created and consumed by PatchExecutor's
 * non-exported verifier subclass; this public type has no arbitrary-path API.
 */
export class PatchVerifier {
  private readonly profiles: ReadonlyMap<string, VerificationProfile>;
  private readonly candidates = new WeakMap<VerificationCandidate, CandidateRegistration>();
  private readonly dockerImage: string;
  private readonly trustedRuntimePath: string;
  private readonly containerNameFactory: () => string;
  private readonly dockerCommandRunner: DockerCommandRunner | undefined;
  readonly #registeredProfileNames: readonly string[];

  constructor(profiles: readonly VerificationProfile[], options: PatchVerifierOptions = {}) {
    const entries = new Map<string, VerificationProfile>();
    for (const profile of profiles) {
      validateProfile(profile);
      if (entries.has(profile.name)) {
        throw new TypeError(`Verification profile is registered more than once: ${profile.name}`);
      }
      entries.set(profile.name, freezeProfile(profile));
    }
    this.profiles = entries;
    this.#registeredProfileNames = Object.freeze(
      [...entries.keys()].sort((left, right) => left.localeCompare(right)),
    );
    this.dockerImage = options.dockerImage ?? DEFAULT_DOCKER_IMAGE;
    this.trustedRuntimePath = options.trustedRuntimePath ?? DEFAULT_TRUSTED_RUNTIME_PATH;
    this.containerNameFactory = options.containerNameFactory ??
      (() => `pi-rlm-patch-${process.pid}-${randomUUID().slice(0, 12)}`);
    this.dockerCommandRunner = options.dockerCommandRunner;
    if (
      this.dockerImage.length === 0 ||
      this.dockerImage.includes("\0") ||
      this.trustedRuntimePath.length === 0 ||
      this.trustedRuntimePath.includes("\0")
    ) {
      throw new TypeError("Docker verification runtime configuration is invalid");
    }
  }

  static createRootPort(
    profiles: readonly VerificationProfile[],
    options: PatchVerifierOptions = {},
  ): {
    profileNames(): string[];
    verifySnapshot(
      profileName: string,
      input: PatchVerificationInput,
      candidateSnapshotPath: string,
      candidateManifestPath: string,
      signal?: AbortSignal,
    ): Promise<PatchVerificationResult>;
  } {
    const verifier = new PatchVerifier(profiles, options);
    return Object.freeze({
      profileNames: () => [...verifier.#registeredProfileNames],
      verifySnapshot: (
        profileName: string,
        input: PatchVerificationInput,
        candidateSnapshotPath: string,
        candidateManifestPath: string,
        signal?: AbortSignal,
      ) => verifier.#verifyExactSnapshot(
        profileName,
        input,
        candidateSnapshotPath,
        candidateManifestPath,
        signal,
      ),
    });
  }

  async #verifyExactSnapshot(
    profileName: string,
    input: PatchVerificationInput,
    candidateSnapshotPath: string,
    candidateManifestPath: string,
    signal?: AbortSignal,
  ): Promise<PatchVerificationResult> {
    const candidate = Object.freeze({ opaque: "verification-candidate" as const });
    this.candidates.set(candidate, {
      snapshotPath: candidateSnapshotPath,
      manifestPath: candidateManifestPath,
      consumed: false,
    });
    return this.consumeCandidate(candidate, profileName, input, signal);
  }

  private async consumeCandidate(
    candidate: VerificationCandidate,
    profileName: string,
    input: PatchVerificationInput,
    signal?: AbortSignal,
  ): Promise<PatchVerificationResult> {
    const registration = this.candidates.get(candidate);
    if (!registration || registration.consumed) {
      return { ok: false, checks: [], failureCode: "PATCH_SCHEMA_INVALID" };
    }
    registration.consumed = true;
    const profile = this.profiles.get(profileName);
    if (!profile) {
      return { ok: false, checks: [], failureCode: "PATCH_SCHEMA_INVALID" };
    }

    const checks: VerificationCheckReceipt[] = [];
    for (const step of profile.steps) {
      if (signal?.aborted) return { ok: false, checks, failureCode: "ABORTED" };
      const startedAt = Date.now();
      if (step.kind === "diff-policy") {
        const passed = input.changedPaths.length > 0 && /^[a-f0-9]{64}$/u.test(input.normalizedDiffHash);
        const check: VerificationCheckReceipt = {
          name: "diff-policy",
          kind: step.kind,
          status: passed ? "passed" : "failed",
          durationMs: Date.now() - startedAt,
          failureCode: passed ? undefined : "DIFF_POLICY_FAILED",
        };
        checks.push(check);
        if (!passed) return { ok: false, checks, failureCode: "DIFF_POLICY_FAILED" };
        continue;
      }
      if (step.kind === "post-write-evidence") {
        const passed =
          input.preWriteRevision !== input.postWriteRevision &&
          input.postWriteEvidenceIds.length === input.changedPaths.length &&
          input.postWriteEvidenceIds.length > 0;
        const check: VerificationCheckReceipt = {
          name: "post-write-evidence",
          kind: step.kind,
          status: passed ? "passed" : "failed",
          durationMs: Date.now() - startedAt,
          failureCode: passed ? undefined : "POST_WRITE_INDEX_FAILED",
        };
        checks.push(check);
        if (!passed) return { ok: false, checks, failureCode: "POST_WRITE_INDEX_FAILED" };
        continue;
      }

      const failureCode = commandFailureCode(step.kind);
      let command: SandboxedCommand;
      let trustedScript: string | undefined;
      let expectedFocusedProof: Buffer | undefined;
      if (step.kind === "focused-check") {
        const focusedCommand = focusedCheckCommand(profile.name, step);
        command = focusedCommand;
        trustedScript = step.trustedScript;
        expectedFocusedProof = focusedCommand.expectedProof;
      } else {
        command = contractCommand(step);
      }
      try {
        const result = await executeSandboxedCommand(
          command,
          trustedScript,
          registration.snapshotPath,
          registration.manifestPath,
          this.trustedRuntimePath,
          this.dockerImage,
          step.timeoutMs,
          step.outputLimitBytes,
          this.containerNameFactory,
          this.dockerCommandRunner,
          signal,
        );
        const resultFailureCode = commandResultFailureCode(
          result,
          step,
          expectedFocusedProof,
        );
        const passed = resultFailureCode === undefined;
        const check: VerificationCheckReceipt = {
          name: step.name,
          kind: step.kind,
          status: passed ? "passed" : "failed",
          durationMs: Date.now() - startedAt,
          exitCode: result.exitCode,
          outputDigest: outputDigest(result.output),
          outputBytes: result.output.length,
          outputTruncated: result.outputTruncated,
          failureCode: resultFailureCode,
        };
        checks.push(check);
        if (resultFailureCode) return { ok: false, checks, failureCode: resultFailureCode };
      } catch (error) {
        if (error instanceof VerificationAbortedError || signal?.aborted) {
          checks.push({
            name: step.name,
            kind: step.kind,
            status: "failed",
            durationMs: Date.now() - startedAt,
            failureCode: "ABORTED",
          });
          return { ok: false, checks, failureCode: "ABORTED" };
        }
        const cleanupFailure = error instanceof DockerCleanupError;
        const setupError = cleanupFailure ? error.primaryFailure : error;
        const primaryFailureCode = cleanupFailure
          ? error.primaryResult
            ? commandResultFailureCode(error.primaryResult, step, expectedFocusedProof)
            : setupFailureCode(setupError)
          : undefined;
        const resultFailureCode = cleanupFailure
          ? "CLEANUP_FAILED"
          : setupFailureCode(setupError);
        const primaryResult = cleanupFailure ? error.primaryResult : undefined;
        checks.push({
          name: step.name,
          kind: step.kind,
          status: "failed",
          durationMs: Date.now() - startedAt,
          exitCode: primaryResult?.exitCode,
          outputDigest: primaryResult ? outputDigest(primaryResult.output) : undefined,
          outputBytes: primaryResult?.output.length,
          outputTruncated: primaryResult?.outputTruncated,
          failureCode: resultFailureCode,
        });
        return {
          ok: false,
          checks,
          failureCode: resultFailureCode,
          primaryFailureCode,
        };
      }
    }
    return { ok: true, checks };
  }
}

