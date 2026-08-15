#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { runRlmContractCheck } from "./contract-check.ts";
import { parseRlmContractFile } from "./contract-file.ts";
import type { FileIndexedContext } from "./file-context.ts";
import { createFileIndexedContext } from "./file-context.ts";

interface CandidateManifestFile {
  path: string;
  sha256: string;
  mode: number;
}

interface CandidateManifest {
  version: 1;
  sourceRevision: string;
  files: readonly CandidateManifestFile[];
}

function canonicalRelativePath(path: unknown, subject: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    throw new Error(`${subject} must be a canonical relative path`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`${subject} must be a canonical relative path`);
  }
  return path;
}

function parseManifest(value: unknown): CandidateManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Candidate manifest must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.sourceRevision !== "string" ||
    record.sourceRevision.length === 0 ||
    !Array.isArray(record.files)
  ) {
    throw new Error("Candidate manifest has an invalid shape");
  }
  const files = record.files.map((value, index): CandidateManifestFile => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Candidate manifest file ${index} must be an object`);
    }
    const file = value as Record<string, unknown>;
    const path = canonicalRelativePath(file.path, `Candidate manifest file ${index} path`);
    if (
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(file.sha256) ||
      !Number.isInteger(file.mode) ||
      Number(file.mode) < 0 ||
      Number(file.mode) > 0o777
    ) {
      throw new Error(`Candidate manifest file ${index} is invalid`);
    }
    return { path, sha256: file.sha256, mode: Number(file.mode) };
  });
  const sortedPaths = files.map((file) => file.path).toSorted((left, right) => left.localeCompare(right));
  if (
    files.length === 0 ||
    files.some((file, index) => file.path !== sortedPaths[index]) ||
    new Set(sortedPaths).size !== sortedPaths.length
  ) {
    throw new Error("Candidate manifest file paths must be unique and sorted");
  }
  return { version: 1, sourceRevision: record.sourceRevision, files };
}

function isInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
}

async function walkCandidateFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    if (directory === root && entry.name === ".git") continue;
    const absolutePath = resolve(directory, entry.name);
    if (!isInside(root, absolutePath)) throw new Error("Candidate path escapes its root");
    if (entry.isDirectory()) {
      paths.push(...await walkCandidateFiles(root, absolutePath));
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("Candidate contains a non-regular or symbolic-link file");
    }
    paths.push(relative(root, absolutePath).split(sep).join("/"));
  }
  return paths.toSorted((left, right) => left.localeCompare(right));
}

async function loadVerifiedCandidate(
  candidateRoot: string,
  manifest: CandidateManifest,
): Promise<FileIndexedContext> {
  const rootInfo = await lstat(candidateRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Candidate root must be a regular directory");
  }
  const actualPaths = await walkCandidateFiles(candidateRoot);
  const manifestPaths = manifest.files.map((file) => file.path);
  if (
    actualPaths.length !== manifestPaths.length ||
    actualPaths.some((path, index) => path !== manifestPaths[index])
  ) {
    throw new Error("Candidate path set does not match the host manifest");
  }

  const files: Array<{ path: string; content: string }> = [];
  for (const expected of manifest.files) {
    const candidatePath = resolve(candidateRoot, expected.path);
    if (!isInside(candidateRoot, candidatePath)) {
      throw new Error("Candidate manifest path escapes its root");
    }
    const info = await lstat(candidatePath);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== expected.mode) {
      throw new Error("Candidate file kind or mode does not match the host manifest");
    }
    const bytes = await readFile(candidatePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== expected.sha256) {
      throw new Error("Candidate file content does not match the host manifest");
    }
    files.push({ path: expected.path, content: bytes.toString("utf8") });
  }
  return createFileIndexedContext(files, { sourceRevision: manifest.sourceRevision });
}

async function run(args: readonly string[]): Promise<number> {
  if (args.length !== 3) {
    throw new Error("Usage: patch-contract-check <candidate-dir> <manifest.json> <contract.json>");
  }
  const [candidateDirectory, manifestPath, contractPath] = args;
  if (!candidateDirectory || !manifestPath || !contractPath) {
    throw new Error("Usage: patch-contract-check <candidate-dir> <manifest.json> <contract.json>");
  }
  const candidateRoot = resolve(candidateDirectory);
  const manifest = parseManifest(JSON.parse(await readFile(resolve(manifestPath), "utf8")));
  const context = await loadVerifiedCandidate(candidateRoot, manifest);
  const contract = parseRlmContractFile(await readFile(resolve(contractPath), "utf8"));
  const result = await runRlmContractCheck(context, contract, { isolation: { mode: "subprocess" } });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.status === "passed" ? 0 : 1;
}

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
