import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  renderRlmContractCheckResult,
  runRlmContractCheck,
} from "../src/contract-check.ts";
import {
  parseRlmContractFile,
  type RlmContractFile,
} from "../src/contract-file.ts";
import {
  createFileIndexedContext,
  loadGitDirectoryContext,
} from "../src/file-context.ts";

const contractFile: RlmContractFile = {
  version: 1,
  factContract: {
    requirements: [
      {
        id: "value",
        description: "Exact value returned by Target.",
        grounding: "quoted",
        minSupports: 1,
        extractor: {
          source: { kind: "symbol", name: "Target", before: 0, after: 5 },
          select: { kind: "contains-all", literals: ["CHECK_OK"] },
          capture: { kind: "quoted-string", index: 0 },
          reduce: { kind: "single", exactCount: 1 },
        },
      },
    ],
    finalizer: { kind: "template", template: "value={{value}}" },
  },
  answerContract: {
    description: "Return one value assignment.",
    pattern: "^value=[A-Z_]+$",
  },
};

test("checks extraction, grounding, finalization, and answer pattern with zero model calls", async () => {
  const context = createFileIndexedContext([
    {
      path: "src/value.ts",
      content: [
        "export function Target(): string {",
        '  return "CHECK_OK";',
        "}",
      ].join("\n"),
    },
  ]);

  const result = await runRlmContractCheck(context, contractFile, {
    isolation: { mode: "subprocess" },
  });

  assert.equal(result.status, "passed");
  assert.equal(result.modelCalls, 0);
  assert.equal(result.answer, "value=CHECK_OK");
  assert.equal(result.answerPattern, "passed");
  assert.equal(result.runtimeFinalized, true);
  assert.equal(result.corpusActions, 2);
  assert.deepEqual(result.facts, [
    {
      factId: "value",
      status: "grounded",
      value: "CHECK_OK",
      evidenceIds: [result.facts[0]!.evidenceIds[0]!],
      extractionStatus: "grounded",
      sourcePath: "src/value.ts",
      selectedLines: 1,
      capturedValues: 1,
    },
  ]);
  assert.match(
    renderRlmContractCheckResult("fixture.json", result),
    /PASS fixture\.json[\s\S]*model calls: 0/u,
  );
});

test("reports deterministic source drift without guessing or model calls", async () => {
  const context = createFileIndexedContext([
    {
      path: "src/value.ts",
      content: [
        "export function Target(): string {",
        '  return "CHANGED";',
        "}",
      ].join("\n"),
    },
  ]);

  const result = await runRlmContractCheck(context, contractFile, {
    isolation: { mode: "subprocess" },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.modelCalls, 0);
  assert.equal(result.answer, undefined);
  assert.equal(result.answerPattern, "failed");
  assert.equal(result.runtimeFinalized, false);
  assert.deepEqual(result.facts, [
    {
      factId: "value",
      status: "pending",
      evidenceIds: [],
      extractionStatus: "failed",
      failureCode: "CARDINALITY_MISMATCH",
      sourcePath: "src/value.ts",
      selectedLines: 0,
      capturedValues: 0,
    },
  ]);
  assert.match(
    renderRlmContractCheckResult("fixture.json", result),
    /FAIL fixture\.json[\s\S]*CARDINALITY_MISMATCH/u,
  );
});

test("the shipped contract grounds the native query entrypoint", async () => {
  const repositoryRoot = new URL("../", import.meta.url);
  const contract = parseRlmContractFile(
    await readFile(
      new URL("examples/contracts/exact-source-value.v1.json", repositoryRoot),
      "utf8",
    ),
  );
  const context = await loadGitDirectoryContext(fileURLToPath(repositoryRoot));

  const result = await runRlmContractCheck(context, contract, {
    isolation: { mode: "subprocess" },
  });

  assert.equal(result.status, "passed");
  assert.equal(result.modelCalls, 0);
  assert.equal(result.answer, "query-entrypoint=./sheperd-cli.ts");
  assert.equal(result.answerPattern, "passed");
  assert.equal(result.runtimeFinalized, true);
});
