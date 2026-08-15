import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import test from "node:test";

import {
  createFileIndexedContext,
  createFileIndexedEvidenceSession,
} from "../src/file-context.ts";
import {
  createRegistrationInsertionFixture,
  createRegistrationInsertionVerificationProfiles,
  createTwoFileWiringFixture,
  createTwoFileWiringVerificationProfiles,
  REGISTRATION_INSERTION_QUESTION,
  REGISTRATION_INSERTION_TARGETS,
  TWO_FILE_WIRING_TARGETS,
} from "../src/patch-phase-c-fixtures.ts";
import {
  buildNativeEditsPatchPlan,
  nativeEditTargetMetadata,
  nativeEditTargetSummary,
  requiresLeadingNewlineSeparator,
  requiresTerminalNewline,
  resolveNativeEditTargets,
} from "../src/native-edits.ts";
import type {
  NativePatchEditTarget,
  PreparedNativePatchEdit,
} from "../src/native-edits.ts";
import { derivePatchPrecondition, hashPatchSpan } from "../src/patch-plan.ts";

function prepareTargets(
  context: Parameters<typeof createFileIndexedEvidenceSession>[0],
  targets: readonly NativePatchEditTarget[],
): PreparedNativePatchEdit[] {
  const evidence = createFileIndexedEvidenceSession(context);
  evidence.beginTurn();
  return targets.map((target) => {
    const slice = evidence.readLines(target.path, target.startLine, target.endLine);
    evidence.observe([slice.id]);
    return {
      target,
      currentText: slice.text,
      requiresLeadingNewlineSeparator: requiresLeadingNewlineSeparator(
        context.read(target.path),
        target,
      ),
      requiresTerminalNewline: requiresTerminalNewline(context.read(target.path), target),
      evidenceId: slice.id,
      precondition: derivePatchPrecondition(context, evidence, {
        path: target.path,
        evidenceId: slice.id,
        operation: target.operation,
        startLine: target.startLine,
        endLine: target.endLine,
      }),
    };
  });
}

test("registration insertion binds the anchor hash and insertion range before a replacement exists", async () => {
  const fixture = await createRegistrationInsertionFixture();
  try {
    const [target] = REGISTRATION_INSERTION_TARGETS;
    assert.ok(target);
    const [prepared] = prepareTargets(fixture.context, [target]);
    assert.ok(prepared);
    assert.equal(prepared.precondition.operation, "insert-before");
    assert.equal(prepared.precondition.startLine, 5);
    assert.equal(prepared.precondition.endLine, 5);
    assert.equal(
      prepared.precondition.expectedOldHash,
      hashPatchSpan(fixture.context.read("src/registry.ts"), "insert-before", 5, 5),
    );
    const plan = buildNativeEditsPatchPlan(
      "Register the create command.",
      [target],
      [prepared],
      [{ id: target.id, replacement: '  "create",\n' }],
    );
    assert.deepEqual(plan.edits, [{
      path: "src/registry.ts",
      evidenceId: prepared.evidenceId,
      expectedOldHash: prepared.precondition.expectedOldHash,
      operation: "insert-before",
      startLine: 5,
      endLine: 5,
      replacement: '  "create",\n',
    }]);
  } finally {
    await fixture.cleanup();
  }
});

test("registration fixture specifies insertion syntax without embedding the expected replacement", () => {
  assert.match(REGISTRATION_INSERTION_QUESTION, /quoted string-literal entry/u);
  assert.doesNotMatch(REGISTRATION_INSERTION_QUESTION, /"create",/u);
});

test("registration insertion rejects anchor copies and unterminated replacement text before executor submission", async () => {
  const fixture = await createRegistrationInsertionFixture();
  try {
    const [target] = REGISTRATION_INSERTION_TARGETS;
    assert.ok(target);
    const [prepared] = prepareTargets(fixture.context, [target]);
    assert.ok(prepared);
    assert.throws(
      () => buildNativeEditsPatchPlan(
        "Register the create command.",
        [target],
        [prepared],
        [{ id: target.id, replacement: '  "create",' }],
      ),
      /must end with a newline/u,
    );
    assert.throws(
      () => buildNativeEditsPatchPlan(
        "Register the create command.",
        [target],
        [prepared],
        [{ id: target.id, replacement: `${prepared.currentText.trimEnd()}\n` }],
      ),
      /must contain only new text/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("replace ranges require a terminal newline only when their exact host span has one", () => {
  const terminatedContext = createFileIndexedContext([{
    path: "src/config.ts",
    content: "first\nsecond\nthird",
  }]);
  const multilineTarget: NativePatchEditTarget = {
    id: "replace-first-two",
    path: "src/config.ts",
    operation: "replace-range",
    startLine: 1,
    endLine: 2,
  };
  const [terminatedPrepared] = prepareTargets(terminatedContext, [multilineTarget]);
  assert.ok(terminatedPrepared);
  assert.equal(terminatedPrepared.requiresTerminalNewline, true);
  assert.throws(
    () => buildNativeEditsPatchPlan(
      "Replace the first two lines.",
      [multilineTarget],
      [terminatedPrepared],
      [{ id: multilineTarget.id, replacement: "updated first\nupdated second" }],
    ),
    /must end with a newline/u,
  );
  const multilinePlan = buildNativeEditsPatchPlan(
    "Replace the first two lines.",
    [multilineTarget],
    [terminatedPrepared],
    [{ id: multilineTarget.id, replacement: "updated first\nupdated second\n" }],
  );
  assert.equal(multilinePlan.edits[0]?.replacement, "updated first\nupdated second\n");

  const eofContext = createFileIndexedContext([{
    path: "src/config.ts",
    content: "first\nsecond",
  }]);
  const eofTarget: NativePatchEditTarget = {
    id: "replace-eof",
    path: "src/config.ts",
    operation: "replace-range",
    startLine: 2,
    endLine: 2,
  };
  const [eofPrepared] = prepareTargets(eofContext, [eofTarget]);
  assert.ok(eofPrepared);
  assert.equal(eofPrepared.requiresTerminalNewline, false);
  const eofPlan = buildNativeEditsPatchPlan(
    "Replace the EOF line.",
    [eofTarget],
    [eofPrepared],
    [{ id: eofTarget.id, replacement: "updated second" }],
  );
  assert.equal(eofPlan.edits[0]?.replacement, "updated second");
});

test("insert-after at an unterminated EOF anchor requires a host-derived leading separator", () => {
  const eofContext = createFileIndexedContext([{
    path: "src/registry.ts",
    content: "first\nsecond",
  }]);
  const eofTarget: NativePatchEditTarget = {
    id: "insert-after-eof",
    path: "src/registry.ts",
    operation: "insert-after",
    startLine: 2,
    endLine: 2,
  };
  const [eofPrepared] = prepareTargets(eofContext, [eofTarget]);
  assert.ok(eofPrepared);
  assert.equal(eofPrepared.requiresLeadingNewlineSeparator, true);
  assert.throws(
    () => buildNativeEditsPatchPlan(
      "Insert a new entry.",
      [eofTarget],
      [eofPrepared],
      [{ id: eofTarget.id, replacement: "third\n" }],
    ),
    /must start with a newline separator/u,
  );
  const eofPlan = buildNativeEditsPatchPlan(
    "Insert a new entry.",
    [eofTarget],
    [eofPrepared],
    [{ id: eofTarget.id, replacement: "\nthird\n" }],
  );
  assert.equal(eofPlan.edits[0]?.replacement, "\nthird\n");

  const terminatedContext = createFileIndexedContext([{
    path: "src/registry.ts",
    content: "first\nsecond\n",
  }]);
  const [terminatedPrepared] = prepareTargets(terminatedContext, [eofTarget]);
  assert.ok(terminatedPrepared);
  assert.equal(terminatedPrepared.requiresLeadingNewlineSeparator, false);
  assert.equal(
    buildNativeEditsPatchPlan(
      "Insert a new entry.",
      [eofTarget],
      [terminatedPrepared],
      [{ id: eofTarget.id, replacement: "third\n" }],
    ).edits[0]?.replacement,
    "third\n",
  );
});

test("native-edits requires every host ID exactly once and preserves cross-file evidence", async () => {
  const fixture = await createTwoFileWiringFixture();
  try {
    const prepared = prepareTargets(fixture.context, TWO_FILE_WIRING_TARGETS);
    assert.equal(new Set(prepared.map((entry) => entry.evidenceId)).size, 2);
    assert.deepEqual(prepared.map((entry) => entry.target.path).sort(), [
      "src/consumer.ts",
      "src/producer.ts",
    ]);
    const plan = buildNativeEditsPatchPlan(
      "Enable and wire the feature.",
      TWO_FILE_WIRING_TARGETS,
      prepared,
      [
        { id: "wire-feature-consumer", replacement: "export const featureEnabled = featureConfig.enabled;\n" },
        { id: "enable-feature-config", replacement: "  enabled: true,\n" },
      ],
    );
    assert.deepEqual(plan.edits.map((edit) => ({
      path: edit.path,
      operation: edit.operation,
      startLine: edit.startLine,
      endLine: edit.endLine,
      evidenceId: edit.evidenceId,
    })), prepared.map((entry) => ({
      path: entry.target.path,
      operation: entry.target.operation,
      startLine: entry.target.startLine,
      endLine: entry.target.endLine,
      evidenceId: entry.evidenceId,
    })));

    assert.throws(
      () => buildNativeEditsPatchPlan(
        "Reject comment imitations before execution.",
        TWO_FILE_WIRING_TARGETS,
        prepared,
        [
          { id: "enable-feature-config", replacement: "  // enabled: true,\n" },
          {
            id: "wire-feature-consumer",
            replacement: "// export const featureEnabled = featureConfig.enabled;\n",
          },
        ],
      ),
      /does not satisfy its host replacement constraint/u,
    );

    assert.throws(
      () => buildNativeEditsPatchPlan(
        "Reject consumer comment imitation before execution.",
        TWO_FILE_WIRING_TARGETS,
        prepared,
        [
          { id: "enable-feature-config", replacement: "  enabled: true,\n" },
          {
            id: "wire-feature-consumer",
            replacement: "// export const featureEnabled = featureConfig.enabled;\n",
          },
        ],
      ),
      /does not satisfy its host replacement constraint/u,
    );
    const whitespaceVariant = buildNativeEditsPatchPlan(
      "Accept whitespace-preserving executable replacements.",
      TWO_FILE_WIRING_TARGETS,
      prepared,
      [
        { id: "enable-feature-config", replacement: "    enabled  :  true , \n" },
        {
          id: "wire-feature-consumer",
          replacement: " export   const  featureEnabled = featureConfig.enabled ;\n",
        },
      ],
    );
    assert.deepEqual(
      whitespaceVariant.edits.map((edit) => edit.replacement),
      [
        "    enabled  :  true , \n",
        " export   const  featureEnabled = featureConfig.enabled ;\n",
      ],
    );

    assert.throws(
      () => buildNativeEditsPatchPlan(
        "Duplicate IDs are rejected.",
        TWO_FILE_WIRING_TARGETS,
        prepared,
        [
          { id: "enable-feature-config", replacement: "  enabled: true,\n" },
          { id: "enable-feature-config", replacement: "export const featureEnabled = featureConfig.enabled;\n" },
        ],
      ),
      /duplicate target id/u,
    );
    assert.throws(
      () => buildNativeEditsPatchPlan(
        "Missing IDs are rejected.",
        TWO_FILE_WIRING_TARGETS,
        prepared,
        [{ id: "enable-feature-config", replacement: "  enabled: true,\n" }],
      ),
      /exactly one replacement/u,
    );
    assert.throws(
      () => buildNativeEditsPatchPlan(
        "Extra IDs are rejected.",
        TWO_FILE_WIRING_TARGETS,
        prepared,
        [
          { id: "enable-feature-config", replacement: "  enabled: true,\n" },
          { id: "foreign-target", replacement: "export const featureEnabled = featureConfig.enabled;\n" },
        ],
      ),
      /unknown target id/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("Phase C fixture cleanup certifies removal of each exact temporary root", async () => {
  for (const createFixture of [
    createRegistrationInsertionFixture,
    createTwoFileWiringFixture,
  ]) {
    const fixture = await createFixture();
    const root = fixture.root;
    try {
      await fixture.cleanup();
      await assert.rejects(() => lstat(root), { code: "ENOENT" });
    } finally {
      await fixture.cleanup();
    }
  }
});

test("native-replacement remains a strict one-edit adapter without accepting native-edits", () => {
  const targets = resolveNativeEditTargets(
    "native-replacement",
    undefined,
    { path: "src/config.ts", startLine: 6, endLine: 6 },
  );
  assert.deepEqual(targets, [{
    id: "native-replacement",
    path: "src/config.ts",
    operation: "replace-range",
    startLine: 6,
    endLine: 6,
  }]);
  assert.throws(
    () => resolveNativeEditTargets("native-edits", undefined, undefined),
    /requires exact host nativeEdits/u,
  );
});

test("Phase C fixtures bind their source contracts and trusted TypeScript runtime checks", () => {
  const [registration] = createRegistrationInsertionVerificationProfiles();
  const [wiring] = createTwoFileWiringVerificationProfiles();
  assert.equal(registration?.steps[2].contractPath, ".rlm/registration-insertion-contract.v1.json");
  assert.equal(registration?.steps[3].trustedScript, "src/patch-registration-focused.ts");
  assert.equal(wiring?.steps[2].contractPath, ".rlm/two-file-wiring-contract.v1.json");
  assert.equal(wiring?.steps[3].trustedScript, "src/patch-two-file-focused.ts");
});

test("Phase C target metadata serializes constraint identity without its host-only regex", () => {
  const [producer, consumer] = TWO_FILE_WIRING_TARGETS;
  assert.ok(producer);
  assert.ok(consumer);
  const metadata = [producer, consumer].map((target) => nativeEditTargetMetadata(target));
  const summary = nativeEditTargetSummary(TWO_FILE_WIRING_TARGETS);
  const serialized = JSON.stringify(metadata);

  assert.deepEqual(
    metadata.map((target) => target.replacementConstraint?.description),
    [
      "Replacement must be one executable enabled: true property line.",
      "Replacement must directly export featureEnabled from featureConfig.enabled.",
    ],
  );
  assert.equal(metadata.every((target) => /^[a-f0-9]{64}$/u.test(target.replacementConstraint?.digest ?? "")), true);
  assert.equal(serialized.includes("\\\\s*enabled"), false);
  assert.equal(summary.includes("\\\\s*enabled"), false);
});
