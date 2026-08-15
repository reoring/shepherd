import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { parseRlmContractFile } from "../src/contract-file.ts";

const validContract = {
  version: 1,
  factContract: {
    requirements: [
      {
        id: "value",
        description: "Exact source value.",
        grounding: "quoted",
        minSupports: 1,
        extractor: {
          source: { kind: "symbol", name: "Target", before: 0, after: 20 },
          select: { kind: "contains-all", literals: ["VALUE="] },
          capture: { kind: "quoted-string", index: 0 },
          reduce: { kind: "single", exactCount: 1 },
        },
      },
    ],
    finalizer: { kind: "template", template: "value={{value}}" },
  },
  answerContract: {
    description: "Return one value assignment.",
    pattern: "^value=.+$",
  },
};

test("parses a strict versioned RLM contract file", () => {
  assert.deepEqual(
    parseRlmContractFile(JSON.stringify(validContract)),
    validContract,
  );
});

test("rejects unsupported versions, unknown fields, and invalid answer patterns", () => {
  assert.throws(
    () => parseRlmContractFile(JSON.stringify({ ...validContract, version: 2 })),
    /version must be 1/u,
  );
  assert.throws(
    () =>
      parseRlmContractFile(
        JSON.stringify({ ...validContract, unexpected: true }),
      ),
    /unknown field: contract\.unexpected/u,
  );
  assert.throws(
    () =>
      parseRlmContractFile(
        JSON.stringify({
          ...validContract,
          factContract: {
            ...validContract.factContract,
            requirements: [
              {
                ...validContract.factContract.requirements[0],
                unexpected: true,
              },
            ],
          },
        }),
      ),
    /unknown field: contract\.factContract\.requirements\[0\]\.unexpected/u,
  );
  assert.throws(
    () =>
      parseRlmContractFile(
        JSON.stringify({
          ...validContract,
          answerContract: {
            description: "Invalid regex.",
            pattern: "[",
          },
        }),
      ),
    /answerContract pattern is invalid/u,
  );
});

test("rejects oversized or malformed JSON before model execution", () => {
  assert.throws(() => parseRlmContractFile("{"), /valid JSON/u);
  assert.throws(
    () => parseRlmContractFile(`{"padding":"${"x".repeat(256 * 1024)}"}`),
    /exceeds 262144 bytes/u,
  );
});

test("parses the shipped versioned contract example", async () => {
  const text = await readFile(
    new URL("../examples/contracts/exact-source-value.v1.json", import.meta.url),
    "utf8",
  );
  assert.equal(parseRlmContractFile(text).version, 1);
});
