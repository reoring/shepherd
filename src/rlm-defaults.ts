import type { PiRlmLimits } from "./shared-limits.ts";

export const DEFAULT_RLM_LIMITS: Readonly<PiRlmLimits> = Object.freeze({
  maxDepth: 2,
  maxConcurrentModelCalls: 4,
  maxSubcallInputTokens: 8_000,
  maxProviderOutputTokens: 512,
  finalizationReserveTokens: 2_000,
  maxRootTurns: 6,
  maxTokens: 20_000,
  maxCostUsd: 0.05,
  timeoutMs: 180_000,
});
