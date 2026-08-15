import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadGitDirectoryContext,
  type FileIndexedContext,
} from "./file-context.ts";
import type { NativePatchEditTarget } from "./native-edits.ts";
import type { VerificationProfile } from "./patch-verifier.ts";

export const REGISTRATION_INSERTION_PROFILE = "registration-insertion-v1";
export const TWO_FILE_WIRING_PROFILE = "two-file-wiring-v1";

export const REGISTRATION_INSERTION_QUESTION = [
  "Register the create command in the command registry.",
  "Insert the requested command as a quoted string-literal entry in the command list.",
  "Preserve the typed command declaration and change only the selected insertion target.",
].join(" ");

export const TWO_FILE_WIRING_QUESTION = [
  "Set featureConfig.enabled to true and set the exported featureEnabled initializer directly to featureConfig.enabled.",
  "Change only the selected lines. Do not include full replacement lines, indentation, or punctuation.",
].join(" ");

export const REGISTRATION_INSERTION_TARGETS = Object.freeze([
  Object.freeze({
    id: "register-create-command",
    path: "src/registry.ts",
    operation: "insert-before" as const,
    startLine: 5,
    endLine: 5,
  }),
]) satisfies readonly NativePatchEditTarget[];

export const TWO_FILE_WIRING_TARGETS = Object.freeze([
  Object.freeze({
    id: "enable-feature-config",
    path: "src/producer.ts",
    operation: "replace-range" as const,
    startLine: 6,
    endLine: 6,
    replacementConstraint: Object.freeze({
      description: "Replacement must be one executable enabled: true property line.",
      source: "^\\s*enabled\\s*:\\s*true\\s*,\\s*$",
      flags: "u",
    }),
  }),
  Object.freeze({
    id: "wire-feature-consumer",
    path: "src/consumer.ts",
    operation: "replace-range" as const,
    startLine: 3,
    endLine: 3,
    replacementConstraint: Object.freeze({
      description: "Replacement must directly export featureEnabled from featureConfig.enabled.",
      source: "^\\s*export\\s+const\\s+featureEnabled\\s*=\\s*featureConfig\\.enabled\\s*;\\s*$",
      flags: "u",
    }),
  }),
]) satisfies readonly NativePatchEditTarget[];

export interface PhaseCRepairFixture {
  root: string;
  context: FileIndexedContext;
  question: string;
  verificationProfile: string;
  nativeEdits: readonly NativePatchEditTarget[];
  cleanup(): Promise<void>;
}

interface FixtureDefinition {
  prefix: string;
  question: string;
  verificationProfile: string;
  nativeEdits: readonly NativePatchEditTarget[];
  files: Readonly<Record<string, string>>;
}

function runGit(cwd: string, args: readonly string[]): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  execFile("git", [...args], { cwd }, (error) => {
    if (error) reject(error);
    else resolve();
  });
  return promise;
}

async function createFixture(definition: FixtureDefinition): Promise<PhaseCRepairFixture> {
  const root = await mkdtemp(join(tmpdir(), definition.prefix));
  try {
    for (const [path, content] of Object.entries(definition.files)) {
      const parent = path.split("/").slice(0, -1).join("/");
      if (parent.length > 0) await mkdir(join(root, parent), { recursive: true });
      await writeFile(join(root, path), content, "utf8");
    }
    await runGit(root, ["init"]);
    await runGit(root, ["add", "."]);
    await runGit(root, [
      "-c",
      "user.name=Pi RLM Phase C Fixture",
      "-c",
      "user.email=patch-fixture@example.test",
      "commit",
      "-m",
      definition.prefix,
    ]);
    return {
      root,
      context: await loadGitDirectoryContext(root),
      question: definition.question,
      verificationProfile: definition.verificationProfile,
      nativeEdits: definition.nativeEdits,
      async cleanup(): Promise<void> {
        await rm(root, { recursive: true, force: true });
        try {
          await lstat(root);
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
            return;
          }
          throw error;
        }
        throw new Error("Phase C fixture temporary root cleanup could not be certified");
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function registrationContract(): string {
  return JSON.stringify({
    version: 1,
    factContract: {
      requirements: [{
        id: "registration",
        description: "The command registry contains the create command.",
        grounding: "quoted",
        minSupports: 1,
        extractor: {
          source: {
            kind: "search-open",
            literal: "export const commands",
            path: "src/registry.ts",
            before: 0,
            after: 2,
          },
          select: { kind: "contains-all", literals: ["create"] },
          capture: { kind: "quoted-string", index: 0 },
          reduce: { kind: "single", exactCount: 1 },
        },
      }],
      finalizer: { kind: "template", template: "registration={{registration}}" },
    },
    answerContract: {
      description: "Return the registered command.",
      pattern: "^registration=create$",
    },
  }, null, 2);
}

function wiringContract(): string {
  return JSON.stringify({
    version: 1,
    factContract: {
      requirements: [{
        id: "wiring",
        description: "The consumer reads the feature configuration.",
        grounding: "quoted",
        minSupports: 1,
        extractor: {
          source: {
            kind: "search-open",
            literal: "featureEnabled = featureConfig.enabled",
            path: "src/consumer.ts",
            before: 0,
            after: 0,
          },
          select: { kind: "contains-all", literals: ["featureEnabled = featureConfig.enabled"] },
          capture: { kind: "identifier-after", literal: "featureEnabled = " },
          reduce: { kind: "single", exactCount: 1 },
        },
      }],
      finalizer: { kind: "template", template: "wiring={{wiring}}" },
    },
    answerContract: {
      description: "Return the verified consumer wiring.",
      pattern: "^wiring=featureConfig.enabled$",
    },
  }, null, 2);
}

export function createRegistrationInsertionVerificationProfiles(): VerificationProfile[] {
  return [{
    name: REGISTRATION_INSERTION_PROFILE,
    steps: [
      { kind: "diff-policy" },
      { kind: "post-write-evidence" },
      {
        kind: "rlm-contract",
        name: "registration-insertion-contract",
        contractPath: ".rlm/registration-insertion-contract.v1.json",
        expectedAnswer: "registration=create",
        timeoutMs: 5_000,
        outputLimitBytes: 4_096,
      },
      {
        kind: "focused-check",
        name: "registration-insertion-runtime",
        trustedScript: "src/patch-registration-focused.ts",
        timeoutMs: 5_000,
        outputLimitBytes: 4_096,
      },
    ],
  }];
}

export function createTwoFileWiringVerificationProfiles(): VerificationProfile[] {
  return [{
    name: TWO_FILE_WIRING_PROFILE,
    steps: [
      { kind: "diff-policy" },
      { kind: "post-write-evidence" },
      {
        kind: "rlm-contract",
        name: "two-file-wiring-contract",
        contractPath: ".rlm/two-file-wiring-contract.v1.json",
        expectedAnswer: "wiring=featureConfig.enabled",
        timeoutMs: 5_000,
        outputLimitBytes: 4_096,
      },
      {
        kind: "focused-check",
        name: "two-file-wiring-runtime",
        trustedScript: "src/patch-two-file-focused.ts",
        timeoutMs: 5_000,
        outputLimitBytes: 4_096,
      },
    ],
  }];
}

export function createRegistrationInsertionFixture(): Promise<PhaseCRepairFixture> {
  return createFixture({
    prefix: "pi-rlm-registration-insertion-",
    question: REGISTRATION_INSERTION_QUESTION,
    verificationProfile: REGISTRATION_INSERTION_PROFILE,
    nativeEdits: REGISTRATION_INSERTION_TARGETS,
    files: {
      "src/registry.ts": [
        'export type CommandName = "inspect" | "create";',
        "",
        "export const commands: readonly CommandName[] = [",
        '  "inspect",',
        "];",
        "",
        "export function hasCommand(command: string): command is CommandName {",
        "  return commands.includes(command as CommandName);",
        "}",
        "",
      ].join("\n"),
      ".rlm/registration-insertion-contract.v1.json": `${registrationContract()}\n`,
    },
  });
}

export function createTwoFileWiringFixture(): Promise<PhaseCRepairFixture> {
  return createFixture({
    prefix: "pi-rlm-two-file-wiring-",
    question: TWO_FILE_WIRING_QUESTION,
    verificationProfile: TWO_FILE_WIRING_PROFILE,
    nativeEdits: TWO_FILE_WIRING_TARGETS,
    files: {
      "src/producer.ts": [
        "export interface FeatureConfiguration {",
        "  enabled: boolean;",
        "}",
        "",
        "export const featureConfig: FeatureConfiguration = {",
        "  enabled: false,",
        "};",
        "",
      ].join("\n"),
      "src/consumer.ts": [
        'import { featureConfig } from "./producer.ts";',
        "",
        "export const featureEnabled = false;",
        "",
      ].join("\n"),
      ".rlm/two-file-wiring-contract.v1.json": `${wiringContract()}\n`,
    },
  });
}
