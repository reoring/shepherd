import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadGitDirectoryContext,
  type FileIndexedContext,
} from "./file-context.ts";
import type { VerificationProfile } from "./patch-verifier.ts";
import type { NativePatchReplacementTarget } from "./runner.ts";

export const DEFAULT_REPAIR_PROFILE_NAME = "default-repair-v1";
export const DEFAULT_REPAIR_QUESTION = [
  "Change the default timeout from 10 to 20.",
  "Keep the typed declaration and default mapping consistent.",
  "Inspect the consumer to preserve its contract, and change only src/config.ts.",
].join(" ");

export const DEFAULT_REPAIR_NATIVE_REPLACEMENT_TARGET = Object.freeze({
  path: "src/config.ts",
  startLine: 6,
  endLine: 6,
}) satisfies NativePatchReplacementTarget;

export interface DefaultRepairFixture {
  root: string;
  context: FileIndexedContext;
  question: string;
  verificationProfile: string;
  nativeReplacementTarget: NativePatchReplacementTarget;
  cleanup(): Promise<void>;
}

function runGit(cwd: string, args: readonly string[]): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  execFile("git", [...args], { cwd }, (error) => {
    if (error) reject(error);
    else resolve();
  });
  return promise;
}

function defaultRepairContract(): string {
  return JSON.stringify({
    version: 1,
    factContract: {
      requirements: [
        {
          id: "timeout",
          description: "The default timeout mapping is exactly 20.",
          grounding: "quoted",
          minSupports: 1,
          extractor: {
            source: {
              kind: "search-open",
              literal: "timeout: 20",
              path: "src/config.ts",
              before: 0,
              after: 0,
            },
            select: { kind: "contains-all", literals: ["timeout: 20"] },
            capture: { kind: "number-after", literal: "timeout: " },
            reduce: { kind: "single", exactCount: 1 },
          },
        },
      ],
      finalizer: { kind: "template", template: "timeout={{timeout}}" },
    },
    answerContract: {
      description: "Return the verified default timeout.",
      pattern: "^timeout=20$",
    },
  }, null, 2);
}

export function createDefaultRepairVerificationProfiles(): VerificationProfile[] {
  return [
    {
      name: DEFAULT_REPAIR_PROFILE_NAME,
      steps: [
        { kind: "diff-policy" },
        { kind: "post-write-evidence" },
        {
          kind: "rlm-contract",
          name: "default-timeout-contract",
          contractPath: ".rlm/default-timeout-contract.v1.json",
          expectedAnswer: "timeout=20",
          timeoutMs: 5_000,
          outputLimitBytes: 4_096,
        },
        {
          kind: "focused-check",
          name: "default-timeout-consumer",
          trustedScript: "src/patch-focused-fixture.ts",
          timeoutMs: 5_000,
          outputLimitBytes: 4_096,
        },
      ],
    },
  ];
}

export async function createDefaultRepairFixture(): Promise<DefaultRepairFixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-rlm-default-repair-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, ".rlm"));
  await writeFile(
    join(root, "src", "config.ts"),
    [
      "export interface TimeoutConfig {",
      "  timeout: number;",
      "}",
      "",
      "export const defaultConfig: TimeoutConfig = {",
      "  timeout: 10,",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(root, "src", "consumer.ts"),
    [
      'import { defaultConfig } from "./config.ts";',
      "",
      "export const usesTimeout = defaultConfig.timeout;",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(root, ".rlm", "default-timeout-contract.v1.json"),
    `${defaultRepairContract()}\n`,
    "utf8",
  );
  await runGit(root, ["init"]);
  await runGit(root, ["add", "."]);
  await runGit(root, [
    "-c",
    "user.name=Pi RLM Patch Fixture",
    "-c",
    "user.email=patch-fixture@example.test",
    "commit",
    "-m",
    "default timeout fixture",
  ]);
  return {
    root,
    context: await loadGitDirectoryContext(root),
    question: DEFAULT_REPAIR_QUESTION,
    verificationProfile: DEFAULT_REPAIR_PROFILE_NAME,
    nativeReplacementTarget: DEFAULT_REPAIR_NATIVE_REPLACEMENT_TARGET,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
