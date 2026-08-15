import assert from "node:assert/strict";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import { PiRlmRunner } from "../src/runner.ts";
import {
  estimateSubcallInputTokens,
  SharedRunLimits,
  SubcallPreflightError,
} from "../src/shared-limits.ts";
import { createFauxRuntime } from "./faux-runtime.ts";

test("reserves estimated prompt tokens atomically before subcall dispatch", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-subcall-reservation-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  const limits = new SharedRunLimits({
    maxTokens: 1_500,
    maxSubcallInputTokens: 1_200,
    finalizationReserveTokens: 100,
  });
  const prompt = "x".repeat(1_200);
  const estimate = estimateSubcallInputTokens(prompt);

  try {
    const first = limits.reserveSubcall(prompt, faux.getModel(), "llm");
    assert.equal(first.estimatedInputTokens, estimate);
    assert.throws(
      () => limits.reserveSubcall(prompt, faux.getModel(), "llm"),
      /would exceed the remaining RLM token budget.*No provider request was sent/,
    );
    assert.equal(limits.snapshot().preflightRejectedSubcalls, 1);
    assert.equal(limits.snapshot().peakReservedSubcallInputTokens, estimate);

    first.release();
    const afterRelease = limits.reserveSubcall(prompt, faux.getModel(), "llm");
    afterRelease.release();
  } finally {
    limits.dispose();
    unregister();
  }
});

test("rejects a single subcall whose estimated input cost exceeds remaining budget", async () => {
  const { faux, unregister } = await createFauxRuntime({
    provider: "pi-rlm-subcall-cost-test",
    models: [
      {
        id: "expensive",
        contextWindow: 64_000,
        maxTokens: 4_096,
        cost: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  const limits = new SharedRunLimits({
    maxTokens: 100_000,
    maxCostUsd: 0.001,
    maxSubcallInputTokens: 100_000,
  });

  try {
    assert.throws(
      () => limits.reserveSubcall("x".repeat(3_000), faux.getModel(), "llm"),
      /estimated input cost.*remaining RLM cost budget.*No provider request was sent/,
    );
    assert.equal(limits.snapshot().preflightRejectedSubcalls, 1);
  } finally {
    limits.dispose();
    unregister();
  }
});

test("aborts after repeated preflight rejections instead of looping indefinitely", async () => {
  const { faux, unregister } = await createFauxRuntime({
    provider: "pi-rlm-subcall-rejection-cap-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  const limits = new SharedRunLimits({
    maxTokens: 20_000,
    maxSubcallInputTokens: 100,
    maxPreflightRejectedSubcalls: 2,
  });

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () => limits.reserveSubcall("x".repeat(2_000), faux.getModel(), "llm"),
        /RLM subcall preflight rejected/,
      );
    }
    assert.throws(
      () => limits.reserveSubcall("x".repeat(2_000), faux.getModel(), "llm"),
      /RLM subcall preflight rejection limit exceeded: 3\/2/,
    );
    assert.equal(limits.signal.aborted, true);
    assert.equal(limits.snapshot().preflightRejectedSubcalls, 3);
  } finally {
    limits.dispose();
    unregister();
  }
});

test("oversized llm and leaf rlm calls fail closed and return replanning guidance", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-subcall-guidance-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
for (const query of [llm_query, rlm_query]) {
  try {
    await query({question: "Return the inline context.", evidenceIds: [], inlineContext: "x".repeat(2_000)});
  } catch (error) {
    console.log(String(error));
  }
}`,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `answer.content = "REPLANNED_WITHOUT_PROVIDER_CALL"; answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      limits: {
        maxDepth: 1,
        maxTokens: 20_000,
        maxCostUsd: 0.05,
        maxSubcallInputTokens: 500,
      },
    }).run("External context", "Replan oversized subcalls.");

    assert.equal(result.response, "REPLANNED_WITHOUT_PROVIDER_CALL");
    assert.equal(result.usage.preflightRejectedSubcalls, 2);
    assert.equal(result.usage.llmSubcalls, 1);
    assert.equal(result.usage.rlmSubcalls, 1);
    assert.equal(faux.state.callCount, 2, "rejected subcalls must not reach the provider");
    const messages = JSON.stringify(result.rootMessages);
    assert.match(messages, /split it into smaller chunks or use rlm_query/);
    assert.match(messages, /No provider request was sent/);
  } finally {
    unregister();
  }
});

test("exposes structured replanning state and a deterministic chunk helper", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-structured-replan-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  let observedContinuation = "";
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `await llm_query({question: "Return the inline context.", evidenceIds: [], inlineContext: "x".repeat(2_000)});`,
      }),
      { stopReason: "toolUse" },
    ),
    (context) => {
      observedContinuation = JSON.stringify(context.messages);
      return fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `
if (last_replan?.code !== "RLM_SUBCALL_REPLAN_REQUIRED") {
  throw new Error("missing structured replan state");
}
answer.content = JSON.stringify(chunk_text("ABCDEFGHIJ", 4));
answer.ready = true;`,
        }),
        { stopReason: "toolUse" },
      );
    },
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      limits: {
        maxTokens: 20_000,
        maxCostUsd: 0.05,
        maxSubcallInputTokens: 1_000,
      },
    }).run("External context", "Follow the structured replan contract.");

    assert.equal(result.response, '["ABCD","EFGH","IJ"]');
    assert.equal(result.usage.preflightRejectedSubcalls, 1);
    assert.equal(faux.state.callCount, 2);
    assert.match(observedContinuation, /RLM_SUBCALL_REPLAN_REQUIRED/);
    assert.match(observedContinuation, /last_replan/);
    assert.match(observedContinuation, /chunk_text/);
    assert.match(observedContinuation, /maxChunkCharacters/);
  } finally {
    unregister();
  }
});

test("preflight errors expose machine-readable limits without dispatching", async () => {
  const { faux, unregister } = await createFauxRuntime({
    provider: "pi-rlm-structured-preflight-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  const limits = new SharedRunLimits({
    maxTokens: 20_000,
    maxSubcallInputTokens: 1_500,
  });

  try {
    assert.throws(
      () => limits.reserveSubcall("x".repeat(4_000), faux.getModel(), "llm"),
      (error) => {
        assert.ok(error instanceof SubcallPreflightError);
        assert.equal(error.replan.code, "RLM_SUBCALL_REPLAN_REQUIRED");
        assert.equal(error.replan.queryKind, "llm");
        assert.equal(error.replan.reason, "single_call_input_limit");
        assert.equal(error.replan.maxInputTokens, 1_500);
        assert.ok(error.replan.estimatedInputTokens > error.replan.maxInputTokens);
        assert.ok(error.replan.maxChunkCharacters > 0);
        assert.deepEqual(error.replan.strategies, [
          "process_locally",
          "chunk_text_then_llm_query_batched",
          "rlm_query",
        ]);
        return true;
      },
    );
  } finally {
    limits.dispose();
    unregister();
  }
});
