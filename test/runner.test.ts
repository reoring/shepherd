import assert from "node:assert/strict";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";

import { ReplWorkerClient } from "../src/repl-client.ts";
import { PiRlmRunner } from "../src/runner.ts";
import { createFauxRuntime } from "./faux-runtime.ts";

function extractUserPrompt(context: Context): string {
  const userMessage = context.messages.findLast((message) => message.role === "user");
  if (userMessage?.role !== "user") return "";
  if (typeof userMessage.content === "string") return userMessage.content;
  return userMessage.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

test("keeps raw context outside the root model while code launches batched Pi subcalls", async () => {
  const sentinel = "PI_RLM_CONTRACT_SENTINEL";
  const chunkCount = 3;
  const rawContext = `${"haystack\n".repeat(30_000)}MAGIC=${sentinel}\n`;
  const rootPayloads: string[] = [];
  const childPayloads: string[] = [];

  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-contract-test",
    models: [{ id: "deterministic", contextWindow: 256_000, maxTokens: 8_192 }],
  });

  faux.setResponses([
    (context) => {
      rootPayloads.push(JSON.stringify({ systemPrompt: context.systemPrompt, messages: context.messages }));
      return fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `
state.chunks = Array.from({ length: ${chunkCount} }, (_, index) => {
  const start = Math.floor(context.length * index / ${chunkCount});
  const end = Math.floor(context.length * (index + 1) / ${chunkCount});
  return context.slice(start, end);
});
console.log("prepared", state.chunks.length);`,
        }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      rootPayloads.push(JSON.stringify({ systemPrompt: context.systemPrompt, messages: context.messages }));
      return fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `
state.results = await llm_query_batched(
  state.chunks.map((chunk) => ({
    question: "Return a line beginning MAGIC= or NONE.",
    evidenceIds: [],
    inlineContext: chunk
  }))
);
answer.content = state.results.find((result) => result.startsWith("MAGIC=")) ?? "NOT_FOUND";
answer.ready = true;`,
        }),
        { stopReason: "toolUse" },
      );
    },
    ...Array.from({ length: chunkCount }, () => (context: Context) => {
      childPayloads.push(JSON.stringify({ systemPrompt: context.systemPrompt, messages: context.messages }));
      const match = extractUserPrompt(context).match(/^MAGIC=([^\n]+)$/m);
      return fauxAssistantMessage(match ? `MAGIC=${match[1]}` : "NONE");
    }),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), { modelRuntime }).run(
      rawContext,
      "Find the MAGIC value.",
    );

    assert.equal(result.response, `MAGIC=${sentinel}`);
    assert.equal(result.executionCount, 2, "the second REPL turn must reuse state.chunks from the first");
    assert.equal(result.subcallPrompts.length, chunkCount);
    assert.equal(rootPayloads.length, 2);
    assert.equal(childPayloads.length, chunkCount);
    assert.equal(rootPayloads.some((payload) => payload.includes(sentinel)), false);
    assert.equal(JSON.stringify(result.rootMessages).includes(sentinel), false);
    assert.equal(childPayloads.filter((payload) => payload.includes(sentinel)).length, 1);
  } finally {
    unregister();
  }
});

test("keeps normal read-only REPL startup independent from the shared deadline signal", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-startup-signal-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", { code: 'answer.content = "done"; answer.ready = true;' }),
      { stopReason: "toolUse" },
    ),
  ]);
  const originalCreate = ReplWorkerClient.create;
  let startupOptions: Parameters<typeof ReplWorkerClient.create>[2] | undefined;
  let executionSignal: AbortSignal | undefined;
  ReplWorkerClient.create = async (_context, _callHandler, options = {}) => {
    startupOptions = options;
    return {
      execute: async (_code: string, signal?: AbortSignal) => {
        executionSignal = signal;
        return {
          stdout: "",
          stdoutCharacters: 0,
          observations: [],
          corpusHistory: [],
          searchResults: [],
          ready: true,
          answerContentDefined: true,
          answerContent: "done",
          factEvents: [],
          factExtractions: [],
          factFinalized: false,
        };
      },
      close: async () => undefined,
    } as unknown as ReplWorkerClient;
  };
  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
    }).run("read-only context", "Return done.");
    assert.equal(result.response, "done");
    assert.equal(startupOptions?.signal, undefined);
    assert.ok(executionSignal);
    assert.equal(startupOptions ? Object.hasOwn(startupOptions, "signal") : true, false);
  } finally {
    ReplWorkerClient.create = originalCreate;
    unregister();
  }
});
