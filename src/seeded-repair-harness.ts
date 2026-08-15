import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { loadGitDirectoryContext } from "./file-context.ts";
import type { FileIndexedContext } from "./file-context.ts";
import { validateNativeEditTargets } from "./native-edits.ts";
import type { VerificationProfile } from "./patch-verifier.ts";
import type { NativePatchEditTarget } from "./native-edits.ts";
const SEEDED_CONTRACT_PATH = ".rlm/seeded-repair-contract.v1.json";
export const SEEDED_ORACLE_PATH = ".rlm/seeded-repair-oracle.v1.json";
const SEEDED_PROFILE_NAME = "seeded-repository-repair-v1";

export interface SeededRepairDefinition {
  /** Real repository root. It is read-only throughout the harness lifetime. */
  sourceRoot: string;
  /** Canonical, tracked text path within sourceRoot. */
  sourcePath: string;
  /** One bounded source replacement fault supplied by the host. */
  target: NativePatchEditTarget;
  seededReplacement: string;
  question: string;
}

export interface SeededSourceState {
  readonly root: string;
  readonly path: string;
  readonly gitHead: string;
  readonly sha256: string;
  readonly mode: number;
  readonly status: string;
}

export interface SeededRepairFixture {
  readonly root: string;
  readonly context: FileIndexedContext;
  readonly question: string;
  readonly verificationProfile: string;
  readonly nativeEdits: readonly NativePatchEditTarget[];
  readonly sourceState: SeededSourceState;
  readonly oracleSha256: string;
  isRepairedToOracle(candidate: FileIndexedContext | undefined): boolean;
  assertOriginalUnchanged(): Promise<boolean>;
  cleanup(): Promise<void>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalPath(path: string, subject: string): string {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(path)
  ) {
    throw new TypeError(`${subject} must be a canonical relative path`);
  }
  if (path.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new TypeError(`${subject} must be a canonical relative path`);
  }
  return path;
}

function inside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { promise, resolve: complete, reject } = Promise.withResolvers<string>();
  execFile(
    "git",
    [...args],
    { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args[0] ?? ""} failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`, { cause: error }));
      } else {
        complete(stdout);
      }
    },
  );
  return promise;
}

function replacementCandidate(
  source: string,
  target: NativePatchEditTarget,
  replacement: string,
): string {
  if (target.operation !== "replace-range") {
    throw new TypeError("Seeded real-repository faults currently require replace-range targets");
  }
  if (replacement.includes("\0")) {
    throw new TypeError("Seeded replacement must not contain NUL bytes");
  }
  const lines = source.match(/[^\n]*\n|[^\n]+/gu) ?? [];
  if (target.endLine > lines.length) {
    throw new RangeError("Seeded fault line range is outside the selected source file");
  }
  return `${lines.slice(0, target.startLine - 1).join("")}${replacement}${lines.slice(target.endLine).join("")}`;
}

async function captureSourceState(root: string, sourcePath: string): Promise<SeededSourceState> {
  const path = canonicalPath(sourcePath, "Seeded source path");
  const resolvedRoot = await realpath(root);
  const candidatePath = resolve(resolvedRoot, path);
  if (!inside(resolvedRoot, candidatePath)) {
    throw new TypeError("Seeded source path escapes the source root");
  }
  await runGit(resolvedRoot, ["ls-files", "--error-unmatch", "--", path]);
  const status = await runGit(resolvedRoot, ["status", "--porcelain=v1", "--untracked-files=all", "--", path]);
  if (status.length > 0) {
    throw new Error("Seeded repair requires a clean selected source path");
  }
  const file = await lstat(candidatePath);
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new TypeError("Seeded repair requires a tracked regular text file");
  }
  const content = await readFile(candidatePath, "utf8");
  if (content.includes("\0")) {
    throw new TypeError("Seeded repair requires UTF-8 text without NUL bytes");
  }
  return Object.freeze({
    root: resolvedRoot,
    path,
    gitHead: (await runGit(resolvedRoot, ["rev-parse", "HEAD"])).trim(),
    sha256: sha256(content),
    mode: file.mode,
    status,
  });
}

async function sourceStateMatches(initial: SeededSourceState): Promise<boolean> {
  try {
    const current = await captureSourceState(initial.root, initial.path);
    return current.gitHead === initial.gitHead &&
      current.sha256 === initial.sha256 &&
      current.mode === initial.mode &&
      current.status === initial.status;
  } catch {
    return false;
  }
}

function seededContract(oracleSha256: string): string {
  return JSON.stringify({
    version: 1,
    factContract: {
      requirements: [{
        id: "oracle",
        description: "The seeded oracle digest is available to the trusted verifier.",
        grounding: "quoted",
        minSupports: 1,
        extractor: {
          source: {
            kind: "search-open",
            literal: oracleSha256,
            path: SEEDED_ORACLE_PATH,
            before: 0,
            after: 0,
          },
          select: { kind: "contains-all", literals: ["\"oracleSha256\"", oracleSha256] },
          capture: { kind: "quoted-string", index: 1 },
          reduce: { kind: "single", exactCount: 1 },
        },
      }],
      finalizer: { kind: "template", template: "oracle={{oracle}}" },
    },
    answerContract: {
      description: "Return the seeded oracle digest.",
      pattern: `^oracle=${oracleSha256}$`,
    },
  }, null, 2);
}

function seededOracle(sourcePath: string, oracleSha256: string): string {
  return JSON.stringify({ version: 1, sourcePath, oracleSha256 }, null, 2);
}

export function createSeededRepairVerificationProfiles(
  oracleSha256: string,
): VerificationProfile[] {
  return [{
    name: SEEDED_PROFILE_NAME,
    steps: [
      { kind: "diff-policy" },
      { kind: "post-write-evidence" },
      {
        kind: "rlm-contract",
        name: "seeded-repository-contract",
        contractPath: SEEDED_CONTRACT_PATH,
        expectedAnswer: `oracle=${oracleSha256}`,
        timeoutMs: 5_000,
        outputLimitBytes: 4_096,
      },
      {
        kind: "focused-check",
        name: "seeded-repository-oracle",
        trustedScript: "src/patch-seeded-repair-focused.ts",
        timeoutMs: 5_000,
        outputLimitBytes: 4_096,
      },
    ],
  }];
}

/**
 * Builds a one-file, committed, disposable fault from a real tracked text
 * file. The pristine source remains in a host closure and never enters the
 * native-edits model prompt or tool payload.
 */
export async function createSeededRepairFixture(
  definition: SeededRepairDefinition,
): Promise<SeededRepairFixture> {
  const sourcePath = canonicalPath(definition.sourcePath, "Seeded source path");
  const [target] = validateNativeEditTargets([definition.target]);
  if (!target || target.path !== sourcePath) {
    throw new TypeError("Seeded repair target must exactly select the supplied source path");
  }
  const sourceState = await captureSourceState(definition.sourceRoot, sourcePath);
  const oracle = await readFile(join(sourceState.root, sourcePath), "utf8");
  const oracleSha256 = sha256(oracle);
  const faulted = replacementCandidate(oracle, target, definition.seededReplacement);
  if (faulted === oracle) {
    throw new TypeError("Seeded repair fault must change the selected source bytes");
  }

  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, "pi-rlm-seeded-repair-"));
  if (!inside(parent, root)) {
    await rm(root, { recursive: true, force: true });
    throw new Error("Seeded repair temporary root escaped its owned parent");
  }
  try {
    await mkdir(join(root, dirname(sourcePath)), { recursive: true });
    await mkdir(join(root, ".rlm"), { recursive: true });
    await writeFile(join(root, sourcePath), oracle, "utf8");
    await chmod(join(root, sourcePath), sourceState.mode & 0o777);
    await writeFile(
      join(root, SEEDED_CONTRACT_PATH),
      `${seededContract(oracleSha256)}\n`,
      "utf8",
    );
    await writeFile(
      join(root, SEEDED_ORACLE_PATH),
      `${seededOracle(sourcePath, oracleSha256)}\n`,
      "utf8",
    );
    await runGit(root, ["init"]);
    await runGit(root, ["add", "."]);
    await runGit(root, [
      "-c",
      "user.name=Pi RLM Seeded Repair",
      "-c",
      "user.email=seeded-repair@example.test",
      "commit",
      "-m",
      "capture selected source oracle",
    ]);
    await writeFile(join(root, sourcePath), faulted, "utf8");
    await runGit(root, ["add", "--", sourcePath]);
    await runGit(root, [
      "-c",
      "user.name=Pi RLM Seeded Repair",
      "-c",
      "user.email=seeded-repair@example.test",
      "commit",
      "-m",
      "seed bounded repair fault",
    ]);
    const context = await loadGitDirectoryContext(root);
    return Object.freeze({
      root,
      context,
      question: definition.question,
      verificationProfile: SEEDED_PROFILE_NAME,
      nativeEdits: Object.freeze([target]),
      sourceState,
      oracleSha256,
      isRepairedToOracle(candidate: FileIndexedContext | undefined): boolean {
        try {
          return candidate?.read(sourcePath) === oracle;
        } catch {
          return false;
        }
      },
      assertOriginalUnchanged: () => sourceStateMatches(sourceState),
      async cleanup(): Promise<void> {
        await rm(root, { recursive: true, force: true });
        try {
          await stat(root);
          throw new Error("Seeded repair temporary root cleanup could not be certified");
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") throw error;
        }
        if (!await sourceStateMatches(sourceState)) {
          throw new Error("Seeded repair changed the original source repository");
        }
      },
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
