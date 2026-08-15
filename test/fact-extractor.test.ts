import assert from "node:assert/strict";
import test from "node:test";

import {
  applyFactExtractor,
  FactExtractorError,
  validateFactExtractor,
} from "../src/fact-extractor.ts";
import type { PiRlmFactExtractor } from "../src/worker-protocol.ts";

const routerSource = [
  "func NewRouterWithConfig(cfg Config) http.Handler {",
  "\tfor _, mw := range cfg.Middlewares {",
  "\t\tr.Use(mw)",
  "\t}",
  "\tr.Get(\"/healthz\", health.Handler())",
  "\tr.Get(\"/readyz\", health.Handler())",
  "\tr.Group(func(api chi.Router) {",
  "\tapi.Use(middleware.Timeout(cfg.RequestTimeout))",
  "\tfor _, mount := range cfg.Mounts {",
  "\t\tmount(api)",
  "\t}",
  "\t})",
  "}",
  "func unrelated() {",
  "\tone()",
  "\ttwo()",
  "\tthree()",
  "\tfour()",
  "\tfive()",
  "\tsix()",
  "\tseven()",
  "}",
].join("\n");

const probesExtractor: PiRlmFactExtractor = {
  source: {
    kind: "symbol",
    name: "NewRouterWithConfig",
    before: 0,
    after: 80,
  },
  select: {
    kind: "contains-all",
    literals: ["r.Get(", "health.Handler()"],
  },
  capture: {
    kind: "quoted-string",
    index: 0,
  },
  reduce: {
    kind: "join",
    exactCount: 2,
    separator: ",",
  },
};

const timedExtractor: PiRlmFactExtractor = {
  source: {
    kind: "symbol",
    name: "NewRouterWithConfig",
    before: 0,
    after: 80,
  },
  scope: {
    afterLiteral: "api.Use(middleware.Timeout(cfg.RequestTimeout))",
    maxLines: 12,
    beforeLiteral: "\t})",
  },
  select: {
    kind: "contains-all",
    literals: ["range cfg."],
  },
  capture: {
    kind: "identifier-after",
    literal: "cfg.",
  },
  reduce: {
    kind: "single",
    exactCount: 1,
  },
};

const sseExtractor: PiRlmFactExtractor = {
  source: {
    kind: "search-open",
    literal: "SSEMounts:",
    path: "platform-api/cmd/server/main.go",
    before: 5,
    after: 12,
  },
  scope: {
    afterLiteral: "SSEMounts:",
    beforeLiteral: "},",
    maxLines: 8,
  },
  select: {
    kind: "identifier-chain-line",
    trailingDelimiter: ",",
  },
  capture: {
    kind: "identifier-chain",
    stripTrailingDelimiter: true,
  },
  reduce: {
    kind: "join",
    exactCount: 2,
    separator: ",",
  },
};

test("extracts ordered quoted paths with complete-line supports", () => {
  const result = applyFactExtractor(probesExtractor, routerSource);

  assert.equal(result.value, "/healthz,/readyz");
  assert.deepEqual(result.supportQuotes, [
    '\tr.Get("/healthz", health.Handler())',
    '\tr.Get("/readyz", health.Handler())',
  ]);
  assert.equal(result.selectedLineCount, 2);
  assert.equal(result.capturedValueCount, 2);
});

function quotedStringExtractor(index = 0): PiRlmFactExtractor {
  return {
    source: { kind: "symbol", name: "registry", before: 0, after: 20 },
    select: { kind: "contains-all", literals: ["entry"] },
    capture: { kind: "quoted-string", index },
    reduce: { kind: "single", exactCount: 1 },
  };
}

test("captures single- and double-quoted literals with escaped delimiters", () => {
  assert.equal(
    applyFactExtractor(
      quotedStringExtractor(),
      'const entry = "double \\"quote\\"";',
    ).value,
    'double "quote"',
  );
  assert.equal(
    applyFactExtractor(
      quotedStringExtractor(),
      "const entry = 'single \\'quote\\'';",
    ).value,
    "single 'quote'",
  );
});

test("captures a selected literal from mixed quote styles", () => {
  const source = 'const entry = ["inspect", \'create\', "delete"];';

  assert.equal(applyFactExtractor(quotedStringExtractor(1), source).value, "create");
});

test("fails closed for unterminated and mismatched quoted literals", () => {
  for (const source of [
    'const entry = "unterminated;',
    "const entry = 'mismatched\";",
    'const entry = "mismatched\';',
  ]) {
    assert.throws(
      () => applyFactExtractor(quotedStringExtractor(), source),
      (error: unknown) => {
        assert.ok(error instanceof FactExtractorError);
        assert.equal(error.code, "CAPTURE_FAILED");
        return true;
      },
    );
  }
});

test("scopes identifier capture after the timeout anchor", () => {
  const result = applyFactExtractor(timedExtractor, routerSource);

  assert.equal(result.value, "Mounts");
  assert.deepEqual(result.supportQuotes, ["\tfor _, mount := range cfg.Mounts {"]);
  assert.equal(result.scopedLineCount, 3);
});

test("extracts an ordered identifier-chain list from complete lines", () => {
  const source = [
    "SSEMounts: []server.RouteMounter{",
    "\tstreamHandler.Mount,",
    "\tdevWorkspaceHandler.MountProxy,",
    "},",
  ].join("\n");
  const result = applyFactExtractor(sseExtractor, source);

  assert.equal(
    result.value,
    "streamHandler.Mount,devWorkspaceHandler.MountProxy",
  );
  assert.deepEqual(result.supportQuotes, [
    "\tstreamHandler.Mount,",
    "\tdevWorkspaceHandler.MountProxy,",
  ]);
});

test("captures identifier chains after a bounded literal", () => {
  const extractor: PiRlmFactExtractor = {
    source: { kind: "symbol", name: "NewRootCmd", before: 0, after: 80 },
    select: { kind: "contains-all", literals: ["rootCmd.AddCommand("] },
    capture: { kind: "identifier-after", literal: "rootCmd.AddCommand(" },
    reduce: { kind: "join", exactCount: 2, separator: "," },
  };
  const source = [
    "rootCmd.AddCommand(cluster.NewClusterCmd())",
    "rootCmd.AddCommand(operatorcmd.NewOperatorCmd())",
  ].join("\n");

  assert.equal(
    applyFactExtractor(extractor, source).value,
    "cluster.NewClusterCmd,operatorcmd.NewOperatorCmd",
  );
});

test("captures a numeric token after a bounded literal", () => {
  const extractor: PiRlmFactExtractor = {
    source: { kind: "symbol", name: "limits", before: 0, after: 20 },
    select: { kind: "contains-all", literals: ["maxDepth:"] },
    capture: { kind: "number-after", literal: "maxDepth:" },
    reduce: { kind: "single", exactCount: 1 },
  };

  assert.equal(
    applyFactExtractor(extractor, "  maxDepth: 2,\n  maxTokens: 20_000,").value,
    "2",
  );
});

test("fails closed when source cardinality changes", () => {
  const source = [routerSource, '\tr.Get("/livez", health.Handler())'].join("\n");

  assert.throws(
    () => applyFactExtractor(probesExtractor, source),
    (error: unknown) => {
      assert.ok(error instanceof FactExtractorError);
      assert.equal(error.code, "CARDINALITY_MISMATCH");
      return true;
    },
  );
});

test("fails closed when a scope anchor is absent", () => {
  assert.throws(
    () => applyFactExtractor(timedExtractor, "for _, mount := range cfg.Mounts {}"),
    (error: unknown) => {
      assert.ok(error instanceof FactExtractorError);
      assert.equal(error.code, "SCOPE_NOT_FOUND");
      return true;
    },
  );
});

test("rejects duplicate captures instead of silently deduplicating", () => {
  const source = [
    "SSEMounts: []server.RouteMounter{",
    "\tstreamHandler.Mount,",
    "\tstreamHandler.Mount,",
    "},",
  ].join("\n");

  assert.throws(
    () => applyFactExtractor(sseExtractor, source),
    (error: unknown) => {
      assert.ok(error instanceof FactExtractorError);
      assert.equal(error.code, "CAPTURE_FAILED");
      return true;
    },
  );
});

test("validates bounded extractor contracts without arbitrary regex", () => {
  assert.deepEqual(validateFactExtractor(probesExtractor), probesExtractor);
  assert.deepEqual(
    validateFactExtractor({
      ...probesExtractor,
      reduce: { kind: "join", exactCount: 16, separator: "," },
    }),
    {
      ...probesExtractor,
      reduce: { kind: "join", exactCount: 16, separator: "," },
    },
  );
  assert.throws(
    () =>
      validateFactExtractor({
        ...probesExtractor,
        reduce: { kind: "join", exactCount: 17, separator: "," },
      }),
    /exactCount/u,
  );
  assert.throws(
    () =>
      validateFactExtractor({
        ...probesExtractor,
        select: { kind: "contains-all", literals: [] },
      }),
    /literals/u,
  );
});
