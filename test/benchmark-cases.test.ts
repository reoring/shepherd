import assert from "node:assert/strict";
import test from "node:test";

import {
  createMatchedBenchmarkCases,
  isExactBenchmarkAnswer,
} from "../src/benchmark-cases.ts";

test("matched benchmark cases use the same question and exactly one expected needle", () => {
  const cases = createMatchedBenchmarkCases();
  assert.equal(cases.length, 2);
  assert.equal(new Set(cases.map((benchmarkCase) => benchmarkCase.question)).size, 1);

  for (const benchmarkCase of cases) {
    const needle = `NEEDLE_TOKEN=${benchmarkCase.expected}`;
    assert.equal(benchmarkCase.content.split(needle).length - 1, 1);
  }
  assert.ok(cases[1]!.content.length > cases[0]!.content.length * 100);
});

test("benchmark correctness requires the exact requested answer", () => {
  assert.equal(isExactBenchmarkAnswer("EXPECTED\n", "EXPECTED"), true);
  assert.equal(isExactBenchmarkAnswer("The answer is EXPECTED", "EXPECTED"), false);
});
