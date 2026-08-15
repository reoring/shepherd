import { execFile, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  createFileIndexedContext,
  loadGitDirectoryContext,
  type FileIndexedContext,
  type FileIndexedEvidenceSession,
} from "./file-context.ts";
import {
  DEFAULT_MUTATION_LIMITS,
  PatchPlanError,
  createRootPatchAuthority,
  generatePatchCandidate,
  validatePatchPlan,
  type MutationLimits,
  type PatchCandidate,
  type PatchEditHash,
  type PatchFailureCode,
  type PatchPlanValidationRequest,
  type RootPatchAuthority,
  type ValidatedPatchPlan,
} from "./patch-plan.ts";
import {
  PatchVerifier,
  type PatchVerifierOptions,
  type PatchVerificationInput,
  type PatchVerificationResult,
  type VerificationCheckReceipt,
  type VerificationProfile,
} from "./patch-verifier.ts";

export type PatchRuntimeState =
  | "READ_ONLY"
  | "PLAN_SUBMITTED"
  | "PLAN_VALIDATED"
  | "APPLIED"
  | "REINDEXED"
  | "VERIFYING"
  | "ACCEPTED"
  | "PLAN_REJECTED"
  | "PLANNING_FAILED"
  | "APPLY_FAILED"
  | "POST_WRITE_INDEX_FAILED"
  | "VERIFICATION_FAILED"
  | "CLEANUP_FAILED"
  | "ABORTED";

type TerminalPatchState = Extract<
  PatchRuntimeState,
  | "PLAN_REJECTED"
  | "APPLY_FAILED"
  | "POST_WRITE_INDEX_FAILED"
  | "VERIFICATION_FAILED"
  | "CLEANUP_FAILED"
  | "ABORTED"
>;

export interface PatchReceipt {
  state: PatchRuntimeState;
  preWriteRevision: string;
  postWriteRevision?: string;
  changedPaths: readonly string[];
  normalizedDiffHash?: string;
  editHashes: readonly PatchEditHash[];
  postWriteEvidenceIds: readonly string[];
  verificationProfile?: string;
  checks: readonly VerificationCheckReceipt[];
  transitions: readonly PatchRuntimeState[];
  failureCode?: PatchFailureCode;
  /** Retained when exact cleanup supersedes an otherwise terminal result. */
  primaryFailureCode?: PatchFailureCode;
}

export interface PatchExecutionRequest {
  plan: unknown;
  verificationProfile: string;
  context: FileIndexedContext;
  evidenceSession: FileIndexedEvidenceSession;
  limits?: MutationLimits;
  signal?: AbortSignal;
}

export interface PatchExecutionResult {
  state: PatchRuntimeState;
  receipt: PatchReceipt;
  postContext?: FileIndexedContext;
}

export interface PatchExecutorOptions {
  /** Host-only test seam; it receives only the disposable candidate worktree. */
  beforeWrite?: (worktreeSourceRoot: string) => Promise<void>;
  /** Host-only test seam used to force a post-write indexing failure. */
  beforeReindex?: (worktreeSourceRoot: string) => Promise<void>;
  /** Host-only test seam for failure during verification snapshot setup. */
  beforeMaterializeVerificationSnapshot?: (snapshotPath: string) => Promise<void>;
  /** Host-only test seam for certifying verification snapshot cleanup. */
  cleanupVerificationSnapshot?: (snapshotParent: string) => Promise<boolean>;
  /** Host-only test seam for adversarial snapshot-manifest drift checks. */
  beforeVerifySnapshot?: (snapshotPath: string, manifestPath: string) => Promise<void>;
  /** Host-only test seam for proving cleanup gates every post-worktree terminal result. */
  cleanupWorktree?: (
    repository: { readonly repositoryRoot: string },
    worktreePath: string,
    worktreeParent: string,
  ) => Promise<boolean>;
  /** Host-owned Docker image/runtime configuration; PatchPlan cannot influence it. */
  verification?: PatchVerifierOptions;
}

interface RepositorySource {
  repositoryRoot: string;
  selectedRelativePath: string;
}

interface VerificationSnapshot {
  parent: string;
  path: string;
  manifestPath: string;
}

interface CandidateManifest {
  version: 1;
  sourceRevision: string;
  files: Array<{ path: string; sha256: string; mode: number }>;
}

interface RootVerifierPort {
  profileNames(): string[];
  verifySnapshot(
    profileName: string,
    input: PatchVerificationInput,
    candidateSnapshotPath: string,
    candidateManifestPath: string,
    signal?: AbortSignal,
  ): Promise<PatchVerificationResult>;
}

class SourcePreflightError extends Error {
  readonly code: PatchFailureCode;

  constructor(code: PatchFailureCode) {
    super(code);
    this.name = "SourcePreflightError";
    this.code = code;
  }
}

class VerificationSnapshotCleanupError extends Error {
  constructor() {
    super("Verification snapshot cleanup could not be certified");
    this.name = "VerificationSnapshotCleanupError";
  }
}

class PatchAbortError extends Error {
  constructor() {
    super("Patch execution aborted");
    this.name = "PatchAbortError";
  }
}

const GIT_OPERATION_TIMEOUT_MS = 10_000;
const GIT_CLEANUP_TIMEOUT_MS = 10_000;

interface GitCommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new PatchAbortError();
}

function isInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
}

function hashBytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function runGit(
  cwd: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<string> {
  const { signal, timeoutMs = GIT_OPERATION_TIMEOUT_MS } = options;
  throwIfAborted(signal);
  const { promise, resolve: complete, reject } = Promise.withResolvers<string>();
  let aborted = false;
  let child: ChildProcess;
  const onAbort = (): void => {
    aborted = true;
    child.kill("SIGKILL");
  };
  try {
    child = execFile(
      "git",
      [...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        signal?.removeEventListener("abort", onAbort);
        if (aborted || signal?.aborted) {
          reject(new PatchAbortError());
          return;
        }
        if (error) {
          reject(
            new Error(
              `git ${args[0] ?? ""} failed${stderr.trim().length > 0 ? `: ${stderr.trim()}` : ""}`,
              { cause: error },
            ),
          );
          return;
        }
        complete(stdout);
      },
    );
  } catch (error) {
    if (signal?.aborted) throw new PatchAbortError();
    throw error;
  }
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return promise;
}

function terminalTransitions(state: TerminalPatchState): PatchRuntimeState[] {
  if (state === "ABORTED") return ["READ_ONLY", state];
  if (state === "PLAN_REJECTED") return ["READ_ONLY", "PLAN_SUBMITTED", state];
  if (state === "APPLY_FAILED") return ["READ_ONLY", "PLAN_SUBMITTED", "PLAN_VALIDATED", state];
  if (state === "POST_WRITE_INDEX_FAILED") {
    return ["READ_ONLY", "PLAN_SUBMITTED", "PLAN_VALIDATED", "APPLIED", state];
  }
  return [
    "READ_ONLY",
    "PLAN_SUBMITTED",
    "PLAN_VALIDATED",
    "APPLIED",
    "REINDEXED",
    "VERIFYING",
    state,
  ];
}

function failureReceipt(
  state: TerminalPatchState,
  preWriteRevision: string,
  failureCode: PatchFailureCode,
  partial: Partial<Omit<PatchReceipt, "state" | "preWriteRevision" | "failureCode">> = {},
): PatchReceipt {
  return {
    state,
    preWriteRevision,
    changedPaths: partial.changedPaths ?? [],
    normalizedDiffHash: partial.normalizedDiffHash,
    editHashes: partial.editHashes ?? [],
    postWriteEvidenceIds: partial.postWriteEvidenceIds ?? [],
    verificationProfile: partial.verificationProfile,
    checks: partial.checks ?? [],
    transitions: partial.transitions ?? terminalTransitions(state),
    postWriteRevision: partial.postWriteRevision,
    primaryFailureCode: partial.primaryFailureCode,
    failureCode,
  };
}

function repositoryPath(repository: RepositorySource, path: string): string {
  return repository.selectedRelativePath.length === 0
    ? path
    : `${repository.selectedRelativePath}/${path}`;
}

function splitNul(value: string): string[] {
  return value.split("\0").filter((entry) => entry.length > 0);
}

async function resolveRepositorySource(
  context: FileIndexedContext,
  signal: AbortSignal | undefined,
): Promise<RepositorySource> {
  if (!context.sourceRoot) throw new Error("Patch execution requires a Git-backed file context");
  const sourceRoot = await realpath(context.sourceRoot);
  const repositoryRoot = await realpath(
    (await runGit(sourceRoot, ["rev-parse", "--show-toplevel"], { signal })).trim(),
  );
  if (!isInside(repositoryRoot, sourceRoot)) {
    throw new Error("Indexed source root escapes the repository root");
  }
  return {
    repositoryRoot,
    selectedRelativePath: relative(repositoryRoot, sourceRoot).split(sep).join("/"),
  };
}

async function assertCleanSource(
  repository: RepositorySource,
  context: FileIndexedContext,
  signal: AbortSignal | undefined,
): Promise<void> {
  const revision = (await runGit(repository.repositoryRoot, ["rev-parse", "HEAD"], { signal })).trim();
  if (revision !== context.sourceRevision) throw new SourcePreflightError("SOURCE_REVISION_MISMATCH");
  const status = await runGit(
    repository.repositoryRoot,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { signal },
  );
  if (status.length > 0) throw new SourcePreflightError("APPLY_FAILED");
}

async function assertSupportedTargets(
  repository: RepositorySource,
  paths: readonly string[],
  signal: AbortSignal | undefined,
): Promise<void> {
  for (const path of paths) {
    const trackedPath = repositoryPath(repository, path);
    try {
      await runGit(
        repository.repositoryRoot,
        ["ls-files", "--error-unmatch", "--", trackedPath],
        { signal },
      );
    } catch (error) {
      if (error instanceof PatchAbortError) throw error;
      throw new SourcePreflightError("FILE_NOT_TRACKED");
    }
    const sourcePath = resolve(repository.repositoryRoot, trackedPath);
    if (!isInside(repository.repositoryRoot, sourcePath)) {
      throw new SourcePreflightError("PATH_OUT_OF_SCOPE");
    }
    const info = await lstat(sourcePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new SourcePreflightError("FILE_KIND_UNSUPPORTED");
    }
  }
}

async function assertResolvedCandidateParent(
  worktreeSourceRoot: string,
  target: string,
): Promise<void> {
  const resolvedRoot = await realpath(worktreeSourceRoot);
  const resolvedParent = await realpath(dirname(target));
  if (!isInside(resolvedRoot, resolvedParent)) {
    throw new SourcePreflightError("PATH_OUT_OF_SCOPE");
  }
}

async function assertWorktreeMatchesIndexed(
  context: FileIndexedContext,
  worktreeSourceRoot: string,
  changedPaths: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const modes = new Map<string, number>();
  for (const path of changedPaths) {
    const target = resolve(worktreeSourceRoot, path);
    if (!isInside(worktreeSourceRoot, target)) throw new SourcePreflightError("PATH_OUT_OF_SCOPE");
    await assertResolvedCandidateParent(worktreeSourceRoot, target);
    const expected = Buffer.from(context.read(path), "utf8");
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new SourcePreflightError("FILE_KIND_UNSUPPORTED");
    }
    const actual = await readFile(target);
    if (hashBytes(actual) !== hashBytes(expected)) {
      throw new SourcePreflightError("OLD_SOURCE_MISMATCH");
    }
    modes.set(path, info.mode & 0o777);
  }
  return modes;
}

async function atomicallyReplaceCandidateFile(
  worktreeSourceRoot: string,
  path: string,
  content: string,
  expectedMode: number,
): Promise<void> {
  const target = resolve(worktreeSourceRoot, path);
  const parent = dirname(target);
  if (!isInside(worktreeSourceRoot, target)) throw new SourcePreflightError("PATH_OUT_OF_SCOPE");
  await assertResolvedCandidateParent(worktreeSourceRoot, target);
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new SourcePreflightError("FILE_KIND_UNSUPPORTED");
  }
  const temporary = join(parent, `.${basename(target)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      expectedMode,
    );
    await handle.writeFile(content, "utf8");
    await handle.chmod(expectedMode);
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function certifyCompleteCandidateWorktree(
  repository: RepositorySource,
  worktreePath: string,
  worktreeSourceRoot: string,
  candidate: PatchCandidate,
  signal: AbortSignal | undefined,
): Promise<void> {
  const expectedStatus = new Set(
    candidate.changedPaths.map((path) => ` M ${repositoryPath(repository, path)}`),
  );
  const status = splitNul(
    await runGit(
      worktreePath,
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
      ],
      { signal },
    ),
  );
  if (
    status.length !== expectedStatus.size ||
    status.some((entry) => !expectedStatus.has(entry))
  ) {
    throw new SourcePreflightError("APPLY_FAILED");
  }
  for (const [path, expectedContent] of candidate.files) {
    const target = resolve(worktreeSourceRoot, path);
    if (!isInside(worktreeSourceRoot, target)) throw new SourcePreflightError("PATH_OUT_OF_SCOPE");
    const actual = await readFile(target);
    if (hashBytes(actual) !== hashBytes(Buffer.from(expectedContent, "utf8"))) {
      throw new SourcePreflightError("APPLY_FAILED");
    }
  }
  const modeSummary = await runGit(worktreePath, ["diff", "--summary"], { signal });
  if (modeSummary.length > 0) throw new SourcePreflightError("APPLY_FAILED");
}

async function buildPostWriteContext(
  sourceRoot: string,
  limits: FileIndexedContext["limits"],
  signal: AbortSignal | undefined,
): Promise<FileIndexedContext> {
  throwIfAborted(signal);
  let loaded: FileIndexedContext;
  try {
    loaded = await loadGitDirectoryContext(sourceRoot, limits, { signal });
  } catch (error) {
    if (signal?.aborted) throw new PatchAbortError();
    throw error;
  }
  throwIfAborted(signal);
  return createFileIndexedContext(
    loaded.files.map((metadata) => ({ path: metadata.path, content: loaded.read(metadata.path) })),
    {
      ...limits,
      sourceRoot: loaded.sourceRoot,
      sourceRevision: `sha256:${loaded.corpusId}`,
    },
  );
}

function issuePostWriteEvidence(context: FileIndexedContext, changedPaths: readonly string[]): string[] {
  return changedPaths.map((path) => {
    const metadata = context.files.find((file) => file.path === path);
    if (!metadata || metadata.lines < 1) throw new Error("Changed file has no indexable post-write evidence");
    return context.readLines(path, 1, 1).id;
  });
}

async function isAbsent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

async function cleanupExactDirectory(path: string): Promise<boolean> {
  try {
    await rm(path, { recursive: true, force: true });
    return await isAbsent(path);
  } catch {
    return false;
  }
}

async function cleanupDisposableWorktree(
  repository: { readonly repositoryRoot: string },
  worktreePath: string,
  worktreeParent: string,
): Promise<boolean> {
  try {
    await runGit(
      repository.repositoryRoot,
      ["worktree", "remove", "--force", worktreePath],
      { timeoutMs: GIT_CLEANUP_TIMEOUT_MS },
    );
    if (!await isAbsent(worktreePath)) return false;
    const records = await runGit(
      repository.repositoryRoot,
      ["worktree", "list", "--porcelain"],
      { timeoutMs: GIT_CLEANUP_TIMEOUT_MS },
    );
    if (records.includes(`worktree ${worktreePath}\n`)) return false;
    return cleanupExactDirectory(worktreeParent);
  } catch {
    return false;
  }
}

async function cleanupPartialWorktreeCreation(
  repository: { readonly repositoryRoot: string },
  worktreePath: string,
  worktreeParent: string,
): Promise<boolean> {
  try {
    const records = await runGit(
      repository.repositoryRoot,
      ["worktree", "list", "--porcelain"],
      { timeoutMs: GIT_CLEANUP_TIMEOUT_MS },
    );
    if (records.includes(`worktree ${worktreePath}\n`)) {
      return cleanupDisposableWorktree(repository, worktreePath, worktreeParent);
    }
    return cleanupExactDirectory(worktreeParent);
  } catch {
    return false;
  }
}

async function trackedPathsInSelection(
  repository: RepositorySource,
  worktreePath: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const tracked = splitNul(await runGit(worktreePath, ["ls-files", "-z"], { signal }));
  const prefix = repository.selectedRelativePath;
  const selected = tracked
    .filter((path) => prefix.length === 0 || path.startsWith(`${prefix}/`))
    .map((path) => prefix.length === 0 ? path : path.slice(prefix.length + 1));
  if (selected.length === 0 || new Set(selected).size !== selected.length) {
    throw new SourcePreflightError("APPLY_FAILED");
  }
  return selected.sort((left, right) => left.localeCompare(right));
}

async function createVerificationManifest(
  snapshotPath: string,
  parent: string,
  trackedPaths: readonly string[],
  sourceRevision: string,
): Promise<string> {
  const files: CandidateManifest["files"] = [];
  for (const path of trackedPaths) {
    const source = resolve(snapshotPath, path);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new SourcePreflightError("FILE_KIND_UNSUPPORTED");
    }
    files.push({
      path,
      sha256: hashBytes(await readFile(source)),
      mode: info.mode & 0o777,
    });
  }
  const manifest: CandidateManifest = { version: 1, sourceRevision, files };
  const manifestPath = join(parent, "candidate-manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest), { encoding: "utf8", mode: 0o644 });
  await chmod(parent, 0o755);
  await chmod(snapshotPath, 0o755);
  await chmod(manifestPath, 0o644);
  return manifestPath;
}

async function materializeVerificationSnapshot(
  repository: RepositorySource,
  worktreePath: string,
  worktreeSourceRoot: string,
  candidate: PatchCandidate,
  sourceRevision: string,
  beforeMaterialize: ((snapshotPath: string) => Promise<void>) | undefined,
  cleanupSnapshot: (snapshotParent: string) => Promise<boolean>,
  signal: AbortSignal | undefined,
): Promise<VerificationSnapshot> {
  const parent = await mkdtemp(join(tmpdir(), "pi-rlm-patch-verify-"));
  const snapshotPath = join(parent, "candidate");
  try {
    await mkdir(snapshotPath);
    await beforeMaterialize?.(snapshotPath);
    throwIfAborted(signal);
    const trackedPaths = await trackedPathsInSelection(repository, worktreePath, signal);
    for (const path of trackedPaths) {
      const source = resolve(worktreeSourceRoot, path);
      const destination = resolve(snapshotPath, path);
      if (!isInside(worktreeSourceRoot, source) || !isInside(snapshotPath, destination)) {
        throw new SourcePreflightError("PATH_OUT_OF_SCOPE");
      }
      const info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new SourcePreflightError("FILE_KIND_UNSUPPORTED");
      }
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      await chmod(dirname(destination), 0o755);
      await chmod(destination, (info.mode & 0o777) | 0o444);
      throwIfAborted(signal);
    }
    await runGit(snapshotPath, ["init", "--quiet"], { signal });
    await runGit(snapshotPath, ["add", "--all", "--force"], { signal });
    await runGit(
      snapshotPath,
      [
        "-c",
        "user.name=Pi RLM verification",
        "-c",
        "user.email=verification@pi-rlm.invalid",
        "-c",
        "commit.gpgSign=false",
        "commit",
        "--quiet",
        "-m",
        "candidate snapshot",
      ],
      { signal },
    );
    const snapshotTracked = splitNul(
      await runGit(snapshotPath, ["ls-files", "-z"], { signal }),
    );
    const expectedTracked = new Set(trackedPaths);
    if (
      snapshotTracked.length !== expectedTracked.size ||
      snapshotTracked.some((path) => !expectedTracked.has(path))
    ) {
      throw new SourcePreflightError("APPLY_FAILED");
    }
    const status = await runGit(
      snapshotPath,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { signal },
    );
    if (status.length > 0) throw new SourcePreflightError("APPLY_FAILED");
    for (const [path, expectedContent] of candidate.files) {
      const copied = await readFile(resolve(snapshotPath, path));
      if (hashBytes(copied) !== hashBytes(Buffer.from(expectedContent, "utf8"))) {
        throw new SourcePreflightError("APPLY_FAILED");
      }
    }
    const gitDirectory = await lstat(join(snapshotPath, ".git"));
    if (!gitDirectory.isDirectory() || gitDirectory.isSymbolicLink()) {
      throw new SourcePreflightError("APPLY_FAILED");
    }
    const manifestPath = await createVerificationManifest(
      snapshotPath,
      parent,
      trackedPaths,
      sourceRevision,
    );
    return { parent, path: snapshotPath, manifestPath };
  } catch (error) {
    let cleanupSucceeded = false;
    try {
      cleanupSucceeded = await cleanupSnapshot(parent);
    } catch {
      cleanupSucceeded = false;
    }
    if (!cleanupSucceeded) throw new VerificationSnapshotCleanupError();
    throw error;
  }
}

function cleanupFailureResult(
  primary: PatchExecutionResult,
  preWriteRevision: string,
): PatchExecutionResult {
  const receipt = primary.receipt;
  return {
    state: "CLEANUP_FAILED",
    receipt: failureReceipt("CLEANUP_FAILED", preWriteRevision, "CLEANUP_FAILED", {
      changedPaths: receipt.changedPaths,
      normalizedDiffHash: receipt.normalizedDiffHash,
      editHashes: receipt.editHashes,
      postWriteRevision: receipt.postWriteRevision,
      postWriteEvidenceIds: receipt.postWriteEvidenceIds,
      verificationProfile: receipt.verificationProfile,
      checks: receipt.checks,
      primaryFailureCode: receipt.failureCode === "CLEANUP_FAILED"
        ? receipt.primaryFailureCode
        : receipt.failureCode,
      transitions: [...receipt.transitions.slice(0, -1), "CLEANUP_FAILED"],
    }),
    postContext: primary.postContext,
  };
}

function verificationSetupFailure(
  preWriteRevision: string,
  partialReceipt: Partial<Omit<PatchReceipt, "state" | "preWriteRevision" | "failureCode">>,
  postContext: FileIndexedContext,
  postWriteEvidenceIds: readonly string[],
): PatchExecutionResult {
  return {
    state: "VERIFICATION_FAILED",
    receipt: failureReceipt("VERIFICATION_FAILED", preWriteRevision, "VERIFICATION_SETUP_FAILED", {
      ...partialReceipt,
      postWriteRevision: postContext.sourceRevision,
      postWriteEvidenceIds,
      transitions: [
        "READ_ONLY",
        "PLAN_SUBMITTED",
        "PLAN_VALIDATED",
        "APPLIED",
        "REINDEXED",
        "VERIFICATION_FAILED",
      ],
    }),
    postContext,
  };
}

export class PatchExecutor {
  private readonly verifier: RootVerifierPort;
  private readonly authority: RootPatchAuthority;
  private readonly beforeWrite: ((worktreeSourceRoot: string) => Promise<void>) | undefined;
  private readonly beforeReindex: ((worktreeSourceRoot: string) => Promise<void>) | undefined;
  private readonly beforeMaterializeVerificationSnapshot: ((snapshotPath: string) => Promise<void>) | undefined;
  private readonly beforeVerifySnapshot: ((snapshotPath: string, manifestPath: string) => Promise<void>) | undefined;
  private readonly cleanupVerificationSnapshot: (snapshotParent: string) => Promise<boolean>;
  private readonly cleanupWorktree: NonNullable<PatchExecutorOptions["cleanupWorktree"]>;
  private submittedPlans = 0;
  private terminal = false;

  private constructor(
    verificationProfiles: readonly VerificationProfile[],
    options: PatchExecutorOptions = {},
  ) {
    this.verifier = PatchVerifier.createRootPort(verificationProfiles, options.verification);
    this.authority = createRootPatchAuthority();
    this.beforeWrite = options.beforeWrite;
    this.beforeReindex = options.beforeReindex;
    this.beforeMaterializeVerificationSnapshot = options.beforeMaterializeVerificationSnapshot;
    this.beforeVerifySnapshot = options.beforeVerifySnapshot;
    this.cleanupVerificationSnapshot = options.cleanupVerificationSnapshot ?? cleanupExactDirectory;
    this.cleanupWorktree = options.cleanupWorktree ?? cleanupDisposableWorktree;
  }

  static createRoot(
    verificationProfiles: readonly VerificationProfile[],
    options: PatchExecutorOptions = {},
  ): PatchExecutor {
    return new PatchExecutor(verificationProfiles, options);
  }

  async execute(request: PatchExecutionRequest): Promise<PatchExecutionResult> {
    const preWriteRevision = request.context.sourceRevision;
    if (request.signal?.aborted) {
      this.terminal = true;
      return {
        state: "ABORTED",
        receipt: failureReceipt("ABORTED", preWriteRevision, "ABORTED", {
          transitions: ["READ_ONLY", "ABORTED"],
        }),
      };
    }
    if (this.terminal) {
      return {
        state: "PLAN_REJECTED",
        receipt: failureReceipt("PLAN_REJECTED", preWriteRevision, "MUTATION_BUDGET_EXCEEDED"),
      };
    }

    const planRevisionCount = this.submittedPlans;
    this.submittedPlans += 1;
    const verificationProfile = request.verificationProfile;
    if (!this.verifier.profileNames().includes(verificationProfile)) {
      return {
        state: "PLAN_REJECTED",
        receipt: failureReceipt("PLAN_REJECTED", preWriteRevision, "PATCH_SCHEMA_INVALID"),
      };
    }
    const validationRequest: PatchPlanValidationRequest = {
      ...request,
      authority: this.authority,
      submittedPlanCount: 1,
      planRevisionCount,
    };
    let validated: ValidatedPatchPlan;
    try {
      validated = validatePatchPlan(validationRequest);
    } catch (error) {
      const failureCode = error instanceof PatchPlanError ? error.code : "PATCH_SCHEMA_INVALID";
      const maximumRevisions = request.limits?.maxPlanRevisions ?? DEFAULT_MUTATION_LIMITS.maxPlanRevisions;
      if (planRevisionCount >= maximumRevisions) this.terminal = true;
      return {
        state: "PLAN_REJECTED",
        receipt: failureReceipt("PLAN_REJECTED", preWriteRevision, failureCode),
      };
    }
    this.terminal = true;

    let repository: RepositorySource;
    try {
      repository = await resolveRepositorySource(request.context, request.signal);
      throwIfAborted(request.signal);
      await assertCleanSource(repository, request.context, request.signal);
      await assertSupportedTargets(repository, validated.changedPaths, request.signal);
    } catch (error) {
      if (error instanceof PatchAbortError) {
        return {
          state: "ABORTED",
          receipt: failureReceipt("ABORTED", preWriteRevision, "ABORTED", {
            changedPaths: validated.changedPaths,
            editHashes: validated.editHashes,
            verificationProfile,
            transitions: ["READ_ONLY", "PLAN_SUBMITTED", "PLAN_VALIDATED", "ABORTED"],
          }),
        };
      }
      const failureCode = error instanceof SourcePreflightError ? error.code : "APPLY_FAILED";
      const state: TerminalPatchState =
        failureCode === "APPLY_FAILED" ? "APPLY_FAILED" : "PLAN_REJECTED";
      return {
        state,
        receipt: failureReceipt(state, preWriteRevision, failureCode, {
          changedPaths: validated.changedPaths,
          editHashes: validated.editHashes,
          verificationProfile,
        }),
      };
    }

    const candidate = generatePatchCandidate(request.context, validated);
    const partialReceipt = {
      changedPaths: candidate.changedPaths,
      normalizedDiffHash: candidate.normalizedDiffHash,
      editHashes: candidate.editHashes,
      verificationProfile,
    };
    let worktreeParent: string | undefined;
    let worktreePath: string | undefined;
    let worktreeCreated = false;
    let verificationSnapshot: VerificationSnapshot | undefined;
    let primary: PatchExecutionResult | undefined;
    let abortTransitions: PatchRuntimeState[] = [
      "READ_ONLY",
      "PLAN_SUBMITTED",
      "PLAN_VALIDATED",
    ];

    try {
      throwIfAborted(request.signal);
      worktreeParent = await mkdtemp(join(tmpdir(), "pi-rlm-patch-worktree-"));
      throwIfAborted(request.signal);
      worktreePath = join(worktreeParent, "candidate");
      await runGit(
        repository.repositoryRoot,
        ["worktree", "add", "--detach", worktreePath, preWriteRevision],
        { signal: request.signal },
      );
      worktreeCreated = true;
      throwIfAborted(request.signal);
      const worktreeSourceRoot = resolve(worktreePath, repository.selectedRelativePath);
      if (!isInside(worktreePath, worktreeSourceRoot)) throw new Error("Worktree source path escapes disposable worktree");
      throwIfAborted(request.signal);
      await this.beforeWrite?.(worktreeSourceRoot);
      throwIfAborted(request.signal);
      const candidateModes = await assertWorktreeMatchesIndexed(
        request.context,
        worktreeSourceRoot,
        candidate.changedPaths,
      );
      for (const [path, content] of candidate.files) {
        throwIfAborted(request.signal);
        const expectedMode = candidateModes.get(path);
        if (expectedMode === undefined) throw new SourcePreflightError("APPLY_FAILED");
        await atomicallyReplaceCandidateFile(worktreeSourceRoot, path, content, expectedMode);
        if (!abortTransitions.includes("APPLIED")) abortTransitions = [...abortTransitions, "APPLIED"];
        throwIfAborted(request.signal);
      }
      await certifyCompleteCandidateWorktree(
        repository,
        worktreePath,
        worktreeSourceRoot,
        candidate,
        request.signal,
      );
      throwIfAborted(request.signal);

      let postContext: FileIndexedContext | undefined;
      let postWriteEvidenceIds: string[] | undefined;
      try {
        await this.beforeReindex?.(worktreeSourceRoot);
        throwIfAborted(request.signal);
        postContext = await buildPostWriteContext(
          worktreeSourceRoot,
          request.context.limits,
          request.signal,
        );
        postWriteEvidenceIds = issuePostWriteEvidence(postContext, candidate.changedPaths);
        abortTransitions = [...abortTransitions, "REINDEXED"];
        throwIfAborted(request.signal);
      } catch (error) {
        if (error instanceof PatchAbortError) throw error;
        primary = {
          state: "POST_WRITE_INDEX_FAILED",
          receipt: failureReceipt("POST_WRITE_INDEX_FAILED", preWriteRevision, "POST_WRITE_INDEX_FAILED", partialReceipt),
        };
      }

      if (!primary && postContext && postWriteEvidenceIds) {
        try {
          throwIfAborted(request.signal);
          verificationSnapshot = await materializeVerificationSnapshot(
            repository,
            worktreePath,
            worktreeSourceRoot,
            candidate,
            postContext.sourceRevision,
            this.beforeMaterializeVerificationSnapshot,
            this.cleanupVerificationSnapshot,
            request.signal,
          );
          throwIfAborted(request.signal);
          await this.beforeVerifySnapshot?.(
            verificationSnapshot.path,
            verificationSnapshot.manifestPath,
          );
          throwIfAborted(request.signal);
          abortTransitions = [...abortTransitions, "VERIFYING"];
          const verification = await this.verifier.verifySnapshot(
            verificationProfile,
            {
              changedPaths: candidate.changedPaths,
              normalizedDiffHash: candidate.normalizedDiffHash,
              preWriteRevision,
              postWriteRevision: postContext.sourceRevision,
              postWriteEvidenceIds,
            },
            verificationSnapshot.path,
            verificationSnapshot.manifestPath,
            request.signal,
          );
          if (!verification.ok) {
            const verificationFailureCode = verification.failureCode ?? "FOCUSED_CHECK_FAILED";
            const verificationState: TerminalPatchState =
              verificationFailureCode === "ABORTED" ? "ABORTED" : "VERIFICATION_FAILED";
            const verificationFailure: PatchExecutionResult = {
              state: verificationState,
              receipt: failureReceipt(verificationState, preWriteRevision, verificationFailureCode, {
                ...partialReceipt,
                postWriteRevision: postContext.sourceRevision,
                postWriteEvidenceIds,
                checks: verification.checks,
                primaryFailureCode: verification.primaryFailureCode,
                ...(verificationFailureCode === "ABORTED"
                  ? { transitions: [...abortTransitions, "ABORTED"] }
                  : {}),
              }),
              postContext,
            };
            primary = verificationFailureCode === "CLEANUP_FAILED"
              ? cleanupFailureResult(
                {
                  ...verificationFailure,
                  receipt: {
                    ...verificationFailure.receipt,
                    failureCode: verification.primaryFailureCode,
                  },
                },
                preWriteRevision,
              )
              : verificationFailure;
          }
          if (verification.ok) {
            throwIfAborted(request.signal);
            try {
              await certifyCompleteCandidateWorktree(
                repository,
                worktreePath,
                worktreeSourceRoot,
                candidate,
                request.signal,
              );
              throwIfAborted(request.signal);
              primary = {
                state: "ACCEPTED",
                receipt: {
                  state: "ACCEPTED",
                  preWriteRevision,
                  postWriteRevision: postContext.sourceRevision,
                  changedPaths: candidate.changedPaths,
                  normalizedDiffHash: candidate.normalizedDiffHash,
                  editHashes: candidate.editHashes,
                  postWriteEvidenceIds,
                  verificationProfile,
                  checks: verification.checks,
                  transitions: ["READ_ONLY", "PLAN_SUBMITTED", "PLAN_VALIDATED", "APPLIED", "REINDEXED", "VERIFYING", "ACCEPTED"],
                },
                postContext,
              };
            } catch (error) {
              if (error instanceof PatchAbortError) throw error;
              primary = {
                state: "VERIFICATION_FAILED",
                receipt: failureReceipt("VERIFICATION_FAILED", preWriteRevision, "DIFF_POLICY_FAILED", {
                  ...partialReceipt,
                  postWriteRevision: postContext.sourceRevision,
                  postWriteEvidenceIds,
                  checks: verification.checks,
                }),
                postContext,
              };
            }
          }
        } catch (error) {
          if (error instanceof PatchAbortError) throw error;
          const setupFailure = verificationSetupFailure(
            preWriteRevision,
            partialReceipt,
            postContext,
            postWriteEvidenceIds,
          );
          primary = error instanceof VerificationSnapshotCleanupError
            ? cleanupFailureResult(setupFailure, preWriteRevision)
            : setupFailure;
        }
      }
    } catch (error) {
      if (error instanceof VerificationSnapshotCleanupError) {
        primary = cleanupFailureResult(
          {
            state: "APPLY_FAILED",
            receipt: failureReceipt("APPLY_FAILED", preWriteRevision, "APPLY_FAILED", partialReceipt),
          },
          preWriteRevision,
        );
      } else if (error instanceof PatchAbortError) {
        primary = {
          state: "ABORTED",
          receipt: failureReceipt("ABORTED", preWriteRevision, "ABORTED", {
            ...partialReceipt,
            transitions: [...abortTransitions, "ABORTED"],
          }),
        };
      } else {
        const failureCode = error instanceof SourcePreflightError ? error.code : "APPLY_FAILED";
        const state: TerminalPatchState = failureCode === "OLD_SOURCE_MISMATCH" ? "PLAN_REJECTED" : "APPLY_FAILED";
        primary = {
          state,
          receipt: failureReceipt(state, preWriteRevision, failureCode, partialReceipt),
        };
      }
    }

    if (!primary) {
      primary = {
        state: "APPLY_FAILED",
        receipt: failureReceipt("APPLY_FAILED", preWriteRevision, "APPLY_FAILED", partialReceipt),
      };
    }

    let cleanupSucceeded = true;
    if (verificationSnapshot) {
      try {
        cleanupSucceeded = await this.cleanupVerificationSnapshot(verificationSnapshot.parent) && cleanupSucceeded;
      } catch {
        cleanupSucceeded = false;
      }
    }
    if (worktreeCreated && worktreePath && worktreeParent) {
      try {
        cleanupSucceeded = await this.cleanupWorktree(
          { repositoryRoot: repository.repositoryRoot },
          worktreePath,
          worktreeParent,
        ) && cleanupSucceeded;
      } catch {
        cleanupSucceeded = false;
      }
    } else if (worktreePath && worktreeParent) {
      cleanupSucceeded = await cleanupPartialWorktreeCreation(
        { repositoryRoot: repository.repositoryRoot },
        worktreePath,
        worktreeParent,
      ) && cleanupSucceeded;
    } else if (worktreeParent) {
      cleanupSucceeded = await cleanupExactDirectory(worktreeParent) && cleanupSucceeded;
    }

    return cleanupSucceeded ? primary : cleanupFailureResult(primary, preWriteRevision);
  }
}
