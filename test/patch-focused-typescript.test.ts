import assert from "node:assert/strict";
import test from "node:test";

import { assertFeatureEnabledReadsFeatureConfig } from "../src/patch-focused-typescript.ts";

test("two-file focused verifier accepts only the executable featureConfig property access", () => {
  assert.doesNotThrow(() => assertFeatureEnabledReadsFeatureConfig([
    'import { featureConfig } from "./producer.ts";',
    "export const featureEnabled = featureConfig.enabled;",
  ].join("\n")));
});

test("two-file focused verifier rejects a comment that imitates the required wiring", () => {
  assert.throws(
    () => assertFeatureEnabledReadsFeatureConfig([
      'import { featureConfig } from "./producer.ts";',
      "// export const featureEnabled = featureConfig.enabled;",
      "export const featureEnabled = true;",
    ].join("\n")),
    /must export featureEnabled = featureConfig\.enabled/u,
  );
});

test("two-file focused verifier rejects syntactically invalid consumer source", () => {
  assert.throws(
    () => assertFeatureEnabledReadsFeatureConfig([
      'import { featureConfig } from "./producer.ts";',
      "export const featureEnabled = ;",
    ].join("\n")),
    /Focused consumer TypeScript parse failed/u,
  );
});
