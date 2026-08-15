import assert from "node:assert/strict";

import type { Context } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { PiRlmRunner } from "./runner.ts";

const SENTINEL = "PI_RLM_SYMBOLIC_RECURSION_PROVED";
const CHUNK_COUNT = 4;
const rawContext = `${"haystack-line\n".repeat(80_000)}MAGIC=${SENTINEL}\n`;
const isolationMode = process.env.PI_RLM_ISOLATION ?? "subprocess";
if (isolationMode !== "subprocess" && isolationMode !== "docker") {
  throw new Error(`Unsupported PI_RLM_ISOLATION: ${isolationMode}`);
}
interface ObservedContext {
  systemPrompt?: string;
  messages: Context["messages"];
  toolNames: string[];
}

const observedRootContexts: ObservedContext[] = [];
const observedSubcallContexts: ObservedContext[] = [];

function observeContext(context: Context): ObservedContext {
  return {
    systemPrompt: context.systemPrompt,
    messages: structuredClone(context.messages),
    toolNames: context.tools?.map((tool) => tool.name) ?? [],
  };
}

const faux = fauxProvider({
  provider: "pi-rlm-poc",
  models: [
    {
      id: "deterministic",
      contextWindow: 512_000,
      maxTokens: 16_384,
    },
  ],
});
const modelRuntime = await ModelRuntime.create({
  modelsPath: null,
  refreshOnCreate: false,
});
modelRuntime.registerNativeProvider(faux.provider);

const rootStepOne = (context: Context) => {
  observedRootContexts.push(observeContext(context));
  return fauxAssistantMessage(
    fauxToolCall(
      "rlm_exec",
      {
        code: `
state.chunks = Array.from({ length: ${CHUNK_COUNT} }, (_, index) => {
  const start = Math.floor(context.length * index / ${CHUNK_COUNT});
  const end = Math.floor(context.length * (index + 1) / ${CHUNK_COUNT});
  return context.slice(start, end);
});
console.log("prepared", state.chunks.length, "chunks");`,
      },
      { id: "root-prepare" },
    ),
    { stopReason: "toolUse" },
  );
};

const rootStepTwo = (context: Context) => {
  observedRootContexts.push(observeContext(context));
  return fauxAssistantMessage(
    fauxToolCall(
      "rlm_exec",
      {
        code: `
state.results = await llm_query_batched(
  state.chunks.map((chunk, index) => ({
    question: "Find a line beginning MAGIC= in chunk " + index + ". Return that line or NONE.",
    evidenceIds: [],
    inlineContext: chunk
  }))
);
answer.content = state.results.find((result) => result.startsWith("MAGIC=")) ?? "NOT_FOUND";
answer.ready = true;
console.log("aggregated", state.results.length, "subcall results");`,
      },
      { id: "root-aggregate" },
    ),
    { stopReason: "toolUse" },
  );
};

const subcallStep = (context: Context) => {
  observedSubcallContexts.push(observeContext(context));
  const userMessage = context.messages.findLast((message) => message.role === "user");
  let prompt = "";
  if (userMessage?.role === "user") {
    prompt =
      typeof userMessage.content === "string"
        ? userMessage.content
        : userMessage.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
  }
  const match = prompt.match(/^MAGIC=([^\n]+)$/m);
  return fauxAssistantMessage(match ? `MAGIC=${match[1]}` : "NONE");
};

faux.setResponses([
  rootStepOne,
  rootStepTwo,
  ...Array.from({ length: CHUNK_COUNT }, () => subcallStep),
]);

try {
  const result = await new PiRlmRunner(faux.getModel(), {
    modelRuntime,
    isolation: { mode: isolationMode },
  }).run(rawContext, "Find the MAGIC value in the external context.");

  assert.equal(result.response, `MAGIC=${SENTINEL}`);
  assert.equal(result.executionCount, 2);
  assert.equal(result.subcallPrompts.length, CHUNK_COUNT);
  assert.equal(observedRootContexts.length, 2);
  assert.equal(observedSubcallContexts.length, CHUNK_COUNT);

  const serializedRootContexts = JSON.stringify(observedRootContexts);
  assert.equal(serializedRootContexts.includes(SENTINEL), false);
  assert.equal(serializedRootContexts.includes("haystack-line\nhaystack-line\n"), false);
  assert.equal(JSON.stringify(result.rootMessages).includes(SENTINEL), false);

  console.log(
    JSON.stringify(
      {
        status: "pass",
        isolationMode,
        answer: result.response,
        rawContextCharacters: rawContext.length,
        rootPromptCharacters: result.rootPrompt.length,
        rootModelCalls: observedRootContexts.length,
        replExecutions: result.executionCount,
        programmaticSubcalls: result.subcallPrompts.length,
        rootContextContainsSentinel: serializedRootContexts.includes(SENTINEL),
        childContextsContainingSentinel: observedSubcallContexts.filter((context) =>
          JSON.stringify(context).includes(SENTINEL),
        ).length,
      },
      null,
      2,
    ),
  );
} finally {
  modelRuntime.unregisterProvider(faux.provider.id);
}
