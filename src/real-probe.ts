import assert from "node:assert/strict";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { PiRlmRunner } from "./runner.ts";

const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel("openai", "gpt-5.6-luna");
if (!model) throw new Error("Configured Pi model openai/gpt-5.6-luna is unavailable");
if (!modelRuntime.hasConfiguredAuth(model.provider)) {
  throw new Error("Pi authentication for openai/gpt-5.6-luna is unavailable");
}

const sentinel = "REAL_PI_RLM_PROBE_7F3A9C";
const filler = "This is unrelated haystack material.\n".repeat(30_000);
const rawContext = `${filler}MAGIC=${sentinel}\n${filler}`;
console.log(
  JSON.stringify({
    status: "starting",
    model: `${model.provider}/${model.id}`,
    rawContextCharacters: rawContext.length,
  }),
);
const result = await new PiRlmRunner(model, { modelRuntime }).run(
  rawContext,
  "Find the exact token after MAGIC=. Inspect the external context with rlm_exec and return only that token.",
);

assert.equal(result.response.trim(), sentinel);
assert.equal(JSON.stringify(result.rootMessages).includes("This is unrelated haystack material.".repeat(10)), false);

console.log(
  JSON.stringify(
    {
      status: "pass",
      model: `${model.provider}/${model.id}`,
      answer: result.response.trim(),
      rawContextCharacters: rawContext.length,
      rootPromptCharacters: result.rootPrompt.length,
      replExecutions: result.executionCount,
      answerRejections: result.answerRejections,
      programmaticSubcalls: result.subcallPrompts.length,
      tokens: result.usage.totalTokens,
      cost: result.usage.costUsd,
    },
    null,
    2,
  ),
);
