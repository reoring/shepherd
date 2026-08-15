import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import { PatchExecutor } from "../src/patch-executor.ts";
import { executePatchPlanning } from "../src/patch-planner.ts";
import {
  createDefaultRepairFixture,
  createDefaultRepairVerificationProfiles,
  type DefaultRepairFixture,
} from "../src/patch-planning-fixture.ts";
import {
  createRegistrationInsertionFixture,
  createRegistrationInsertionVerificationProfiles,
  createTwoFileWiringFixture,
} from "../src/patch-phase-c-fixtures.ts";
import { createFileIndexedEvidenceSession } from "../src/file-context.ts";
import {
  DEFAULT_MUTATION_LIMITS,
  derivePatchPrecondition,
  hashPatchSpan,
  parsePatchPlan,
} from "../src/patch-plan.ts";
import { ReplDockerCleanupError } from "../src/repl-client.ts";
import type {
  DockerCommandResult,
  DockerCommandRunner,
} from "../src/patch-verifier.ts";
import { PiRlmRunError, PiRlmRunner } from "../src/runner.ts";
import { createFauxRuntime } from "./faux-runtime.ts";

function dockerResult(
  stdout = "",
  overrides: Partial<DockerCommandResult> = {},
): DockerCommandResult {
  return {
    exitCode: 0,
    output: Buffer.from(stdout, "utf8"),
    stdout: Buffer.from(stdout, "utf8"),
    stderr: Buffer.alloc(0),
    timedOut: false,
    outputTruncated: false,
    ...overrides,
  };
}

function trustedVerificationRunner(contractAnswer = "timeout=20"): DockerCommandRunner {
  let starts = 0;
  return async (args, _timeoutMs, _outputLimitBytes, stdin) => {
    if (args[0] === "create") {
      const cidFile = args[args.indexOf("--cidfile") + 1];
      if (!cidFile) throw new Error("Patch verifier omitted Docker cidfile");
      await writeFile(cidFile, `${"a".repeat(64)}\n`, "utf8");
      return dockerResult();
    }
    if (args[0] === "start") {
      starts += 1;
      if (starts === 1) {
        return dockerResult(`${JSON.stringify({
          status: "passed",
          modelCalls: 0,
          runtimeFinalized: true,
          answer: contractAnswer,
        })}\n`);
      }
      const challenge = JSON.parse(stdin?.toString("utf8") ?? "") as {
        secret: string;
        profile: string;
        step: string;
      };
      const proof = createHmac("sha256", challenge.secret)
        .update(`focused-proof\0${challenge.profile}\0${challenge.step}`, "utf8")
        .digest("hex");
      return dockerResult(`${JSON.stringify({ proof })}\n`);
    }
    if (args[0] === "rm") return dockerResult();
    if (args[0] === "container") {
      const identity = args[2] ?? "";
      const stdout = "[]\n";
      const stderr = `Error: No such container: ${identity}\n`;
      return dockerResult(stdout + stderr, {
        exitCode: 1,
        stdout: Buffer.from(stdout, "utf8"),
        stderr: Buffer.from(stderr, "utf8"),
      });
    }
    throw new Error(`Unexpected Docker verifier command: ${args.join(" ")}`);
  };
}

async function withFixture(
  exercise: (fixture: DefaultRepairFixture) => Promise<void>,
): Promise<void> {
  const fixture = await createDefaultRepairFixture();
  try {
    await exercise(fixture);
  } finally {
    await fixture.cleanup();
  }
}

function validPatchSubmission(fixture: DefaultRepairFixture): string {
  return `
const slice = await read_lines("src/config.ts", 1, 7);
const precondition = await get_patch_precondition({
  path: "src/config.ts",
  evidenceId: slice.id,
  operation: "replace-range",
  startLine: 6,
  endLine: 6,
});
submit_patch_plan({
  version: 1,
  sourceRevision: "${fixture.context.sourceRevision}",
  intent: "Set the default timeout to 20.",
  edits: [{
    path: "src/config.ts",
    evidenceId: slice.id,
    expectedOldHash: precondition.expectedOldHash,
    operation: "replace-range",
    startLine: 6,
    endLine: 6,
    replacement: "  timeout: 20,\\n",
  }],
});`;
}

test("default root patch planning retains the REPL-only mode", async () => {
  await withFixture(async (fixture) => {
    const { faux, modelRuntime, unregister } = await createFauxRuntime({
      provider: "pi-rlm-patch-plan-root-test",
      models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
    });
    faux.setResponses([
      (context) => {
        const systemPrompt = context.systemPrompt;
        assert.ok(typeof systemPrompt === "string" && systemPrompt.length > 0);
        assert.match(systemPrompt, /Call rlm_exec/u);
        assert.doesNotMatch(systemPrompt, /prepare_patch_replace|submit_patch_replacement/u);
        assert.deepEqual(context.tools?.map((tool) => tool.name), ["rlm_exec"]);
        return fauxAssistantMessage(
          fauxToolCall("rlm_exec", { code: validPatchSubmission(fixture) }),
          { stopReason: "toolUse" },
        );
      },
    ]);

    try {
      const result = await executePatchPlanning({
        runner: new PiRlmRunner(faux.getModel(), {
          modelRuntime,
          limits: { maxRootTurns: 2 },
          isolation: { mode: "docker" },
        }),
        executor: PatchExecutor.createRoot(createDefaultRepairVerificationProfiles(), {
          verification: { dockerCommandRunner: trustedVerificationRunner() },
        }),
        context: fixture.context,
        question: fixture.question,
        verificationProfile: fixture.verificationProfile,
      });

      assert.equal(result.state, "ACCEPTED");
      assert.equal(result.accepted, true);
      assert.equal(result.plan?.edits.length, 1);
      assert.equal(result.planning?.evidenceSession.context, fixture.context);
      assert.equal(
        result.plan?.edits[0]?.expectedOldHash,
        hashPatchSpan(fixture.context.read("src/config.ts"), "replace-range", 6, 6),
      );
      assert.equal(
        result.planning?.trace.corpusCalls.some(
          (call) => call.operation === "get_patch_precondition",
        ),
        true,
      );
      assert.equal(result.receipt?.checks.every((check) => check.status === "passed"), true);
      assert.equal(faux.state.callCount, 1);
    } finally {
      unregister();
    }
  });
});

test("native-edits exposes only staged host-owned tools and submits the exact one-target set", async () => {
  await withFixture(async (fixture) => {
    const nativeEdits = [{
      id: "set-default-timeout",
      path: "src/config.ts",
      operation: "replace-range" as const,
      startLine: 6,
      endLine: 6,
    }];
    const { faux, modelRuntime, unregister } = await createFauxRuntime({
      provider: "pi-rlm-native-edits-root-test",
      models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
    });
    faux.setResponses([
      (context) => {
        assert.deepEqual(context.tools?.map((tool) => tool.name), ["prepare_native_edits"]);
        assert.match(context.systemPrompt ?? "", /only active tool is prepare_native_edits/u);
        assert.equal(JSON.stringify(context.messages).includes("  timeout: 10,"), false);
        const schema = context.tools?.[0]?.parameters as {
          additionalProperties?: boolean;
          properties?: Record<string, unknown>;
        } | undefined;
        assert.equal(schema?.additionalProperties, false);
        assert.deepEqual(Object.keys(schema?.properties ?? {}), []);
        return fauxAssistantMessage(
          fauxToolCall("prepare_native_edits", {}),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        assert.deepEqual(context.tools?.map((tool) => tool.name), ["submit_native_edits"]);
        assert.match(context.systemPrompt ?? "", /only active tool is submit_native_edits/u);
        assert.equal(JSON.stringify(context.messages).includes("  timeout: 10,"), true);
        return fauxAssistantMessage(
          fauxToolCall("submit_native_edits", {
            intent: "Set the default timeout to 20.",
            replacements: [{
              id: "set-default-timeout",
              replacement: "  timeout: 20,\n",
            }],
          }),
          { stopReason: "toolUse" },
        );
      },
    ]);
    try {
      const result = await executePatchPlanning({
        runner: new PiRlmRunner(faux.getModel(), {
          modelRuntime,
          limits: { maxRootTurns: 2 },
          isolation: { mode: "docker" },
        }),
        executor: PatchExecutor.createRoot(createDefaultRepairVerificationProfiles(), {
          verification: { dockerCommandRunner: trustedVerificationRunner() },
        }),
        context: fixture.context,
        question: fixture.question,
        verificationProfile: fixture.verificationProfile,
        patchPlanningMode: "native-edits",
        nativeEdits,
      });
      assert.equal(result.state, "ACCEPTED");
      assert.equal(result.plan?.edits.length, 1);
      assert.equal(result.plan?.edits[0]?.replacement, "  timeout: 20,\n");
      assert.equal(
        result.plan?.edits[0]?.expectedOldHash,
        hashPatchSpan(fixture.context.read("src/config.ts"), "replace-range", 6, 6),
      );
      assert.deepEqual(result.planning?.trace.patchTools?.map((tool) => tool.tool), [
        "prepare_native_edits",
        "submit_native_edits",
      ]);
      assert.equal(
        result.planning?.trace.patchTools?.[0]?.targets?.[0]?.id,
        "set-default-timeout",
      );
    } finally {
      unregister();
    }
  });
});

test("native replacement rejects a missing terminal newline once before accepting the bounded correction", async () => {
  await withFixture(async (fixture) => {
    const nativeEdits = [{
      id: "set-default-timeout",
      path: "src/config.ts",
      operation: "replace-range" as const,
      startLine: 6,
      endLine: 6,
    }];
    const { faux, modelRuntime, unregister } = await createFauxRuntime({
      provider: "pi-rlm-native-replacement-newline-resubmission-test",
      models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
    });
    faux.setResponses([
      (context) => {
        assert.deepEqual(context.tools?.map((tool) => tool.name), ["prepare_native_edits"]);
        return fauxAssistantMessage(
          fauxToolCall("prepare_native_edits", {}),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        assert.deepEqual(context.tools?.map((tool) => tool.name), ["submit_native_edits"]);
        assert.match(context.systemPrompt ?? "", /requiresTerminalNewline is true/u);
        assert.match(JSON.stringify(context.messages), /\\"requiresTerminalNewline\\":true/u);
        assert.doesNotMatch(JSON.stringify(context.messages), /timeout: 20/u);
        return fauxAssistantMessage(
          fauxToolCall("submit_native_edits", {
            intent: "Set the default timeout to 20.",
            replacements: [{
              id: "set-default-timeout",
              replacement: "  timeout: 20,",
            }],
          }),
          { stopReason: "toolUse" },
        );
      },
      () => fauxAssistantMessage(
        fauxToolCall("submit_native_edits", {
          intent: "Set the default timeout to 20.",
          replacements: [{
            id: "set-default-timeout",
            replacement: "  timeout: 20,\n",
          }],
        }),
        { stopReason: "toolUse" },
      ),
    ]);
    try {
      const result = await new PiRlmRunner(faux.getModel(), {
        modelRuntime,
        limits: { maxRootTurns: 3 },
        isolation: { mode: "docker" },
      }).planPatch(fixture.context, fixture.question, {
        mode: "native-edits",
        nativeEdits,
      });

      assert.equal(result.plan.edits[0]?.replacement, "  timeout: 20,\n");
      assert.equal(result.trace.patchPlanRejections, 1);
      assert.deepEqual(result.trace.patchTools?.map((tool) => tool.status), [
        "prepared",
        "rejected",
        "submitted",
      ]);
      assert.equal(faux.state.callCount, 3);
    } finally {
      unregister();
    }
  });
});

test("native insertion rejects malformed text once before accepting a corrected host-bound replacement", async () => {
  const fixture = await createRegistrationInsertionFixture();
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-native-insertion-resubmission-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    (context) => {
      assert.deepEqual(context.tools?.map((tool) => tool.name), ["prepare_native_edits"]);
      return fauxAssistantMessage(
        fauxToolCall("prepare_native_edits", {}),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      assert.deepEqual(context.tools?.map((tool) => tool.name), ["submit_native_edits"]);
      assert.match(context.systemPrompt ?? "", /must end with a newline/u);
      assert.match(context.systemPrompt ?? "", /source code derived directly from the question and target ID/u);
      return fauxAssistantMessage(
        fauxToolCall("submit_native_edits", {
          intent: "Register the requested command.",
          replacements: [{
            id: "register-create-command",
            replacement: "new command text",
          }],
        }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      return fauxAssistantMessage(
        fauxToolCall("submit_native_edits", {
          intent: "Register the requested command.",
          replacements: [{
            id: "register-create-command",
            replacement: '  "create",\n',
          }],
        }),
        { stopReason: "toolUse" },
      );
    },
  ]);
  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      limits: { maxRootTurns: 3 },
      isolation: { mode: "docker" },
    }).planPatch(fixture.context, fixture.question, {
      mode: "native-edits",
      nativeEdits: fixture.nativeEdits,
    });

    assert.equal(result.plan.edits[0]?.replacement, '  "create",\n');
    assert.equal(result.trace.patchPlanRejections, 1);
    assert.deepEqual(result.trace.patchTools?.map((tool) => tool.status), [
      "prepared",
      "rejected",
      "submitted",
    ]);
    assert.equal(faux.state.callCount, 3);
  } finally {
    unregister();
    await fixture.cleanup();
  }
});

test("native two-file constraints reject comment imitations once before accepting whitespace-valid corrections", async () => {
  const fixture = await createTwoFileWiringFixture();
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-native-two-file-replacement-constraints",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    () => fauxAssistantMessage(
      fauxToolCall("prepare_native_edits", {}),
      { stopReason: "toolUse" },
    ),
    (context) => {
      assert.match(
        JSON.stringify(context.messages),
        /Replacement must be one executable enabled: true property line\./u,
      );
      assert.match(
        JSON.stringify(context.messages),
        /Replacement must directly export featureEnabled from featureConfig\.enabled\./u,
      );
      assert.doesNotMatch(JSON.stringify(context.messages), /\^\\\\s\*enabled/u);
      return fauxAssistantMessage(
        fauxToolCall("submit_native_edits", {
          intent: "Enable and wire the feature.",
          replacements: [
            { id: "enable-feature-config", replacement: "  // enabled: true,\n" },
            {
              id: "wire-feature-consumer",
              replacement: "// export const featureEnabled = featureConfig.enabled;\n",
            },
          ],
        }),
        { stopReason: "toolUse" },
      );
    },
    () => fauxAssistantMessage(
      fauxToolCall("submit_native_edits", {
        intent: "Enable and wire the feature.",
        replacements: [
          { id: "enable-feature-config", replacement: "    enabled  :  true , \n" },
          {
            id: "wire-feature-consumer",
            replacement: " export   const  featureEnabled = featureConfig.enabled ;\n",
          },
        ],
      }),
      { stopReason: "toolUse" },
    ),
  ]);
  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      limits: { maxRootTurns: 3 },
      isolation: { mode: "docker" },
    }).planPatch(fixture.context, fixture.question, {
      mode: "native-edits",
      nativeEdits: fixture.nativeEdits,
    });

    assert.deepEqual(
      result.plan.edits.map((edit) => edit.replacement),
      [
        "    enabled  :  true , \n",
        " export   const  featureEnabled = featureConfig.enabled ;\n",
      ],
    );
    assert.equal(result.trace.patchPlanRejections, 1);
    assert.deepEqual(result.trace.patchTools?.map((tool) => tool.status), [
      "prepared",
      "rejected",
      "submitted",
    ]);
    assert.equal(faux.state.callCount, 3);
  } finally {
    unregister();
    await fixture.cleanup();
  }
});

test("registration executor accepts create entries in both quote styles", async () => {
  for (const { name, replacement } of [
    { name: "double", replacement: '  "create",\n' },
    { name: "single", replacement: "  'create',\n" },
  ]) {
    const fixture = await createRegistrationInsertionFixture();
    const { faux, modelRuntime, unregister } = await createFauxRuntime({
      provider: `pi-rlm-registration-${name}-quote-style-test`,
      models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
    });
    faux.setResponses([
      () => fauxAssistantMessage(
        fauxToolCall("prepare_native_edits", {}),
        { stopReason: "toolUse" },
      ),
      () => fauxAssistantMessage(
        fauxToolCall("submit_native_edits", {
          intent: "Register the requested command.",
          replacements: [{
            id: "register-create-command",
            replacement,
          }],
        }),
        { stopReason: "toolUse" },
      ),
    ]);
    try {
      const result = await executePatchPlanning({
        runner: new PiRlmRunner(faux.getModel(), {
          modelRuntime,
          limits: { maxRootTurns: 2 },
          isolation: { mode: "docker" },
        }),
        executor: PatchExecutor.createRoot(
          createRegistrationInsertionVerificationProfiles(),
          { verification: { dockerCommandRunner: trustedVerificationRunner("registration=create") } },
        ),
        context: fixture.context,
        question: fixture.question,
        verificationProfile: fixture.verificationProfile,
        patchPlanningMode: "native-edits",
        nativeEdits: fixture.nativeEdits,
      });

      assert.equal(result.state, "ACCEPTED");
      assert.equal(result.plan?.edits[0]?.replacement, replacement);
      assert.equal(result.receipt?.checks.every((check) => check.status === "passed"), true);
    } finally {
      unregister();
      await fixture.cleanup();
    }
  }
});


test("native replacement rejects a missing host target before any model call", async () => {
  await withFixture(async (fixture) => {
    const { faux, modelRuntime, unregister } = await createFauxRuntime({
      provider: "pi-rlm-native-replacement-missing-target-test",
      models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
    });
    try {
      await assert.rejects(
        () => new PiRlmRunner(faux.getModel(), {
          modelRuntime,
          isolation: { mode: "docker" },
        }).planPatch(fixture.context, fixture.question, {
          mode: "native-replacement",
        }),
        /requires an exact host nativeReplacementTarget/u,
      );
      assert.equal(faux.state.callCount, 0);
    } finally {
      unregister();
    }
  });
});

test("trusted focused TypeScript check rejects invalid timeout candidates before accepting", async () => {
  await withFixture(async (fixture) => {
    for (const replacement of [
      "  timeout: 20 as string,\n",
      "  timeout: 20 satisfies string,\n",
    ]) {
      const evidenceSession = createFileIndexedEvidenceSession(fixture.context);
      const slice = evidenceSession.readLines("src/config.ts", 6, 6);
      evidenceSession.observe([slice.id]);
      const result = await PatchExecutor.createRoot(
        createDefaultRepairVerificationProfiles(),
      ).execute({
        plan: parsePatchPlan({
          version: 1,
          sourceRevision: fixture.context.sourceRevision,
          intent: "Set the default timeout to 20.",
          edits: [{
            path: "src/config.ts",
            evidenceId: slice.id,
            expectedOldHash: hashPatchSpan(
              fixture.context.read("src/config.ts"),
              "replace-range",
              6,
              6,
            ),
            operation: "replace-range",
            startLine: 6,
            endLine: 6,
            replacement,
          }],
        }),
        verificationProfile: fixture.verificationProfile,
        context: fixture.context,
        evidenceSession,
        limits: { ...DEFAULT_MUTATION_LIMITS },
      });

      assert.equal(result.state, "VERIFICATION_FAILED");
      assert.equal(result.receipt.failureCode, "FOCUSED_CHECK_FAILED");
      assert.equal(
        result.receipt.checks.find((check) => check.kind === "rlm-contract")?.status,
        "passed",
      );
    }
  });
});

test("normal root sessions do not expose native patch tools", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-native-replacement-normal-absence-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    (context) => {
      assert.deepEqual(context.tools?.map((tool) => tool.name).sort(), ["rlm_exec"]);
      return fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: 'answer.content = "normal session"; answer.ready = true;',
        }),
        { stopReason: "toolUse" },
      );
    },
  ]);
  try {
    const result = await new PiRlmRunner(faux.getModel(), { modelRuntime }).run(
      "normal context",
      "Return the normal session marker.",
    );
    assert.equal(result.response, "normal session");
    assert.equal(faux.state.callCount, 1);
  } finally {
    unregister();
  }
});


test("root planner expands a host-bound patch draft into a strict PatchPlan", async () => {
  await withFixture(async (fixture) => {
    const { faux, modelRuntime, unregister } = await createFauxRuntime({
      provider: "pi-rlm-patch-plan-draft-test",
      models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `
const span = await read_lines("src/config.ts", 1, 7);
const precondition = await get_patch_precondition({
  path: "src/config.ts",
  evidenceId: span.id,
  operation: "replace",
  startLine: 6,
  endLine: 6,
});
submit_patch_plan({
  intent: "Set the default timeout to 20.",
  edits: [{
    path: "src/config.ts",
    operation: "replace",
    startLine: 6,
    endLine: 6,
    replacement: "  timeout: 20,\\n",
    precondition,
  }],
});`,
        }),
        { stopReason: "toolUse" },
      ),
    ]);
    try {
      const result = await new PiRlmRunner(faux.getModel(), {
        modelRuntime,
        isolation: { mode: "docker" },
      }).planPatch(fixture.context, fixture.question);

      assert.equal(result.plan.sourceRevision, fixture.context.sourceRevision);
      assert.equal(result.plan.edits[0]?.operation, "replace-range");
      assert.equal(
        result.plan.edits[0]?.expectedOldHash,
        hashPatchSpan(fixture.context.read("src/config.ts"), "replace-range", 6, 6),
      );
      assert.equal(result.trace.executions[0]?.patchSubmitAttempts, 1);
      assert.equal(result.trace.executions[0]?.patchSubmitRejections, 0);
    } finally {
      unregister();
    }
  });
});

test("prepared replacement persists across REPL executions but needs explicit intent and replacement", async () => {
  await withFixture(async (fixture) => {
    const { faux, modelRuntime, unregister } = await createFauxRuntime({
      provider: "pi-rlm-patch-plan-persisted-prepared-test",
      models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: 'await prepare_patch_replace("src/config.ts", 6, 6);',
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `
let emptyIntentRejected = false;
try {
  submit_prepared_patch_replace("", "  timeout: 20,\\n");
} catch {
  emptyIntentRejected = true;
}
if (!emptyIntentRejected) throw new Error("empty intent was accepted");
submit_prepared_patch_replace(
  "Set the default timeout to 20.",
  "  timeout: 20,\\n",
);`,
        }),
        { stopReason: "toolUse" },
      ),
    ]);
    try {
      const result = await new PiRlmRunner(faux.getModel(), {
        modelRuntime,
        limits: { maxRootTurns: 2 },
        isolation: { mode: "docker" },
      }).planPatch(fixture.context, fixture.question);

      assert.equal(result.plan.edits[0]?.replacement, "  timeout: 20,\n");
      assert.deepEqual(result.trace.executions[0]?.preparedPatchReplace, {
        path: "src/config.ts",
        startLine: 6,
        endLine: 6,
      });
      assert.equal(result.trace.executions[0]?.patchSubmitAttempts, 0);
      assert.equal(result.trace.executions[1]?.patchSubmitAttempts, 1);
      assert.equal(result.trace.executions[1]?.patchSubmitRejections, 0);
    } finally {
      unregister();
    }
  });
});

test("child RLMs do not receive patch submission or precondition authority", async () => {
  await withFixture(async (fixture) => {
    const { faux, modelRuntime, unregister } = await createFauxRuntime({
      provider: "pi-rlm-patch-plan-child-test",
      models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `
state.slice = await read_lines("src/config.ts", 1, 7);
await rlm_query({
  question: "Confirm which patch-planning helpers are available.",
  evidenceIds: [state.slice.id],
});`,
        }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        assert.deepEqual(context.tools?.map((tool) => tool.name).sort(), ["rlm_exec"]);
        return fauxAssistantMessage(
          fauxToolCall("rlm_exec", {
            code: `
if (typeof submit_patch_plan !== "undefined") throw new Error("child received submit authority");
if (typeof get_patch_precondition !== "undefined") throw new Error("child received precondition authority");
if (typeof prepare_patch_replace !== "undefined") throw new Error("child received prepared edit authority");
if (typeof submit_prepared_patch_replace !== "undefined") throw new Error("child received prepared submit authority");
if (typeof prepare_native_edits !== "undefined") throw new Error("child received native prepare authority");
if (typeof submit_native_edits !== "undefined") throw new Error("child received native submit authority");
answer.content = "child authority boundary preserved";
answer.ready = true;`,
          }),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `
const precondition = await get_patch_precondition({
  path: "src/config.ts",
  evidenceId: state.slice.id,
  operation: "replace-range",
  startLine: 6,
  endLine: 6,
});
submit_patch_plan({
  version: 1,
  sourceRevision: "${fixture.context.sourceRevision}",
  intent: "Set the default timeout to 20.",
  edits: [{
    path: "src/config.ts",
    evidenceId: state.slice.id,
    expectedOldHash: precondition.expectedOldHash,
    operation: "replace-range",
    startLine: 6,
    endLine: 6,
    replacement: "  timeout: 20,\\n",
  }],
});`,
        }),
        { stopReason: "toolUse" },
      ),
    ]);

    try {
      const result = await new PiRlmRunner(faux.getModel(), {
        modelRuntime,
        limits: { maxDepth: 2, maxRootTurns: 3 },
        isolation: { mode: "docker" },
      }).planPatch(fixture.context, fixture.question);

      assert.equal(result.plan.edits[0]?.path, "src/config.ts");
      assert.equal(faux.state.callCount, 3);
    } finally {
      unregister();
    }
  });
});

test("invalid PatchPlans fail closed before host execution", async () => {
  await withFixture(async (fixture) => {
    const { faux, modelRuntime, unregister } = await createFauxRuntime({
      provider: "pi-rlm-patch-plan-invalid-test",
      models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
    });
    const invalidSubmission = `
const slice = await read_lines("src/config.ts", 1, 7);
const precondition = await get_patch_precondition({
  path: "src/config.ts",
  evidenceId: slice.id,
  operation: "replace-range",
  startLine: 6,
  endLine: 6,
});
submit_patch_plan({
  version: 1,
  sourceRevision: "${fixture.context.sourceRevision}",
  intent: "Set the default timeout to 20.",
  unexpected: true,
  edits: [{
    path: "src/config.ts",
    evidenceId: slice.id,
    expectedOldHash: precondition.expectedOldHash,
    operation: "replace-range",
    startLine: 6,
    endLine: 6,
    replacement: "  timeout: 20,\\n",
  }],
});`;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("rlm_exec", { code: invalidSubmission }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("rlm_exec", { code: invalidSubmission }), { stopReason: "toolUse" }),
    ]);

    try {
      await assert.rejects(
        () => new PiRlmRunner(faux.getModel(), {
          modelRuntime,
          limits: { maxRootTurns: 2 },
          isolation: { mode: "docker" },
        }).planPatch(fixture.context, fixture.question),
        (error: unknown) => {
          assert.ok(error instanceof PiRlmRunError);
          assert.equal(error.trace.patchPlanRejections, 2);
          assert.equal(error.trace.executions[0]?.patchSubmitAttempts, 1);
          assert.equal(error.trace.executions[0]?.patchSubmitRejections, 1);
          assert.equal(error.trace.executions[1]?.patchSubmitAttempts, 2);
          assert.equal(error.trace.executions[1]?.patchSubmitRejections, 2);
          assert.equal(error.trace.executions[0]?.patchSubmitAttemptDelta, 1);
          assert.equal(error.trace.executions[0]?.patchSubmitRejectionDelta, 1);
          assert.equal(error.trace.executions[1]?.patchSubmitAttemptDelta, 1);
          assert.equal(error.trace.executions[1]?.patchSubmitRejectionDelta, 1);
          assert.match(error.message, /Patch planner permanently exhausted/u);
          return true;
        },
      );
      assert.equal(faux.state.callCount, 2);
    } finally {
      unregister();
    }
  });
});
test("accepts one caught helper rejection before a valid PatchPlan submission", async () => {
  await withFixture(async (fixture) => {
    const { faux, modelRuntime, unregister } = await createFauxRuntime({
      provider: "pi-rlm-patch-plan-caught-rejection-test",
      models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `
const slice = await read_lines("src/config.ts", 1, 7);
const precondition = await get_patch_precondition({
  path: "src/config.ts",
  evidenceId: slice.id,
  operation: "replace-range",
  startLine: 6,
  endLine: 6,
});
const plan = {
  version: 1,
  sourceRevision: "${fixture.context.sourceRevision}",
  intent: "Set the default timeout to 20.",
  edits: [{
    path: "src/config.ts",
    evidenceId: slice.id,
    expectedOldHash: precondition.expectedOldHash,
    operation: "replace-range",
    startLine: 6,
    endLine: 6,
    replacement: "  timeout: 20,\\n",
  }],
};
try {
  submit_patch_plan({ ...plan, unexpected: true });
} catch {}
submit_patch_plan(plan);`,
        }),
        { stopReason: "toolUse" },
      ),
    ]);
    try {
      const result = await new PiRlmRunner(faux.getModel(), {
        modelRuntime,
        isolation: { mode: "docker" },
      }).planPatch(fixture.context, fixture.question);
      const execution = result.trace.executions[0];
      assert.equal(result.plan.edits.length, 1);
      assert.equal(result.trace.patchPlanRejections, 1);
      assert.equal(execution?.patchSubmitAttempts, 2);
      assert.equal(execution?.patchSubmitRejections, 1);
      assert.equal(execution?.patchSubmitAttemptDelta, 2);
      assert.equal(execution?.patchSubmitRejectionDelta, 1);
    } finally {
      unregister();
    }
  });
});

test("permanently exhausts submission after a second caught helper rejection", async () => {
  await withFixture(async (fixture) => {
    const { faux, modelRuntime, unregister } = await createFauxRuntime({
      provider: "pi-rlm-patch-plan-exhaustion-test",
      models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `
const slice = await read_lines("src/config.ts", 1, 7);
const precondition = await get_patch_precondition({
  path: "src/config.ts",
  evidenceId: slice.id,
  operation: "replace-range",
  startLine: 6,
  endLine: 6,
});
const plan = {
  version: 1,
  sourceRevision: "${fixture.context.sourceRevision}",
  intent: "Set the default timeout to 20.",
  edits: [{
    path: "src/config.ts",
    evidenceId: slice.id,
    expectedOldHash: precondition.expectedOldHash,
    operation: "replace-range",
    startLine: 6,
    endLine: 6,
    replacement: "  timeout: 20,\\n",
  }],
};
try {
  submit_patch_plan({ ...plan, unexpected: true });
} catch {}
try {
  submit_patch_plan({ ...plan, unexpected: true });
} catch {}
try {
  submit_patch_plan(plan);
} catch (error) {
  throw error;
}
throw new Error("submission exhaustion was bypassed");`,
        }),
        { stopReason: "toolUse" },
      ),
    ]);
    try {
      await assert.rejects(
        () => new PiRlmRunner(faux.getModel(), {
          modelRuntime,
          isolation: { mode: "docker" },
        }).planPatch(fixture.context, fixture.question),
        (error: unknown) => {
          assert.ok(error instanceof PiRlmRunError);
          assert.equal(error.trace.patchPlanRejections, 3);
          const execution = error.trace.executions[0];
          assert.equal(execution?.patchSubmitAttempts, 3);
          assert.equal(execution?.patchSubmitRejections, 3);
          assert.equal(execution?.patchSubmitRejectionDelta, 3);
          assert.match(error.message, /permanently exhausted/u);
          return true;
        },
      );
    } finally {
      unregister();
    }
  });
});


test("one non-submission REPL error receives a bounded correction turn without consuming patch submission authority", async () => {
  await withFixture(async (fixture) => {
    const { faux, modelRuntime, unregister } = await createFauxRuntime({
      provider: "pi-rlm-patch-plan-exploration-error-test",
      models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("rlm_exec", { code: 'await read_file({ filePath: "src/config.ts" });' }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("rlm_exec", { code: validPatchSubmission(fixture) }),
        { stopReason: "toolUse" },
      ),
    ]);
    try {
      const result = await new PiRlmRunner(faux.getModel(), {
        modelRuntime,
        limits: { maxRootTurns: 2 },
        isolation: { mode: "docker" },
      }).planPatch(fixture.context, fixture.question);

      assert.equal(result.plan.edits.length, 1);
      assert.equal(result.trace.patchPlanRejections, 0);
      assert.equal(result.trace.executions.length, 2);
      assert.equal(result.trace.executions[0]?.patchSubmitAttempts, 0);
      assert.equal(result.trace.executions[0]?.patchSubmitRejections, 0);
      assert.match(result.trace.executions[0]?.error ?? "", /unknown field/u);
      assert.equal(result.trace.executions[1]?.patchSubmitAttempts, 1);
      assert.equal(result.trace.executions[1]?.patchSubmitRejections, 0);
      assert.equal(faux.state.callCount, 2);
    } finally {
      unregister();
    }
  });
});

test("root planner canonicalizes common helper aliases without widening the PatchPlan contract", async () => {
  await withFixture(async (fixture) => {
    const { faux, modelRuntime, unregister } = await createFauxRuntime({
      provider: "pi-rlm-patch-plan-replace-alias-test",
      models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `
const source = await read_file({ path: "src/config.ts" });
if (!source.includes("timeout")) throw new Error("object read_file alias did not return source");
const matches = await search_files({ query: "timeout", pathPrefix: "src/", maxResults: 20 });
if (matches.length === 0) throw new Error("query search_files alias did not return matches");
const slice = await read_lines("src/config.ts", 1, 7);
const aliasPrecondition = await get_patch_precondition({
  path: "src/config.ts",
  evidenceId: slice.id,
  operation: "replace",
  startLine: 6,
  endLine: 6,
});
if (aliasPrecondition.operation !== "replace-range") throw new Error("replace alias was not canonicalized");
const prepared = await prepare_patch_replace("src/config.ts", 6, 6);
submit_prepared_patch_replace(
  "Set the default timeout to 20.",
  prepared,
  "  timeout: 20,\\n",
);`,
        }),
        { stopReason: "toolUse" },
      ),
    ]);
    try {
      const result = await new PiRlmRunner(faux.getModel(), {
        modelRuntime,
        isolation: { mode: "docker" },
      }).planPatch(fixture.context, fixture.question);

      assert.equal(result.plan.edits[0]?.operation, "replace-range");
      assert.equal(result.trace.patchPlanRejections, 0);
      assert.equal(result.trace.executions[0]?.patchSubmitAttempts, 1);
      assert.equal(result.trace.executions[0]?.patchSubmitRejections, 0);
      assert.equal(result.trace.executions[0]?.observedEvidenceIds.length, 2);
      assert.equal(
        result.trace.corpusCalls.some((call) => call.request.operation === "read_file"),
        true,
      );
      assert.equal(
        result.trace.corpusCalls.some((call) => call.request.operation === "search_files"),
        true,
      );
      assert.equal(
        result.trace.corpusCalls.some(
          (call) =>
            call.request.operation === "get_patch_precondition" &&
            call.request.request.operation === "replace-range",
        ),
        true,
      );
      assert.throws(
        () => parsePatchPlan({
          ...result.plan,
          edits: [{ ...result.plan.edits[0]!, operation: "replace" }],
        }),
        /operation is unsupported/u,
      );
    } finally {
      unregister();
    }
  });
});

test("patch planning refuses default and subprocess REPL isolation", async () => {
  await withFixture(async (fixture) => {
    const { faux, modelRuntime, unregister } = await createFauxRuntime({
      provider: "pi-rlm-patch-plan-isolation-test",
      models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
    });
    try {
      for (const isolation of [undefined, { mode: "subprocess" as const }]) {
        await assert.rejects(
          () => new PiRlmRunner(faux.getModel(), { modelRuntime, isolation }).planPatch(
            fixture.context,
            fixture.question,
          ),
          /requires Docker REPL isolation/u,
        );
      }
      assert.equal(faux.state.callCount, 0);
    } finally {
      unregister();
    }
  });
});

test("abort before planning prevents a model handoff and executor invocation", async () => {
  await withFixture(async (fixture) => {
    const controller = new AbortController();
    controller.abort(new Error("provider response contained private-token"));
    let planPatchCalled = false;
    const runner = {
      async planPatch() {
        planPatchCalled = true;
        throw new Error("planner should not be invoked");
      },
    } as unknown as PiRlmRunner;
    const result = await executePatchPlanning({
      runner,
      executor: PatchExecutor.createRoot(createDefaultRepairVerificationProfiles()),
      context: fixture.context,
      question: fixture.question,
      verificationProfile: fixture.verificationProfile,
      signal: controller.signal,
    });

    assert.equal(result.state, "ABORTED");
    assert.equal(result.accepted, false);
    assert.equal(planPatchCalled, false);
    assert.deepEqual(result.trace.states, ["READ_ONLY", "ABORTED"]);
    assert.match(result.trace.failureDigest ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(result.trace).includes("private-token"), false);
  });
});
test("planning failure is not mislabeled as an abort or persisted verbatim", async () => {
  await withFixture(async (fixture) => {
    const runner = {
      async planPatch() {
        throw new Error("provider rejected request with private-token");
      },
    } as unknown as PiRlmRunner;
    const result = await executePatchPlanning({
      runner,
      executor: PatchExecutor.createRoot(createDefaultRepairVerificationProfiles()),
      context: fixture.context,
      question: fixture.question,
      verificationProfile: fixture.verificationProfile,
    });

    assert.equal(result.state, "PLANNING_FAILED");
    assert.equal(result.accepted, false);
    assert.deepEqual(result.trace.states, ["READ_ONLY", "PLANNING_FAILED"]);
    assert.match(result.trace.failureDigest ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(result.trace).includes("private-token"), false);
  });
});


test("successful submit survives later REPL code failure as one transactional plan", async () => {
  await withFixture(async (fixture) => {
    const { faux, modelRuntime, unregister } = await createFauxRuntime({
      provider: "pi-rlm-patch-plan-transaction-test",
      models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("rlm_exec", { code: `${validPatchSubmission(fixture)}\nthrow new Error("after-submit");` }),
        { stopReason: "toolUse" },
      ),
    ]);
    try {
      const result = await new PiRlmRunner(faux.getModel(), {
        modelRuntime,
        isolation: { mode: "docker" },
      }).planPatch(fixture.context, fixture.question);
      assert.equal(result.plan.edits.length, 1);
      assert.equal(result.trace.executions[0]?.patchSubmitAttempts, 1);
      assert.equal(result.trace.executions[0]?.patchSubmitRejections, 0);
      assert.equal(result.trace.executions[0]?.patchSubmitAttemptDelta, 1);
      assert.equal(result.trace.executions[0]?.patchSubmitRejectionDelta, 0);
    } finally {
      unregister();
    }
  });
});

test("reentrant plan submission from a model-owned getter cannot replace the guarded plan", async () => {
  await withFixture(async (fixture) => {
    const { faux, modelRuntime, unregister } = await createFauxRuntime({
      provider: "pi-rlm-patch-plan-reentrant-submission-test",
      models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `
const slice = await read_lines("src/config.ts", 1, 7);
const precondition = await get_patch_precondition({
  path: "src/config.ts",
  evidenceId: slice.id,
  operation: "replace-range",
  startLine: 6,
  endLine: 6,
});
const nestedPlan = {
  version: 1,
  sourceRevision: "${fixture.context.sourceRevision}",
  intent: "Nested plan must not be accepted.",
  edits: [{
    path: "src/config.ts",
    evidenceId: slice.id,
    expectedOldHash: precondition.expectedOldHash,
    operation: "replace-range",
    startLine: 6,
    endLine: 6,
    replacement: "  timeout: 10,\\n",
  }],
};
const outerPlan = {
  ...nestedPlan,
  intent: "The outer plan remains authoritative.",
  edits: [{ ...nestedPlan.edits[0], replacement: "  timeout: 20,\\n" }],
};
Object.defineProperty(outerPlan, "sourceRevision", {
  enumerable: true,
  get() {
    try {
      submit_patch_plan(nestedPlan);
    } catch (error) {
      state.reentrantSubmissionError = String(error);
    }
    return "${fixture.context.sourceRevision}";
  },
});
submit_patch_plan(outerPlan);
if (!state.reentrantSubmissionError.includes("reentrant submission")) {
  throw new Error("reentrant submission was not rejected");
}`,
        }),
        { stopReason: "toolUse" },
      ),
    ]);
    try {
      const result = await new PiRlmRunner(faux.getModel(), {
        modelRuntime,
        isolation: { mode: "docker" },
      }).planPatch(fixture.context, fixture.question);
      const execution = result.trace.executions[0];
      assert.equal(result.plan.intent, "The outer plan remains authoritative.");
      assert.equal(result.plan.edits[0]?.replacement, "  timeout: 20,\n");
      assert.equal(execution?.patchSubmitAttempts, 2);
      assert.equal(execution?.patchSubmitRejections, 1);
    } finally {
      unregister();
    }
  });
});

test("aborted host execution never creates a worktree", async () => {
  await withFixture(async (fixture) => {
    const controller = new AbortController();
    controller.abort();
    const result = await PatchExecutor.createRoot(
      createDefaultRepairVerificationProfiles(),
    ).execute({
      plan: {},
      verificationProfile: fixture.verificationProfile,
      context: fixture.context,
      evidenceSession: createFileIndexedEvidenceSession(fixture.context),
      signal: controller.signal,
    });
    assert.equal(result.state, "ABORTED");
    assert.equal(result.receipt.failureCode, "ABORTED");
    assert.deepEqual(result.receipt.transitions, ["READ_ONLY", "ABORTED"]);
  });
});

test("planner reports Docker cleanup failure rather than a clean abort", async () => {
  await withFixture(async (fixture) => {
    const controller = new AbortController();
    const runner = {
      async planPatch() {
        controller.abort(new Error("private-token"));
        throw new ReplDockerCleanupError();
      },
    } as unknown as PiRlmRunner;
    const result = await executePatchPlanning({
      runner,
      executor: PatchExecutor.createRoot(createDefaultRepairVerificationProfiles()),
      context: fixture.context,
      question: fixture.question,
      verificationProfile: fixture.verificationProfile,
      signal: controller.signal,
    });

    assert.equal(result.state, "CLEANUP_FAILED");
    assert.equal(result.accepted, false);
    assert.equal(JSON.stringify(result.trace).includes("private-token"), false);
  });
});

test("PatchPlan fields and operations reject inherited-name keys", () => {
  const base = {
    version: 1,
    sourceRevision: "revision",
    intent: "reject inherited names",
    edits: [{
      path: "src/config.ts",
      evidenceId: "evidence",
      expectedOldHash: "0".repeat(64),
      operation: "replace-range",
      startLine: 1,
      endLine: 1,
      replacement: "value\\n",
    }],
  };
  for (const field of ["constructor", "toString"]) {
    assert.throws(
      () => parsePatchPlan({ ...base, [field]: true }),
      /unknown field/u,
    );
    assert.throws(
      () => parsePatchPlan({
        ...base,
        edits: [{ ...base.edits[0], [field]: true }],
      }),
      /unknown field/u,
    );
  }
  assert.throws(
    () => parsePatchPlan(Object.assign(Object.create({ inherited: true }), base)),
    /inherited field/u,
  );
  assert.throws(
    () => parsePatchPlan({
      ...base,
      edits: [Object.assign(Object.create({ inherited: true }), base.edits[0])],
    }),
    /inherited field/u,
  );
  const { operation, ...editWithoutOperation } = base.edits[0];
  assert.throws(
    () => parsePatchPlan({
      ...base,
      edits: [Object.assign(Object.create({ operation }), editWithoutOperation)],
    }),
    /inherited field operation/u,
  );
  assert.throws(
    () => parsePatchPlan({
      ...base,
      edits: [{ ...base.edits[0], operation: "constructor" }],
    }),
    /operation is unsupported/u,
  );
});

test("PatchPlan records accept ordinary cross-realm objects", () => {
  const plan = runInNewContext(`({
    version: 1,
    sourceRevision: "revision",
    intent: "accept VM records",
    edits: [{
      path: "src/config.ts",
      evidenceId: "evidence",
      expectedOldHash: "${"0".repeat(64)}",
      operation: "replace-range",
      startLine: 1,
      endLine: 1,
      replacement: "value\\n",
    }],
  })`);

  const parsed = parsePatchPlan(plan);
  assert.equal(Object.getPrototypeOf(parsed.edits), Array.prototype);
  assert.deepEqual(parsed, {
    version: 1,
    sourceRevision: "revision",
    intent: "accept VM records",
    edits: [{
      path: "src/config.ts",
      evidenceId: "evidence",
      expectedOldHash: "0".repeat(64),
      operation: "replace-range",
      startLine: 1,
      endLine: 1,
      replacement: "value\n",
    }],
  });
});


test("patch precondition rejects inherited request fields", async () => {
  await withFixture(async (fixture) => {
    const session = createFileIndexedEvidenceSession(fixture.context);
    const slice = session.readLines("src/config.ts", 1, 7);
    session.observe([slice.id]);
    const inherited = Object.create({
      path: "src/config.ts",
      evidenceId: slice.id,
      operation: "replace-range",
      startLine: 6,
      endLine: 6,
    }) as Parameters<typeof derivePatchPrecondition>[2];
    assert.throws(
      () => derivePatchPrecondition(fixture.context, session, inherited),
      /Patch precondition/u,
    );
    const foreign = runInNewContext(
      `({
        path: "src/config.ts",
        evidenceId,
        operation: "replace-range",
        startLine: 6,
        endLine: 6,
      })`,
      { evidenceId: slice.id },
    ) as Parameters<typeof derivePatchPrecondition>[2];
    assert.equal(
      derivePatchPrecondition(fixture.context, session, foreign).path,
      "src/config.ts",
    );
  });
});

test("root patch precondition protocol rejects inherited fields inside the isolated REPL", async () => {
  await withFixture(async (fixture) => {
    const { faux, modelRuntime, unregister } = await createFauxRuntime({
      provider: "pi-rlm-patch-precondition-inherited-test",
      models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `
const slice = await read_lines("src/config.ts", 1, 7);
const inherited = Object.create({ unexpected: true });
Object.assign(inherited, {
  path: "src/config.ts",
  evidenceId: slice.id,
  operation: "replace-range",
  startLine: 6,
  endLine: 6,
});
await get_patch_precondition(inherited);`,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("rlm_exec", { code: validPatchSubmission(fixture) }),
        { stopReason: "toolUse" },
      ),
    ]);
    try {
      const result = await new PiRlmRunner(faux.getModel(), {
        modelRuntime,
        limits: { maxRootTurns: 2 },
        isolation: { mode: "docker" },
      }).planPatch(fixture.context, fixture.question);

      assert.equal(result.plan.edits.length, 1);
      assert.equal(result.trace.patchPlanRejections, 0);
      assert.match(result.trace.executions[0]?.error ?? "", /inherited field/u);
      assert.equal(result.trace.executions[1]?.patchSubmitAttempts, 1);
      assert.equal(result.trace.executions[1]?.patchSubmitRejections, 0);
      assert.equal(faux.state.callCount, 2);
    } finally {
      unregister();
    }
  });
});
