#!/usr/bin/env node
import { focusedProof, readFocusedChallenge } from "./patch-focused-proof.ts";
import { typecheckCandidate } from "./patch-focused-typescript.ts";

const challenge = await readFocusedChallenge();
const candidateRegistryPath = "/workspace/src/registry.ts";
await typecheckCandidate([candidateRegistryPath]);
// Candidate modules exist only in the verifier's read-only mount, never in the host runtime.
const { commands, hasCommand } = await import(candidateRegistryPath);
if (!commands.includes("create") || !hasCommand("create")) {
  throw new Error("Focused command registration assertion failed");
}
process.stdout.write(focusedProof(challenge));
