#!/usr/bin/env node
import { focusedProof, readFocusedChallenge } from "./patch-focused-proof.ts";
import { typecheckCandidate } from "./patch-focused-typescript.ts";

const challenge = await readFocusedChallenge();
if (challenge.profile === "fixture-fails") process.exit(7);
if (challenge.profile === "fixture-empty-output") process.exit(0);
if (challenge.profile === "fixture-timeout") {
  const never = Promise.withResolvers<never>();
  setInterval(() => undefined, 60_000);
  await never.promise;
}

// Candidate source exists only inside the read-only verification mount. The
// compiler is resolved relative to this trusted script, never the candidate.
// This import must stay dynamic because the candidate mount is absent on host.
const candidateConfigPath = "/workspace/src/config.ts";
const candidateModulePath = "/workspace/src/consumer.ts";
await typecheckCandidate([candidateConfigPath, candidateModulePath]);
const { usesTimeout } = await import(candidateModulePath);
if (usesTimeout !== 20) throw new Error("Focused timeout consumer assertion failed");
process.stdout.write(focusedProof(challenge));
