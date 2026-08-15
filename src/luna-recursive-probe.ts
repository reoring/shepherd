import assert from "node:assert/strict";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { PiRlmRunner } from "./runner.ts";

const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel("openai", "gpt-5.6-luna");
if (!model) throw new Error("Configured Pi model openai/gpt-5.6-luna is unavailable");
if (!modelRuntime.hasConfiguredAuth(model.provider)) {
  throw new Error("Pi authentication for openai/gpt-5.6-luna is unavailable");
}

const childBlocks = [
  "[CHILD]\nTASK: Use rlm_exec on this context directly. Do not call llm_query or rlm_query. Return only the value from the assignment line below.\nVALUE=ALPHA_LUNA\n[/CHILD]",
  "[CHILD]\nTASK: Use rlm_exec on this context directly. Do not call llm_query or rlm_query. Return only the value from the assignment line below.\nVALUE=BETA_LUNA\n[/CHILD]",
];
const filler = "Unrelated recursive-probe record.\n".repeat(5_000);
const rawContext = `${filler}${childBlocks.join(`\n${filler}`)}\n${filler}`;

console.log(
  JSON.stringify({
    status: "starting",
    model: `${model.provider}/${model.id}`,
    rawContextCharacters: rawContext.length,
    expectedChildNodes: childBlocks.length,
  }),
);

const result = await new PiRlmRunner(model, {
  modelRuntime,
  isolation: { mode: "subprocess" },
  limits: {
    maxDepth: 2,
    maxConcurrentModelCalls: 2,
    maxSubcallInputTokens: 8_000,
    timeoutMs: 120_000,
    maxTokens: 20_000,
    maxCostUsd: 0.02,
  },
}).run(
  rawContext,
  [
    "Use rlm_exec to extract the two complete [CHILD]...[/CHILD] blocks with JavaScript.",
    'Pass the blocks, in order, to one rlm_query_batched() call as {question: "Return only the VALUE.", evidenceIds: [], inlineContext: block}.',
    "Do not parse VALUE in the root and do not call llm_query or llm_query_batched.",
    'Join the two child results with "|" and submit that exact string through answer.',
  ].join(" "),
);


assert.equal(result.response.trim(), "ALPHA_LUNA|BETA_LUNA");
assert.equal(result.usage.rlmNodes, 3);
assert.equal(result.usage.rlmSubcalls, 2);
assert.equal(result.usage.peakConcurrentModelCalls, 2);

console.log(
  JSON.stringify(
    {
      status: "pass",
      model: `${model.provider}/${model.id}`,
      answer: result.response.trim(),
      rawContextCharacters: rawContext.length,
      rootPromptCharacters: result.rootPrompt.length,
      rootReplExecutions: result.executionCount,
      answerRejections: result.answerRejections,
      rlmNodes: result.usage.rlmNodes,
      rlmSubcalls: result.usage.rlmSubcalls,
      llmSubcalls: result.usage.llmSubcalls,
      peakConcurrentModelCalls: result.usage.peakConcurrentModelCalls,
      modelCalls: result.usage.modelCalls,
      tokens: result.usage.totalTokens,
      cost: result.usage.costUsd,
    },
    null,
    2,
  ),
);
