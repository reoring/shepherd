import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFileIndexedContext,
  createFileIndexedEvidenceSession,
  loadGitDirectoryContext,
  type FileIndexedContext,
  type FileIndexedEvidenceSession,
} from "../src/file-context.ts";
import { PatchExecutor, type PatchExecutorOptions } from "../src/patch-executor.ts";
import {
  DEFAULT_MUTATION_LIMITS,
  hashPatchSpan,
  parsePatchPlan,
  type MutationLimits,
  type PatchEdit,
  type PatchPlan,
  type RootPatchAuthority,
} from "../src/patch-plan.ts";
import {
  PatchVerifier,
  type DockerCommandResult,
  type DockerCommandRunner,
  type VerificationProfile,
} from "../src/patch-verifier.ts";

interface Fixture {
  root: string;
  context: FileIndexedContext;
}

interface ObservedEvidence {
  session: FileIndexedEvidenceSession;
  evidenceId: string;
}

function runGit(cwd: string, args: readonly string[]): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  execFile("git", [...args], { cwd }, (error) => {
    if (error) reject(error);
    else resolve();
  });
  return promise;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-rlm-patch-poc-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, ".rlm"));
  await mkdir(join(root, "docs"));
  await writeFile(
    join(root, "src", "config.ts"),
    [
      "export const timeout = 10;",
      'export const label = "fixture";',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(root, "src", "consumer.ts"),
    [
      'import { timeout } from "./config.ts";',
      "export const usesTimeout = timeout;",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(root, "docs", "outside.ts"), "export const outside = true;\n", "utf8");
  await writeFile(
    join(root, ".rlm", "timeout-contract.v1.json"),
    JSON.stringify({
      version: 1,
      factContract: {
        requirements: [
          {
            id: "timeout",
            description: "The configured timeout is exactly 20.",
            grounding: "quoted",
            minSupports: 1,
            extractor: {
              source: {
                kind: "search-open",
                literal: "export const timeout = 20;",
                path: "src/config.ts",
                before: 0,
                after: 0,
              },
              select: { kind: "contains-all", literals: ["export const timeout = 20;"] },
              capture: { kind: "identifier-after", literal: "const " },
              reduce: { kind: "single", exactCount: 1 },
            },
          },
        ],
        finalizer: { kind: "template", template: "timeout={{timeout}}" },
      },
      answerContract: {
        description: "Return the verified timeout binding.",
        pattern: "^timeout=timeout$",
      },
    }),
    "utf8",
  );
  await runGit(root, ["init"]);
  await runGit(root, ["add", "."]);
  await runGit(root, [
    "-c",
    "user.name=Patch PoC",
    "-c",
    "user.email=patch-poc@example.test",
    "commit",
    "-m",
    "fixture",
  ]);
  return { root, context: await loadGitDirectoryContext(root) };
}

async function withFixture(
  exercise: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const fixture = await createFixture();
  try {
    await exercise(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

function observe(
  context: FileIndexedContext,
  path: string,
  startLine = 1,
  endLine = 1,
): ObservedEvidence {
  const session = createFileIndexedEvidenceSession(context);
  const slice = session.readLines(path, startLine, endLine);
  session.observe([slice.id]);
  return { session, evidenceId: slice.id };
}

function patchEdit(
  context: FileIndexedContext,
  evidenceId: string,
  path: string,
  replacement: string,
  startLine = 1,
  endLine = 1,
  operation: PatchEdit["operation"] = "replace-range",
): PatchEdit {
  return {
    path,
    evidenceId,
    expectedOldHash: hashPatchSpan(
      context.read(path),
      operation,
      startLine,
      endLine,
    ),
    operation,
    startLine,
    endLine,
    replacement,
  };
}

function patchPlan(
  context: FileIndexedContext,
  edits: readonly PatchEdit[],
): PatchPlan {
  return {
    version: 1,
    sourceRevision: context.sourceRevision,
    intent: "Repair the fixture timeout.",
    edits: [...edits],
  };
}

function rawPlanWithPath(path: string): unknown {
  return {
    version: 1,
    sourceRevision: "revision",
    intent: "Reject unsafe control characters before evidence lookup.",
    edits: [{
      path,
      evidenceId: "evidence",
      expectedOldHash: "0".repeat(64),
      operation: "replace-range",
      startLine: 1,
      endLine: 1,
      replacement: "value\n",
    }],
  };
}

const rootAuthority = Object.freeze({ role: "root" as const }) as RootPatchAuthority;

function contractStep(): VerificationProfile["steps"][2] {
  return {
    kind: "rlm-contract",
    name: "fixture-contract",
    contractPath: ".rlm/timeout-contract.v1.json",
    expectedAnswer: "timeout=timeout",
    timeoutMs: 5_000,
    outputLimitBytes: 4_096,
  };
}

function verificationProfiles(): VerificationProfile[] {
  return [
    {
      name: "fixture-pass",
      steps: [
        { kind: "diff-policy" },
        { kind: "post-write-evidence" },
        contractStep(),
        {
          kind: "focused-check",
          name: "focused-fixture-check",
          trustedScript: "src/patch-focused-fixture.ts",
          timeoutMs: 5_000,
          outputLimitBytes: 4_096,
        },
      ],
    },
    {
      name: "fixture-fails",
      steps: [
        { kind: "diff-policy" },
        { kind: "post-write-evidence" },
        contractStep(),
        {
          kind: "focused-check",
          name: "focused-fixture-check",
          trustedScript: "src/patch-focused-fixture.ts",
          timeoutMs: 5_000,
          outputLimitBytes: 4_096,
        },
      ],
    },
    {
      name: "fixture-empty-output",
      steps: [
        { kind: "diff-policy" },
        { kind: "post-write-evidence" },
        contractStep(),
        {
          kind: "focused-check",
          name: "empty-success-output",
          trustedScript: "src/patch-focused-fixture.ts",
          timeoutMs: 5_000,
          outputLimitBytes: 4_096,
        },
      ],
    },
    {
      name: "fixture-timeout",
      steps: [
        { kind: "diff-policy" },
        { kind: "post-write-evidence" },
        contractStep(),
        {
          kind: "focused-check",
          name: "timeout-fixture-check",
          trustedScript: "src/patch-focused-fixture.ts",
          timeoutMs: 1_000,
          outputLimitBytes: 4_096,
        },
      ],
    },
    {
      name: "fixture-contract-bypass",
      steps: [
        { kind: "diff-policy" },
        { kind: "post-write-evidence" },
        contractStep(),
        {
          kind: "focused-check",
          name: "focused-fixture-check",
          trustedScript: "src/patch-focused-fixture.ts",
          timeoutMs: 5_000,
          outputLimitBytes: 4_096,
        },
      ],
    },
  ];
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

function fixtureDockerRunner(
  focusedResult: "passed" | "timed-out" | "create-timed-out",
  options: {
    readonly onCreate?: (args: readonly string[]) => void;
    readonly failCleanup?: boolean;
  } = {},
): DockerCommandRunner {
  let starts = 0;
  return async (args, _timeoutMs, _outputLimitBytes, stdin) => {
    if (args[0] === "create") {
      options.onCreate?.(args);
      if (focusedResult === "create-timed-out") {
        return dockerResult("", { exitCode: -1, timedOut: true });
      }
      const cidFile = args[args.indexOf("--cidfile") + 1];
      if (!cidFile) throw new Error("Docker create test command omitted cidfile");
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
          answer: "timeout=timeout",
        })}\n`);
      }
      if (focusedResult === "timed-out") {
        return dockerResult("", { exitCode: -1, timedOut: true });
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
    if (args[0] === "rm") {
      if (options.failCleanup && starts === 2) {
        return dockerResult("", {
          exitCode: 1,
          stderr: Buffer.from("intentional cleanup failure\n", "utf8"),
        });
      }
      return dockerResult();
    }
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
    throw new Error(`Unexpected Docker test command: ${args.join(" ")}`);
  };
}

function cleanupFailingDockerRunner(
  focusedResult: "passed" | "timed-out" | "create-timed-out",
): DockerCommandRunner {
  return fixtureDockerRunner(focusedResult, { failCleanup: true });
}


function cleanupAndReportFailure(
  throwAfterCleanup = false,
): NonNullable<PatchExecutorOptions["cleanupWorktree"]> {
  return async (repository, worktreePath, worktreeParent) => {
    await runGit(repository.repositoryRoot, ["worktree", "remove", "--force", worktreePath]);
    await rm(worktreeParent, { recursive: true, force: true });
    if (throwAfterCleanup) throw new Error("intentional cleanup failure");
    return false;
  };
}

function dockerContainerExists(name: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  execFile("docker", ["container", "inspect", name], (error) => resolve(!error));
  return promise;
}

function executor(
  authorityOrOptions: RootPatchAuthority | PatchExecutorOptions = rootAuthority,
  maybeOptions: PatchExecutorOptions = {},
): PatchExecutor {
  const options = "role" in authorityOrOptions ? maybeOptions : authorityOrOptions;
  return PatchExecutor.createRoot(verificationProfiles(), options);
}

function limited(overrides: Partial<MutationLimits> = {}): MutationLimits {
  return { ...DEFAULT_MUTATION_LIMITS, ...overrides };
}

test("applies an observed plan in a disposable worktree and accepts only after verification", async () => {
  await withFixture(async ({ root, context }) => {
    const observed = observe(context, "src/config.ts");
    const original = await readFile(join(root, "src", "config.ts"), "utf8");
    const plan = patchPlan(context, [
      patchEdit(
        context,
        observed.evidenceId,
        "src/config.ts",
        "export const timeout = 20;\n",
      ),
    ]);

    const result = await executor().execute({
      plan,
      verificationProfile: "fixture-pass",
      context,
      evidenceSession: observed.session,
      limits: limited(),
    });

    assert.equal(result.state, "ACCEPTED");
    assert.equal(result.receipt.state, "ACCEPTED");
    assert.equal(result.receipt.failureCode, undefined);
    assert.deepEqual(result.receipt.changedPaths, ["src/config.ts"]);
    assert.match(result.receipt.normalizedDiffHash ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(result.receipt.checks.every((check) => check.status === "passed"), true);
    assert.notEqual(result.receipt.preWriteRevision, result.receipt.postWriteRevision);
    assert.equal(await readFile(join(root, "src", "config.ts"), "utf8"), original);
  });
});
test("records an insertion hash from the post-write candidate span", async () => {
  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts", 1, 2);
    const inserted = "export const retries = 3;\n";
    const result = await executor().execute({ plan: patchPlan(context, [
      patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n", 1, 1),
      patchEdit(context, observed.evidenceId, "src/config.ts", inserted, 2, 2, "insert-after"),
    ]), verificationProfile: "fixture-pass", context,
    evidenceSession: observed.session,
    limits: limited(), });
    assert.equal(result.state, "ACCEPTED");
    const receiptHash = result.receipt.editHashes.find((hash) => hash.operation === "insert-after");
    assert.ok(receiptHash);
    const postWrite = result.postContext?.read("src/config.ts") ?? "";
    const insertedLine = postWrite.split("\n").find((line) => line === "export const retries = 3;");
    assert.equal(
      receiptHash.newHash,
      createHash("sha256").update(`${insertedLine}\n`, "utf8").digest("hex"),
    );
  });
});
test("rejects a candidate whose checkout no longer matches indexed bytes before writing", async () => {
  await withFixture(async ({ root, context }) => {
    const observed = observe(context, "src/config.ts");
    const original = await readFile(join(root, "src", "config.ts"), "utf8");
    const result = await executor(rootAuthority, {
      beforeWrite: async (worktreeSourceRoot) => {
        await writeFile(join(worktreeSourceRoot, "src", "config.ts"), "export const timeout = 999;\n", "utf8");
      },
    }).execute({ plan: patchPlan(context, [
      patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n"),
    ]), verificationProfile: "fixture-pass", context,
    evidenceSession: observed.session,
    limits: limited(), });
    assert.equal(result.state, "PLAN_REJECTED");
    assert.equal(result.receipt.failureCode, "OLD_SOURCE_MISMATCH");
    assert.equal(await readFile(join(root, "src", "config.ts"), "utf8"), original);
  });
});

test("never accepts a patch when disposable-worktree cleanup cannot be certified", async () => {
  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts");
    const result = await executor(rootAuthority, {
      cleanupWorktree: async (repository, worktreePath, worktreeParent) => {
        await runGit(repository.repositoryRoot, ["worktree", "remove", "--force", worktreePath]);
        await rm(worktreeParent, { recursive: true, force: true });
        return false;
      },
    }).execute({ plan: patchPlan(context, [
      patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n"),
    ]), verificationProfile: "fixture-pass", context,
    evidenceSession: observed.session,
    limits: limited(), });
    assert.equal(result.state, "CLEANUP_FAILED");
    assert.equal(result.receipt.failureCode, "CLEANUP_FAILED");
    assert.notEqual(result.state, "ACCEPTED");
  });
});

test("rejects a stale source revision before creating a worktree", async () => {
  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts");
    const plan = {
      ...patchPlan(context, [
        patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n"),
      ]),
      sourceRevision: "stale-revision",
    };
    const result = await executor().execute({ plan, verificationProfile: "fixture-pass", context, evidenceSession: observed.session, limits: limited() });
    assert.equal(result.state, "PLAN_REJECTED");
    assert.equal(result.receipt.failureCode, "SOURCE_REVISION_MISMATCH");
  });
});

test("rejects foreign or stale evidence IDs", async () => {
  await withFixture(async ({ context }) => {
    const foreignContext = createFileIndexedContext(
      [{ path: "src/config.ts", content: context.read("src/config.ts") }],
      { sourceRevision: "foreign-revision" },
    );
    const foreign = observe(foreignContext, "src/config.ts");
    const current = observe(context, "src/config.ts");
    const plan = patchPlan(context, [
      patchEdit(context, foreign.evidenceId, "src/config.ts", "export const timeout = 20;\n"),
    ]);
    const result = await executor().execute({ plan, verificationProfile: "fixture-pass", context, evidenceSession: current.session, limits: limited() });
    assert.equal(result.state, "PLAN_REJECTED");
    assert.equal(result.receipt.failureCode, "EVIDENCE_NOT_OBSERVED");
    const staleSessionResult = await executor().execute({
      plan,
      verificationProfile: "fixture-pass",
      context,
      evidenceSession: foreign.session,
      limits: limited(),
    });
    assert.equal(staleSessionResult.state, "PLAN_REJECTED");
    assert.equal(staleSessionResult.receipt.failureCode, "EVIDENCE_REVISION_MISMATCH");
  });
});

test("rejects an edit to a file that has not been observed", async () => {
  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts");
    const edit = patchEdit(context, observed.evidenceId, "src/consumer.ts", "export const usesTimeout = 20;\n");
    const result = await executor().execute({ plan: patchPlan(context, [edit]), verificationProfile: "fixture-pass", context,
    evidenceSession: observed.session,
    limits: limited(), });
    assert.equal(result.state, "PLAN_REJECTED");
    assert.equal(result.receipt.failureCode, "EDIT_OUTSIDE_EVIDENCE");
  });
});

test("rejects a path outside the configured allowlist", async () => {
  await withFixture(async ({ context }) => {
    const observed = observe(context, "docs/outside.ts");
    const edit = patchEdit(context, observed.evidenceId, "docs/outside.ts", "export const outside = false;\n");
    const result = await executor().execute({ plan: patchPlan(context, [edit]), verificationProfile: "fixture-pass", context,
    evidenceSession: observed.session,
    limits: limited({ allowedPathPrefixes: ["src/"] }), });
    assert.equal(result.state, "PLAN_REJECTED");
    assert.equal(result.receipt.failureCode, "PATH_OUT_OF_SCOPE");
  });
});

test("rejects an old-source hash mismatch", async () => {
  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts");
    const edit = { ...patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n"), expectedOldHash: "0".repeat(64) };
    const result = await executor().execute({ plan: patchPlan(context, [edit]), verificationProfile: "fixture-pass", context, evidenceSession: observed.session, limits: limited() });
    assert.equal(result.state, "PLAN_REJECTED");
    assert.equal(result.receipt.failureCode, "OLD_SOURCE_MISMATCH");
  });
});

test("rejects overlapping edits", async () => {
  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts", 1, 2);
    const first = patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n", 1, 1);
    const second = patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 30;\n", 1, 1);
    const result = await executor().execute({ plan: patchPlan(context, [first, second]), verificationProfile: "fixture-pass", context, evidenceSession: observed.session, limits: limited() });
    assert.equal(result.state, "PLAN_REJECTED");
    assert.equal(result.receipt.failureCode, "EDIT_OVERLAP");
  });
});

test("rejects changed-file and line budgets before apply", async () => {
  await withFixture(async ({ context }) => {
    const session = createFileIndexedEvidenceSession(context);
    const config = session.readLines("src/config.ts", 1, 1);
    const consumer = session.readLines("src/consumer.ts", 1, 1);
    session.observe([config.id, consumer.id]);
    const result = await executor().execute({ plan: patchPlan(context, [
      patchEdit(context, config.id, "src/config.ts", "export const timeout = 20;\n"),
      patchEdit(context, consumer.id, "src/consumer.ts", "export const usesTimeout = 20;\n"),
    ]), verificationProfile: "fixture-pass", context,
    evidenceSession: session,
    limits: limited({ maxChangedFiles: 1 }), });
    assert.equal(result.state, "PLAN_REJECTED");
    assert.equal(result.receipt.failureCode, "MUTATION_BUDGET_EXCEEDED");
    const lineBudgetResult = await executor().execute({ plan: patchPlan(context, [
      patchEdit(context, config.id, "src/config.ts", "export const timeout = 20;\n"),
    ]), verificationProfile: "fixture-pass", context,
    evidenceSession: session,
    limits: limited({ maxInsertedLines: 0 }), });
    assert.equal(lineBudgetResult.state, "PLAN_REJECTED");
    assert.equal(lineBudgetResult.receipt.failureCode, "MUTATION_BUDGET_EXCEEDED");
  });
});
test("requires all fixed verification roles in order", () => {
  const incomplete = {
    name: "missing-focused-check",
    steps: [
      { kind: "diff-policy" },
      { kind: "post-write-evidence" },
      {
        kind: "rlm-contract",
        name: "contract",
        contractPath: ".rlm/timeout-contract.v1.json",
        expectedAnswer: "timeout=timeout",
        timeoutMs: 5_000,
        outputLimitBytes: 4_096,
      },
    ],
  } as unknown as VerificationProfile;
  assert.throws(() => new PatchVerifier([incomplete]), /require diff-policy, post-write-evidence, rlm-contract, and focused-check/u);
});

test("rejects model-selected verification profiles even when the host selects fixture-pass", async () => {
  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts");
    const modelSelectedWeakProfile = {
      ...patchPlan(context, [
        patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n"),
      ]),
      verificationProfile: "fixture-weak",
    };
    const rejected = await executor().execute({
      plan: modelSelectedWeakProfile,
      verificationProfile: "fixture-pass",
      context,
      evidenceSession: observed.session,
      limits: limited(),
    });
    assert.equal(rejected.state, "PLAN_REJECTED");
    assert.equal(rejected.receipt.failureCode, "PATCH_SCHEMA_INVALID");

    const strict = await executor().execute({
      plan: patchPlan(context, [
        patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n"),
      ]),
      verificationProfile: "fixture-fails",
      context,
      evidenceSession: observed.session,
      limits: limited(),
    });
    assert.equal(strict.state, "VERIFICATION_FAILED");
    assert.equal(strict.receipt.failureCode, "FOCUSED_CHECK_FAILED");
  });
});

test("rejects control characters in patch paths before evidence resolution", () => {
  for (const path of [
    "src/\nsecret.ts",
    "src/\rsecret.ts",
    "src/\u0085secret.ts",
    "src/\u2028secret.ts",
    "src/\u2029secret.ts",
  ]) {
    assert.throws(
      () => parsePatchPlan(rawPlanWithPath(path)),
      (error: unknown) => error instanceof Error && error.message.includes("canonical relative path"),
      path,
    );
  }
});


test("never reports ACCEPTED when an allowlisted verification command fails", async () => {
  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts");
    const result = await executor().execute({
      plan: patchPlan(context, [patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n")]),
      verificationProfile: "fixture-fails",
      context,
      evidenceSession: observed.session,
      limits: limited(),
    });
    assert.equal(result.state, "VERIFICATION_FAILED");
    assert.equal(result.receipt.failureCode, "FOCUSED_CHECK_FAILED");
    assert.notEqual(result.state, "ACCEPTED");
  });
});
test("rejects exit-zero verification commands without their expected success output", async () => {
  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts");
    const result = await executor().execute({
      plan: patchPlan(context, [patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n")]),
      verificationProfile: "fixture-empty-output",
      context,
      evidenceSession: observed.session,
      limits: limited(),
    });
    assert.equal(result.state, "VERIFICATION_FAILED");
    assert.equal(result.receipt.failureCode, "FOCUSED_CHECK_FAILED");
  });
});
test("rejects a prior proof when a comment alone satisfies the source contract", async () => {
  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts");
    const result = await executor().execute({
      plan: patchPlan(context, [
        patchEdit(context, observed.evidenceId, "src/config.ts", [
          "// export const timeout = 20;",
          "export const timeout = 10;",
          "process.stdout.write('{\"proof\":\"previous-run-proof\"}\\n');",
          "process.exit(0);",
          "",
        ].join("\n")),
      ]),
      verificationProfile: "fixture-contract-bypass",
      context,
      evidenceSession: observed.session,
      limits: limited(),
    });
    assert.equal(result.state, "VERIFICATION_FAILED");
    assert.equal(result.receipt.failureCode, "FOCUSED_CHECK_FAILED");
    assert.notEqual(result.state, "ACCEPTED");
    assert.equal(
      result.receipt.checks.find((check) => check.kind === "rlm-contract")?.status,
      "passed",
    );
    const focusedCheck = result.receipt.checks.find((check) => check.kind === "focused-check");
    assert.equal(focusedCheck?.status, "failed");
    assert.ok(focusedCheck?.exitCode !== undefined && focusedCheck.exitCode !== 0);
  });
});


test("rejects the complete plan before an invalid second edit can partially apply", async () => {
  await withFixture(async ({ root, context }) => {
    const observed = observe(context, "src/config.ts", 1, 2);
    const original = await readFile(join(root, "src", "config.ts"), "utf8");
    const validFirst = patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n", 1, 1);
    const invalidSecond = {
      ...patchEdit(context, observed.evidenceId, "src/config.ts", "export const label = \"changed\";\n", 2, 2),
      expectedOldHash: "f".repeat(64),
    };
    const result = await executor().execute({ plan: patchPlan(context, [validFirst, invalidSecond]), verificationProfile: "fixture-pass", context,
    evidenceSession: observed.session,
    limits: limited(), });
    assert.equal(result.state, "PLAN_REJECTED");
    assert.equal(result.receipt.failureCode, "OLD_SOURCE_MISMATCH");
    assert.equal(await readFile(join(root, "src", "config.ts"), "utf8"), original);
  });
});

test("keeps the original checkout unchanged after a valid disposable-worktree apply", async () => {
  await withFixture(async ({ root, context }) => {
    const observed = observe(context, "src/config.ts");
    const original = await readFile(join(root, "src", "config.ts"), "utf8");
    const result = await executor().execute({ plan: patchPlan(context, [patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n")]), verificationProfile: "fixture-pass", context,
    evidenceSession: observed.session,
    limits: limited(), });
    assert.equal(result.state, "ACCEPTED");
    assert.equal(await readFile(join(root, "src", "config.ts"), "utf8"), original);
  });
});


test("invalidates pre-write evidence IDs after re-indexing the applied candidate", async () => {
  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts");
    const result = await executor().execute({ plan: patchPlan(context, [patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n")]), verificationProfile: "fixture-pass", context,
    evidenceSession: observed.session,
    limits: limited(), });
    assert.equal(result.state, "ACCEPTED");
    assert.ok(result.postContext);
    assert.notEqual(result.postContext.sourceRevision, context.sourceRevision);
    assert.throws(() => result.postContext?.resolveEvidence([observed.evidenceId]), /stale, or foreign evidence/u);
  });
});

test("runs the trusted rlm-check contract against the self-contained candidate snapshot", async () => {
  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts");
    const accepted = await executor().execute({ plan: patchPlan(context, [
      patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n"),
    ]), verificationProfile: "fixture-pass", context,
    evidenceSession: observed.session,
    limits: limited(), });
    const contractCheck = accepted.receipt.checks.find((check) => check.kind === "rlm-contract");
    assert.equal(accepted.state, "ACCEPTED");
    assert.equal(contractCheck?.status, "passed");
    assert.equal(contractCheck?.name, "fixture-contract");
    assert.ok(contractCheck?.outputDigest);

    const drifted = await executor().execute({ plan: patchPlan(context, [
      patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 30;\n"),
    ]), verificationProfile: "fixture-pass", context,
    evidenceSession: observed.session,
    limits: limited(), });
    assert.equal(drifted.state, "VERIFICATION_FAILED");
    assert.equal(drifted.receipt.failureCode, "CONTRACT_CHECK_FAILED");
  });
});

test("rejects snapshot path, content, and mode drift against the host manifest", async () => {
  const mutations: ReadonlyArray<{
    name: string;
    mutate: (snapshotPath: string) => Promise<void>;
  }> = [
    {
      name: "extra",
      mutate: async (snapshotPath) => {
        await writeFile(join(snapshotPath, "extra.ts"), "export const extra = true;\n", "utf8");
      },
    },
    {
      name: "missing",
      mutate: async (snapshotPath) => {
        await unlink(join(snapshotPath, "src", "consumer.ts"));
      },
    },
    {
      name: "content",
      mutate: async (snapshotPath) => {
        await writeFile(join(snapshotPath, "src", "config.ts"), "export const timeout = 30;\n", "utf8");
      },
    },
    {
      name: "mode",
      mutate: async (snapshotPath) => {
        await chmod(join(snapshotPath, "src", "config.ts"), 0o755);
      },
    },
  ];

  for (const mutation of mutations) {
    await withFixture(async ({ context }) => {
      const observed = observe(context, "src/config.ts");
      const result = await executor(rootAuthority, {
        beforeVerifySnapshot: async (snapshotPath) => mutation.mutate(snapshotPath),
      }).execute({ plan: patchPlan(context, [
        patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n"),
      ]), verificationProfile: "fixture-pass", context,
      evidenceSession: observed.session,
      limits: limited(), });
      assert.equal(result.state, "VERIFICATION_FAILED", mutation.name);
      assert.equal(result.receipt.failureCode, "CONTRACT_CHECK_FAILED", mutation.name);
    });
  }
});

test("retains reindexed receipt data when verification snapshot setup fails", async () => {
  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts");
    const result = await executor(rootAuthority, {
      beforeVerifySnapshot: async () => {
        throw new Error("intentional verification setup failure");
      },
    }).execute({
      plan: patchPlan(context, [patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n")]),
      verificationProfile: "fixture-pass",
      context,
      evidenceSession: observed.session,
      limits: limited(),
    });
    assert.equal(result.state, "VERIFICATION_FAILED");
    assert.equal(result.receipt.failureCode, "VERIFICATION_SETUP_FAILED");
    assert.ok(result.receipt.postWriteRevision);
    assert.equal(result.receipt.postWriteEvidenceIds.length, 1);
    assert.deepEqual(result.receipt.transitions, [
      "READ_ONLY",
      "PLAN_SUBMITTED",
      "PLAN_VALIDATED",
      "APPLIED",
      "REINDEXED",
      "VERIFICATION_FAILED",
    ]);
    assert.ok(result.postContext);
  });
});

test("retains verification-setup failure when partial snapshot cleanup cannot be certified", async () => {
  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts");
    const result = await executor(rootAuthority, {
      beforeMaterializeVerificationSnapshot: async () => {
        throw new Error("intentional partial snapshot failure");
      },
      cleanupVerificationSnapshot: async () => false,
    }).execute({
      plan: patchPlan(context, [patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n")]),
      verificationProfile: "fixture-pass",
      context,
      evidenceSession: observed.session,
      limits: limited(),
    });
    assert.equal(result.state, "CLEANUP_FAILED");
    assert.equal(result.receipt.failureCode, "CLEANUP_FAILED");
    assert.equal(result.receipt.primaryFailureCode, "VERIFICATION_SETUP_FAILED");
    assert.ok(result.receipt.postWriteRevision);
    assert.equal(result.receipt.postWriteEvidenceIds.length, 1);
  });
});

test("keeps candidate capability issuance private and rejects a duplicate executor attempt", async () => {
  const verifier = new PatchVerifier(verificationProfiles());
  assert.equal("issueCandidate" in verifier, false);
  assert.equal("verifyExactSnapshot" in verifier, false);
  assert.equal(Object.getPrototypeOf(verifier).verifyExactSnapshot, undefined);
  assert.equal("verify" in verifier, false);

  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts");
    const singleUseExecutor = executor();
    const firstExecution = singleUseExecutor.execute({ plan: patchPlan(context, [
      patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n"),
    ]), verificationProfile: "fixture-pass", context,
    evidenceSession: observed.session,
    limits: limited(), });
    const duplicateExecution = await singleUseExecutor.execute({ plan: patchPlan(context, [
      patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n"),
    ]), verificationProfile: "fixture-pass", context,
    evidenceSession: observed.session,
    limits: limited(), });
    const firstResult = await firstExecution;
    assert.equal(firstResult.state, "ACCEPTED");
    assert.equal(duplicateExecution.state, "PLAN_REJECTED");
    assert.equal(duplicateExecution.receipt.failureCode, "MUTATION_BUDGET_EXCEEDED");
  });
});

test("rejects an extra tracked worktree change outside the generated candidate", async () => {
  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts");
    const result = await executor(rootAuthority, {
      beforeWrite: async (worktreeSourceRoot) => {
        await writeFile(join(worktreeSourceRoot, "docs", "outside.ts"), "export const outside = false;\n", "utf8");
      },
    }).execute({ plan: patchPlan(context, [
      patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n"),
    ]), verificationProfile: "fixture-pass", context,
    evidenceSession: observed.session,
    limits: limited(), });
    assert.equal(result.state, "APPLY_FAILED");
    assert.equal(result.receipt.failureCode, "APPLY_FAILED");
  });
});

test("rejects an untracked worktree file outside the generated candidate", async () => {
  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts");
    const result = await executor(rootAuthority, {
      beforeWrite: async (worktreeSourceRoot) => {
        await writeFile(join(worktreeSourceRoot, "untracked.ts"), "export const untracked = true;\n", "utf8");
      },
    }).execute({ plan: patchPlan(context, [
      patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n"),
    ]), verificationProfile: "fixture-pass", context,
    evidenceSession: observed.session,
    limits: limited(), });
    assert.equal(result.state, "APPLY_FAILED");
    assert.equal(result.receipt.failureCode, "APPLY_FAILED");
  });
});

test("rejects planned-path mode drift without omitting it from the receipt", async () => {
  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts");
    const result = await executor(rootAuthority, {
      beforeWrite: async (worktreeSourceRoot) => {
        await chmod(join(worktreeSourceRoot, "src", "config.ts"), 0o755);
      },
    }).execute({ plan: patchPlan(context, [
      patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n"),
    ]), verificationProfile: "fixture-pass", context,
    evidenceSession: observed.session,
    limits: limited(), });
    assert.equal(result.state, "APPLY_FAILED");
    assert.deepEqual(result.receipt.changedPaths, ["src/config.ts"]);
  });
});

test("rejects a swapped candidate symlink without reading or changing the original checkout", async () => {
  await withFixture(async ({ root, context }) => {
    const observed = observe(context, "src/config.ts");
    const original = await readFile(join(root, "src", "config.ts"), "utf8");
    const result = await executor(rootAuthority, {
      beforeWrite: async (worktreeSourceRoot) => {
        const candidatePath = join(worktreeSourceRoot, "src", "config.ts");
        await unlink(candidatePath);
        await symlink(join(root, "src", "config.ts"), candidatePath);
      },
    }).execute({ plan: patchPlan(context, [
      patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n"),
    ]), verificationProfile: "fixture-pass", context,
    evidenceSession: observed.session,
    limits: limited(), });
    assert.equal(result.state, "APPLY_FAILED");
    assert.equal(await readFile(join(root, "src", "config.ts"), "utf8"), original);
  });
});

test("rejects an ancestor-directory symlink that resolves into the original checkout", async () => {
  await withFixture(async ({ root, context }) => {
    const observed = observe(context, "src/config.ts");
    const original = await readFile(join(root, "src", "config.ts"), "utf8");
    const result = await executor(rootAuthority, {
      beforeWrite: async (worktreeSourceRoot) => {
        const candidateDirectory = join(worktreeSourceRoot, "src");
        await rm(candidateDirectory, { recursive: true, force: true });
        await symlink(join(root, "src"), candidateDirectory, "dir");
      },
    }).execute({ plan: patchPlan(context, [
      patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n"),
    ]), verificationProfile: "fixture-pass", context,
    evidenceSession: observed.session,
    limits: limited(), });
    assert.equal(result.state, "APPLY_FAILED");
    assert.equal(await readFile(join(root, "src", "config.ts"), "utf8"), original);
  });
});

test("uses the host non-root Docker identity for patch verification", async () => {
  await withFixture(async ({ context }) => {
    const createArgv: string[][] = [];
    const observed = observe(context, "src/config.ts");
    const result = await executor(rootAuthority, {
      verification: {
        dockerCommandRunner: fixtureDockerRunner("passed", {
          onCreate: (args) => createArgv.push([...args]),
        }),
      },
    }).execute({
      plan: patchPlan(context, [patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n")]),
      verificationProfile: "fixture-pass",
      context,
      evidenceSession: observed.session,
      limits: limited(),
    });
    assert.equal(result.state, "ACCEPTED");

    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const gid = typeof process.getgid === "function" ? process.getgid() : undefined;
    const expectedIdentity = uid !== undefined && gid !== undefined && uid !== 0 && gid !== 0
      ? `${uid}:${gid}`
      : "65534:65534";
    assert.notEqual(expectedIdentity, "0:0");
    assert.equal(createArgv.length, 2);
    for (const args of createArgv) {
      const user = args.find((arg) => arg.startsWith("--user="));
      assert.equal(user, `--user=${expectedIdentity}`);
      assert.notEqual(user, "--user=0:0");
    }
  });
});

test("removes the exact Docker containers after a focused-check timeout", async () => {
  await withFixture(async ({ context }) => {
    const names: string[] = [];
    const observed = observe(context, "src/config.ts");
    const result = await executor(rootAuthority, {
      verification: {
        containerNameFactory: () => {
          const name = `pi-rlm-timeout-${process.pid}-${randomUUID().slice(0, 12)}-${names.length}`;
          names.push(name);
          return name;
        },
      },
    }).execute({
      plan: patchPlan(context, [patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n")]),
      verificationProfile: "fixture-timeout",
      context,
      evidenceSession: observed.session,
      limits: limited(),
    });
    assert.equal(result.state, "VERIFICATION_FAILED");
    assert.equal(result.receipt.failureCode, "VERIFICATION_TIMEOUT");
    assert.equal(names.length, 2);
    for (const name of names) {
      assert.equal(await dockerContainerExists(name), false);
    }
  });
});

test("derives Docker cleanup primary failure from the completed focused command", async () => {
  for (const [focusedResult, primaryFailureCode] of [
    ["passed", undefined],
    ["timed-out", "VERIFICATION_TIMEOUT"],
  ] as const) {
    await withFixture(async ({ context }) => {
      const observed = observe(context, "src/config.ts");
      const result = await executor(rootAuthority, {
        verification: {
          dockerCommandRunner: cleanupFailingDockerRunner(focusedResult),
        },
      }).execute({
        plan: patchPlan(context, [patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n")]),
        verificationProfile: "fixture-pass",
        context,
        evidenceSession: observed.session,
        limits: limited(),
      });
      assert.equal(result.state, "CLEANUP_FAILED");
      assert.equal(result.receipt.failureCode, "CLEANUP_FAILED");
      assert.equal(result.receipt.primaryFailureCode, primaryFailureCode);
      const focusedCheck = result.receipt.checks.find((check) => check.kind === "focused-check");
      assert.equal(focusedCheck?.failureCode, "CLEANUP_FAILED");
      if (focusedResult === "passed") {
        assert.equal(focusedCheck?.exitCode, 0);
        assert.ok(focusedCheck?.outputDigest);
        assert.ok((focusedCheck?.outputBytes ?? 0) > 0);
        assert.equal(focusedCheck?.outputTruncated, false);
      }
    });
  }
});

test("reports a Docker create timeout as verification timeout", async () => {
  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts");
    const result = await executor(rootAuthority, {
      verification: {
        dockerCommandRunner: cleanupFailingDockerRunner("create-timed-out"),
      },
    }).execute({
      plan: patchPlan(context, [patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n")]),
      verificationProfile: "fixture-pass",
      context,
      evidenceSession: observed.session,
      limits: limited(),
    });
    assert.equal(result.state, "VERIFICATION_FAILED");
    assert.equal(result.receipt.failureCode, "VERIFICATION_TIMEOUT");
  });
});

test("preserves timeout primary failure through nested Docker and worktree cleanup failures", async () => {
  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts");
    const result = await executor(rootAuthority, {
      verification: {
        dockerCommandRunner: cleanupFailingDockerRunner("timed-out"),
      },
      cleanupWorktree: cleanupAndReportFailure(),
    }).execute({
      plan: patchPlan(context, [patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n")]),
      verificationProfile: "fixture-pass",
      context,
      evidenceSession: observed.session,
      limits: limited(),
    });
    assert.equal(result.state, "CLEANUP_FAILED");
    assert.equal(result.receipt.failureCode, "CLEANUP_FAILED");
    assert.equal(result.receipt.primaryFailureCode, "VERIFICATION_TIMEOUT");
  });
});

test("continues worktree cleanup after rejected partial snapshot cleanup", async () => {
  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts");
    let worktreeCleanupRuns = 0;
    const result = await executor(rootAuthority, {
      beforeMaterializeVerificationSnapshot: async () => {
        throw new Error("intentional partial snapshot failure");
      },
      cleanupVerificationSnapshot: async () => {
        throw new Error("intentional snapshot cleanup rejection");
      },
      cleanupWorktree: async (repository, worktreePath, worktreeParent) => {
        worktreeCleanupRuns += 1;
        await runGit(repository.repositoryRoot, ["worktree", "remove", "--force", worktreePath]);
        await rm(worktreeParent, { recursive: true, force: true });
        return true;
      },
    }).execute({
      plan: patchPlan(context, [patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n")]),
      verificationProfile: "fixture-pass",
      context,
      evidenceSession: observed.session,
      limits: limited(),
    });
    assert.equal(worktreeCleanupRuns, 1);
    assert.equal(result.state, "CLEANUP_FAILED");
    assert.equal(result.receipt.primaryFailureCode, "VERIFICATION_SETUP_FAILED");
  });
});

test("cleanup failure supersedes apply, index, verification, and success outcomes", async () => {
  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts");
    const result = await executor(rootAuthority, {
      beforeWrite: async (worktreeSourceRoot) => {
        await writeFile(join(worktreeSourceRoot, "docs", "outside.ts"), "export const outside = false;\n", "utf8");
      },
      cleanupWorktree: cleanupAndReportFailure(),
    }).execute({ plan: patchPlan(context, [
      patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n"),
    ]), verificationProfile: "fixture-pass", context,
    evidenceSession: observed.session,
    limits: limited(), });
    assert.equal(result.state, "CLEANUP_FAILED");
    assert.equal(result.receipt.failureCode, "CLEANUP_FAILED");
    assert.equal(result.receipt.primaryFailureCode, "APPLY_FAILED");
  });

  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts");
    const result = await executor(rootAuthority, {
      beforeReindex: async () => {
        throw new Error("intentional index failure");
      },
      cleanupWorktree: cleanupAndReportFailure(true),
    }).execute({ plan: patchPlan(context, [
      patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n"),
    ]), verificationProfile: "fixture-pass", context,
    evidenceSession: observed.session,
    limits: limited(), });
    assert.equal(result.state, "CLEANUP_FAILED");
    assert.equal(result.receipt.failureCode, "CLEANUP_FAILED");
    assert.equal(result.receipt.primaryFailureCode, "POST_WRITE_INDEX_FAILED");
  });

  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts");
    const result = await executor(rootAuthority, {
      cleanupWorktree: cleanupAndReportFailure(),
    }).execute({
      plan: patchPlan(context, [patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n")]),
      verificationProfile: "fixture-fails",
      context,
      evidenceSession: observed.session,
      limits: limited(),
    });
    assert.equal(result.state, "CLEANUP_FAILED");
    assert.equal(result.receipt.failureCode, "CLEANUP_FAILED");
    assert.equal(result.receipt.primaryFailureCode, "FOCUSED_CHECK_FAILED");
  });

  await withFixture(async ({ context }) => {
    const observed = observe(context, "src/config.ts");
    const result = await executor(rootAuthority, {
      cleanupWorktree: cleanupAndReportFailure(true),
    }).execute({ plan: patchPlan(context, [
      patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n"),
    ]), verificationProfile: "fixture-pass", context,
    evidenceSession: observed.session,
    limits: limited(), });
    assert.equal(result.state, "CLEANUP_FAILED");
    assert.equal(result.receipt.failureCode, "CLEANUP_FAILED");
    assert.equal(result.receipt.primaryFailureCode, undefined);
  });
});

test("aborts after worktree creation before candidate writes and removes that exact worktree", async () => {
  await withFixture(async ({ root, context }) => {
    const controller = new AbortController();
    const observed = observe(context, "src/config.ts");
    const original = await readFile(join(root, "src", "config.ts"), "utf8");
    let candidateRoot: string | undefined;
    const result = await executor(rootAuthority, {
      beforeWrite: async (worktreeSourceRoot) => {
        candidateRoot = worktreeSourceRoot;
        controller.abort();
      },
    }).execute({
      plan: patchPlan(context, [
        patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n"),
      ]),
      verificationProfile: "fixture-pass",
      context,
      evidenceSession: observed.session,
      limits: limited(),
      signal: controller.signal,
    });

    assert.equal(result.state, "ABORTED");
    assert.equal(result.receipt.failureCode, "ABORTED");
    assert.deepEqual(result.receipt.transitions, [
      "READ_ONLY",
      "PLAN_SUBMITTED",
      "PLAN_VALIDATED",
      "ABORTED",
    ]);
    assert.equal(await readFile(join(root, "src", "config.ts"), "utf8"), original);
    const cleanedCandidateRoot = candidateRoot;
    if (!cleanedCandidateRoot) throw new Error("Expected a disposable candidate worktree");
    await assert.rejects(
      () => readFile(join(cleanedCandidateRoot, "src", "config.ts"), "utf8"),
      { code: "ENOENT" },
    );
  });
});

test("aborts an active Docker verification command and cleans its exact containers", async () => {
  await withFixture(async ({ context }) => {
    const controller = new AbortController();
    const observed = observe(context, "src/config.ts");
    let starts = 0;
    let removals = 0;
    let inspections = 0;
    let commandObservedAbort = false;
    const dockerCommandRunner: DockerCommandRunner = async (args, _timeoutMs, _outputLimitBytes, _stdin, signal) => {
      if (args[0] === "create") {
        const cidFile = args[args.indexOf("--cidfile") + 1];
        if (!cidFile) throw new Error("Docker create test command omitted cidfile");
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
            answer: "timeout=timeout",
          })}\n`);
        }
        controller.abort();
        commandObservedAbort = signal?.aborted === true;
        return dockerResult("", { exitCode: -1, aborted: true });
      }
      if (args[0] === "rm") {
        removals += 1;
        return dockerResult();
      }
      if (args[0] === "container") {
        inspections += 1;
        const identity = args[2] ?? "";
        const stdout = "[]\n";
        const stderr = `Error: No such container: ${identity}\n`;
        return dockerResult(stdout + stderr, {
          exitCode: 1,
          stdout: Buffer.from(stdout, "utf8"),
          stderr: Buffer.from(stderr, "utf8"),
        });
      }
      throw new Error(`Unexpected Docker verification command: ${args.join(" ")}`);
    };
    const result = await executor(rootAuthority, {
      verification: { dockerCommandRunner },
    }).execute({
      plan: patchPlan(context, [
        patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n"),
      ]),
      verificationProfile: "fixture-pass",
      context,
      evidenceSession: observed.session,
      limits: limited(),
      signal: controller.signal,
    });

    assert.equal(result.state, "ABORTED");
    assert.equal(result.receipt.failureCode, "ABORTED");
    assert.deepEqual(result.receipt.transitions, [
      "READ_ONLY",
      "PLAN_SUBMITTED",
      "PLAN_VALIDATED",
      "APPLIED",
      "REINDEXED",
      "VERIFYING",
      "ABORTED",
    ]);
    assert.equal(commandObservedAbort, true);
    assert.equal(removals, 2);
    assert.equal(inspections, 2);
  });
});
test("aborts after candidate writes before indexing and removes the disposable candidate", async () => {
  await withFixture(async ({ root, context }) => {
    const controller = new AbortController();
    const observed = observe(context, "src/config.ts");
    const original = await readFile(join(root, "src", "config.ts"), "utf8");
    let candidateRoot: string | undefined;
    const result = await executor(rootAuthority, {
      beforeReindex: async (worktreeSourceRoot) => {
        candidateRoot = worktreeSourceRoot;
        controller.abort();
      },
    }).execute({
      plan: patchPlan(context, [
        patchEdit(context, observed.evidenceId, "src/config.ts", "export const timeout = 20;\n"),
      ]),
      verificationProfile: "fixture-pass",
      context,
      evidenceSession: observed.session,
      limits: limited(),
      signal: controller.signal,
    });

    assert.equal(result.state, "ABORTED");
    assert.equal(result.receipt.failureCode, "ABORTED");
    assert.deepEqual(result.receipt.transitions, [
      "READ_ONLY",
      "PLAN_SUBMITTED",
      "PLAN_VALIDATED",
      "APPLIED",
      "ABORTED",
    ]);
    assert.equal(await readFile(join(root, "src", "config.ts"), "utf8"), original);
    const cleanedCandidateRoot = candidateRoot;
    if (!cleanedCandidateRoot) throw new Error("Expected a disposable candidate worktree");
    await assert.rejects(
      () => readFile(join(cleanedCandidateRoot, "src", "config.ts"), "utf8"),
      { code: "ENOENT" },
    );
  });
});

