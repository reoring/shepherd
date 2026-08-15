import { AsyncLocalStorage } from "node:async_hooks";
import {
  createAssistantMessageEventStream,
  calculateCost,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";
import type {
  ReplBudgetSnapshot,
  SubcallReplan,
  SubcallReplanReason,
  WorkerCallKind,
} from "./worker-protocol.ts";
export type ProviderStream<TOptions extends StreamOptions = SimpleStreamOptions> = (
  model: Model<Api>,
  context: Context,
  options?: TOptions,
) => AssistantMessageEventStream;

export interface PiRlmLimits {
  maxDepth?: number;
  maxConcurrentModelCalls?: number;
  timeoutMs?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  maxSubcallInputTokens?: number;
  maxPreflightRejectedSubcalls?: number;
  maxProviderOutputTokens?: number;
  finalizationReserveTokens?: number;
  maxRootTurns?: number;
  /**
   * Optional provider-call ceiling for hosts that make one provider call per
   * root turn. Pi-RLM's recursive provider traffic intentionally does not use
   * this ceiling.
   */
  maxProviderCalls?: number;
}

export interface PiRlmUsage {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  peakConcurrentModelCalls: number;
  rlmNodes: number;
  llmSubcalls: number;
  rlmSubcalls: number;
  preflightRejectedSubcalls: number;
  preflightRejectedProviderCalls: number;
  peakReservedSubcallInputTokens: number;
  peakReservedProviderTokens: number;
  postHocLimitViolations: number;
}

export interface PiRlmProviderCallTrace {
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
  rejectionReason?: string;
}

const DEFAULT_LIMITS: Required<
  Pick<
    PiRlmLimits,
    | "maxDepth"
    | "maxConcurrentModelCalls"
    | "maxSubcallInputTokens"
    | "maxPreflightRejectedSubcalls"
    | "maxProviderOutputTokens"
    | "finalizationReserveTokens"
    | "maxRootTurns"
  >
> = {
  maxDepth: 1,
  maxConcurrentModelCalls: 4,
  maxSubcallInputTokens: 32_000,
  maxPreflightRejectedSubcalls: 8,
  maxProviderOutputTokens: 512,
  finalizationReserveTokens: 2_000,
  maxRootTurns: 6,
};

export class RunLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunLimitError";
  }
}

export class SubcallPreflightError extends RunLimitError {
  readonly replan: SubcallReplan;

  constructor(replan: SubcallReplan) {
    super(`RLM subcall preflight rejected: ${replan.message}`);
    this.name = "SubcallPreflightError";
    this.replan = replan;
  }
}

export interface SubcallReservation {
  estimatedInputTokens: number;
  estimatedInputCostUsd: number;
  release(): void;
}

interface ProviderCallReservation {
  trace: PiRlmProviderCallTrace;
  release(): void;
}

interface ProviderCallScope {
  finalizationReserveAvailable: boolean;
}

const SUBCALL_INPUT_TOKEN_OVERHEAD = 512;
const PROVIDER_INPUT_TOKEN_OVERHEAD = 512;
const CONSERVATIVE_UTF8_BYTES_PER_TOKEN = 3;

export function estimateSubcallInputTokens(prompt: string): number {
  return (
    Math.ceil(Buffer.byteLength(prompt, "utf8") / CONSERVATIVE_UTF8_BYTES_PER_TOKEN) +
    SUBCALL_INPUT_TOKEN_OVERHEAD
  );
}

export function estimateProviderInputTokens(context: Context): number {
  const serialized = JSON.stringify({
    systemPrompt: context.systemPrompt,
    messages: context.messages,
    tools: context.tools,
  });
  return (
    Math.ceil(Buffer.byteLength(serialized, "utf8") / CONSERVATIVE_UTF8_BYTES_PER_TOKEN) +
    PROVIDER_INPUT_TOKEN_OVERHEAD
  );
}
const REPLAN_CHUNK_HEADROOM_TOKENS = 512;

function estimateSubcallInputCostUsd(model: Model<Api>, inputTokens: number): number {
  const usage: Usage = {
    input: inputTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: inputTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return calculateCost(model, usage).total;
}

function estimateProviderCostUsd(
  model: Model<Api>,
  inputTokens: number,
  outputTokens: number,
): number {
  const usage: Usage = {
    input: inputTokens,
    output: outputTokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: inputTokens + outputTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return calculateCost(model, usage).total;
}

function maxInputTokensWithinCost(
  model: Model<Api>,
  remainingCostUsd: number,
  ceiling: number,
): number {
  if (remainingCostUsd <= 0 || ceiling <= 0) return 0;
  let lower = 0;
  let upper = ceiling;
  while (lower < upper) {
    const candidate = Math.ceil((lower + upper) / 2);
    if (estimateSubcallInputCostUsd(model, candidate) <= remainingCostUsd) {
      lower = candidate;
    } else {
      upper = candidate - 1;
    }
  }
  return lower;
}

interface SemaphoreWaiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

class AsyncSemaphore {
  private readonly capacity: number;
  private active = 0;
  private peak = 0;
  private readonly queue: SemaphoreWaiter[] = [];

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get peakActive(): number {
    return this.peak;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.capacity) {
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      return Promise.resolve(this.createRelease());
    }

    const { promise, resolve, reject } = Promise.withResolvers<() => void>();
    const waiter: SemaphoreWaiter = {
      resolve,
      reject,
      signal,
      onAbort: () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal.reason ?? new RunLimitError("Model call aborted while waiting for concurrency capacity"));
      },
    };
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    this.queue.push(waiter);
    return promise;
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.admitNext();
    };
  }

  private admitNext(): void {
    while (this.queue.length > 0 && this.active < this.capacity) {
      const waiter = this.queue.shift();
      if (!waiter) return;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason ?? new RunLimitError("Model call aborted"));
        continue;
      }
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      waiter.resolve(this.createRelease());
    }
  }
}

function validateLimits(limits: PiRlmLimits): void {
  const positiveIntegers: Array<[string, number | undefined]> = [
    ["maxDepth", limits.maxDepth],
    ["maxConcurrentModelCalls", limits.maxConcurrentModelCalls],
    ["timeoutMs", limits.timeoutMs],
    ["maxTokens", limits.maxTokens],
    ["maxSubcallInputTokens", limits.maxSubcallInputTokens],
    ["maxPreflightRejectedSubcalls", limits.maxPreflightRejectedSubcalls],
    ["maxProviderOutputTokens", limits.maxProviderOutputTokens],
    ["maxRootTurns", limits.maxRootTurns],
    ["maxProviderCalls", limits.maxProviderCalls],
  ];
  for (const [name, value] of positiveIntegers) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  }
  if (
    limits.finalizationReserveTokens !== undefined &&
    (!Number.isInteger(limits.finalizationReserveTokens) ||
      limits.finalizationReserveTokens < 0)
  ) {
    throw new RangeError("finalizationReserveTokens must be a non-negative integer");
  }
  if (limits.maxCostUsd !== undefined && (!Number.isFinite(limits.maxCostUsd) || limits.maxCostUsd <= 0)) {
    throw new RangeError("maxCostUsd must be a positive finite number");
  }
}

export class SharedRunLimits {
  readonly maxDepth: number;
  readonly maxParallelSubcalls: number;
  readonly maxSubcallInputTokens: number;
  readonly maxPreflightRejectedSubcalls: number;
  readonly maxProviderOutputTokens: number;
  readonly finalizationReserveTokens: number;
  readonly maxRootTurns: number;
  readonly maxProviderCalls: number | undefined;
  readonly signal: AbortSignal;

  private readonly controller = new AbortController();
  private readonly semaphore: AsyncSemaphore;
  private readonly providerCallScope = new AsyncLocalStorage<ProviderCallScope>();
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private readonly deadlineAt: number | undefined;
  private readonly externalSignal: AbortSignal | undefined;
  private readonly externalAbort: (() => void) | undefined;
  private readonly limits: PiRlmLimits;
  private reservedSubcallInputTokens = 0;
  private reservedSubcallInputCostUsd = 0;
  private reservedProviderTokens = 0;
  private reservedProviderCostUsd = 0;
  private nextProviderCallId = 1;
  private dispatchedProviderCallCount = 0;
  private readonly providerCallTraces: PiRlmProviderCallTrace[] = [];
  private usage: PiRlmUsage = {
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
  };

  constructor(limits: PiRlmLimits = {}, externalSignal?: AbortSignal) {
    validateLimits(limits);
    this.limits = limits;
    this.maxDepth = limits.maxDepth ?? DEFAULT_LIMITS.maxDepth;
    this.maxParallelSubcalls =
      limits.maxConcurrentModelCalls ?? DEFAULT_LIMITS.maxConcurrentModelCalls;
    this.maxSubcallInputTokens =
      limits.maxSubcallInputTokens ?? DEFAULT_LIMITS.maxSubcallInputTokens;
    this.maxPreflightRejectedSubcalls =
      limits.maxPreflightRejectedSubcalls ??
      DEFAULT_LIMITS.maxPreflightRejectedSubcalls;
    this.maxProviderOutputTokens =
      limits.maxProviderOutputTokens ?? DEFAULT_LIMITS.maxProviderOutputTokens;
    this.finalizationReserveTokens =
      limits.finalizationReserveTokens ?? DEFAULT_LIMITS.finalizationReserveTokens;
    this.maxRootTurns = limits.maxRootTurns ?? DEFAULT_LIMITS.maxRootTurns;
    this.maxProviderCalls = limits.maxProviderCalls;
    this.semaphore = new AsyncSemaphore(this.maxParallelSubcalls);
    this.signal = this.controller.signal;
    this.externalSignal = externalSignal;
    this.deadlineAt =
      limits.timeoutMs === undefined ? undefined : Date.now() + limits.timeoutMs;

    if (externalSignal) {
      this.externalAbort = () => {
        this.controller.abort(externalSignal.reason ?? new RunLimitError("RLM run aborted by caller"));
      };
      if (externalSignal.aborted) this.externalAbort();
      else externalSignal.addEventListener("abort", this.externalAbort, { once: true });
    }

    if (limits.timeoutMs !== undefined) {
      this.timeout = setTimeout(() => {
        this.controller.abort(new RunLimitError(`RLM timeout exceeded: ${limits.timeoutMs}ms`));
      }, limits.timeoutMs);
      this.timeout.unref();
    }
  }

  wrapProvider<TOptions extends StreamOptions>(
    upstream: ProviderStream<TOptions>,
  ): ProviderStream<TOptions> {
    return (model, context, options) => {
      const output = createAssistantMessageEventStream();
      void this.forwardProviderStream(output, upstream, model, context, options);
      return output;
    };
  }

  withFinalizationProviderCall<T>(operation: () => Promise<T>): Promise<T> {
    return this.providerCallScope.run(
      { finalizationReserveAvailable: true },
      operation,
    );
  }

  recordNode(): void {
    this.usage.rlmNodes += 1;
  }

  recordSubcall(kind: "llm" | "rlm"): void {
    if (kind === "llm") this.usage.llmSubcalls += 1;
    else this.usage.rlmSubcalls += 1;
  }

  reserveSubcall(
    prompt: string,
    model: Model<Api>,
    kind: WorkerCallKind,
  ): SubcallReservation {
    this.throwIfAborted();
    const estimatedInputTokens = estimateSubcallInputTokens(prompt);
    const estimatedInputCostUsd = estimateSubcallInputCostUsd(model, estimatedInputTokens);
    const remainingTokenBudget =
      this.limits.maxTokens === undefined
        ? undefined
        : Math.max(
            0,
            this.limits.maxTokens -
              this.usage.totalTokens -
              this.reservedSubcallInputTokens -
              this.reservedProviderTokens -
              this.finalizationReserveTokens,
          );
    const remainingCostBudgetUsd =
      this.limits.maxCostUsd === undefined
        ? undefined
        : Math.max(
            0,
            this.limits.maxCostUsd -
              this.usage.costUsd -
              this.reservedSubcallInputCostUsd -
              this.reservedProviderCostUsd,
          );
    let maxInputTokens = this.maxSubcallInputTokens;
    if (remainingTokenBudget !== undefined) {
      maxInputTokens = Math.min(maxInputTokens, remainingTokenBudget);
    }
    if (remainingCostBudgetUsd !== undefined) {
      maxInputTokens = Math.min(
        maxInputTokens,
        maxInputTokensWithinCost(model, remainingCostBudgetUsd, maxInputTokens),
      );
    }

    let reason: SubcallReplanReason | undefined;
    let message: string | undefined;
    if (estimatedInputTokens > this.maxSubcallInputTokens) {
      reason = "single_call_input_limit";
      message =
        `${kind}_query estimated input ${estimatedInputTokens} tokens exceeds the ` +
        `single-call limit ${this.maxSubcallInputTokens}.`;
    } else if (
      remainingTokenBudget !== undefined &&
      estimatedInputTokens > remainingTokenBudget
    ) {
      reason = "remaining_token_budget";
      message =
        `${kind}_query estimated input ${estimatedInputTokens} tokens would exceed the ` +
        `remaining RLM token budget ${remainingTokenBudget}.`;
    } else if (
      remainingCostBudgetUsd !== undefined &&
      estimatedInputCostUsd > remainingCostBudgetUsd
    ) {
      reason = "remaining_cost_budget";
      message =
        `${kind}_query estimated input cost $${estimatedInputCostUsd.toFixed(6)} would ` +
        `exceed the remaining RLM cost budget $${remainingCostBudgetUsd.toFixed(6)}.`;
    }

    if (reason && message) {
      const maxChunkCharacters = Math.max(
        0,
        (maxInputTokens -
          SUBCALL_INPUT_TOKEN_OVERHEAD -
          REPLAN_CHUNK_HEADROOM_TOKENS) *
          CONSERVATIVE_UTF8_BYTES_PER_TOKEN,
      );
      return this.rejectSubcall({
        code: "RLM_SUBCALL_REPLAN_REQUIRED",
        queryKind: kind,
        reason,
        estimatedInputTokens,
        estimatedInputCostUsd,
        maxInputTokens,
        maxChunkCharacters,
        remainingTokenBudget,
        remainingCostBudgetUsd,
        strategies: [
          "process_locally",
          "chunk_text_then_llm_query_batched",
          "rlm_query",
        ],
        message:
          `${message} Keep context external: split it into smaller chunks or use ` +
          "rlm_query for a child REPL. No provider request was sent.",
      });
    }

    this.reservedSubcallInputTokens += estimatedInputTokens;
    this.reservedSubcallInputCostUsd += estimatedInputCostUsd;
    this.usage.peakReservedSubcallInputTokens = Math.max(
      this.usage.peakReservedSubcallInputTokens,
      this.reservedSubcallInputTokens,
    );

    let released = false;
    return {
      estimatedInputTokens,
      estimatedInputCostUsd,
      release: () => {
        if (released) return;
        released = true;
        this.reservedSubcallInputTokens -= estimatedInputTokens;
        this.reservedSubcallInputCostUsd -= estimatedInputCostUsd;
      },
    };
  }

  private rejectSubcall(replan: SubcallReplan): never {
    this.usage.preflightRejectedSubcalls += 1;
    if (
      this.usage.preflightRejectedSubcalls >
      this.maxPreflightRejectedSubcalls
    ) {
      const error = new RunLimitError(
        `RLM subcall preflight rejection limit exceeded: ` +
          `${this.usage.preflightRejectedSubcalls}/${this.maxPreflightRejectedSubcalls}. ` +
          "The model did not replan after repeated fail-closed guidance.",
      );
      this.controller.abort(error);
      throw error;
    }
    throw new SubcallPreflightError(replan);
  }

  providerTraces(): PiRlmProviderCallTrace[] {
    return structuredClone(this.providerCallTraces);
  }

  replBudgetSnapshot(
    rootTurns: number,
    maxObservationCharacters: number,
  ): ReplBudgetSnapshot {
    return {
      remainingTokens:
        this.limits.maxTokens === undefined
          ? undefined
          : Math.max(
              0,
              this.limits.maxTokens -
                this.usage.totalTokens -
                this.reservedSubcallInputTokens -
                this.reservedProviderTokens -
                this.finalizationReserveTokens,
            ),
      remainingCostUsd:
        this.limits.maxCostUsd === undefined
          ? undefined
          : Math.max(
              0,
              this.limits.maxCostUsd -
                this.usage.costUsd -
                this.reservedSubcallInputCostUsd -
                this.reservedProviderCostUsd,
            ),
      remainingRootTurns: Math.max(0, this.maxRootTurns - rootTurns),
      maxObservationCharacters,
      finalizationReserveTokens: this.finalizationReserveTokens,
    };
  }

  reservationSnapshot(): {
    subcallInputTokens: number;
    providerTokens: number;
    subcallInputCostUsd: number;
    providerCostUsd: number;
  } {
    return {
      subcallInputTokens: this.reservedSubcallInputTokens,
      providerTokens: this.reservedProviderTokens,
      subcallInputCostUsd: this.reservedSubcallInputCostUsd,
      providerCostUsd: this.reservedProviderCostUsd,
    };
  }

  private reserveProviderCall<TOptions extends StreamOptions>(
    model: Model<Api>,
    context: Context,
    options?: TOptions,
  ): ProviderCallReservation {
    this.throwIfAborted();
    const estimatedInputTokens = estimateProviderInputTokens(context);
    const reservedOutputTokens = Math.min(
      options?.maxTokens ?? model.maxTokens,
      this.maxProviderOutputTokens,
    );
    const reservedTokens = estimatedInputTokens + reservedOutputTokens;
    const estimatedCostUsd = estimateProviderCostUsd(
      model,
      estimatedInputTokens,
      reservedOutputTokens,
    );
    const providerCallScope = this.providerCallScope.getStore();
    const usesFinalizationReserve =
      providerCallScope?.finalizationReserveAvailable === true;
    if (providerCallScope) providerCallScope.finalizationReserveAvailable = false;
    const heldFinalizationTokens = usesFinalizationReserve
      ? 0
      : this.finalizationReserveTokens;
    const remainingTokensBefore =
      this.limits.maxTokens === undefined
        ? undefined
        : Math.max(
            0,
            this.limits.maxTokens -
              this.usage.totalTokens -
              this.reservedSubcallInputTokens -
              this.reservedProviderTokens -
              heldFinalizationTokens,
          );
    const remainingCostBeforeUsd =
      this.limits.maxCostUsd === undefined
        ? undefined
        : Math.max(
            0,
            this.limits.maxCostUsd -
              this.usage.costUsd -
              this.reservedSubcallInputCostUsd -
              this.reservedProviderCostUsd,
          );
    const trace: PiRlmProviderCallTrace = {
      id: this.nextProviderCallId,
      estimatedInputTokens,
      reservedOutputTokens,
      reservedTokens,
      usesFinalizationReserve,
      remainingTokensBefore,
      remainingCostBeforeUsd,
      dispatched: false,
    };
    this.nextProviderCallId += 1;
    this.providerCallTraces.push(trace);

    let rejectionReason: string | undefined;
    if (
      this.maxProviderCalls !== undefined &&
      this.dispatchedProviderCallCount >= this.maxProviderCalls
    ) {
      rejectionReason =
        `Provider turn limit exceeded: ${this.dispatchedProviderCallCount}/${this.maxProviderCalls}`;
    } else if (
      remainingTokensBefore !== undefined &&
      reservedTokens > remainingTokensBefore
    ) {
      rejectionReason =
        `RLM provider budget preflight rejected: estimated input ${estimatedInputTokens} + ` +
        `output ${reservedOutputTokens} exceeds remaining token budget ${remainingTokensBefore}`;
    } else if (
      remainingCostBeforeUsd !== undefined &&
      estimatedCostUsd > remainingCostBeforeUsd
    ) {
      rejectionReason =
        `RLM provider budget preflight rejected: estimated cost $${estimatedCostUsd.toFixed(6)} ` +
        `exceeds remaining cost budget $${remainingCostBeforeUsd.toFixed(6)}`;
    }
    if (rejectionReason) {
      trace.rejectionReason = rejectionReason;
      this.usage.preflightRejectedProviderCalls += 1;
      const error = new RunLimitError(rejectionReason);
      this.controller.abort(error);
      throw error;
    }

    this.reservedProviderTokens += reservedTokens;
    this.dispatchedProviderCallCount += 1;
    this.reservedProviderCostUsd += estimatedCostUsd;
    this.usage.peakReservedProviderTokens = Math.max(
      this.usage.peakReservedProviderTokens,
      this.reservedProviderTokens,
    );
    trace.dispatched = true;
    let released = false;
    return {
      trace,
      release: () => {
        if (released) return;
        released = true;
        this.reservedProviderTokens -= reservedTokens;
        this.reservedProviderCostUsd -= estimatedCostUsd;
      },
    };
  }

  snapshot(): PiRlmUsage {
    return {
      ...this.usage,
      peakConcurrentModelCalls: this.semaphore.peakActive,
    };
  }

  remainingTimeMs(): number | undefined {
    if (this.deadlineAt === undefined) return undefined;
    return Math.max(0, this.deadlineAt - Date.now());
  }

  throwIfAborted(): void {
    if (this.signal.aborted) {
      throw this.signal.reason ?? new RunLimitError("RLM run aborted");
    }
  }

  dispose(): void {
    clearTimeout(this.timeout);
    this.timeout = undefined;
    if (this.externalSignal && this.externalAbort) {
      this.externalSignal.removeEventListener("abort", this.externalAbort);
    }
  }

  private async forwardProviderStream<TOptions extends StreamOptions>(
    output: AssistantMessageEventStream,
    upstream: ProviderStream<TOptions>,
    model: Model<Api>,
    context: Context,
    options?: TOptions,
  ): Promise<void> {
    let release: (() => void) | undefined;
    let providerReservation: ProviderCallReservation | undefined;
    try {
      providerReservation = this.reserveProviderCall(model, context, options);
      const signals = [this.signal];
      if (options?.signal) signals.push(options.signal);
      const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
      release = await this.semaphore.acquire(signal);
      this.throwIfAborted();

      const maxTokens = Math.min(
        options?.maxTokens ?? model.maxTokens,
        this.maxProviderOutputTokens,
      );
      const inner = upstream(model, context, {
        ...options,
        maxTokens,
        signal,
      } as TOptions);
      let terminal: AssistantMessage | undefined;
      for await (const event of inner) {
        if (event.type === "done") {
          this.recordUsage(event.message.usage, providerReservation.trace);
          terminal = event.message;
        } else if (event.type === "error") {
          this.recordUsage(event.error.usage, providerReservation.trace);
          terminal = event.error;
        }
        output.push(event);
      }
      output.end(terminal);
    } catch (error) {
      const message = this.createErrorMessage(model, error);
      output.push({
        type: "error",
        reason: message.stopReason === "aborted" ? "aborted" : "error",
        error: message,
      });
      output.end(message);
    } finally {
      release?.();
      providerReservation?.release();
    }
  }

  private recordUsage(usage: Usage, trace: PiRlmProviderCallTrace): void {
    this.usage.modelCalls += 1;
    this.usage.inputTokens += usage.input;
    this.usage.outputTokens += usage.output;
    this.usage.cacheReadTokens += usage.cacheRead;
    this.usage.cacheWriteTokens += usage.cacheWrite;
    this.usage.totalTokens += usage.totalTokens;
    this.usage.costUsd += usage.cost.total;
    trace.actualTokens = usage.totalTokens;
    trace.actualCostUsd = usage.cost.total;
    trace.remainingTokensAfter =
      this.limits.maxTokens === undefined
        ? undefined
        : Math.max(0, this.limits.maxTokens - this.usage.totalTokens);
    trace.remainingCostAfterUsd =
      this.limits.maxCostUsd === undefined
        ? undefined
        : Math.max(0, this.limits.maxCostUsd - this.usage.costUsd);

    if (this.limits.maxTokens !== undefined && this.usage.totalTokens > this.limits.maxTokens) {
      this.usage.postHocLimitViolations += 1;
      const error = new RunLimitError(
        `RLM token limit exceeded after provider usage: ${this.usage.totalTokens}/${this.limits.maxTokens}`,
      );
      this.controller.abort(error);
      throw error;
    }
    if (this.limits.maxCostUsd !== undefined && this.usage.costUsd > this.limits.maxCostUsd) {
      this.usage.postHocLimitViolations += 1;
      const error = new RunLimitError(
        `RLM cost limit exceeded after provider usage: $${this.usage.costUsd.toFixed(6)}/$${this.limits.maxCostUsd.toFixed(6)}`,
      );
      this.controller.abort(error);
      throw error;
    }
  }

  private createErrorMessage(model: Model<Api>, error: unknown): AssistantMessage {
    const message = error instanceof Error ? error.message : String(error);
    return {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: this.signal.aborted ? "aborted" : "error",
      errorMessage: message,
      timestamp: Date.now(),
    };
  }
}
