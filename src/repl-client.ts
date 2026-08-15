import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  FileIndexedContext,
  type FileIndexedEvidenceSession,
  createFileIndexedEvidenceSession,
  readIndexedFile,
  type IndexedObservationResult,
  type IndexedSearchHit,
} from "./file-context.ts";

import { derivePatchPrecondition } from "./patch-plan.ts";
import type { PatchPlan } from "./patch-plan.ts";
import {
  requiresLeadingNewlineSeparator,
  requiresTerminalNewline,
  validateNativeEditTargets,
} from "./native-edits.ts";
import type {
  NativePatchEditTarget,
  PreparedNativePatchEdit,
} from "./native-edits.ts";
import {
  isExactOwnedContainerNotFound,
  type DockerCommandResult,
  type DockerCommandRunner,
} from "./patch-verifier.ts";
import type {
  CorpusCallRequest,
  CorpusCallResult,
  CorpusHistoryEntry,
  EvidenceQuery,
  ParentToWorkerMessage,
  PiRlmFactContract,
  PiRlmFactExtractionEvent,
  PiRlmFactEvent,
  PiRlmFactFinalizationBlock,
  PiRlmFactStateSnapshot,
  PreparedPatchReplace,
  ReplBudgetSnapshot,
  SubcallReplan,
  WorkerCallKind,
  WorkerCallResult,
  WorkerContextDescriptor,
  WorkerAnswerMode,
  WorkerToParentMessage,
} from "./worker-protocol.ts";

export type ReplIsolationMode = "subprocess" | "docker";

export interface ReplIsolationOptions {
  mode?: ReplIsolationMode;
  dockerImage?: string;
  startupTimeoutMs?: number;
  executionTimeoutMs?: number;
  syncExecutionTimeoutMs?: number;
  /** Host-only seam for bounded Docker container lifecycle checks. */
  dockerLifecycleRunner?: DockerCommandRunner;
}

export interface ReplWorkerCreateOptions {
  isolation?: ReplIsolationOptions;
  factContract?: PiRlmFactContract;
  answerMode?: WorkerAnswerMode;
  corpusCallObserver?: CorpusCallObserver;
  patchPlanning?: boolean;
  /** Bounds startup as well as every later execution. */
  signal?: AbortSignal;
}

export interface ReplExecutionResult {
  stdout: string;
  stdoutCharacters: number;
  observations: IndexedObservationResult[];
  corpusHistory: CorpusHistoryEntry[];
  searchResults: IndexedSearchHit[];
  ready: boolean;
  answerContentDefined?: boolean;
  answerContent?: string;
  error?: string;
  replan?: SubcallReplan;
  factState?: PiRlmFactStateSnapshot;
  factEvents: PiRlmFactEvent[];
  factExtractions: PiRlmFactExtractionEvent[];
  factFinalized: boolean;
  factFinalizationBlock?: PiRlmFactFinalizationBlock;
  submittedPatchPlan?: PatchPlan;
  preparedPatchReplace?: PreparedPatchReplace;
  patchSubmitAttempts?: number;
  patchSubmitRejections?: number;
}


export type WorkerCallHandler = (
  kind: WorkerCallKind,
  queries: EvidenceQuery[],
  model?: string,
) => Promise<WorkerCallResult[]>;
export type CorpusCallObserver = (request: CorpusCallRequest) => void;

interface PendingExecution {
  resolve: (result: ReplExecutionResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 300_000;
const DEFAULT_SYNC_EXECUTION_TIMEOUT_MS = 5_000;
const MAX_STDERR_CHARS = 8_000;
const DOCKER_LIFECYCLE_TIMEOUT_MS = 5_000;
const DOCKER_LIFECYCLE_OUTPUT_LIMIT_BYTES = 16 * 1024;

export class ReplWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplWorkerError";
  }
}

export class ReplDockerCleanupError extends ReplWorkerError {
  constructor() {
    super("Docker REPL container cleanup could not be certified");
    this.name = "ReplDockerCleanupError";
  }
}

interface DockerLifecycleResult extends DockerCommandResult {
  startError?: Error;
}

function appendLifecycleOutput(
  chunks: Buffer[],
  bytes: { value: number },
  chunk: Buffer,
): boolean {
  const remaining = DOCKER_LIFECYCLE_OUTPUT_LIMIT_BYTES - bytes.value;
  if (remaining <= 0) return false;
  if (chunk.length > remaining) {
    chunks.push(chunk.subarray(0, remaining));
    bytes.value += remaining;
    return false;
  }
  chunks.push(chunk);
  bytes.value += chunk.length;
  return true;
}

function executeDockerLifecycleCommand(
  args: readonly string[],
  dockerLifecycleRunner: DockerCommandRunner | undefined,
): Promise<DockerLifecycleResult> {
  if (dockerLifecycleRunner) {
    const lifecycle = dockerLifecycleRunner(
      args,
      DOCKER_LIFECYCLE_TIMEOUT_MS,
      DOCKER_LIFECYCLE_OUTPUT_LIMIT_BYTES,
    ).catch((error: unknown) => ({
      exitCode: -1,
      output: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      timedOut: false,
      outputTruncated: false,
      startError: error instanceof Error ? error : new Error("Docker lifecycle command failed to start"),
    }));
    return Promise.race([
      lifecycle,
      delay(DOCKER_LIFECYCLE_TIMEOUT_MS, undefined, { ref: false }).then(() => ({
        exitCode: -1,
        output: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        timedOut: true,
        outputTruncated: false,
      })),
    ]);
  }

  const deferred = Promise.withResolvers<DockerLifecycleResult>();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const outputChunks: Buffer[] = [];
  const stdoutBytes = { value: 0 };
  const stderrBytes = { value: 0 };
  const outputBytes = { value: 0 };
  let settled = false;
  let timedOut = false;
  let outputTruncated = false;
  let timeout: NodeJS.Timeout | undefined;
  let child: ChildProcess;
  const finish = (result: DockerLifecycleResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    deferred.resolve(result);
  };

  try {
    child = spawn("docker", [...args], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    finish({
      exitCode: -1,
      output: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      timedOut: false,
      outputTruncated: false,
      startError: error instanceof Error ? error : new Error("Docker lifecycle command failed to start"),
    });
    return deferred.promise;
  }

  const append = (chunks: Buffer[], bytes: { value: number }) => (chunk: Buffer): void => {
    const streamAccepted = appendLifecycleOutput(chunks, bytes, chunk);
    const outputAccepted = appendLifecycleOutput(outputChunks, outputBytes, chunk);
    outputTruncated = !streamAccepted || !outputAccepted || outputTruncated;
  };
  child.stdout?.on("data", append(stdoutChunks, stdoutBytes));
  child.stderr?.on("data", append(stderrChunks, stderrBytes));
  child.once("error", (error) => {
    finish({
      exitCode: -1,
      output: Buffer.concat(outputChunks),
      stdout: Buffer.concat(stdoutChunks),
      stderr: Buffer.concat(stderrChunks),
      timedOut,
      outputTruncated,
      startError: error,
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
    });
  });
  timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, DOCKER_LIFECYCLE_TIMEOUT_MS);
  return deferred.promise;
}

export class ReplWorkerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly callHandler: WorkerCallHandler;
  private readonly executionTimeoutMs: number;
  private readonly syncExecutionTimeoutMs: number;
  private readonly containerName: string | undefined;
  private readonly dockerLifecycleRunner: DockerCommandRunner | undefined;
  private readonly fileContext: FileIndexedContext | undefined;
  private readonly fileEvidenceSession: FileIndexedEvidenceSession | undefined;
  private readonly corpusCallObserver: CorpusCallObserver | undefined;
  private readonly ready: Promise<void>;
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((error: Error) => void) | undefined;
  private pendingExecution: PendingExecution | undefined;
  private writeChain = Promise.resolve();
  private stderr = "";
  private closed = false;
  private gracefulClose = false;
  private dockerCleanup: Promise<void> | undefined;
  private readonly patchPlanning: boolean;
  private failure: Promise<Error> | undefined;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    callHandler: WorkerCallHandler,
    options: ReplIsolationOptions,
    containerName?: string,
    fileContext?: FileIndexedContext,
    corpusCallObserver?: CorpusCallObserver,
    patchPlanning = false,
  ) {
    this.child = child;
    this.callHandler = callHandler;
    this.executionTimeoutMs = options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    this.syncExecutionTimeoutMs = options.syncExecutionTimeoutMs ?? DEFAULT_SYNC_EXECUTION_TIMEOUT_MS;
    this.containerName = containerName;
    this.dockerLifecycleRunner = options.dockerLifecycleRunner;
    this.fileContext = fileContext;
    this.fileEvidenceSession = fileContext
      ? createFileIndexedEvidenceSession(fileContext)
      : undefined;
    this.corpusCallObserver = corpusCallObserver;
    this.patchPlanning = patchPlanning;
    const ready = Promise.withResolvers<void>();
    this.ready = ready.promise;
    this.resolveReady = ready.resolve;
    this.rejectReady = ready.reject;

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.receiveLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_CHARS);
    });
    child.once("error", (error) => this.fail(new ReplWorkerError(`REPL worker failed to start: ${error.message}`)));
    child.once("exit", (code, signal) => {
      if (this.gracefulClose) return;
      const detail = this.stderr ? `\n${this.stderr}` : "";
      this.fail(
        new ReplWorkerError(
          `REPL worker exited unexpectedly (code=${String(code)}, signal=${String(signal)})${detail}`,
        ),
      );
    });
  }

  static async create(
    context: string | FileIndexedContext,
    callHandler: WorkerCallHandler,
    options: ReplWorkerCreateOptions = {},
  ): Promise<ReplWorkerClient> {
    options.signal?.throwIfAborted();
    if (options.patchPlanning && !(context instanceof FileIndexedContext)) {
      throw new ReplWorkerError("Patch planning requires a file-indexed context");
    }
    const isolation = options.isolation ?? {};
    const workerPath = fileURLToPath(new URL("./repl-worker.ts", import.meta.url));
    const mode = isolation.mode ?? "subprocess";
    if (options.patchPlanning && mode !== "docker") {
      throw new ReplWorkerError("Patch planning requires Docker REPL isolation");
    }
    let child: ChildProcessWithoutNullStreams;
    let containerName: string | undefined;

    if (mode === "docker") {
      containerName = `pi-rlm-${process.pid}-${randomUUID().slice(0, 8)}`;
      const sourceDirectory = dirname(workerPath);
      child = spawn(
        "docker",
        [
          "run",
          "--rm",
          "--name",
          containerName,
          "--network=none",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--pids-limit=64",
          "--memory=256m",
          "--cpus=1",
          "--user=65534:65534",
          "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
          "-i",
          "-v",
          `${sourceDirectory}:/app/src:ro`,
          isolation.dockerImage ?? "node:24-alpine",
          "node",
          "/app/src/repl-worker.ts",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
    } else {
      child = spawn(process.execPath, [workerPath], {
        env: {
          HOME: process.env.HOME ?? "",
          PATH: process.env.PATH ?? "",
          NODE_NO_WARNINGS: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    }

    const fileContext = context instanceof FileIndexedContext ? context : undefined;
    const client = new ReplWorkerClient(
      child,
      callHandler,
      isolation,
      containerName,
      fileContext,
      options.corpusCallObserver,
      options.patchPlanning === true,
    );
    const abortStartup = () => {
      client.terminate(new ReplWorkerError("REPL worker startup aborted"));
    };
    options.signal?.addEventListener("abort", abortStartup, { once: true });
    if (options.signal?.aborted) abortStartup();

    const workerContext: WorkerContextDescriptor =
      context instanceof FileIndexedContext
        ? {
            kind: "files",
            files: context.files,
            totalBytes: context.totalBytes,
            sourceRevision: context.sourceRevision,
            corpusId: context.corpusId,
            factContract: options.factContract,
            answerMode: options.answerMode,
            ...(options.patchPlanning ? { patchPlanning: { root: true as const } } : {}),
          }
        : { kind: "text", text: context };
    const startupTimeoutMs =
      isolation.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    try {
      options.signal?.throwIfAborted();
      await client.send({ type: "init", context: workerContext });
      await Promise.race([
        client.ready,
        delay(startupTimeoutMs, undefined, { ref: false }).then(() => {
          throw new ReplWorkerError(`REPL worker startup exceeded ${startupTimeoutMs}ms`);
        }),
      ]);
      options.signal?.throwIfAborted();
      return client;
    } catch (error) {
      await client.close();
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abortStartup);
    }
  }

  /** The exact host evidence session used for this worker's root corpus calls. */
  getEvidenceSession(): FileIndexedEvidenceSession | undefined {
    return this.fileEvidenceSession;
  }

  /**
   * Prepares every exact host target atomically with respect to the evidence
   * turn. Model code never supplies paths, operations, or line ranges.
   */
  prepareNativeEdits(
    targets: readonly NativePatchEditTarget[],
  ): readonly PreparedNativePatchEdit[] {
    if (this.closed) {
      throw new ReplWorkerError("prepare_native_edits is unavailable after the REPL closes");
    }
    const fileContext = this.fileContext;
    const fileEvidenceSession = this.fileEvidenceSession;
    if (!this.patchPlanning || !fileContext || !fileEvidenceSession) {
      throw new ReplWorkerError(
        "prepare_native_edits is available only to the root patch planner",
      );
    }
    const exactTargets = validateNativeEditTargets(targets);
    fileEvidenceSession.beginTurn();
    return Object.freeze(exactTargets.map((target) => {
      this.corpusCallObserver?.({
        operation: "read_lines",
        path: target.path,
        startLine: target.startLine,
        endLine: target.endLine,
      });
      const slice = fileEvidenceSession.readLines(
        target.path,
        target.startLine,
        target.endLine,
      );
      this.corpusCallObserver?.({ operation: "observe", evidenceIds: [slice.id] });
      fileEvidenceSession.observe([slice.id]);
      const [observed] = fileEvidenceSession.resolveObservedEvidence([slice.id]);
      if (!observed || observed.truncated) {
        throw new ReplWorkerError(
          `prepare_native_edits requires complete observed evidence for ${target.id}`,
        );
      }
      const request = {
        path: target.path,
        evidenceId: slice.id,
        operation: target.operation,
        startLine: target.startLine,
        endLine: target.endLine,
      };
      this.corpusCallObserver?.({ operation: "get_patch_precondition", request });
      const precondition = derivePatchPrecondition(
        fileContext,
        fileEvidenceSession,
        request,
      );
      return Object.freeze({
        target,
        currentText: observed.text,
        requiresLeadingNewlineSeparator: requiresLeadingNewlineSeparator(
          fileContext.read(target.path),
          target,
        ),
        requiresTerminalNewline: requiresTerminalNewline(fileContext.read(target.path), target),
        evidenceId: precondition.evidenceId,
        precondition,
      });
    }));
  }


  async execute(
    code: string,
    signal?: AbortSignal,
    budget?: ReplBudgetSnapshot,
  ): Promise<ReplExecutionResult> {
    if (this.closed) throw new ReplWorkerError("REPL worker is closed");
    if (this.pendingExecution) throw new ReplWorkerError("REPL worker already has an active execution");
    signal?.throwIfAborted();
    this.fileEvidenceSession?.beginTurn();

    const id = `exec-${randomUUID()}`;
    const deferred = Promise.withResolvers<ReplExecutionResult>();
    const onAbort = signal
      ? () => this.terminate(new ReplWorkerError("REPL execution aborted"))
      : undefined;
    if (signal && onAbort) signal.addEventListener("abort", onAbort, { once: true });
    this.pendingExecution = {
      resolve: deferred.resolve,
      reject: deferred.reject,
      timeout: setTimeout(
        () => this.terminate(new ReplWorkerError(`REPL execution exceeded ${this.executionTimeoutMs}ms`)),
        this.executionTimeoutMs,
      ),
      signal,
      onAbort,
    };

    try {
      await this.send({
        type: "execute",
        id,
        code,
        syncTimeoutMs: this.syncExecutionTimeoutMs,
        budget: budget ?? {
          maxObservationCharacters:
            this.fileContext?.limits.maxObservationCharactersPerTurn ?? 0,
          finalizationReserveTokens: 0,
        },
      });
    } catch (error) {
      this.terminate(
        error instanceof Error ? error : new ReplWorkerError(String(error)),
      );
    }
    return deferred.promise;
  }

  resetAnswer(): Promise<void> {
    if (this.closed) return Promise.reject(new ReplWorkerError("REPL worker is closed"));
    return this.send({ type: "reset_answer" });
  }

  async close(): Promise<void> {
    if (this.closed) {
      if (this.failure) throw await this.failure;
      await this.ensureDockerCleanup();
      return;
    }
    this.gracefulClose = true;
    try {
      await this.send({ type: "shutdown" });
      this.child.stdin.end();
      await Promise.race([once(this.child, "exit"), delay(1_000)]);
    } catch {
      // Process cleanup below is authoritative.
    } finally {
      this.closed = true;
      if (this.child.exitCode === null) this.child.kill("SIGKILL");
      await this.ensureDockerCleanup();
      this.rejectPending(new ReplWorkerError("REPL worker closed"));
    }
  }

  private receiveLine(line: string): void {
    let message: WorkerToParentMessage;
    try {
      message = JSON.parse(line) as WorkerToParentMessage;
    } catch (error) {
      this.terminate(
        new ReplWorkerError(`REPL worker emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`),
      );
      return;
    }

    if (message.type === "ready") {
      this.resolveReady?.();
      this.resolveReady = undefined;
      this.rejectReady = undefined;
      return;
    }
    if (message.type === "call") {
      void this.answerWorkerCall(message.id, message.kind, message.queries, message.model);
      return;
    }
    if (message.type === "corpus_call") {
      void this.answerCorpusCall(message.id, message.request);
      return;
    }

    const pending = this.pendingExecution;
    if (!pending) return;
    this.pendingExecution = undefined;
    clearTimeout(pending.timeout);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    pending.resolve({
      stdout: message.stdout,
      stdoutCharacters: message.stdoutCharacters,
      observations: message.observations,
      corpusHistory: message.corpusHistory,
      searchResults: message.searchResults,
      ready: message.ready,
      answerContentDefined: message.answerContentDefined,
      answerContent: message.answerContent,
      error: message.error,
      replan: message.replan,
      factState: message.factState,
      factEvents: message.factEvents,
      factExtractions: message.factExtractions,
      factFinalized: message.factFinalized,
      factFinalizationBlock: message.factFinalizationBlock,
      submittedPatchPlan: message.submittedPatchPlan,
      preparedPatchReplace: message.preparedPatchReplace,
      patchSubmitAttempts: message.patchSubmitAttempts,
      patchSubmitRejections: message.patchSubmitRejections,
    });
  }

  private async answerWorkerCall(
    id: string,
    kind: WorkerCallKind,
    queries: EvidenceQuery[],
    model?: string,
  ): Promise<void> {
    let results: WorkerCallResult[];
    try {
      if (this.fileEvidenceSession) {
        for (const query of queries) {
          if (query.evidenceIds && query.evidenceIds.length > 0) {
            this.fileEvidenceSession.resolveEvidence(query.evidenceIds);
          }
        }
      }
      results = await this.callHandler(kind, queries, model);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results = queries.map(() => ({ ok: false, error: message }));
    }
    if (!this.closed) {
      try {
        await this.send({ type: "call_result", id, results });
      } catch (error) {
        this.terminate(
          error instanceof Error ? error : new ReplWorkerError(String(error)),
        );
      }
    }
  }
  private async answerCorpusCall(id: string, request: CorpusCallRequest): Promise<void> {
    let result: CorpusCallResult;
    try {
      if (!this.fileContext) {
        throw new ReplWorkerError(`${request.operation} requires a file-indexed context`);
      }
      this.corpusCallObserver?.(request);
      switch (request.operation) {
        case "read_file":
          result = { ok: true, value: readIndexedFile(this.fileContext, request.path) };
          break;
        case "search_files":
          if (!this.fileEvidenceSession) {
            throw new ReplWorkerError("search_files requires an evidence session");
          }
          result = {
            ok: true,
            value: this.fileEvidenceSession.search(request.request),
          };
          break;
        case "search_open":
          if (!this.fileEvidenceSession) {
            throw new ReplWorkerError("search_open requires an evidence session");
          }
          result = {
            ok: true,
            value: this.fileEvidenceSession.searchOpen(request.request),
          };
          break;
        case "read_lines":
          if (!this.fileEvidenceSession) {
            throw new ReplWorkerError("read_lines requires an evidence session");
          }
          result = {
            ok: true,
            value: this.fileEvidenceSession.readLines(
              request.path,
              request.startLine,
              request.endLine,
            ),
          };
          break;
        case "open_match":
          if (!this.fileEvidenceSession) {
            throw new ReplWorkerError("open_match requires an evidence session");
          }
          result = {
            ok: true,
            value: this.fileEvidenceSession.openMatch(request.matchId, request.options),
          };
          break;
        case "read_symbol":
          if (!this.fileEvidenceSession) {
            throw new ReplWorkerError("read_symbol requires an evidence session");
          }
          result = {
            ok: true,
            value: this.fileEvidenceSession.readSymbol(
              request.name,
              request.options,
            ),
          };
          break;
        case "observe":
          if (!this.fileEvidenceSession) {
            throw new ReplWorkerError("observe requires a file-indexed evidence session");
          }
          result = {
            ok: true,
            value: this.fileEvidenceSession.observe(request.evidenceIds),
          };
          break;
        case "find_symbol":
          if (!this.fileEvidenceSession) {
            throw new ReplWorkerError("find_symbol requires an evidence session");
          }
          result = {
            ok: true,
            value: this.fileEvidenceSession.findSymbol(request.name, request.options),
          };
          break;
        case "get_patch_precondition":
          if (!this.fileEvidenceSession) {
            throw new ReplWorkerError(
              "get_patch_precondition requires an evidence session",
            );
          }
          result = {
            ok: true,
            value: derivePatchPrecondition(
              this.fileContext,
              this.fileEvidenceSession,
              request.request,
            ),
          };
          break;
      }
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!this.closed) {
      try {
        await this.send({ type: "corpus_result", id, result });
      } catch (error) {
        this.terminate(
          error instanceof Error ? error : new ReplWorkerError(String(error)),
        );
      }
    }
  }

  private send(message: ParentToWorkerMessage): Promise<void> {
    if (this.closed) return Promise.reject(new ReplWorkerError("REPL worker is closed"));
    const payload = `${JSON.stringify(message)}\n`;
    this.writeChain = this.writeChain.then(() => {
      const deferred = Promise.withResolvers<void>();
      const onError = (error: Error) => deferred.reject(error);
      this.child.stdin.once("error", onError);
      this.child.stdin.write(payload, "utf8", () => {
        this.child.stdin.removeListener("error", onError);
        deferred.resolve();
      });
      return deferred.promise;
    });
    return this.writeChain;
  }

  private terminate(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
    this.completeFailure(error);
  }

  private fail(error: Error): void {
    if (this.closed && this.gracefulClose) return;
    this.closed = true;
    this.completeFailure(error);
  }

  private completeFailure(error: Error): void {
    this.failure ??= this.ensureDockerCleanup().then(
      () => error,
      () => new ReplDockerCleanupError(),
    );
    void this.failure.then((finalError) => {
      this.rejectReady?.(finalError);
      this.rejectReady = undefined;
      this.resolveReady = undefined;
      this.rejectPending(finalError);
    });
  }

  private rejectPending(error: Error): void {
    const pending = this.pendingExecution;
    if (!pending) return;
    this.pendingExecution = undefined;
    clearTimeout(pending.timeout);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    pending.reject(error);
  }

  private ensureDockerCleanup(): Promise<void> {
    this.dockerCleanup ??= this.removeDockerContainer();
    return this.dockerCleanup;
  }

  private async removeDockerContainer(): Promise<void> {
    if (!this.containerName) return;
    const removal = await executeDockerLifecycleCommand(
      ["rm", "--force", this.containerName],
      this.dockerLifecycleRunner,
    );
    if (
      removal.startError ||
      removal.timedOut ||
      (removal.exitCode !== 0 &&
        !isExactOwnedContainerNotFound(removal, this.containerName, ""))
    ) {
      throw new ReplDockerCleanupError();
    }
    const inspection = await executeDockerLifecycleCommand(
      ["container", "inspect", this.containerName],
      this.dockerLifecycleRunner,
    );
    if (
      inspection.startError ||
      inspection.timedOut ||
      !isExactOwnedContainerNotFound(inspection, this.containerName, "[]\n")
    ) {
      throw new ReplDockerCleanupError();
    }
  }
}
