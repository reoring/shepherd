import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chmod, lstat, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import {
  createCoreMatchedPatchCases,
  createDirectPiPrompt,
  createFreshMatchedCandidate,
  inspectCandidateScope,
  isMatchedPatchBenchmarkAccepted,
  MATCHED_BENCHMARK_LIMITS,
  runDirectPiMutation,
  summarizeMatchedPatchRuns,
  verifyDirectCandidate,
  type MatchedPatchRun,
  type MatchedPatchSource,
} from "../src/matched-patch-benchmark.ts";
import type { DockerCommandResult, DockerCommandRunner } from "../src/patch-verifier.ts";
import { createFauxRuntime } from "./faux-runtime.ts";

async function withDefaultSource(
  exercise: (source: MatchedPatchSource) => Promise<void>,
): Promise<void> {
  const source = await createCoreMatchedPatchCases()[0]!.createSource();
  try {
    await exercise(source);
  } finally {
    await source.cleanup();
  }
}

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

function trustedVerificationRunner(
  answer: string,
  onCreate?: (args: readonly string[]) => Promise<void>,
): DockerCommandRunner {
  let starts = 0;
  return async (args, _timeoutMs, _outputLimitBytes, stdin) => {
    if (args[0] === "create") {
      await onCreate?.(args);
      const cidFile = args[args.indexOf("--cidfile") + 1];
      if (!cidFile) throw new Error("Verifier omitted its cidfile");
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
          answer,
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

const EMPTY_USAGE = {
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
} as const;

test("matched cases expose only the shared question and exact target contract to Direct Pi", async () => {
  const cases = createCoreMatchedPatchCases();
  assert.deepEqual(cases.map((benchmarkCase) => benchmarkCase.id), [
    "default-replacement",
    "registration-insertion",
    "two-file-wiring",
  ]);
  for (const benchmarkCase of cases) {
    const source = await benchmarkCase.createSource();
    try {
      if (benchmarkCase.id === "two-file-wiring") {
        assert.equal(
          source.question,
          "Set featureConfig.enabled to true and set the exported featureEnabled initializer directly to featureConfig.enabled. Change only the selected lines. Do not include full replacement lines, indentation, or punctuation.",
        );
      }
      const prompt = createDirectPiPrompt(source);
      assert.equal(prompt.includes(source.question), true);
      assert.equal(prompt.includes(source.verificationProfile), false);
      assert.equal(prompt.includes("expectedAnswer"), false);
      assert.equal(prompt.includes(".rlm/"), false);
      for (const target of source.nativeEdits) {
        assert.match(prompt, new RegExp(`${target.id}: path=${target.path}; operation=${target.operation}; range=${target.startLine}-${target.endLine}`, "u"));
      }
    } finally {
      await source.cleanup();
    }
  }
});

test("paired harness candidates start from an identical fresh source revision without mutating the fixture", async () => {
  await withDefaultSource(async (source) => {
    const first = await createFreshMatchedCandidate(source);
    const second = await createFreshMatchedCandidate(source);
    try {
      assert.equal(first.sourceRevision, source.sourceRevision);
      assert.equal(second.sourceRevision, source.sourceRevision);
      assert.equal(
        await readFile(`${source.root}/src/config.ts`, "utf8"),
        await readFile(`${first.root}/src/config.ts`, "utf8"),
      );
      await writeFile(`${first.root}/src/config.ts`, "export const mutatedOnlyInCandidate = true;\n", "utf8");
      assert.notEqual(
        await readFile(`${source.root}/src/config.ts`, "utf8"),
        await readFile(`${first.root}/src/config.ts`, "utf8"),
      );
      assert.equal(
        await readFile(`${source.root}/src/config.ts`, "utf8"),
        await readFile(`${second.root}/src/config.ts`, "utf8"),
      );
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });
});

test("Direct Pi rejects an out-of-scope write and retains no raw attempted path or error", async () => {
  const secret = "Authorization: Bearer private-token";
  await withDefaultSource(async (source) => {
    const candidate = await createFreshMatchedCandidate(source);
    const { faux, modelRuntime, unregister } = await createFauxRuntime({
      provider: "matched-direct-scope-test",
      models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
    });
    faux.setResponses([
      (context) => {
        assert.deepEqual(context.tools?.map((tool) => tool.name), ["read", "edit", "write"]);
        assert.equal(context.tools?.some((tool) => tool.name === "bash"), false);
        return fauxAssistantMessage(
          fauxToolCall("write", { path: `../${secret}`, content: "leak" }),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage("done"),
    ]);
    try {
      const direct = await runDirectPiMutation({
        source,
        candidate,
        model: faux.getModel(),
        modelRuntime,
      });
      const verification = await verifyDirectCandidate({ source, candidateRoot: candidate.root });
      const serialized = JSON.stringify({ direct, verification });

      assert.equal(direct.trace.tools[0]?.path, "<rejected-path>");
      assert.equal(direct.trace.tools[0]?.rejectionCategory, "scope-policy");
      assert.equal(verification.scopeViolation, false);
      assert.equal(verification.checks.length, 0);
      assert.equal(serialized.includes(secret), false);
      assert.equal(serialized.includes("private-token"), false);
    } finally {
      unregister();
      await candidate.cleanup();
    }
  });
});

test("Direct Pi records oldText precondition failures without treating them as scope violations", async () => {
  const secret = "private old text";
  await withDefaultSource(async (source) => {
    const candidate = await createFreshMatchedCandidate(source);
    const { faux, modelRuntime, unregister } = await createFauxRuntime({
      provider: "matched-direct-old-text-test",
      models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("edit", {
          path: "src/config.ts",
          oldText: secret,
          newText: "timeout: 20",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    try {
      const direct = await runDirectPiMutation({
        source,
        candidate,
        model: faux.getModel(),
        modelRuntime,
      });
      const verification = await verifyDirectCandidate({ source, candidateRoot: candidate.root });
      const serialized = JSON.stringify({ direct, verification });

      assert.equal(direct.trace.tools[0]?.rejectionCategory, "old-text-precondition");
      assert.equal(verification.scopeViolation, false);
      assert.equal(serialized.includes(secret), false);
    } finally {
      unregister();
      await candidate.cleanup();
    }
  });
});

test("Direct Pi enforces the staged two-file replacement constraints as content preconditions", async () => {
  const benchmarkCase = createCoreMatchedPatchCases().find(
    (candidate) => candidate.id === "two-file-wiring",
  );
  assert.ok(benchmarkCase);
  const source = await benchmarkCase.createSource();
  const candidate = await createFreshMatchedCandidate(source);
  try {
    const prompt = createDirectPiPrompt(source);
    assert.match(prompt, /Replacement must be one executable enabled: true property line\./u);
    assert.match(
      prompt,
      /Replacement must directly export featureEnabled from featureConfig\.enabled\./u,
    );
    assert.doesNotMatch(prompt, /\^\\s\*enabled/u);

    await writeFile(
      `${candidate.root}/src/producer.ts`,
      [
        "export interface FeatureConfiguration {",
        "  enabled: boolean;",
        "}",
        "",
        "export const featureConfig: FeatureConfiguration = {",
        "  // enabled: true,",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      `${candidate.root}/src/consumer.ts`,
      [
        'import { featureConfig } from "./producer.ts";',
        "",
        "// export const featureEnabled = featureConfig.enabled;",
        "",
      ].join("\n"),
      "utf8",
    );

    const invalidScope = await inspectCandidateScope(source, candidate.root);
    const invalidVerification = await verifyDirectCandidate({
      source,
      candidateRoot: candidate.root,
    });
    assert.equal(invalidScope.valid, false);
    assert.equal(invalidScope.failureCode, "OLD_SOURCE_MISMATCH");
    assert.equal(invalidVerification.rejectionCategory, "content-precondition");
    assert.equal(invalidVerification.scopeViolation, false);
    assert.equal(invalidVerification.checks.length, 0);

    await writeFile(
      `${candidate.root}/src/producer.ts`,
      [
        "export interface FeatureConfiguration {",
        "  enabled: boolean;",
        "}",
        "",
        "export const featureConfig: FeatureConfiguration = {",
        "  enabled: true,",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    const consumerCommentScope = await inspectCandidateScope(source, candidate.root);
    assert.equal(consumerCommentScope.valid, false);
    assert.equal(consumerCommentScope.failureCode, "OLD_SOURCE_MISMATCH");

    await writeFile(
      `${candidate.root}/src/producer.ts`,
      [
        "export interface FeatureConfiguration {",
        "  enabled: boolean;",
        "}",
        "",
        "export const featureConfig: FeatureConfiguration = {",
        "    enabled  :  true , ",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      `${candidate.root}/src/consumer.ts`,
      [
        'import { featureConfig } from "./producer.ts";',
        "",
        " export   const  featureEnabled = featureConfig.enabled ;",
        "",
      ].join("\n"),
      "utf8",
    );
    const whitespaceValid = await inspectCandidateScope(source, candidate.root);
    assert.equal(whitespaceValid.valid, true);
  } finally {
    await candidate.cleanup();
    await source.cleanup();
  }
});

test("Direct Pi post-mutation verification uses the Phase A profile and trusted checks", async () => {
  await withDefaultSource(async (source) => {
    const candidate = await createFreshMatchedCandidate(source);
    try {
      const configPath = `${candidate.root}/src/config.ts`;
      const config = await readFile(configPath, "utf8");
      await writeFile(configPath, config.replace("timeout: 10", "timeout: 20"), "utf8");
      const scope = await inspectCandidateScope(source, candidate.root);
      assert.equal(scope.valid, true);
      const verification = await verifyDirectCandidate({
        source,
        candidateRoot: candidate.root,
        verification: { dockerCommandRunner: trustedVerificationRunner("timeout=20") },
      });

      assert.equal(verification.accepted, true);
      assert.deepEqual(verification.checks.map((check) => check.kind), [
        "diff-policy",
        "post-write-evidence",
        "rlm-contract",
        "focused-check",
      ]);
      assert.equal(verification.checks.every((check) => check.status === "passed"), true);
    } finally {
      await candidate.cleanup();
    }
  });
});

test("Direct Pi rejects candidate mode changes before trusted verification", async () => {
  await withDefaultSource(async (source) => {
    const candidate = await createFreshMatchedCandidate(source);
    try {
      const configPath = `${candidate.root}/src/config.ts`;
      const config = await readFile(configPath, "utf8");
      const originalInfo = await lstat(`${source.root}/src/config.ts`);
      const originalMode = originalInfo.mode & 0o777;
      const changedMode = originalMode ^ 0o400;
      await writeFile(configPath, config.replace("timeout: 10", "timeout: 20"), "utf8");
      await chmod(configPath, changedMode);
      const changedInfo = await lstat(configPath);
      assert.notEqual(changedInfo.mode & 0o777, originalMode);

      const scope = await inspectCandidateScope(source, candidate.root);
      const verification = await verifyDirectCandidate({
        source,
        candidateRoot: candidate.root,
      });

      assert.equal(scope.valid, false);
      assert.equal(scope.failureCode, "DIFF_POLICY_FAILED");
      assert.equal(verification.accepted, false);
      assert.equal(verification.failureCode, "DIFF_POLICY_FAILED");
      assert.equal(verification.rejectionCategory, "mutation-shape");
      assert.equal(verification.scopeViolation, false);
      assert.equal(verification.checks.length, 0);
    } finally {
      await candidate.cleanup();
    }
  });
});

test("Direct Pi rejects candidate symlinks before trusted verification", async () => {
  await withDefaultSource(async (source) => {
    const candidate = await createFreshMatchedCandidate(source);
    try {
      const configPath = `${candidate.root}/src/config.ts`;
      await unlink(configPath);
      await symlink(`${source.root}/src/config.ts`, configPath);

      const scope = await inspectCandidateScope(source, candidate.root);
      const verification = await verifyDirectCandidate({
        source,
        candidateRoot: candidate.root,
      });

      assert.equal(scope.valid, false);
      assert.equal(scope.failureCode, "DIFF_POLICY_FAILED");
      assert.equal(verification.accepted, false);
      assert.equal(verification.failureCode, "DIFF_POLICY_FAILED");
      assert.equal(verification.rejectionCategory, "mutation-shape");
      assert.equal(verification.scopeViolation, false);
      assert.equal(verification.checks.length, 0);
    } finally {
      await candidate.cleanup();
    }
  });
});

test("Direct Pi cannot dispatch more provider turns than the matched root-turn limit", async () => {
  await withDefaultSource(async (source) => {
    const candidate = await createFreshMatchedCandidate(source);
    const { faux, modelRuntime, unregister } = await createFauxRuntime({
      provider: "matched-direct-turn-limit-test",
      models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("read", { path: "src/config.ts" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("direct answer"),
    ]);
    try {
      const direct = await runDirectPiMutation({
        source,
        candidate,
        model: faux.getModel(),
        modelRuntime,
        limits: { ...MATCHED_BENCHMARK_LIMITS, maxRootTurns: 1 },
      });

      assert.equal(direct.completed, false);
      assert.equal(direct.usage.modelCalls, 1);
      assert.equal(
        direct.trace.providerCalls.filter((call) => call.dispatched).length,
        1,
      );
      assert.equal(direct.trace.providerCalls.length, 2);
      assert.equal(direct.trace.providerCalls[1]?.dispatched, false);
    } finally {
      unregister();
      await candidate.cleanup();
    }
  });
});

test("matched aggregation counts a completed but incorrect direct run as a false success", () => {
  const runs: MatchedPatchRun[] = [{
    schemaVersion: 1,
    section: "core",
    caseId: "default-replacement",
    harness: "direct-pi",
    repeat: 1,
    order: 1,
    sourceRevision: "a".repeat(40),
    sourceFingerprint: "b".repeat(64),
    state: "DIRECT_REJECTED",
    accepted: true,
    correct: false,
    falseSuccess: true,
    scopeViolation: false,
    rejectionCategories: ["old-text-precondition"],
    originalUnchanged: true,
    durationMs: 1,
    usage: EMPTY_USAGE,
    checks: [],
    trace: { tools: [], providerCalls: [] },
  }];

  const [summary] = summarizeMatchedPatchRuns(runs);
  assert.equal(summary?.acceptedCorrectRate, 0);
  assert.equal(summary?.falseSuccesses, 1);
  assert.equal(summary?.meetsAcceptance, false);
  assert.equal(summary?.scopeViolations, 0);
  assert.equal(summary?.rejectionCategories["old-text-precondition"], 1);
  assert.equal(summary?.rejectionCategories["scope-policy"], 0);
});

test("matched report acceptance includes a configured optional seeded repository", () => {
  assert.equal(MATCHED_BENCHMARK_LIMITS.finalizationReserveTokens, 0);
  assert.equal(isMatchedPatchBenchmarkAccepted(true, undefined, true), true);
  assert.equal(isMatchedPatchBenchmarkAccepted(true, false, true), false);
  assert.equal(isMatchedPatchBenchmarkAccepted(true, true, false), false);
});
