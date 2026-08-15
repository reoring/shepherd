import assert from "node:assert/strict";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { PiRlmRunner } from "./runner.ts";

const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel("openai", "gpt-5.6-luna");
if (!model) throw new Error("Configured Pi model openai/gpt-5.6-luna is unavailable");
if (!modelRuntime.hasConfiguredAuth(model.provider)) {
  throw new Error("Pi authentication for openai/gpt-5.6-luna is unavailable");
}

const sentinel = "LUNA_STRUCTURED_REPLAN_OK";
const filler = "Unrelated structured replanning record.\n".repeat(600);
const rawContext = `${filler}MAGIC=${sentinel}\n${filler}`;

function findStructuredReplan(messages: unknown[]): unknown {
  for (const message of messages) {
    if (!message || typeof message !== "object" || !("details" in message)) continue;
    const details = message.details;
    if (
      details &&
      typeof details === "object" &&
      "replan" in details &&
      details.replan
    ) {
      return details.replan;
    }
  }
  return undefined;
}

console.log(
  JSON.stringify({
    status: "starting",
    model: `${model.provider}/${model.id}`,
    rawContextCharacters: rawContext.length,
  }),
);

const result = await new PiRlmRunner(model, {
  modelRuntime,
  isolation: { mode: "subprocess" },
  limits: {
    maxDepth: 2,
    maxConcurrentModelCalls: 4,
    maxSubcallInputTokens: 8_000,
    maxPreflightRejectedSubcalls: 8,
    timeoutMs: 120_000,
    maxTokens: 20_000,
    maxCostUsd: 0.05,
  },
}).run(
  rawContext,
  [
    'Use rlm_exec and first attempt llm_query({question: "Return the MAGIC value.", evidenceIds: [], inlineContext: context}) exactly once to exercise the preflight contract.',
    "When RLM_SUBCALL_REPLAN_REQUIRED is returned, do not retry the same call.",
    "Inspect last_replan, split context with chunk_text(context, last_replan.maxChunkCharacters),",
    'then call llm_query_batched() with {question: "Return the MAGIC value or NONE.", evidenceIds: [], inlineContext: chunk} for each chunk.',
    "Submit only the non-NONE MAGIC value through answer.",
  ].join(" "),
  {
    validateAnswer: (candidate) =>
      candidate === sentinel
        ? { valid: true }
        : {
            valid: false,
            reason: "The submitted answer does not satisfy the requested exact output format.",
          },
  },
);

assert.equal(result.response, sentinel);
assert.ok(result.usage.preflightRejectedSubcalls >= 1);
assert.ok(result.usage.totalTokens <= 20_000);
assert.ok(result.usage.costUsd <= 0.05);
assert.match(JSON.stringify(result.rootMessages), /RLM_SUBCALL_REPLAN_REQUIRED/);

const structuredReplan = findStructuredReplan(result.rootMessages);

console.log(
  JSON.stringify(
    {
      status: "pass",
      model: `${model.provider}/${model.id}`,
      answer: result.response,
      rawContextCharacters: rawContext.length,
      executionCount: result.executionCount,
      answerRejections: result.answerRejections,
      structuredReplanObservedInRootMessages: structuredReplan !== undefined,
      structuredReplan,
      preflightRejectedSubcalls: result.usage.preflightRejectedSubcalls,
      peakReservedSubcallInputTokens: result.usage.peakReservedSubcallInputTokens,
      llmSubcalls: result.usage.llmSubcalls,
      rlmSubcalls: result.usage.rlmSubcalls,
      modelCalls: result.usage.modelCalls,
      tokens: result.usage.totalTokens,
      cost: result.usage.costUsd,
    },
    null,
    2,
  ),
);
