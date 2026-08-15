import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";

import { PiRlmRunner } from "../src/runner.ts";
import { SharedRunLimits } from "../src/shared-limits.ts";
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

test("rlm_query creates a child Pi RLM with its own isolated REPL", async () => {
  const sentinel = "RECURSIVE_CHILD_OK";
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-recursive-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
const childAnswer = await rlm_query({question: "Find MAGIC in this child context.", evidenceIds: [], inlineContext: "MAGIC=${sentinel}"});
answer.content = childAnswer;
answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
const match = context.match(/^MAGIC=([^\\n]+)$/m);
answer.content = match?.[1] ?? "NOT_FOUND";
answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      limits: { maxDepth: 2 },
      isolation: { mode: "subprocess" },
    }).run("Delegate this task to a child RLM.", "Return the child result.");

    assert.equal(result.response, sentinel);
    assert.equal(result.usage.rlmNodes, 2);
    assert.equal(result.usage.rlmSubcalls, 1);
    assert.equal(result.usage.modelCalls, 2);
    assert.equal(result.trace.providerCalls.length, 2);
    assert.equal(result.trace.providerCalls.every((call) => call.dispatched), true);
  } finally {
    unregister();
  }
});

test("maxDepth falls back from rlm_query to a one-shot Pi call", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-depth-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
answer.content = await rlm_query({question: "Return exactly LEAF_OK", evidenceIds: []});
answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("LEAF_OK"),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      limits: { maxDepth: 1 },
    }).run("Use the recursion function.", "Return its result.");

    assert.equal(result.response, "LEAF_OK");
    assert.equal(result.usage.rlmNodes, 1);
    assert.equal(result.usage.rlmSubcalls, 1);
    assert.equal(result.usage.modelCalls, 2);
  } finally {
    unregister();
  }
});

test("shared provider semaphore caps batched model-call concurrency", async () => {
  const concurrency = { active: 0, peak: 0 };
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-concurrency-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  const subcall = async (context: Context) => {
    concurrency.active += 1;
    concurrency.peak = Math.max(concurrency.peak, concurrency.active);
    await delay(30);
    concurrency.active -= 1;
    return fauxAssistantMessage(extractUserPrompt(context));
  };
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
const values = await llm_query_batched(["A", "B", "C", "D"].map((question) => ({question, evidenceIds: []})));
answer.content = values.join("");
answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
    subcall,
    subcall,
    subcall,
    subcall,
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      limits: { maxConcurrentModelCalls: 2 },
    }).run("Run a batch.", "Concatenate the batch results.");

    assert.equal(result.response, "ABCD");
    assert.equal(concurrency.peak, 2);
    assert.equal(result.usage.peakConcurrentModelCalls, 2);
    assert.equal(result.usage.llmSubcalls, 4);
    assert.equal(result.usage.modelCalls, 5);
    assert.equal(result.usage.peakReservedProviderTokens > 0, true);
  } finally {
    unregister();
  }
});

test("provider preflight rejects root calls before crossing the shared token budget", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-token-limit-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `answer.content = "SHOULD_NOT_COMPLETE"; answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    const runner = new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      limits: { maxTokens: 1 },
    });
    await assert.rejects(
      runner.run("Context", "Answer."),
      /provider budget preflight rejected/,
    );
    assert.equal(faux.state.callCount, 0);
  } finally {
    unregister();
  }
});

test("provider preflight preserves finalization reserve before dispatch", async () => {
  const api: Api = `pi-rlm-finalization-reserve-${Date.now()}`;
  const model: Model<Api> = {
    id: "reserve-model",
    name: "Reserve Model",
    api,
    provider: "pi-rlm-finalization-reserve",
    baseUrl: "http://localhost:0",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 1_000,
  };
  let dispatched = 0;
  const limits = new SharedRunLimits({
    maxTokens: 1_000,
    maxProviderOutputTokens: 100,
    finalizationReserveTokens: 500,
  });
  const limited = limits.wrapProvider(() => {
    dispatched += 1;
    throw new Error("upstream must not be called");
  });

  try {
    const events = [];
    for await (const event of limited(model, { messages: [] }, { maxTokens: 100 })) {
      events.push(event);
    }
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "error");
    if (terminal?.type !== "error") assert.fail("expected preflight error");
    assert.match(terminal.error.errorMessage ?? "", /budget preflight rejected/u);
    assert.equal(dispatched, 0);
    assert.equal(limits.snapshot().preflightRejectedProviderCalls, 1);
    assert.equal(limits.reservationSnapshot().providerTokens, 0);
  } finally {
    limits.dispose();
  }
});

test("finalization provider call consumes the reserve once", async () => {
  const api: Api = `pi-rlm-finalization-consume-${Date.now()}`;
  const model: Model<Api> = {
    id: "finalization-model",
    name: "Finalization Model",
    api,
    provider: "pi-rlm-finalization-consume",
    baseUrl: "http://localhost:0",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 1_000,
  };
  let dispatched = 0;
  const limits = new SharedRunLimits({
    maxTokens: 1_000,
    maxProviderOutputTokens: 100,
    finalizationReserveTokens: 500,
  });
  const limited = limits.wrapProvider(() => {
    dispatched += 1;
    throw new Error("expected finalization dispatch");
  });

  try {
    const terminalErrors: string[] = [];
    await limits.withFinalizationProviderCall(async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        for await (const event of limited(model, { messages: [] }, { maxTokens: 100 })) {
          if (event.type === "error") {
            terminalErrors.push(event.error.errorMessage ?? "");
          }
        }
      }
    });

    assert.equal(dispatched, 1);
    assert.match(terminalErrors[0] ?? "", /expected finalization dispatch/u);
    assert.match(terminalErrors[1] ?? "", /budget preflight rejected/u);
    assert.deepEqual(
      limits.providerTraces().map((trace) => ({
        finalization: trace.usesFinalizationReserve,
        dispatched: trace.dispatched,
      })),
      [
        { finalization: true, dispatched: true },
        { finalization: false, dispatched: false },
      ],
    );
  } finally {
    limits.dispose();
  }
});

test("last root turn finalizes from persistent REPL state", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-final-turn-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  let finalPrompt = "";
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `state.result = "FINAL_TURN_OK";`,
      }),
      { stopReason: "toolUse" },
    ),
    (context) => {
      finalPrompt = extractUserPrompt(context);
      return fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `answer.content = state.result; answer.ready = true;`,
        }),
        { stopReason: "toolUse" },
      );
    },
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      limits: {
        maxRootTurns: 2,
        maxTokens: 20_000,
        finalizationReserveTokens: 2_000,
      },
    }).run("External context", "Return the stored result.");

    assert.equal(result.response, "FINAL_TURN_OK");
    assert.match(finalPrompt, /FINALIZATION TURN/u);
    assert.deepEqual(
      result.trace.providerCalls.map((trace) => trace.usesFinalizationReserve),
      [false, true],
    );
  } finally {
    unregister();
  }
});

test("shared deadline aborts a stalled provider call", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-timeout-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    async () => {
      await delay(100);
      return fauxAssistantMessage("TOO_LATE");
    },
  ]);

  try {
    const runner = new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      limits: { timeoutMs: 20 },
      isolation: { executionTimeoutMs: 1_000 },
    });
    await assert.rejects(
      runner.run("Context", "Answer."),
      /RLM timeout exceeded/,
    );
  } finally {
    unregister();
  }
});

test("shared cost limit rejects the provider response that crosses the budget", async () => {
  const api: Api = `pi-rlm-cost-test-${Date.now()}`;
  const model: Model<Api> = {
    id: "cost-model",
    name: "Cost Model",
    api,
    provider: "pi-rlm-cost-test",
    baseUrl: "http://localhost:0",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
  };
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "costly" }],
    api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const providerStream = () => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    });
    return stream;
  };
  const limits = new SharedRunLimits({ maxCostUsd: 0.01 });
  const limitedStream = limits.wrapProvider(providerStream);

  try {
    const events = [];
    for await (const event of limitedStream(model, { messages: [] })) events.push(event);

    const terminal = events.at(-1);
    assert.equal(terminal?.type, "error");
    if (terminal?.type !== "error") assert.fail("expected a terminal provider error");
    assert.match(terminal.error.errorMessage ?? "", /RLM cost limit exceeded/);
    assert.equal(limits.snapshot().costUsd, 0.02);
    assert.equal(limits.signal.aborted, true);
    assert.equal(limits.reservationSnapshot().providerTokens, 0);
  } finally {
    limits.dispose();
  }
});

test("corrective prompt recovers when the root model answers without rlm_exec", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-tool-recovery-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage("UNSUPPORTED_DIRECT_ANSWER"),
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `answer.content = \"RECOVERED_WITH_TOOL\"; answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), { modelRuntime }).run(
      "External context",
      "Use the external context.",
    );
    assert.equal(result.response, "RECOVERED_WITH_TOOL");
    assert.equal(result.usage.modelCalls, 2);
  } finally {
    unregister();
  }
});

test("accepts a callable answer handle emitted by a Pi model", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-callable-answer-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `answer({ content: "CALLABLE_ANSWER_OK", ready: true });`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), { modelRuntime }).run(
      "External context",
      "Use the callable answer form.",
    );
    assert.equal(result.response, "CALLABLE_ANSWER_OK");
  } finally {
    unregister();
  }
});

test("get_budget exposes an immutable bounded snapshot without a legacy binding", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-budget-snapshot-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
const snapshot = get_budget();
snapshot.remainingRootTurns = 999;
answer.content = JSON.stringify({snapshot, fresh: get_budget(), legacyType: typeof budget});
answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      limits: {
        maxTokens: 10_000,
        maxProviderOutputTokens: 128,
        finalizationReserveTokens: 500,
        maxRootTurns: 3,
      },
    }).run("External context", "Return the budget snapshot.");
    const resultPayload = JSON.parse(result.response) as {
      snapshot: {
        remainingTokens: number;
        remainingRootTurns: number;
        finalizationReserveTokens: number;
      };
      fresh: { remainingRootTurns: number };
      legacyType: string;
    };
    assert.equal(resultPayload.snapshot.remainingRootTurns, 3);
    assert.equal(resultPayload.snapshot.finalizationReserveTokens, 500);
    assert.equal(resultPayload.snapshot.remainingTokens > 0, true);
    assert.equal(resultPayload.fresh.remainingRootTurns, 3);
    assert.equal(resultPayload.legacyType, "undefined");
  } finally {
    unregister();
  }
});

test("public answer contracts reach the root prompt without exposing an oracle", async () => {
  const rootPrompts: string[] = [];
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-public-contract-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    (context: Context) => {
      rootPrompts.push(extractUserPrompt(context));
      return fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `answer.content = "CONTRACT_OK"; answer.ready = true;`,
        }),
        { stopReason: "toolUse" },
      );
    },
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), { modelRuntime }).run(
      "External context",
      "Return one contract value.",
      {
        publicAnswerContract: {
          description: "Return one uppercase token.",
          pattern: "^[A-Z_]+$",
        },
      },
    );
    assert.equal(result.response, "CONTRACT_OK");
    assert.match(rootPrompts[0] ?? "", /Return one uppercase token/u);
    assert.match(rootPrompts[0] ?? "", /\^\[A-Z_\]\+\$/u);
    assert.equal((rootPrompts[0] ?? "").includes("CONTRACT_OK"), false);
  } finally {
    unregister();
  }
});

test("accepts a reassigned answer binding after a model subcall", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-reassigned-answer-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `answer = await llm_query({question: "Return exactly REASSIGNED_ANSWER_OK", evidenceIds: []});`,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("REASSIGNED_ANSWER_OK"),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), { modelRuntime }).run(
      "External context",
      "Return the subcall answer.",
    );
    assert.equal(result.response, "REASSIGNED_ANSWER_OK");
    assert.equal(result.usage.llmSubcalls, 1);
  } finally {
    unregister();
  }
});

test("rejects undefined answers before accepting one explicit REPL resubmission", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-intrinsic-answer-contract-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `answer.content = undefined; answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `answer.content = "RESUBMITTED_ANSWER_OK"; answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), { modelRuntime }).run(
      "External context",
      "Return a non-empty answer.",
    );
    assert.equal(result.response, "RESUBMITTED_ANSWER_OK");
    assert.equal(result.executionCount, 2);
    assert.equal(result.answerRejections, 1);
    const messages = JSON.stringify(result.rootMessages);
    assert.match(messages, /answer\.content is undefined/);
    assert.match(messages, /Revise it inside the REPL and submit again/);
  } finally {
    unregister();
  }
});

test("uses a caller validator to reject quoted and malformed answers without correcting them", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-exact-answer-contract-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `answer.content = '"EXACT_ANSWER_OK"'; answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `answer.content = "EXACT_ANSWER_OK"; answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);
  const observedCandidates: string[] = [];

  try {
    const result = await new PiRlmRunner(faux.getModel(), { modelRuntime }).run(
      "External context",
      "Return only the exact token.",
      {
        validateAnswer: (candidate) => {
          observedCandidates.push(candidate);
          return candidate === "EXACT_ANSWER_OK"
            ? { valid: true }
            : {
                valid: false,
                reason: "The submitted answer does not satisfy the requested exact output format.",
              };
        },
      },
    );
    assert.equal(result.response, "EXACT_ANSWER_OK");
    assert.deepEqual(observedCandidates, [
      '"EXACT_ANSWER_OK"',
      "EXACT_ANSWER_OK",
    ]);
    assert.equal(result.executionCount, 2);
    assert.equal(result.answerRejections, 1);
  } finally {
    unregister();
  }
});

test("fails after one bounded invalid resubmission instead of inferring an answer", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-bounded-answer-contract-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses(
    Array.from({ length: 2 }, () =>
      fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `answer.content = ""; answer.ready = true;`,
        }),
        { stopReason: "toolUse" },
      ),
    ),
  );

  try {
    await assert.rejects(
      new PiRlmRunner(faux.getModel(), { modelRuntime }).run(
        "External context",
        "Return a non-empty answer.",
      ),
      /Answer contract rejected 2 submissions.*answer\.content must not be empty/,
    );
    assert.equal(faux.state.callCount, 2);
  } finally {
    unregister();
  }
});
