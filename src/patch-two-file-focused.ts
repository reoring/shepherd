#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { focusedProof, readFocusedChallenge } from "./patch-focused-proof.ts";
import {
  assertFeatureEnabledReadsFeatureConfig,
  typecheckCandidate,
} from "./patch-focused-typescript.ts";

const challenge = await readFocusedChallenge();
const candidateProducerPath = "/workspace/src/producer.ts";
const candidateConsumerPath = "/workspace/src/consumer.ts";
await typecheckCandidate([candidateProducerPath, candidateConsumerPath]);
assertFeatureEnabledReadsFeatureConfig(await readFile(candidateConsumerPath, "utf8"));
// Candidate modules exist only in the verifier's read-only mount, never in the host runtime.
const { featureConfig } = await import(candidateProducerPath);
const { featureEnabled } = await import(candidateConsumerPath);
if (featureConfig.enabled !== true || featureEnabled !== true) {
  throw new Error("Focused two-file wiring assertion failed");
}
process.stdout.write(focusedProof(challenge));
