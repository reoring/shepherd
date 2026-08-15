import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import test from "node:test";

import { captureHarnessSource } from "../src/harness-provenance.ts";

test("harness provenance deterministically binds source, tests, and dependency lock", async () => {
  const packageRoot = await realpath(process.cwd());
  const first = await captureHarnessSource(packageRoot);
  const second = await captureHarnessSource(packageRoot);

  assert.match(first.identity.gitCommit, /^[0-9a-f]{40}$/u);
  assert.match(first.identity.manifestSha256, /^[0-9a-f]{64}$/u);
  assert.match(first.identity.packageLockSha256, /^[0-9a-f]{64}$/u);
  assert.match(first.identity.snapshotSha256, /^[0-9a-f]{64}$/u);
  assert.equal(first.identity.manifestSha256, second.identity.manifestSha256);
  assert.equal(first.identity.snapshotSha256, second.identity.snapshotSha256);
  assert.deepEqual(first.manifest, second.manifest);
  assert.deepEqual(
    first.snapshot.map((entry) => entry.path),
    [...first.snapshot.map((entry) => entry.path)].sort(),
  );
  assert.ok(first.snapshot.some((entry) => entry.path === "src/runner.ts"));
  assert.ok(first.snapshot.some((entry) => entry.path === "test/indexed-context.test.ts"));
  assert.ok(first.snapshot.some((entry) => entry.path === "package-lock.json"));
  assert.equal(
    first.snapshot.some(
      (entry) => entry.path.includes("node_modules") || entry.path.includes("results.json"),
    ),
    false,
  );
  for (const entry of first.snapshot) {
    assert.equal(Buffer.byteLength(entry.content, "utf8"), entry.bytes);
    assert.equal(createHash("sha256").update(entry.content).digest("hex"), entry.sha256);
  }
});
