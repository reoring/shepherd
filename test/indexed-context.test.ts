import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";

import {
  beginIndexedObservationTurn,
  createFileIndexedContext,
  createFileIndexedEvidenceSession,
  findIndexedSymbol,
  loadGitDirectoryContext,
  loadIndexedPathContext,
  observeIndexedEvidence,
  openIndexedMatch,
  readIndexedFile,
  readIndexedLines,
  searchIndexedFiles,
} from "../src/file-context.ts";
import { PiRlmRunError, PiRlmRunner } from "../src/runner.ts";
import { createQueryEvidenceReceipt } from "../src/query-command.ts";
import type { PiRlmFactStateSnapshot } from "../src/worker-protocol.ts";
import { createFauxRuntime } from "./faux-runtime.ts";
function runGit(cwd: string, args: string[]): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  execFile("git", args, { cwd }, (error) => {
    if (error) reject(error);
    else resolve();
  });
  return promise;
}


const indexedContext = createFileIndexedContext([
  {
    path: "src/alpha.ts",
    content: [
      "export function targetValue(): string {",
      '  return "MAGIC=INDEXED_OK";',
      "}",
      "",
    ].join("\n"),
  },
  {
    path: "src/nested/beta.go",
    content: [
      "package nested",
      "",
      "func OtherValue() string {",
      '\treturn "ordinary"',
      "}",
      "",
    ].join("\n"),
  },
]);

test("indexed file helpers expose deterministic metadata, reads, and source symbols", () => {
  assert.deepEqual(
    indexedContext.files.map((file) => file.path),
    ["src/alpha.ts", "src/nested/beta.go"],
  );
  assert.match(readIndexedFile(indexedContext, "src/alpha.ts"), /MAGIC=INDEXED_OK/u);
  assert.throws(() => readIndexedFile(indexedContext, "../secret"), /canonical relative path/u);

  const symbols = findIndexedSymbol(indexedContext, "targetValue");
  assert.match(symbols[0]!.id, /^match_[0-9a-f]{32}$/u);
  assert.equal(symbols[0]!.path, "src/alpha.ts");
  assert.equal(symbols[0]!.line, 1);
  assert.equal(symbols[0]!.preview, "export function targetValue(): string {");
  assert.equal(symbols[0]!.text, symbols[0]!.preview);
  assert.equal(symbols[0]!.kind, "definition");
});

test("read_symbol resolves one definition and never selects ambiguous definitions", () => {
  const resolvedSession = createFileIndexedEvidenceSession(indexedContext);
  const resolved = resolvedSession.readSymbol("targetValue", {
    before: 0,
    after: 2,
  });
  assert.equal(resolved.status, "resolved");
  if (resolved.status !== "resolved") assert.fail("expected one resolved definition");
  assert.equal(resolved.match.path, "src/alpha.ts");
  assert.equal(resolved.slice.path, "src/alpha.ts");
  assert.match(resolved.slice.text, /MAGIC=INDEXED_OK/u);
  assert.deepEqual(
    resolvedSession.resolveEvidence([resolved.slice.id]).map((slice) => slice.id),
    [resolved.slice.id],
  );

  const ambiguousContext = createFileIndexedContext([
    { path: "a.ts", content: "export function duplicate(): void {}\n" },
    { path: "b.ts", content: "export function duplicate(): void {}\n" },
  ]);
  const ambiguous = createFileIndexedEvidenceSession(ambiguousContext).readSymbol(
    "duplicate",
  );
  assert.equal(ambiguous.status, "ambiguous");
  if (ambiguous.status !== "ambiguous") assert.fail("expected ambiguous definitions");
  assert.deepEqual(
    ambiguous.matches.map((match) => match.path),
    ["a.ts", "b.ts"],
  );
  assert.equal("slice" in ambiguous, false);
});

test("indexed evidence search opens deterministic bounded source slices", () => {
  const matches = searchIndexedFiles(indexedContext, {
    literal: "MAGIC=",
    pathPrefix: "src/",
    maxResults: 10,
  });
  assert.equal(matches.length, 1);
  assert.match(matches[0]!.id, /^match_[0-9a-f]{32}$/u);
  assert.equal(matches[0]!.path, "src/alpha.ts");
  assert.equal(matches[0]!.line, 2);

  const direct = readIndexedLines(indexedContext, "src/alpha.ts", 1, 3);
  const opened = openIndexedMatch(indexedContext, matches[0]!.id, { before: 1, after: 1 });
  assert.equal(opened.id, direct.id);
  assert.match(opened.id, /^evidence_[0-9a-f]{32}$/u);
  assert.equal(opened.revision, indexedContext.sourceRevision);
  assert.equal(opened.startLine, 1);
  assert.equal(opened.endLine, 3);
  assert.match(opened.text, /MAGIC=INDEXED_OK/u);

  beginIndexedObservationTurn(indexedContext);
  const first = observeIndexedEvidence(indexedContext, [opened.id]);
  assert.equal(first.evidence.length, 1);
  assert.equal(first.evidence[0]!.id, opened.id);
  assert.deepEqual(first.omittedDuplicateIds, []);
  const duplicate = observeIndexedEvidence(indexedContext, [opened.id]);
  assert.equal(duplicate.evidence.length, 0);
  assert.deepEqual(duplicate.omittedDuplicateIds, [opened.id]);
});

test("search_open returns at most two deterministic bounded slices", () => {
  const session = createFileIndexedEvidenceSession(indexedContext);
  const opened = session.searchOpen({
    literal: "MAGIC=",
    pathPrefix: "src/",
    maxResults: 1,
    before: 1,
    after: 1,
  });
  assert.equal(opened.truncated, false);
  assert.equal(opened.results.length, 1);
  assert.equal(opened.results[0]!.match.path, "src/alpha.ts");
  assert.equal(opened.results[0]!.slice.path, "src/alpha.ts");
  assert.match(opened.results[0]!.slice.text, /MAGIC=INDEXED_OK/u);
  assert.deepEqual(
    session.resolveEvidence([opened.results[0]!.slice.id]).map((slice) => slice.id),
    [opened.results[0]!.slice.id],
  );

  const many = createFileIndexedEvidenceSession(
    createFileIndexedContext([
      { path: "a.txt", content: "TARGET\n" },
      { path: "b.txt", content: "TARGET\n" },
      { path: "c.txt", content: "TARGET\n" },
    ]),
  );
  const bounded = many.searchOpen({ literal: "TARGET", maxResults: 2 });
  assert.equal(bounded.results.length, 2);
  assert.equal(bounded.truncated, true);
  assert.deepEqual(
    bounded.results.map((result) => result.match.path),
    ["a.txt", "b.txt"],
  );
  assert.throws(
    () => many.searchOpen({ literal: "TARGET", maxResults: 3 }),
    /at most 2/u,
  );
});

test("evidence ranges enforce path, line, character, and revision boundaries", () => {
  const bounded = createFileIndexedContext(
    [
      { path: "a/source.txt", content: "1111\n2222\n3333\n4444" },
      { path: "b/source.txt", content: "1111\nother" },
    ],
    { maxSliceLines: 2, maxSliceCharacters: 8 },
  );
  const hits = searchIndexedFiles(bounded, {
    literal: "1111",
    pathPrefix: "a/",
  });
  assert.deepEqual(hits.map((hit) => hit.path), ["a/source.txt"]);
  assert.throws(
    () => searchIndexedFiles(bounded, { literal: "1111", pathPrefix: "../a" }),
    /canonical relative path/u,
  );

  const slice = readIndexedLines(bounded, "a/source.txt", 1, 4);
  assert.equal(slice.startLine, 1);
  assert.equal(slice.endLine <= 2, true);
  assert.equal(slice.text.length <= 8, true);
  assert.equal(slice.truncated, true);
  assert.equal(readIndexedLines(bounded, "a/source.txt", 1, 4).id, slice.id);
  assert.throws(
    () => readIndexedLines(bounded, "../source.txt", 1, 1),
    /canonical relative path/u,
  );
  assert.throws(
    () => readIndexedLines(bounded, "a/source.txt", 0, 1),
    /positive integer/u,
  );

  const foreign = createFileIndexedContext([
    { path: "a/source.txt", content: "different" },
  ]);
  assert.throws(
    () => foreign.resolveEvidence([slice.id]),
    /stale, or foreign evidence ID/u,
  );
  assert.throws(
    () => foreign.openMatch(hits[0]!.id),
    /stale match ID/u,
  );
  const firstSession = createFileIndexedEvidenceSession(bounded);
  const secondSession = createFileIndexedEvidenceSession(bounded);
  const sessionSlice = firstSession.readLines("a/source.txt", 1, 1);
  assert.throws(
    () => secondSession.resolveEvidence([sessionSlice.id]),
    /this session/u,
  );
});

test("observation ceilings bound unique source across turns", () => {
  const bounded = createFileIndexedContext(
    [{ path: "source.txt", content: "abcdefghij\nklmnop" }],
    {
      maxSliceCharacters: 16,
      maxObservationCharactersPerTurn: 4,
      maxObservedCharactersPerRun: 6,
    },
  );
  const firstSlice = readIndexedLines(bounded, "source.txt", 1, 1);
  const secondSlice = readIndexedLines(bounded, "source.txt", 2, 2);

  beginIndexedObservationTurn(bounded);
  const first = observeIndexedEvidence(bounded, [firstSlice.id]);
  assert.equal(first.evidence[0]!.text, "abcd");
  assert.equal(first.evidence[0]!.truncated, true);
  assert.equal(first.remainingObservationCharacters, 0);

  beginIndexedObservationTurn(bounded);
  const second = observeIndexedEvidence(bounded, [secondSlice.id]);
  assert.equal(second.evidence[0]!.text, "kl");
  assert.equal(second.truncated, true);
  assert.equal(second.remainingObservationCharacters, 0);
});

test("large generated files expose only a bounded target slice", () => {
  const largeContent = `${"ordinary\n".repeat(800_000)}TARGET_GENERATED_SYMBOL\n`;
  const large = createFileIndexedContext([
    { path: "generated/client.gen.go", content: largeContent },
  ]);
  const hits = searchIndexedFiles(large, {
    literal: "TARGET_GENERATED_SYMBOL",
    pathPrefix: "generated/",
  });
  assert.equal(hits.length, 1);
  const slice = openIndexedMatch(large, hits[0]!.id, { before: 2, after: 2 });
  assert.equal(slice.text.length <= 16 * 1024, true);
  assert.match(slice.text, /TARGET_GENERATED_SYMBOL/u);
  assert.equal(slice.text.includes("ordinary\n".repeat(10_000)), false);
});

test("file-indexed context stays outside model chat while all native REPL helpers remain usable", async () => {
  const rootPayloads: string[] = [];
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-indexed-context-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    (context: Context) => {
      rootPayloads.push(JSON.stringify({ systemPrompt: context.systemPrompt, messages: context.messages }));
      return fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `
const paths = list_files();
const source = await read_file("src/alpha.ts");
const matches = await search_files({literal: "MAGIC=", pathPrefix: "src/"});
const slice = await open_match(matches[0].id, {before: 1, after: 1});
await observe([slice.id]);
const symbols = await find_symbol("targetValue");
const resolvedSymbol = await read_symbol("targetValue", {before: 0, after: 2});
const openedSearch = await search_open({literal: "MAGIC=", pathPrefix: "src/", maxResults: 1, before: 1, after: 1});
answer.content = JSON.stringify({
  metadata: files,
  paths,
  hasMagic: source.includes("MAGIC=INDEXED_OK"),
  match: matches[0],
  symbol: symbols[0],
  resolvedStatus: resolvedSymbol.status,
  resolvedPath: resolvedSymbol.status === "resolved" ? resolvedSymbol.slice.path : null,
  searchOpenCount: openedSearch.results.length,
  searchOpenPath: openedSearch.results[0]?.slice.path ?? null
});
answer.ready = true;`,
        }),
        { stopReason: "toolUse" },
      );
    },
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      isolation: { mode: "subprocess" },
    }).run(indexedContext, "Inspect targetValue in the indexed source corpus.");

    const answer = JSON.parse(result.response) as {
      metadata: Array<{ path: string; bytes: number; lines: number; language: string }>;
      paths: string[];
      hasMagic: boolean;
      match: { id: string; path: string; line: number; preview: string };
      symbol: { path: string; line: number; kind: string };
      resolvedStatus: string;
      resolvedPath: string | null;
      searchOpenCount: number;
      searchOpenPath: string | null;
    };
    assert.deepEqual(answer.paths, ["src/alpha.ts", "src/nested/beta.go"]);
    assert.equal(answer.metadata[0]?.path, "src/alpha.ts");
    assert.equal(answer.metadata[0]?.language, "typescript");
    assert.equal(answer.hasMagic, true);
    assert.match(result.rootPrompt, /src\/alpha\.ts:1 definition/u);
    assert.equal(answer.match.path, "src/alpha.ts");
    assert.equal(answer.match.line, 2);
    assert.equal(answer.symbol.kind, "definition");
    assert.equal(answer.resolvedStatus, "resolved");
    assert.equal(answer.resolvedPath, "src/alpha.ts");
    assert.equal(answer.searchOpenCount, 1);
    assert.equal(answer.searchOpenPath, "src/alpha.ts");
    assert.equal(rootPayloads.length, 1);
    assert.equal(rootPayloads[0]?.includes("INDEXED_OK"), false);
    assert.equal(rootPayloads[0]?.includes('return "ordinary"'), false);
    assert.equal((rootPayloads[0]?.length ?? 0) < 20_000, true);
    assert.equal(result.trace.executions[0]!.observedEvidenceIds.length, 1);
    assert.equal(result.trace.executions[0]!.observationCharacters > 0, true);
    assert.equal(result.rootPrompt.includes("files=2"), true);
    assert.equal(
      result.rootPrompt.includes(
        'llm_query({question: "...", evidenceIds: [slice.id]})',
      ),
      true,
    );
    assert.equal(
      result.rootPrompt.includes(
        'rlm_query({question: "...", evidenceIds: [slice.id]})',
      ),
      true,
    );
    assert.equal(rootPayloads[0]?.includes("inlineContext"), false);
  } finally {
    unregister();
  }
});

test("file-indexed subcalls receive only selected evidence slices", async () => {
  const subcallPayloads: string[] = [];
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-evidence-subcall-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
const hits = await search_files({literal: "MAGIC=", pathPrefix: "src/"});
const slice = await open_match(hits[0].id, {before: 1, after: 1});
answer.content = await llm_query({
  question: "Return only the MAGIC value.",
  evidenceIds: [slice.id, slice.id]
});
answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
    (context: Context) => {
      const payload = JSON.stringify(context.messages);
      subcallPayloads.push(payload);
      assert.match(payload, /EVIDENCE evidence_[0-9a-f]{32}/u);
      assert.match(payload, /MAGIC=INDEXED_OK/u);
      assert.equal(payload.includes("src/nested/beta.go"), false);
      assert.equal(payload.split("--- EVIDENCE ").length - 1, 1);
      return fauxAssistantMessage("INDEXED_OK");
    },
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      isolation: { mode: "subprocess" },
    }).run(indexedContext, "Return the indexed MAGIC value.");

    assert.equal(result.response, "INDEXED_OK");
    assert.equal(result.usage.llmSubcalls, 1);
    assert.equal(result.trace.subcallPrompts.length, 1);
    assert.equal(subcallPayloads.length, 1);
    assert.deepEqual(
      result.trace.corpusCalls.map((call) => call.request.operation),
      ["search_files", "open_match", "observe"],
    );
  } finally {
    unregister();
  }
});

test("recursive file subcalls receive a selected external evidence context", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-evidence-child-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
const hits = await search_files({literal: "MAGIC=", pathPrefix: "src/"});
const slice = await open_match(hits[0].id, {before: 1, after: 1});
answer.content = await rlm_query({
  question: "Return only the MAGIC value.",
  evidenceIds: [slice.id]
});
answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
const match = context.match(/MAGIC=([A-Z_]+)/);
answer.content = match?.[1] ?? "NOT_FOUND";
answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      limits: { maxDepth: 2 },
      isolation: { mode: "subprocess" },
    }).run(indexedContext, "Delegate the selected evidence to a child RLM.");
    assert.equal(result.response, "INDEXED_OK");
    assert.equal(result.usage.rlmSubcalls, 1);
    assert.equal(result.usage.rlmNodes, 2);
    assert.equal(result.trace.subcallPrompts.length, 1);
  } finally {
    unregister();
  }
});

test("file-indexed subcalls reject foreign revision evidence", async () => {
  const foreign = createFileIndexedContext(
    [{ path: "src/foreign.ts", content: "export const FOREIGN = true;\n" }],
    { sourceRevision: "foreign-revision" },
  );
  const foreignSlice = readIndexedLines(foreign, "src/foreign.ts", 1, 1);
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-foreign-evidence-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `answer.content = await llm_query({question: "Use foreign evidence.", evidenceIds: ["${foreignSlice.id}"]}); answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `answer.content = "FOREIGN_REJECTED"; answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      isolation: { mode: "subprocess" },
    }).run(indexedContext, "Reject evidence from another revision.");
    assert.equal(result.response, "FOREIGN_REJECTED");
    assert.equal(result.usage.llmSubcalls, 0);
    assert.equal(result.usage.modelCalls, 2);
    assert.equal(result.trace.subcallPrompts.length, 0);
  } finally {
    unregister();
  }
});

test("contract-free evidence projection rejects arbitrary answers", async () => {
  const context = createFileIndexedContext([
    { path: "limits.ts", content: "export const limits = {\n  maxDepth: 2,\n};\n" },
  ]);
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-evidence-projection-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `answer.content = {value: "2"}; answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
const opened = await search_open({literal: "maxDepth:", maxResults: 1});
project_answer({
  evidenceId: opened.results[0].slice.id,
  lineContains: "maxDepth:",
  valueKind: "number",
  valueAfter: "maxDepth:"
});`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      isolation: { mode: "subprocess" },
    }).run(context, "Return only the numeric maxDepth value.", {
      requireEvidenceProjection: true,
    });
    assert.equal(result.response, "2");
    assert.equal(result.answerEvidenceIds.length, 1);
    assert.equal(
      context.resolveEvidence(result.answerEvidenceIds)[0]?.path,
      "limits.ts",
    );
    assert.equal(result.usage.modelCalls, 2);
    assert.match(
      result.trace.executions[0]?.error ?? "",
      /RLM_EVIDENCE_PROJECTION_REQUIRED/u,
    );
  } finally {
    unregister();
  }
});

test("contract-free JSON projection recovers from a rejected penultimate selector", async () => {
  const context = createFileIndexedContext([
    { path: "package.json", content: '{\n  "name": "shepherd"\n}\n' },
  ]);
  const providerPrompts: string[] = [];
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-json-projection-recovery-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `await search_open({literal: '"name":', maxResults: 1});`,
      }),
      { stopReason: "toolUse" },
    ),
    (providerContext: Context) => {
      providerPrompts.push(JSON.stringify(providerContext.messages));
      return fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `
const [evidenceId] = get_corpus_history().flatMap((entry) => entry.evidenceIds);
project_answer({
  evidenceId,
  lineContains: "package",
  valueKind: "quoted",
  quotedIndex: 1
});`,
        }),
        { stopReason: "toolUse" },
      );
    },
    (providerContext: Context) => {
      providerPrompts.push(JSON.stringify(providerContext.messages));
      return fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `
const [evidenceId] = get_corpus_history().flatMap((entry) => entry.evidenceIds);
project_answer({
  evidenceId,
  lineContains: '"name":',
  valueKind: "quoted",
  quotedIndex: 1
});`,
        }),
        { stopReason: "toolUse" },
      );
    },
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      limits: {
        maxRootTurns: 3,
        maxTokens: 20_000,
        finalizationReserveTokens: 2_000,
      },
      isolation: { mode: "subprocess" },
    }).run(context, "Return the exact package name.", {
      requireEvidenceProjection: true,
    });

    assert.equal(result.response, "shepherd");
    assert.equal(result.usage.modelCalls, 3);
    assert.match(providerPrompts[1] ?? "", /selected line count is 0; expected 1/u);
    assert.match(result.rootPrompt, /quotedIndex: 1/u);
    assert.match(
      result.trace.executions[1]?.error ?? "",
      /selected line count is 0; expected 1/u,
    );
  } finally {
    unregister();
  }
});

test("terminal projection failure reports the last REPL error", async () => {
  const context = createFileIndexedContext([
    { path: "package.json", content: '{\n  "name": "shepherd"\n}\n' },
  ]);
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-terminal-projection-error-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `await search_open({literal: '"name":', maxResults: 1});`,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
const [evidenceId] = get_corpus_history().flatMap((entry) => entry.evidenceIds);
project_answer({
  evidenceId,
  lineContains: "package",
  valueKind: "quoted",
  quotedIndex: 1
});`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    await assert.rejects(
      () =>
        new PiRlmRunner(faux.getModel(), {
          modelRuntime,
          limits: {
            maxRootTurns: 2,
            maxTokens: 20_000,
            finalizationReserveTokens: 2_000,
          },
          isolation: { mode: "subprocess" },
        }).run(context, "Return the exact package name.", {
          requireEvidenceProjection: true,
        }),
      (error: unknown) => {
        assert.ok(error instanceof PiRlmRunError);
        assert.match(error.message, /selected line count is 0; expected 1/u);
        assert.match(
          error.trace.executions.at(-1)?.error ?? "",
          /selected line count is 0; expected 1/u,
        );
        return true;
      },
    );
  } finally {
    unregister();
  }
});

test("terminal projection no-op reports the final model tool call", async () => {
  const context = createFileIndexedContext([
    { path: "README.md", content: "# Shepherd\n" },
  ]);
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-terminal-projection-noop-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `void get_corpus_history();`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    await assert.rejects(
      () =>
        new PiRlmRunner(faux.getModel(), {
          modelRuntime,
          limits: {
            maxRootTurns: 1,
            maxTokens: 10_000,
            finalizationReserveTokens: 2_000,
          },
          isolation: { mode: "subprocess" },
        }).run(context, "What is this project?", {
          requireEvidenceProjection: true,
        }),
      (error: unknown) => {
        assert.ok(error instanceof PiRlmRunError);
        assert.match(error.message, /get_corpus_history/u);
        return true;
      },
    );
  } finally {
    unregister();
  }
});

test("contract-free bounded synthesis submits content from observed evidence", async () => {
  const context = createFileIndexedContext([
    {
      path: "README.md",
      content: "# Shepherd\n\nShepherd answers questions from bounded source evidence.\n",
    },
    {
      path: "package.json",
      content: '{\n  "name": "shepherd",\n  "description": "Evidence-bound source queries"\n}\n',
    },
  ]);
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-grounded-summary-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
const readme = await search_open({
  literal: "bounded source evidence",
  pathPrefix: "README.md",
  maxResults: 1
});
const metadata = await search_open({
  literal: "Evidence-bound source queries",
  pathPrefix: "package.json",
  maxResults: 1
});
submit_grounded_answer({
  content: "Shepherd is a source-query tool that answers from bounded evidence.",
  evidenceIds: [
    readme.results[0].slice.id,
    metadata.results[0].slice.id
  ]
});`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      isolation: { mode: "subprocess" },
    }).run(context, "What is this project?", {
      requireEvidenceProjection: true,
    });

    assert.equal(
      result.response,
      "Shepherd is a source-query tool that answers from bounded evidence.",
    );
    assert.equal(result.usage.modelCalls, 1);
    assert.equal(result.answerEvidenceIds.length, 2);
    assert.deepEqual(
      context.resolveEvidence(result.answerEvidenceIds).map((slice) => slice.path),
      ["README.md", "package.json"],
    );
    assert.match(result.rootPrompt, /submit_grounded_answer/u);
  } finally {
    unregister();
  }
});

test("bounded evidence submission can follow a metadata-only raw file read", async () => {
  const context = createFileIndexedContext([
    {
      path: "README.md",
      content: "# Shepherd\n\nShepherd answers questions from bounded source evidence.\n",
    },
  ]);
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-grounded-summary-finalization-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `state.readme = await read_file("README.md");`,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
const slice = await read_lines("README.md", 1, 3);
submit_grounded_answer({
  content: "Shepherd answers questions from bounded source evidence.",
  evidenceIds: [slice.id]
});`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      limits: {
        maxRootTurns: 2,
        maxTokens: 20_000,
        finalizationReserveTokens: 2_000,
      },
      isolation: { mode: "subprocess" },
    }).run(context, "What is this project?", {
      requireEvidenceProjection: true,
    });

    assert.equal(
      result.response,
      "Shepherd answers questions from bounded source evidence.",
    );
    assert.equal(result.usage.modelCalls, 2);
    assert.match(result.rootPrompt, /bounded synthesis over explicitly selected evidence/u);
  } finally {
    unregister();
  }
});

test("list_symbols returns metadata before explicit bounded evidence selection", async () => {
  const context = createFileIndexedContext([
    {
      path: "lib/selected.ts",
      content: [
        "export function selectedSymbol(): string {",
        '  return "SELECTED";',
        "}",
        "",
      ].join("\n"),
    },
    {
      path: "lib/other.ts",
      content: [
        "export function otherSymbol(): string {",
        '  return "OTHER";',
        "}",
        "",
      ].join("\n"),
    },
  ]);
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-list-symbols-metadata-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
const definitions = await list_symbols({pathPrefix: "lib", maxResults: 2});
if (list_observed_evidence().length !== 0) {
  throw new Error("list_symbols must not observe source");
}
const selected = definitions.find((definition) => definition.name === "selectedSymbol");
if (!selected) throw new Error("selected definition metadata is absent");
const slice = await read_lines(selected.path, selected.line, selected.line + 2);
submit_grounded_answer({
  content: "selectedSymbol is defined in a bounded slice.",
  evidenceIds: [slice.id]
});`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      isolation: { mode: "subprocess" },
    }).run(context, "Return the selected symbol.", {
      requireEvidenceProjection: true,
    });

    assert.equal(result.response, "selectedSymbol is defined in a bounded slice.");
    assert.deepEqual(
      context.resolveEvidence(result.answerEvidenceIds).map((slice) => slice.path),
      ["lib/selected.ts"],
    );
    assert.match(result.rootPrompt, /list_symbols returns metadata only/u);
    assert.match(result.rootPrompt, /bounded and read-only/u);
  } finally {
    unregister();
  }
});

test("query evidence receipt unions answer and fact support IDs without source text", () => {
  const context = createFileIndexedContext([
    { path: "answer.ts", content: "export const answer = 'ANSWER_SOURCE_TEXT';\n" },
    { path: "facts.ts", content: "export const fact = 'FACT_SOURCE_TEXT';\n" },
  ]);
  const answerEvidence = context.readLines("answer.ts", 1, 1);
  const factEvidence = context.readLines("facts.ts", 1, 1);
  const fact = {
    factId: "fact",
    description: "A grounded fact.",
    grounding: "quoted" as const,
    minSupports: 1,
    status: "grounded" as const,
    claimCount: 1,
    evidenceIds: [factEvidence.id],
  };
  const facts: PiRlmFactStateSnapshot = {
    sourceRevision: context.sourceRevision,
    facts: [fact],
    values: { fact: "FACT_SOURCE_TEXT" },
    pendingFactIds: [],
    factsById: { fact },
  };

  const receipt = createQueryEvidenceReceipt(context, [answerEvidence.id], facts);

  assert.equal(receipt.corpusId, context.corpusId);
  assert.deepEqual(receipt.answerEvidenceIds, [answerEvidence.id, factEvidence.id]);
  assert.deepEqual(
    receipt.evidence,
    [answerEvidence, factEvidence].map(
      ({ id, path, startLine, endLine, sha256, truncated }) => ({
        id,
        path,
        startLine,
        endLine,
        sha256,
        truncated,
      }),
    ),
  );
  assert.doesNotMatch(JSON.stringify(receipt.evidence), /ANSWER_SOURCE_TEXT|FACT_SOURCE_TEXT/u);
});

test("grounded answer submission rejects empty and unobserved evidence", async () => {
  const context = createFileIndexedContext([
    {
      path: "README.md",
      content: "# Shepherd\n\nShepherd answers questions from bounded source evidence.\n",
    },
  ]);
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-grounded-summary-boundary-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `submit_grounded_answer({content: "UNSUPPORTED", evidenceIds: []});`,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code:
          'submit_grounded_answer({content: "UNOBSERVED", evidenceIds: ["evidence_unknown"]});',
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
const opened = await search_open({
  literal: "bounded source evidence",
  pathPrefix: "README.md",
  maxResults: 1
});
submit_grounded_answer({
  content: "Shepherd answers from bounded source evidence.",
  evidenceIds: [opened.results[0].slice.id]
});`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      isolation: { mode: "subprocess" },
    }).run(context, "What is this project?", {
      requireEvidenceProjection: true,
    });

    assert.equal(result.response, "Shepherd answers from bounded source evidence.");
    assert.equal(result.usage.modelCalls, 3);
    assert.match(
      result.trace.executions[0]?.error ?? "",
      /evidenceIds must be a non-empty array/u,
    );
    assert.match(
      result.trace.executions[1]?.error ?? "",
      /requires current observed evidence: evidence_unknown/u,
    );
  } finally {
    unregister();
  }
});

test("grounded answers select only evidence observed within run limits", async () => {
  const context = createFileIndexedContext(
    [
      { path: "src/first.ts", content: "AAAAAAAAAA" },
      { path: "src/second.ts", content: "BBBBBBBBBB" },
    ],
    {
      maxObservationCharactersPerTurn: 10,
      maxObservedCharactersPerRun: 10,
    },
  );
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-observed-evidence-inventory-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
const first = await read_lines("src/first.ts", 1, 1);
const second = await read_lines("src/second.ts", 1, 1);
const observed = list_observed_evidence();
if (observed.length !== 1 || observed[0].evidenceId !== first.id) {
  throw new Error("unexpected observed evidence inventory");
}
if (observed.some((entry) => entry.evidenceId === second.id)) {
  throw new Error("unobserved evidence leaked into inventory");
}
submit_grounded_answer({
  content: "The first bounded source slice was observed.",
  evidenceIds: observed.map((entry) => entry.evidenceId)
});`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      isolation: { mode: "subprocess" },
    }).run(context, "Summarize the observed source.", {
      requireEvidenceProjection: true,
    });

    assert.equal(result.response, "The first bounded source slice was observed.");
    assert.match(result.rootPrompt, /list_observed_evidence/u);
  } finally {
    unregister();
  }
});

test("contract-free runs can reuse observed evidence across turns", async () => {
  const context = createFileIndexedContext([
    { path: "context.txt", content: "MAGIC=OBSERVED_OK\n" },
  ]);
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-contract-free-observed-evidence-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
const opened = await search_open({literal: "MAGIC="});
state.evidenceId = opened.results[0].slice.id;`,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
const facts = get_fact_state();
if (facts.pendingFactIds.length !== 0) throw new Error("unexpected pending facts");
const observed = get_observed_evidence(state.evidenceId);
answer.content = observed.text.match(/MAGIC=([^\\n]+)/)[1];
answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      isolation: { mode: "subprocess" },
    }).run(context, "Return the exact MAGIC value.");
    assert.equal(result.response, "OBSERVED_OK");
    assert.equal(result.usage.modelCalls, 2);
  } finally {
    unregister();
  }
});

test("root transcript retains only the latest prior RLM observation", async () => {
  const context = createFileIndexedContext([
    { path: "a/value.txt", content: "VALUE=MARKER_ONE\n" },
    { path: "b/value.txt", content: "VALUE=MARKER_TWO\n" },
    { path: "c/value.txt", content: "VALUE=MARKER_THREE\n" },
  ]);
  const providerPayloads: string[] = [];
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-transcript-window-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  const openPath = (pathPrefix: string) =>
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
const hits = await search_files({literal: "VALUE=", pathPrefix: "${pathPrefix}"});
await open_match(hits[0].id);`,
      }),
      { stopReason: "toolUse" },
    );
  faux.setResponses([
    (providerContext: Context) => {
      providerPayloads.push(JSON.stringify(providerContext.messages));
      return openPath("a/");
    },
    (providerContext: Context) => {
      providerPayloads.push(JSON.stringify(providerContext.messages));
      return openPath("b/");
    },
    (providerContext: Context) => {
      providerPayloads.push(JSON.stringify(providerContext.messages));
      return openPath("c/");
    },
    (providerContext: Context) => {
      const payload = JSON.stringify(providerContext.messages);
      providerPayloads.push(payload);
      assert.equal(payload.includes("MARKER_ONE"), false);
      assert.match(payload, /MARKER_TWO/u);
      assert.match(payload, /MARKER_THREE/u);
      return fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `answer.content = "WINDOW_OK"; answer.ready = true;`,
        }),
        { stopReason: "toolUse" },
      );
    },
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      isolation: { mode: "subprocess" },
    }).run(context, "Read three bounded values and finish.");
    assert.equal(result.response, "WINDOW_OK");
    assert.equal(providerPayloads.length, 4);
    assert.equal(result.trace.executions[3]!.compactedToolResults >= 1, true);
  } finally {
    unregister();
  }
});

test("execution errors preserve bounded evidence for the recovery turn", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-error-evidence-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  let recoveryPayload = "";
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
await read_lines("src/alpha.ts", 1, 3);
throw new Error("AFTER_EVIDENCE_FAILURE");`,
      }),
      { stopReason: "toolUse" },
    ),
    (providerContext: Context) => {
      recoveryPayload = JSON.stringify(providerContext.messages);
      return fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `answer.content = "RECOVERED"; answer.ready = true;`,
        }),
        { stopReason: "toolUse" },
      );
    },
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      isolation: { mode: "subprocess" },
    }).run(indexedContext, "Recover after an execution error.");

    assert.equal(result.response, "RECOVERED");
    assert.match(recoveryPayload, /MAGIC=INDEXED_OK/u);
    assert.match(recoveryPayload, /AFTER_EVIDENCE_FAILURE/u);
    assert.equal(result.trace.executions.length, 2);
    assert.match(result.trace.executions[0]!.error ?? "", /AFTER_EVIDENCE_FAILURE/u);
    assert.equal(result.trace.executions[0]!.observationCharacters > 0, true);
    assert.equal(result.usage.modelCalls, 2);
  } finally {
    unregister();
  }
});

test("runtime action ledger caches exact corpus calls and stays read-only", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-action-ledger-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  let continuationPayload = "";
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `await read_symbol("targetValue");`,
      }),
      { stopReason: "toolUse" },
    ),
    (providerContext: Context) => {
      continuationPayload = JSON.stringify(providerContext.messages);
      return fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `
const replay = await read_symbol("targetValue");
const history = get_corpus_history();
answer.content = JSON.stringify({
  frozen: Object.isFrozen(history),
  entryFrozen: Object.isFrozen(history[0]),
  historyLength: history.length,
  cacheHits: history[0].cacheHits,
  replayStatus: replay.status,
  legacyType: typeof corpus_history
});
answer.ready = true;`,
        }),
        { stopReason: "toolUse" },
      );
    },
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      isolation: { mode: "subprocess" },
    }).run(indexedContext, "Read targetValue once and reuse the action ledger.");
    const answer = JSON.parse(result.response) as {
      frozen: boolean;
      entryFrozen: boolean;
      historyLength: number;
      cacheHits: number;
      replayStatus: string;
      legacyType: string;
    };

    assert.equal(answer.frozen, true);
    assert.equal(answer.entryFrozen, true);
    assert.equal(answer.historyLength, 1);
    assert.equal(answer.cacheHits, 1);
    assert.equal(answer.replayStatus, "resolved");
    assert.equal(answer.legacyType, "undefined");
    assert.match(continuationPayload, /CORPUS HISTORY/u);
    assert.match(continuationPayload, /read_symbol/u);
    assert.deepEqual(
      result.trace.corpusCalls.map((call) => call.request.operation),
      ["read_symbol", "observe"],
    );
    assert.equal(result.trace.executions[1]!.corpusCacheHits, 1);
  } finally {
    unregister();
  }
});

test("runtime action ledger caches exact failed corpus calls", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-failed-action-ledger-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `await read_symbol("targetValue.qualified");`,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
let replayError = "";
try {
  await read_symbol("targetValue.qualified");
} catch (error) {
  replayError = String(error);
}
const history = get_corpus_history();
answer.content = JSON.stringify({
  replayError,
  historyLength: history.length,
  cacheHits: history[0].cacheHits,
  summary: history[0].summary
});
answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      isolation: { mode: "subprocess" },
    }).run(indexedContext, "Record and reuse one failed corpus action.");
    const answer = JSON.parse(result.response) as {
      replayError: string;
      historyLength: number;
      cacheHits: number;
      summary: string;
    };

    assert.match(answer.replayError, /one source identifier/u);
    assert.equal(answer.historyLength, 1);
    assert.equal(answer.cacheHits, 1);
    assert.match(answer.summary, /error=/u);
    assert.deepEqual(
      result.trace.corpusCalls.map((call) => call.request.operation),
      ["read_symbol"],
    );
    assert.equal(result.trace.executions[1]!.corpusCacheHits, 1);
  } finally {
    unregister();
  }
});

test("console output stays bounded while full files persist in worker state", async () => {
  const suffix = "END_OF_FULL_SOURCE";
  const source = `START_OF_FULL_SOURCE${"x".repeat(20_000)}${suffix}`;
  const context = createFileIndexedContext([
    { path: "src/large.txt", content: source },
  ]);
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-bounded-console-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
state.full = await read_file("src/large.txt");
console.log(state.full);`,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
answer.content = state.full.length === ${source.length} ? "PERSISTED" : "LOST";
answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      isolation: { mode: "subprocess" },
    }).run(context, "Persist and inspect the full file locally.");

    assert.equal(result.response, "PERSISTED");
    assert.equal(result.trace.executions[0]!.stdoutCharacters <= 1_024, true);
    const transcript = JSON.stringify(result.rootMessages);
    assert.match(transcript, /console output omitted/u);
    assert.equal(transcript.includes("START_OF_FULL_SOURCE"), false);
    assert.equal(transcript.includes(suffix), false);
  } finally {
    unregister();
  }
});

test("indexed search is literal and bounded", () => {
  const many = createFileIndexedContext([
    { path: "a.txt", content: "x\nx\nx\n" },
    { path: "b.txt", content: "x\nx\n" },
  ]);

  assert.equal(searchIndexedFiles(many, { literal: "x", maxResults: 3 }).length, 3);
  assert.deepEqual(searchIndexedFiles(many, { literal: ".*" }), []);
  assert.throws(() => searchIndexedFiles(many, { literal: "", maxResults: 1 }), /must not be empty/u);
  assert.throws(() => searchIndexedFiles(many, { literal: "x", maxResults: 0 }), /maxResults/u);
});

test("single file paths use one file-indexed context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rlm-indexed-file-"));
  try {
    const path = join(root, "context.txt");
    await writeFile(path, "MAGIC=SINGLE_FILE_OK\n", "utf8");

    const context = await loadIndexedPathContext(path);

    assert.deepEqual(context.files.map((file) => file.path), ["context.txt"]);
    assert.equal(context.sourceRoot, root);
    assert.match(context.sourceRevision, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(readIndexedFile(context, "context.txt"), "MAGIC=SINGLE_FILE_OK\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("directory context indexes only tracked text files and skips tracked symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rlm-indexed-git-"));
  try {
    await runGit(root, ["init", "--quiet"]);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "tracked.ts"), "export const trackedValue = 1;\n", "utf8");
    await writeFile(join(root, "src", "untracked.ts"), "export const hiddenValue = 2;\n", "utf8");
    await writeFile(join(root, "src", ".env"), "SECRET=not-indexed\n", "utf8");
    await runGit(root, ["add", "src/tracked.ts", "src/.env"]);
    await runGit(root, [
      "-c",
      "user.name=Pi RLM Test",
      "-c",
      "user.email=pi-rlm@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);

    const context = await loadGitDirectoryContext(join(root, "src"));
    assert.deepEqual(context.files.map((file) => file.path), ["tracked.ts"]);
    assert.match(readIndexedFile(context, "tracked.ts"), /trackedValue/u);
    assert.equal(context.sourceRoot, join(root, "src"));
    assert.match(context.sourceRevision ?? "", /^[0-9a-f]{40}$/u);

    await symlink("tracked.ts", join(root, "src", "link.ts"));
    await runGit(root, ["add", "src/link.ts"]);
    const contextWithLink = await loadGitDirectoryContext(join(root, "src"));
    assert.deepEqual(contextWithLink.files.map((file) => file.path), ["tracked.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file-indexed mode rejects raw and evidence-less subcalls without provider dispatch", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-indexed-local-first-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `await read_file("src/nested/beta.go"); answer.content = await llm_query("Search the indexed files yourself."); answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `answer.content = await llm_query({question: "Search the indexed files yourself.", evidenceIds: []}); answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
const matches = await search_files({literal: "MAGIC=", pathPrefix: "src/"});
const source = await read_file(matches[0].path);
answer.content = source.match(/MAGIC=([A-Z_]+)/)[1];
answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      isolation: { mode: "subprocess" },
    }).run(indexedContext, "Return the MAGIC value.");

    assert.equal(result.response, "INDEXED_OK");
    assert.equal(result.usage.modelCalls, 3, "blocked subcalls must not dispatch provider calls");
    assert.equal(result.usage.llmSubcalls, 1, "raw queries must be rejected before subcall accounting");
    assert.equal(result.trace.subcallPrompts.length, 0);
    assert.deepEqual(
      result.trace.corpusCalls.map((call) => call.request.operation),
      ["read_file", "search_files", "read_file"],
    );
  } finally {
    unregister();
  }
});

test("failed indexed answer contracts retain bounded candidates and helper traces", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-indexed-failure-trace-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses(
    [1, 2].map((attempt) =>
      fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `
await read_file("src/alpha.ts");
answer.content = "BAD_${attempt}";
answer.ready = true;`,
        }),
        { stopReason: "toolUse" },
      ),
    ),
  );

  try {
    await assert.rejects(
      new PiRlmRunner(faux.getModel(), {
        modelRuntime,
        isolation: { mode: "subprocess" },
      }).run(indexedContext, "Return exactly EXPECTED.", {
        validateAnswer: (candidate) => ({
          valid: candidate === "EXPECTED",
          reason: "exact output required",
        }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof PiRlmRunError);
        assert.equal(error.trace.executionCount, 2);
        assert.equal(error.trace.answerRejections, 2);
        assert.deepEqual(
          error.trace.rejectedAnswers.map((answer) => answer.candidatePreview),
          ["BAD_1", "BAD_2"],
        );
        assert.deepEqual(
          error.trace.corpusCalls.map((call) => call.request.operation),
          ["read_file", "read_file"],
        );
        return true;
      },
    );
  } finally {
    unregister();
  }
});

test("provided fact contracts persist grounded claims and block premature finalization", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-fact-state-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  let continuationPayload = "";
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
const resolved = await read_symbol("targetValue");
state.evidenceId = resolved.slice.id;
record_fact({
  factId: "value",
  value: "INDEXED_OK",
  supports: [{ evidenceId: state.evidenceId, quote: "MAGIC=INDEXED_OK" }]
});
answer.content = "TOO_EARLY";
answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
    (providerContext: Context) => {
      continuationPayload = JSON.stringify(providerContext.messages);
      return fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `
record_fact({
  factId: "shape",
  value: "function-return",
  supports: [{
    evidenceId: state.evidenceId,
    quote: 'return "MAGIC=INDEXED_OK";'
  }],
  rationale: "The function returns the required source value."
});
const facts = get_fact_state();
answer.content = JSON.stringify({
  frozen: Object.isFrozen(facts),
  factFrozen: Object.isFrozen(facts.facts[0]),
  valuesFrozen: Object.isFrozen(facts.values),
  statuses: facts.facts.map((fact) => fact.status),
  values: facts.values,
  pendingFactIds: facts.pendingFactIds,
  factsByIdValue: facts.factsById.value.latestClaim.value
});
answer.ready = true;`,
        }),
        { stopReason: "toolUse" },
      );
    },
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      isolation: { mode: "subprocess" },
    }).run(indexedContext, "Return the grounded fact state.", {
      factContract: {
        requirements: [
          {
            id: "value",
            description: "Exact source value returned by targetValue.",
            grounding: "quoted",
            minSupports: 1,
          },
          {
            id: "shape",
            description: "Source construct that produces the value.",
            grounding: "derived",
            minSupports: 1,
          },
        ],
      },
    });
    const answer = JSON.parse(result.response) as {
      frozen: boolean;
      factFrozen: boolean;
      valuesFrozen: boolean;
      statuses: string[];
      values: Record<string, string>;
      pendingFactIds: string[];
      factsByIdValue: string;
    };

    assert.deepEqual(answer, {
      frozen: true,
      factFrozen: true,
      valuesFrozen: true,
      statuses: ["grounded", "grounded"],
      values: {
        value: "INDEXED_OK",
        shape: "function-return",
      },
      pendingFactIds: [],
      factsByIdValue: "INDEXED_OK",
    });
    assert.equal(result.answerRejections, 0);
    assert.equal(result.trace.facts.finalizationBlocks, 1);
    assert.deepEqual(
      result.trace.facts.events.map((event) => [event.factId, event.event]),
      [
        ["value", "grounded"],
        ["shape", "grounded"],
      ],
    );
    assert.deepEqual(
      result.trace.facts.finalState?.facts.map((fact) => [fact.factId, fact.status]),
      [
        ["value", "grounded"],
        ["shape", "grounded"],
      ],
    );
    assert.match(continuationPayload, /FACT STATE/u);
    assert.match(continuationPayload, /shape pending/u);
    assert.equal(continuationPayload.includes("TOO_EARLY"), false);
  } finally {
    unregister();
  }
});

test("fact grounding rejects unsupported claims and keeps append-only revisions", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-fact-grounding-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
const resolved = await read_symbol("targetValue");
const evidenceId = resolved.slice.id;
const errors = {};
try {
  record_fact({
    factId: "value",
    value: "INDEXED_OK",
    supports: [{ evidenceId: "evidence_missing", quote: "MAGIC=INDEXED_OK" }]
  });
} catch (error) {
  errors.unobserved = String(error);
}
try {
  record_fact({
    factId: "value",
    value: "INDEXED_OK",
    supports: [{ evidenceId, quote: "NOT_IN_SOURCE" }]
  });
} catch (error) {
  errors.quote = String(error);
}
try {
  record_fact({
    factId: "value",
    value: "WRONG",
    supports: [{ evidenceId, quote: "MAGIC=INDEXED_OK" }]
  });
} catch (error) {
  errors.value = String(error);
}
const firstClaim = {
  factId: "value",
  value: "INDEXED_OK",
  supports: [{ evidenceId, quote: "MAGIC=INDEXED_OK" }]
};
record_fact(firstClaim);
record_fact(firstClaim);
record_fact({
  factId: "value",
  value: "MAGIC=INDEXED_OK",
  supports: [{ evidenceId, quote: "MAGIC=INDEXED_OK" }],
  rationale: "Preserve the complete literal."
});
const facts = get_fact_state();
answer.content = JSON.stringify({
  errors,
  claimCount: facts.facts[0].claimCount,
  version: facts.facts[0].latestClaim.version,
  value: facts.facts[0].latestClaim.value
});
answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      isolation: { mode: "subprocess" },
    }).run(indexedContext, "Ground and revise one source fact.", {
      factContract: {
        requirements: [
          {
            id: "value",
            description: "Exact source value returned by targetValue.",
            grounding: "quoted",
            minSupports: 1,
          },
        ],
      },
    });
    const answer = JSON.parse(result.response) as {
      errors: Record<string, string>;
      claimCount: number;
      version: number;
      value: string;
    };

    assert.match(answer.errors.unobserved ?? "", /observed evidence/u);
    assert.match(answer.errors.quote ?? "", /quote/u);
    assert.match(answer.errors.value ?? "", /quoted fact value/u);
    assert.equal(answer.claimCount, 2);
    assert.equal(answer.version, 2);
    assert.equal(answer.value, "MAGIC=INDEXED_OK");
    assert.equal(result.trace.facts.finalizationBlocks, 0);
    assert.deepEqual(
      result.trace.facts.events.map((event) => event.event),
      ["rejected", "rejected", "rejected", "grounded", "revised"],
    );
  } finally {
    unregister();
  }
});

test("derived facts require unique supports and survive answer rejection", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-derived-fact-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
const resolved = await read_symbol("targetValue");
const evidenceId = resolved.slice.id;
const errors = {};
try {
  record_fact({
    factId: "unknown",
    value: "ignored",
    supports: [{ evidenceId, quote: "targetValue" }]
  });
} catch (error) {
  errors.unknown = String(error);
}
try {
  record_fact({
    factId: "summary",
    value: "targetValue returns INDEXED_OK",
    supports: [
      { evidenceId, quote: "targetValue" },
      { evidenceId, quote: "targetValue" }
    ]
  });
} catch (error) {
  errors.supports = String(error);
}
record_fact({
  factId: "summary",
  value: "targetValue returns INDEXED_OK",
  supports: [
    { evidenceId, quote: "targetValue" },
    { evidenceId, quote: "MAGIC=INDEXED_OK" }
  ]
});
state.errors = errors;
answer.content = "BAD";
answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
const facts = get_fact_state();
answer.content = JSON.stringify({
  errors: state.errors,
  status: facts.facts[0].status,
  claimCount: facts.facts[0].claimCount
});
answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      isolation: { mode: "subprocess" },
    }).run(indexedContext, "Derive one grounded summary.", {
      factContract: {
        requirements: [
          {
            id: "summary",
            description: "Derived description of targetValue.",
            grounding: "derived",
            minSupports: 2,
          },
        ],
      },
      validateAnswer: (candidate) => ({
        valid: candidate !== "BAD",
        reason: "BAD is not accepted",
      }),
    });
    const answer = JSON.parse(result.response) as {
      errors: Record<string, string>;
      status: string;
      claimCount: number;
    };

    assert.match(answer.errors.unknown ?? "", /unknown fact id/u);
    assert.match(answer.errors.supports ?? "", /2 unique supports/u);
    assert.equal(answer.status, "grounded");
    assert.equal(answer.claimCount, 1);
    assert.equal(result.answerRejections, 1);
    assert.equal(result.trace.facts.finalState?.facts[0]?.claimCount, 1);
    assert.equal(
      result.trace.facts.events.every((event) =>
        event.reason === undefined || event.reason.length <= 2_048,
      ),
      true,
    );
    assert.equal(
      result.trace.facts.finalState?.facts.every((fact) =>
        fact.latestClaim?.supports.every(
          (support) => support.quotePreview.length <= 160,
        ) ?? true,
      ),
      true,
    );
  } finally {
    unregister();
  }
});

test("new evidence without a fact claim emits a bounded progress block", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-fact-progress-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  let continuationPayload = "";
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `state.resolved = await read_symbol("targetValue");`,
      }),
      { stopReason: "toolUse" },
    ),
    (providerContext: Context) => {
      continuationPayload = JSON.stringify(providerContext.messages);
      return fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `
const observed = get_observed_evidence(state.resolved.slice.id);
record_fact({
  factId: "value",
  value: "INDEXED_OK",
  supports: [{
    evidenceId: state.resolved.slice.id,
    quote: "MAGIC=INDEXED_OK"
  }]
});
answer.content = JSON.stringify({
  frozen: Object.isFrozen(observed),
  retained: observed.text.includes("MAGIC=INDEXED_OK"),
  evidenceAlias: observed.evidenceId
});
answer.ready = true;`,
        }),
        { stopReason: "toolUse" },
      );
    },
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      isolation: { mode: "subprocess" },
    }).run(indexedContext, "Record the observed value.", {
      factContract: {
        requirements: [
          {
            id: "value",
            description: "Exact source value returned by targetValue.",
            grounding: "quoted",
            minSupports: 1,
          },
        ],
      },
    });
    const answer = JSON.parse(result.response) as {
      frozen: boolean;
      retained: boolean;
      evidenceAlias: string;
    };

    assert.equal(answer.frozen, true);
    assert.equal(answer.retained, true);
    assert.match(answer.evidenceAlias, /^evidence_/u);
    assert.equal(result.trace.facts.progressBlocks, 1);
    assert.equal(result.trace.executions[1]?.observedEvidenceIds.length, 1);
    assert.match(continuationPayload, /RLM_FACT_PROGRESS_REQUIRED/u);
    assert.match(continuationPayload, /value pending/u);
    assert.match(continuationPayload, /Exact source value returned by targetValue/u);
  } finally {
    unregister();
  }
});

test("pending facts without source activity emit a next-action block", async () => {
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-fact-action-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  let continuationPayload = "";
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `get_fact_state();`,
      }),
      { stopReason: "toolUse" },
    ),
    (providerContext: Context) => {
      continuationPayload = JSON.stringify(providerContext.messages);
      return fauxAssistantMessage(
        fauxToolCall("rlm_exec", {
          code: `
const resolved = await read_symbol("targetValue");
record_fact({
  factId: "value",
  value: "INDEXED_OK",
  supports: [{
    evidenceId: resolved.slice.id,
    quote: "MAGIC=INDEXED_OK"
  }]
});
answer.content = "ACTIONED";
answer.ready = true;`,
        }),
        { stopReason: "toolUse" },
      );
    },
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      isolation: { mode: "subprocess" },
    }).run(indexedContext, "Read targetValue and record its value.", {
      factContract: {
        requirements: [
          {
            id: "value",
            description: "Exact source value returned by targetValue.",
            grounding: "quoted",
            minSupports: 1,
          },
        ],
      },
    });

    assert.equal(result.response, "ACTIONED");
    assert.equal(result.trace.facts.actionBlocks, 1);
    assert.match(continuationPayload, /RLM_FACT_ACTION_REQUIRED/u);
    assert.match(continuationPayload, /src\/alpha\.ts/u);
    assert.match(continuationPayload, /read_symbol/u);
    assert.equal(continuationPayload.includes("globalThis"), true);
  } finally {
    unregister();
  }
});

test("quoted-list facts require complete source lines and exact list values", async () => {
  const listContext = createFileIndexedContext([
    { path: "src/list.ts", content: "first.Item,\nsecond.Item,\n" },
  ]);
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-quoted-list-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
const slice = await read_lines("src/list.ts", 1, 2);
let partialError = "";
try {
  record_fact({
    factId: "items",
    value: "first.Item,second.It",
    supports: [
      { evidenceId: slice.id, quote: "first.Item," },
      { evidenceId: slice.id, quote: "second.It" }
    ]
  });
} catch (error) {
  partialError = String(error);
}
record_fact({
  factId: "items",
  value: "first.Item,second.Item",
  supports: [
    { evidenceId: slice.id, quote: "first.Item," },
    { evidenceId: slice.id, quote: "second.Item," }
  ]
});
answer.content = JSON.stringify({
  partialError,
  value: get_fact_state().facts[0].latestClaim.value
});
answer.ready = true;`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      isolation: { mode: "subprocess" },
    }).run(listContext, "Return the exact source item list.", {
      factContract: {
        requirements: [
          {
            id: "items",
            description: "Exact item expressions in source order.",
            grounding: "quoted-list",
            minSupports: 2,
          },
        ],
      },
    });
    const answer = JSON.parse(result.response) as {
      partialError: string;
      value: string;
    };

    assert.match(answer.partialError, /complete observed source line/u);
    assert.equal(answer.value, "first.Item,second.Item");
    assert.deepEqual(
      result.trace.facts.events.map((event) => event.event),
      ["rejected", "grounded"],
    );
  } finally {
    unregister();
  }
});

test("runtime finalizer skips model-authored actions after typed extraction", async () => {
  const context = createFileIndexedContext([
    {
      path: "platform-api/internal/server/server.go",
      content: [
        "package server",
        "func NewRouterWithConfig(cfg Config) {",
        '\tr.Get("/healthz", health.Handler())',
        '\tr.Get("/readyz", health.Handler())',
        "\tr.Group(func(api chi.Router) {",
        "\tapi.Use(middleware.Timeout(cfg.RequestTimeout))",
        "\tfor _, mount := range cfg.Mounts {",
        "\t\tmount(api)",
        "\t}",
        "\t})",
        "\t// unrelated source padding 0123456789012345678901234567890123456789",
        "\t// unrelated source padding 0123456789012345678901234567890123456789",
        "\t// unrelated source padding 0123456789012345678901234567890123456789",
        "\t// unrelated source padding 0123456789012345678901234567890123456789",
        "\t// unrelated source padding 0123456789012345678901234567890123456789",
        "\t// unrelated source padding 0123456789012345678901234567890123456789",
        "\t// unrelated source padding 0123456789012345678901234567890123456789",
        "\t// unrelated source padding 0123456789012345678901234567890123456789",
        "}",
      ].join("\n"),
    },
    {
      path: "platform-api/cmd/server/main.go",
      content: [
        "package main",
        "SSEMounts: []server.RouteMounter{",
        "\tstreamHandler.Mount,",
        "\tdevWorkspaceHandler.MountProxy,",
        "},",
      ].join("\n"),
    },
  ], {
    maxObservationCharactersPerTurn: 1_100,
    maxObservedCharactersPerRun: 4_000,
  });
  const { faux, modelRuntime, unregister } = await createFauxRuntime({
    provider: "pi-rlm-typed-extractor-test",
    models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("rlm_exec", {
        code: `
throw new Error("model-authored code must not run");`,
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  try {
    const result = await new PiRlmRunner(faux.getModel(), {
      modelRuntime,
      isolation: { mode: "subprocess" },
    }).run(context, "Return the router boundary.", {
      factContract: {
        requirements: [
          {
            id: "probes",
            description: "Root probes.",
            grounding: "derived",
            minSupports: 2,
            extractor: {
              source: {
                kind: "symbol",
                name: "NewRouterWithConfig",
                before: 0,
                after: 20,
              },
              select: {
                kind: "contains-all",
                literals: ["r.Get(", "health.Handler()"],
              },
              capture: { kind: "quoted-string", index: 0 },
              reduce: { kind: "join", exactCount: 2, separator: "," },
            },
          },
          {
            id: "sse",
            description: "SSE mounts.",
            grounding: "quoted-list",
            minSupports: 2,
            extractor: {
              source: {
                kind: "search-open",
                literal: "SSEMounts:",
                path: "platform-api/cmd/server/main.go",
                before: 0,
                after: 4,
              },
              scope: {
                afterLiteral: "SSEMounts:",
                beforeLiteral: "},",
                maxLines: 3,
              },
              select: {
                kind: "identifier-chain-line",
                trailingDelimiter: ",",
              },
              capture: {
                kind: "identifier-chain",
                stripTrailingDelimiter: true,
              },
              reduce: { kind: "join", exactCount: 2, separator: "," },
            },
          },
          {
            id: "timed",
            description: "Timed mount field.",
            grounding: "quoted",
            minSupports: 1,
            extractor: {
              source: {
                kind: "symbol",
                name: "NewRouterWithConfig",
                before: 0,
                after: 20,
              },
              scope: {
                afterLiteral:
                  "api.Use(middleware.Timeout(cfg.RequestTimeout))",
                beforeLiteral: "\t})",
                maxLines: 5,
              },
              select: {
                kind: "contains-all",
                literals: ["range cfg."],
              },
              capture: {
                kind: "identifier-after",
                literal: "cfg.",
              },
              reduce: { kind: "single", exactCount: 1 },
            },
          },
        ],
        finalizer: {
          kind: "template",
          template: "probes={{probes}}|sse={{sse}}|timed={{timed}}",
        },
      },
    });

    assert.equal(
      result.response,
      "probes=/healthz,/readyz|sse=streamHandler.Mount,devWorkspaceHandler.MountProxy|timed=Mounts",
    );
    assert.deepEqual(
      result.trace.facts.extractions.map((event) => [
        event.factId,
        event.status,
      ]),
      [
        ["probes", "grounded"],
        ["sse", "grounded"],
        ["timed", "grounded"],
      ],
    );
    assert.deepEqual(
      result.trace.corpusCalls.map((call) => call.request.operation),
      ["read_symbol", "observe", "search_open", "observe"],
    );
    assert.equal(result.trace.facts.runtimeFinalizations, 1);
    assert.equal(result.usage.modelCalls, 1);
  } finally {
    unregister();
  }
});
