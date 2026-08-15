import assert from "node:assert/strict";
import test from "node:test";

import {
  renderFactFinalizer,
  validateFactFinalizer,
} from "../src/fact-finalizer.ts";
import type {
  PiRlmFactContract,
  PiRlmFactStateSnapshot,
} from "../src/worker-protocol.ts";

const contract: PiRlmFactContract = {
  requirements: [
    {
      id: "left",
      description: "Left value.",
      grounding: "quoted",
      minSupports: 1,
    },
    {
      id: "right",
      description: "Right value.",
      grounding: "quoted",
      minSupports: 1,
    },
  ],
  finalizer: {
    kind: "template",
    template: "left={{left}}|right={{right}}",
  },
};

function factState(
  values: Readonly<Record<string, string>>,
  pendingFactIds: readonly string[] = [],
): PiRlmFactStateSnapshot {
  return {
    sourceRevision: "fixture",
    facts: [],
    values,
    pendingFactIds,
    factsById: {},
  };
}

test("renders an exact declared template only after all facts are grounded", () => {
  assert.deepEqual(validateFactFinalizer(contract), contract.finalizer);
  assert.equal(
    renderFactFinalizer(contract, factState({ left: "$&", right: "OK" })),
    "left=$&|right=OK",
  );
  assert.equal(
    renderFactFinalizer(
      contract,
      factState({ left: "$&" }, ["right"]),
    ),
    undefined,
  );
});

test("rejects finalizer templates that do not map required facts exactly once", () => {
  assert.throws(
    () =>
      validateFactFinalizer({
        ...contract,
        finalizer: { kind: "template", template: "left={{left}}" },
      }),
    /missing required fact placeholder: right/u,
  );
  assert.throws(
    () =>
      validateFactFinalizer({
        ...contract,
        finalizer: {
          kind: "template",
          template: "left={{left}}|right={{right}}|extra={{unknown}}",
        },
      }),
    /unknown fact placeholder: unknown/u,
  );
  assert.throws(
    () =>
      validateFactFinalizer({
        ...contract,
        finalizer: {
          kind: "template",
          template: "left={{left}}|again={{left}}|right={{right}}",
        },
      }),
    /duplicate fact placeholder: left/u,
  );
  assert.throws(
    () =>
      validateFactFinalizer({
        ...contract,
        finalizer: {
          kind: "template",
          template: "left={{left}|right={{right}}",
        },
      }),
    /malformed fact placeholder/u,
  );
});
