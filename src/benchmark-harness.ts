import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { type Api, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  type ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { createLimitedModelProvider } from "./limited-provider.ts";
import {
  type PiRlmLimits,
  type PiRlmUsage,
  SharedRunLimits,
} from "./shared-limits.ts";
import type { PiRlmAnswerValidator, PiRlmFailureTrace } from "./runner.ts";

export type DirectPiProfile = "read-only" | "standard";

export interface HarnessRunResult {
  answer: string;
  usage: PiRlmUsage;
  executionCount?: number;
  answerRejections?: number;
  trace?: PiRlmFailureTrace;
}

export interface HarnessObservation extends HarnessRunResult {
  error?: string;
  correct: boolean;
  durationMs: number;
}

export interface RunDirectPiOptions {
  model: Model<Api>;
  modelRuntime: ModelRuntime;
  cwd: string;
  fileName: string;
  question: string;
  limits: PiRlmLimits;
  profile?: DirectPiProfile;
}

export class HarnessOperationError extends Error {
  readonly usage: PiRlmUsage;

  constructor(message: string, usage: PiRlmUsage, cause: unknown) {
    super(message, { cause });
    this.name = "HarnessOperationError";
    this.usage = usage;
  }
}

export const EMPTY_USAGE: PiRlmUsage = {
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
export function createExactAnswerValidator(
  expected: string,
  isCorrect: (answer: string, expected: string) => boolean,
): PiRlmAnswerValidator {
  return (candidate) =>
    isCorrect(candidate, expected)
      ? { valid: true }
      : {
          valid: false,
          reason: "The submitted answer does not satisfy the requested exact output format.",
        };
}

const SETTINGS = {
  compaction: { enabled: false },
  retry: { enabled: false, maxRetries: 0 },
} as const;

const DIRECT_CONFIG: Record<
  DirectPiProfile,
  { systemPrompt: string; tools: string[]; promptInstruction: string }
> = {
  "read-only": {
    systemPrompt: `You are the direct Pi read-only baseline. The user gives you a context path and a question.
Use only the read tool to inspect that path. Do not use shell, grep, code execution, sub-agents, or external knowledge. Return only the requested answer.`,
    tools: ["read"],
    promptInstruction: "Use read to inspect the context path before answering.",
  },
  standard: {
    systemPrompt: `You are the direct Pi standard-tools baseline. The user gives you a file or directory tree and a question.
Use read, grep, or bash as needed, but inspect only the supplied benchmark path and do not modify files. Do not use sub-agents or external knowledge. Return only the requested answer.`,
    tools: ["read", "grep", "bash"],
    promptInstruction: "Use the available standard tools to inspect the context path before answering.",
  },
};

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

function extractLastAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || !("role" in message)) continue;
    if (message.role !== "assistant" || !("content" in message) || !Array.isArray(message.content)) {
      continue;
    }
    const text = message.content
      .filter(
        (block): block is { type: "text"; text: string } =>
          Boolean(
            block &&
              typeof block === "object" &&
              "type" in block &&
              block.type === "text" &&
              "text" in block &&
              typeof block.text === "string",
          ),
      )
      .map((block) => block.text)
      .join("");
    if (text) return text;
  }
  throw new Error("Direct Pi completed without assistant text");
}

function usageFromError(error: unknown): PiRlmUsage {
  if (
    error &&
    typeof error === "object" &&
    "usage" in error &&
    error.usage &&
    typeof error.usage === "object"
  ) {
    return error.usage as PiRlmUsage;
  }
  return EMPTY_USAGE;
}
function traceFromError(error: unknown): PiRlmFailureTrace | undefined {
  if (
    error &&
    typeof error === "object" &&
    "trace" in error &&
    error.trace &&
    typeof error.trace === "object"
  ) {
    return error.trace as PiRlmFailureTrace;
  }
  return undefined;
}


export async function runDirectPi(options: RunDirectPiOptions): Promise<HarnessRunResult> {
  const profile = options.profile ?? "read-only";
  const config = DIRECT_CONFIG[profile];
  const providerRegistrationName = `direct-pi-bench-${randomUUID()}`;
  const limits = new SharedRunLimits(options.limits);
  let providerRegistered = false;

  try {
    const limited = await createLimitedModelProvider(
      options.modelRuntime,
      options.model,
      providerRegistrationName,
      limits,
    );
    options.modelRuntime.registerNativeProvider(limited.provider);
    providerRegistered = true;

    const { session } = await createAgentSession({
      cwd: options.cwd,
      model: limited.model,
      thinkingLevel: "off",
      modelRuntime: options.modelRuntime,
      resourceLoader: createResourceLoader(config.systemPrompt),
      tools: config.tools,
      sessionManager: SessionManager.inMemory(options.cwd),
      settingsManager: SettingsManager.inMemory(SETTINGS),
    });
    const abort = () => void session.abort();
    limits.signal.addEventListener("abort", abort, { once: true });

    try {
      await session.prompt(
        `Question: ${options.question}\nContext path: ${options.fileName}\n${config.promptInstruction}`,
        { expandPromptTemplates: false },
      );
      limits.throwIfAborted();
      return {
        answer: extractLastAssistantText(session.messages).trim(),
        usage: limits.snapshot(),
      };
    } finally {
      limits.signal.removeEventListener("abort", abort);
      session.dispose();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HarnessOperationError(message, limits.snapshot(), error);
  } finally {
    if (providerRegistered) options.modelRuntime.unregisterProvider(providerRegistrationName);
    limits.dispose();
  }
}

export async function observeHarness(
  expected: string,
  isCorrect: (answer: string, expected: string) => boolean,
  operation: () => Promise<HarnessRunResult>,
): Promise<HarnessObservation> {
  const started = performance.now();
  try {
    const result = await operation();
    return {
      ...result,
      correct: isCorrect(result.answer, expected),
      durationMs: performance.now() - started,
    };
  } catch (error) {
    return {
      answer: "",
      error: error instanceof Error ? error.message : String(error),
      correct: false,
      durationMs: performance.now() - started,
      usage: usageFromError(error),
      trace: traceFromError(error),
    };
  }
}
