#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { focusedProof, readFocusedChallenge } from "./patch-focused-proof.ts";

const CANDIDATE_ROOT = "/workspace";
const ORACLE_CONTRACT = "/workspace/.rlm/seeded-repair-oracle.v1.json";
const SHA256 = /^[a-f0-9]{64}$/u;

function canonicalCandidatePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error("Seeded oracle source path is invalid");
  }
  return value;
}

const challenge = await readFocusedChallenge();
const contract = JSON.parse(await readFile(ORACLE_CONTRACT, "utf8")) as {
  version?: unknown;
  sourcePath?: unknown;
  oracleSha256?: unknown;
};
if (
  contract.version !== 1 ||
  typeof contract.oracleSha256 !== "string" ||
  !SHA256.test(contract.oracleSha256)
) {
  throw new Error("Seeded oracle contract is invalid");
}
const sourcePath = canonicalCandidatePath(contract.sourcePath);
const candidatePath = resolve(CANDIDATE_ROOT, sourcePath);
const child = relative(CANDIDATE_ROOT, candidatePath);
if (child === "" || child.startsWith(`..${sep}`) || child === ".." || isAbsolute(child)) {
  throw new Error("Seeded oracle source path escapes the candidate root");
}
const candidate = await readFile(candidatePath, "utf8");
const candidateSha256 = createHash("sha256").update(candidate, "utf8").digest("hex");
if (candidateSha256 !== contract.oracleSha256) {
  throw new Error("Seeded repair candidate does not match the original oracle");
}
process.stdout.write(focusedProof(challenge));
