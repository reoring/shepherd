import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFileIndexedContext,
  createFileIndexedEvidenceSession,
  loadGitDirectoryContext,
} from "../src/file-context.ts";
import {
  captureOriginalCheckoutState,
  hasExactDirtyHarnessSnapshot,
  hasStableHarnessProvenance,
  isCompleteHarnessProvenance,
  isOriginalCheckoutUnchanged,
  PATCH_PHASE_C_RESULT_SCHEMA,
  PATCH_PHASE_C_RUN_SCHEMA,
  redactPatchPocFailure,
  sanitizePiRlmFailureTrace,
  summarizePatchPocPlannerTelemetry,
} from "../src/patch-poc-artifacts.ts";
import {
  createSeededRepairFixture,
  createSeededRepairVerificationProfiles,
} from "../src/seeded-repair-harness.ts";
import { PatchExecutor } from "../src/patch-executor.ts";
import { DEFAULT_MUTATION_LIMITS, hashPatchSpan } from "../src/patch-plan.ts";
import { runRlmContractCheck } from "../src/contract-check.ts";
import { parseRlmContractFile } from "../src/contract-file.ts";
import type { PiRlmFailureTrace } from "../src/runner.ts";

const completeIdentity = {
  gitCommit: "a".repeat(64),
  dirty: false,
  manifestSha256: "b".repeat(64),
  packageLockSha256: "c".repeat(64),
  snapshotSha256: "d".repeat(64),
};

test("patch benchmark acceptance requires a complete harness provenance identity", () => {
  assert.equal(isCompleteHarnessProvenance(completeIdentity), true);
  assert.equal(
    isCompleteHarnessProvenance({ ...completeIdentity, gitCommit: "d".repeat(40) }),
    true,
  );
  assert.equal(
    isCompleteHarnessProvenance({ ...completeIdentity, packageLockSha256: "" }),
    false,
  );
  assert.equal(
    isCompleteHarnessProvenance({ ...completeIdentity, dirty: true }),
    false,
  );
  assert.equal(
    isCompleteHarnessProvenance({
      ...completeIdentity,
      dirty: true,
      snapshotFile: "patch-poc-harness-source.json",
    }),
    true,
  );
});

test("patch benchmark rejects harness drift in identity, manifest, and complete snapshot", () => {
  const initial = {
    identity: { ...completeIdentity },
    manifest: [{ path: "src/runner.ts", bytes: 1, sha256: "e".repeat(64) }],
    snapshot: [{
      path: "src/runner.ts",
      bytes: 1,
      sha256: "e".repeat(64),
      content: "a",
    }],
  };

  assert.equal(hasStableHarnessProvenance(initial, structuredClone(initial)), true);
  assert.equal(
    hasStableHarnessProvenance(
      initial,
      { ...structuredClone(initial), identity: { ...completeIdentity, dirty: true } },
    ),
    false,
  );
  assert.equal(
    hasStableHarnessProvenance(
      initial,
      {
        ...structuredClone(initial),
        manifest: [{ path: "src/runner.ts", bytes: 2, sha256: "f".repeat(64) }],
      },
    ),
    false,
  );
  assert.equal(
    hasStableHarnessProvenance(
      initial,
      {
        ...structuredClone(initial),
        snapshot: [{
          path: "src/runner.ts",
          bytes: 1,
          sha256: "e".repeat(64),
          content: "b",
        }],
      },
    ),
    false,
  );
});

function runGit(cwd: string, args: readonly string[]): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  execFile("git", [...args], { cwd }, (error) => {
    if (error) reject(error);
    else resolve();
  });
  return promise;
}

test("dirty harness provenance rejects deleted, altered, and out-of-root snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rlm-harness-snapshot-"));
  const source = "export const marker = 1;\n";
  const files = [{
    path: "src/runner.ts",
    bytes: Buffer.byteLength(source, "utf8"),
    sha256: createHash("sha256").update(source, "utf8").digest("hex"),
    content: source,
  }];
  const identity = {
    ...completeIdentity,
    dirty: true,
    snapshotFile: "patch-poc-harness-source.json",
    snapshotSha256: createHash("sha256").update(JSON.stringify(files), "utf8").digest("hex"),
  };
  const snapshotPath = join(root, identity.snapshotFile);
  try {
    await writeFile(snapshotPath, `${JSON.stringify({ version: 1, files })}\n`, "utf8");
    assert.equal(await hasExactDirtyHarnessSnapshot(root, identity), true);

    await unlink(snapshotPath);
    assert.equal(await hasExactDirtyHarnessSnapshot(root, identity), false);

    await writeFile(
      snapshotPath,
      `${JSON.stringify({ version: 1, files: [{ ...files[0], content: "altered" }] })}\n`,
      "utf8",
    );
    assert.equal(await hasExactDirtyHarnessSnapshot(root, identity), false);
    assert.equal(
      await hasExactDirtyHarnessSnapshot(root, { ...identity, snapshotFile: "../outside.json" }),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("original checkout state rejects executable-mode and untracked mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rlm-original-checkout-"));
  const configPath = join(root, "src", "config.ts");
  try {
    await mkdir(join(root, "src"));
    await writeFile(configPath, "export const timeout = 10;\n", "utf8");
    await runGit(root, ["init"]);
    await runGit(root, ["add", "."]);
    await runGit(root, [
      "-c",
      "user.name=Pi RLM test",
      "-c",
      "user.email=pi-rlm-test@example.test",
      "commit",
      "-m",
      "fixture",
    ]);

    const originalContext = await loadGitDirectoryContext(root);
    const original = await captureOriginalCheckoutState(root, originalContext);

    await chmod(configPath, 0o755);
    const modeContext = await loadGitDirectoryContext(root);
    const modeMutated = await captureOriginalCheckoutState(root, modeContext);
    assert.equal(modeMutated.head, original.head);
    assert.equal(modeMutated.contentFingerprint, original.contentFingerprint);
    assert.equal(modeMutated.clean, false);
    assert.equal(isOriginalCheckoutUnchanged(original, modeMutated), false);

    await chmod(configPath, 0o644);
    await writeFile(join(root, "untracked.ts"), "export const untracked = true;\n", "utf8");
    const untrackedContext = await loadGitDirectoryContext(root);
    const untrackedMutated = await captureOriginalCheckoutState(root, untrackedContext);
    assert.equal(untrackedMutated.head, original.head);
    assert.equal(untrackedMutated.contentFingerprint, original.contentFingerprint);
    assert.equal(untrackedMutated.trackedManifestSha256, original.trackedManifestSha256);
    assert.equal(untrackedMutated.clean, false);
    assert.equal(isOriginalCheckoutUnchanged(original, untrackedMutated), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("patch benchmark failure artifacts retain only a class and SHA-256 digest", () => {
  const providerError = "provider rejected request: Authorization: Bearer private-token";
  const artifact = redactPatchPocFailure("PLANNING_FAILED", undefined, new Error(providerError));
  const serialized = JSON.stringify(artifact);

  assert.equal(artifact.failureClass, "PLANNING_FAILED");
  assert.match(artifact.failureDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(serialized.includes(providerError), false);
  assert.equal(serialized.includes("private-token"), false);
});

test("planner trace sanitizer hashes errors and never aliases the source trace", () => {
  const secret = "Authorization: Bearer private-token";
  const trace = {
    executionCount: 1,
    answerRejections: 1,
    patchPlanRejections: 1,
    rejectedAnswers: [{
      depth: 0,
      candidateDefined: true,
      candidatePreview: secret,
      candidateLength: secret.length,
      reason: secret,
    }],
    corpusCalls: [{ depth: 0, request: { operation: "read_file", path: secret } }],
    executions: [{
      depth: 0,
      execution: 1,
      stdoutCharacters: 0,
      searchResultCount: 0,
      observationCharacters: 0,
      compactedToolResults: 0,
      observedEvidenceIds: ["evidence-safe-id"],
      corpusHistoryEntries: 0,
      corpusCacheHits: 0,
      budgetBefore: { maxObservationCharacters: 1, finalizationReserveTokens: 0 },
      error: secret,
      pendingFactIds: [],
      groundedFactIds: [],
      factFinalizationBlocked: false,
      patchSubmitAttempts: 1,
      patchSubmitRejections: 1,
      patchSubmitAttemptDelta: 1,
      patchSubmitRejectionDelta: 1,
    }],
    subcallPrompts: [secret],
    providerCalls: [{
      id: 1,
      estimatedInputTokens: 1,
      reservedOutputTokens: 1,
      reservedTokens: 2,
      usesFinalizationReserve: false,
      dispatched: false,
      rejectionReason: secret,
    }],
    facts: {
      contractPresent: false,
      events: [],
      extractions: [],
      finalizationBlocks: 0,
      progressBlocks: 0,
      actionBlocks: 0,
      runtimeFinalizations: 0,
    },
  } satisfies PiRlmFailureTrace;
  const original = structuredClone(trace);
  const sanitized = sanitizePiRlmFailureTrace(trace);
  const serialized = JSON.stringify(sanitized);

  assert.deepEqual(trace, original);
  assert.match(sanitized.executions[0]?.errorDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.match(sanitized.rejectedAnswers[0]?.reasonDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.match(sanitized.providerCalls[0]?.rejectionReasonDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("candidatePreview"), false);
  assert.equal(serialized.includes("subcallPrompts"), false);
});

test("JSONL planner telemetry preserves root retry counters and only safe rejection fields", () => {
  const sanitized = sanitizePiRlmFailureTrace({
    executionCount: 2,
    answerRejections: 0,
    patchPlanRejections: 1,
    rejectedAnswers: [],
    corpusCalls: [],
    executions: [
      {
        depth: 0,
        execution: 1,
        stdoutCharacters: 0,
        searchResultCount: 0,
        observationCharacters: 0,
        compactedToolResults: 0,
        observedEvidenceIds: [],
        corpusHistoryEntries: 0,
        corpusCacheHits: 0,
        budgetBefore: { maxObservationCharacters: 1, finalizationReserveTokens: 0 },
        pendingFactIds: [],
        groundedFactIds: [],
        factFinalizationBlocked: false,
        patchSubmitAttempts: 2,
        patchSubmitRejections: 1,
        patchSubmitAttemptDelta: 1,
        patchSubmitRejectionDelta: 1,
      },
      {
        depth: 1,
        execution: 2,
        stdoutCharacters: 0,
        searchResultCount: 0,
        observationCharacters: 0,
        compactedToolResults: 0,
        observedEvidenceIds: [],
        corpusHistoryEntries: 0,
        corpusCacheHits: 0,
        budgetBefore: { maxObservationCharacters: 1, finalizationReserveTokens: 0 },
        error: "private-token",
        pendingFactIds: [],
        groundedFactIds: [],
        factFinalizationBlocked: false,
      },
    ],
    subcallPrompts: ["private-token"],
    providerCalls: [],
    facts: {
      contractPresent: false,
      events: [],
      extractions: [],
      finalizationBlocks: 0,
      progressBlocks: 0,
      actionBlocks: 0,
      runtimeFinalizations: 0,
    },
  } satisfies PiRlmFailureTrace);
  const telemetry = summarizePatchPocPlannerTelemetry(sanitized, {
    failureClass: "PLANNING_FAILED",
    failureDigest: "a".repeat(64),
  }, 1);
  const serialized = JSON.stringify(telemetry);

  assert.deepEqual(telemetry, {
    executionCount: 1,
    planSubmissionAttempts: 2,
    planSubmissionRejections: 1,
    toolTrace: [],
    rejectionClass: "PLANNING_FAILED",
    rejectionDigest: "a".repeat(64),
  });
  assert.equal(serialized.includes("private-token"), false);

  const nativeTelemetry = summarizePatchPocPlannerTelemetry({
    ...sanitized,
    patchTools: [
      {
        tool: "prepare_patch_replace",
        status: "prepared",
        startLine: 6,
        endLine: 6,
        currentTextCharacters: 14,
      },
      {
        tool: "submit_patch_replacement",
        status: "submitted",
        startLine: 6,
        endLine: 6,
      },
    ],
  }, undefined, 0);
  assert.deepEqual(nativeTelemetry, {
    executionCount: 0,
    planSubmissionAttempts: 1,
    planSubmissionRejections: 0,
    toolTrace: [
      {
        tool: "prepare_patch_replace",
        status: "prepared",
        startLine: 6,
        endLine: 6,
        currentTextCharacters: 14,
      },
      {
        tool: "submit_patch_replacement",
        status: "submitted",
        startLine: 6,
        endLine: 6,
      },
    ],
  });
});

test("Phase C machine artifact schemas require phase, fixture, provenance, and safe run counters", () => {
  assert.equal(PATCH_PHASE_C_RESULT_SCHEMA.properties.phase.const, "C");
  assert.equal(PATCH_PHASE_C_RUN_SCHEMA.properties.oracleMatched.type, "boolean");
  assert.ok(PATCH_PHASE_C_RUN_SCHEMA.required.includes("toolTrace"));
  assert.ok(PATCH_PHASE_C_RESULT_SCHEMA.required.includes("provenanceComplete"));
  assert.equal(
    PATCH_PHASE_C_RESULT_SCHEMA.properties.fixture.properties.nativeEdits.items.properties
      .replacementConstraint.properties.digest.pattern,
    "^[a-f0-9]{64}$",
  );
});

test("native-edits telemetry retains cross-file target evidence without replacement text", () => {
  const rawTrace = {
    executionCount: 0,
    answerRejections: 0,
    patchPlanRejections: 0,
    rejectedAnswers: [],
    corpusCalls: [],
    executions: [],
    patchTools: [{
      tool: "prepare_native_edits",
      status: "prepared",
      targets: [
        {
          id: "producer",
          path: "src/producer.ts",
          operation: "replace-range",
          startLine: 6,
          endLine: 6,
          evidenceId: "evidence-producer",
          currentTextCharacters: 17,
        },
        {
          id: "consumer",
          path: "src/consumer.ts",
          operation: "replace-range",
          startLine: 3,
          endLine: 3,
          evidenceId: "evidence-consumer",
          currentTextCharacters: 37,
        },
      ],
    }, {
      tool: "submit_native_edits",
      status: "submitted",
      targets: [
        {
          id: "producer",
          path: "src/producer.ts",
          operation: "replace-range",
          startLine: 6,
          endLine: 6,
          evidenceId: "evidence-producer",
        },
        {
          id: "consumer",
          path: "src/consumer.ts",
          operation: "replace-range",
          startLine: 3,
          endLine: 3,
          evidenceId: "evidence-consumer",
        },
      ],
    }],
    subcallPrompts: [],
    providerCalls: [],
    facts: {
      contractPresent: false,
      events: [],
      extractions: [],
      finalizationBlocks: 0,
      progressBlocks: 0,
      actionBlocks: 0,
      runtimeFinalizations: 0,
    },
  } satisfies PiRlmFailureTrace;
  const telemetry = summarizePatchPocPlannerTelemetry(
    sanitizePiRlmFailureTrace(rawTrace),
    undefined,
    0,
  );
  assert.equal(telemetry.planSubmissionAttempts, 1);
  assert.deepEqual(
    telemetry.toolTrace[0]?.targets?.map((target) => target.path),
    ["src/producer.ts", "src/consumer.ts"],
  );
  assert.equal(JSON.stringify(telemetry).includes("replacement"), false);
});

test("seeded repair fixture keeps the real tracked source immutable and retains its oracle privately", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "pi-rlm-seeded-source-"));
  const sourcePath = "src/selected.ts";
  const source = "export const selected = 20;\n";
  try {
    await mkdir(join(sourceRoot, "src"));
    await writeFile(join(sourceRoot, sourcePath), source, "utf8");
    await runGit(sourceRoot, ["init"]);
    await runGit(sourceRoot, ["add", "."]);
    await runGit(sourceRoot, [
      "-c",
      "user.name=Pi RLM seeded fixture test",
      "-c",
      "user.email=seeded-fixture@example.test",
      "commit",
      "-m",
      "real tracked source",
    ]);
    let fixtureRoot = "";
    const fixture = await createSeededRepairFixture({
      sourceRoot,
      sourcePath,
      target: {
        id: "restore-selected-value",
        path: sourcePath,
        operation: "replace-range",
        startLine: 1,
        endLine: 1,
      },
      seededReplacement: "export const selected = 10;\n",
      question: "Restore the selected declaration.",
    });
    fixtureRoot = fixture.root;
    try {
      assert.notEqual(fixture.root, sourceRoot);
      assert.equal(await fixture.assertOriginalUnchanged(), true);
      assert.equal(await readFile(join(sourceRoot, sourcePath), "utf8"), source);
      assert.equal(fixture.isRepairedToOracle(fixture.context), false);
      assert.equal(fixture.isRepairedToOracle(createFileIndexedContext([{
        path: sourcePath,
        content: source,
      }])), true);
      const [profile] = createSeededRepairVerificationProfiles(fixture.oracleSha256);
      assert.equal(profile?.steps[2].contractPath, ".rlm/seeded-repair-contract.v1.json");
      assert.equal(profile?.steps[3].trustedScript, "src/patch-seeded-repair-focused.ts");
      const seededContract = JSON.parse(
        await readFile(join(fixture.root, ".rlm", "seeded-repair-contract.v1.json"), "utf8"),
      ) as {
        factContract: {
          requirements: Array<{
            extractor: { capture: { index: number } };
          }>;
        };
      };
      assert.equal(seededContract.factContract.requirements[0]?.extractor.capture.index, 1);
      assert.deepEqual(fixture.context.search({ literal: source }), []);
      assert.equal(
        JSON.stringify({
          question: fixture.question,
          files: fixture.context.files,
          nativeEdits: fixture.nativeEdits,
        }).includes(source),
        false,
      );
    } finally {
      await fixture.cleanup();
    }
    await assert.rejects(() => lstat(fixtureRoot), { code: "ENOENT" });
    assert.equal(await readFile(join(sourceRoot, sourcePath), "utf8"), source);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test("seeded executor separates public digest metadata from the private oracle", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "pi-rlm-seeded-executor-"));
  const sourcePath = "src/selected.ts";
  const oracle = "export const selected = 20;\n";
  try {
    await mkdir(join(sourceRoot, "src"));
    await writeFile(join(sourceRoot, sourcePath), oracle, "utf8");
    await runGit(sourceRoot, ["init"]);
    await runGit(sourceRoot, ["add", "."]);
    await runGit(sourceRoot, [
      "-c",
      "user.name=Pi RLM seeded executor test",
      "-c",
      "user.email=seeded-executor@example.test",
      "commit",
      "-m",
      "seeded executor source",
    ]);
    const fixture = await createSeededRepairFixture({
      sourceRoot,
      sourcePath,
      target: {
        id: "restore-selected-value",
        path: sourcePath,
        operation: "replace-range",
        startLine: 1,
        endLine: 1,
      },
      seededReplacement: "export const selected = 10;\n",
      question: "Restore the selected declaration.",
    });
    try {
      const target = fixture.nativeEdits[0];
      assert.ok(target);
      const execute = async (replacement: string) => {
        const evidenceSession = createFileIndexedEvidenceSession(fixture.context);
        const evidence = evidenceSession.readLines(
          target.path,
          target.startLine,
          target.endLine,
        );
        evidenceSession.observe([evidence.id]);
        return PatchExecutor.createRoot(
          createSeededRepairVerificationProfiles(fixture.oracleSha256),
        ).execute({
          plan: {
            version: 1,
            sourceRevision: fixture.context.sourceRevision,
            intent: "Restore the seeded source declaration.",
            edits: [{
              path: target.path,
              evidenceId: evidence.id,
              expectedOldHash: hashPatchSpan(
                fixture.context.read(target.path),
                target.operation,
                target.startLine,
                target.endLine,
              ),
              operation: target.operation,
              startLine: target.startLine,
              endLine: target.endLine,
              replacement,
            }],
          },
          verificationProfile: fixture.verificationProfile,
          context: fixture.context,
          evidenceSession,
          limits: {
            ...DEFAULT_MUTATION_LIMITS,
            allowedPathPrefixes: [target.path],
            maxChangedFiles: 1,
            maxEdits: 1,
          },
        });
      };
      const directContractCheck = await runRlmContractCheck(
        fixture.context,
        parseRlmContractFile(fixture.context.read(".rlm/seeded-repair-contract.v1.json")),
      );
      assert.equal(directContractCheck.status, "passed", JSON.stringify(directContractCheck));

      const repaired = await execute(oracle);
      assert.equal(
        repaired.receipt.checks.find((check) => check.kind === "rlm-contract")?.status,
        "passed",
      );
      assert.equal(repaired.state, "ACCEPTED");
      assert.equal(repaired.receipt.checks.every((check) => check.status === "passed"), true);

      const wrong = await execute("export const selected = 30;\n");
      assert.equal(wrong.state, "VERIFICATION_FAILED");
      assert.equal(wrong.receipt.failureCode, "FOCUSED_CHECK_FAILED");
      assert.equal(
        wrong.receipt.checks.find((check) => check.kind === "rlm-contract")?.status,
        "passed",
      );
      assert.equal(
        wrong.receipt.checks.find((check) => check.kind === "focused-check")?.status,
        "failed",
      );
    } finally {
      await fixture.cleanup();
    }
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
});
