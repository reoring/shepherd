import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSheperdCliArguments,
  parseSheperdNativeCommandArguments,
} from "../src/sheperd-command.ts";

test("parses /sheperd query context path and question around the explicit separator", () => {
  assert.deepEqual(
    parseSheperdNativeCommandArguments(
      "query context.txt -- Find the MAGIC value -- exactly",
    ),
    {
      command: "query",
      arguments: {
        contextPath: "context.txt",
        question: "Find the MAGIC value -- exactly",
      },
    },
  );
});

test("accepts quoted paths with spaces and Pi-style @ prefixes", () => {
  assert.deepEqual(
    parseSheperdNativeCommandArguments(
      'query @"fixtures/large context" -- Summarize it',
    ),
    {
      command: "query",
      arguments: {
        contextPath: "fixtures/large context",
        question: "Summarize it",
      },
    },
  );
});

test("parses an explicit versioned contract file", () => {
  assert.deepEqual(
    parseSheperdNativeCommandArguments(
      'query @"/workspace/repository" --contract @"contracts/api timeout.json" -- Trace the router',
    ),
    {
      command: "query",
      arguments: {
        contextPath: "/workspace/repository",
        contractPath: "contracts/api timeout.json",
        question: "Trace the router",
      },
    },
  );
});

test("parses /sheperd check directory and contract paths without a question", () => {
  assert.deepEqual(
    parseSheperdNativeCommandArguments(
      'check @"/workspace/repository" --contract @"contracts/api timeout.json"',
    ),
    {
      command: "check",
      arguments: {
        contextPath: "/workspace/repository",
        contractPath: "contracts/api timeout.json",
      },
    },
  );
  for (const value of [
    "",
    "/workspace/repository",
    "/workspace/repository --contract",
    "/workspace/repository --contract contract.json -- extra",
  ]) {
    assert.throws(
      () => parseSheperdNativeCommandArguments(`check ${value}`),
      /Usage: \/sheperd check/u,
    );
  }
});

test("parses headless Sheperd check arguments and CI output controls", () => {
  assert.deepEqual(
    parseSheperdCliArguments([
      "check",
      "/workspace/repository",
      "--contract",
      "contracts/api.json",
    ]),
    {
      command: "check",
      arguments: {
        contextPath: "/workspace/repository",
        contractPath: "contracts/api.json",
        isolationMode: "subprocess",
        outputFormat: "text",
      },
    },
  );
  assert.deepEqual(
    parseSheperdCliArguments([
      "check",
      "/workspace/repository",
      "--contract",
      "contracts/api.json",
      "--isolation",
      "docker",
      "--json",
    ]),
    {
      command: "check",
      arguments: {
        contextPath: "/workspace/repository",
        contractPath: "contracts/api.json",
        isolationMode: "docker",
        outputFormat: "json",
      },
    },
  );
  for (const args of [
    ["check"],
    ["check", "/workspace/repository"],
    ["check", "/workspace/repository", "--contract", "a.json", "--unknown"],
    ["check", "/workspace/repository", "--contract", "a.json", "--isolation", "vm"],
  ]) {
    assert.throws(() => parseSheperdCliArguments(args), /Usage: sheperd check/u);
  }
});

test("parses cross-harness headless Sheperd query arguments", () => {
  assert.deepEqual(
    parseSheperdCliArguments([
      "query",
      "/workspace/repository",
      "--question",
      "Trace the timeout boundary.",
    ]),
    {
      command: "query",
      arguments: {
        contextPath: "/workspace/repository",
        question: "Trace the timeout boundary.",
        isolationMode: "subprocess",
        outputFormat: "text",
      },
    },
  );
  assert.deepEqual(
    parseSheperdCliArguments([
      "query",
      "/workspace/repository",
      "--contract",
      "contracts/api.json",
      "--question",
      "Trace the timeout boundary.",
      "--model",
      "openai/gpt-5.6-luna",
      "--isolation",
      "docker",
      "--json",
    ]),
    {
      command: "query",
      arguments: {
        contextPath: "/workspace/repository",
        contractPath: "contracts/api.json",
        question: "Trace the timeout boundary.",
        modelSpec: "openai/gpt-5.6-luna",
        isolationMode: "docker",
        outputFormat: "json",
      },
    },
  );
  for (const args of [
    ["query"],
    ["query", "/workspace/repository"],
    ["query", "/workspace/repository", "--question", ""],
    ["query", "/workspace/repository", "--question", "--json"],
    ["query", "/workspace/repository", "--question", "Q", "--model", "luna"],
    ["query", "/workspace/repository", "--question", "Q", "--unknown"],
  ]) {
    assert.throws(() => parseSheperdCliArguments(args), /Usage: sheperd query/u);
  }
});

test("rejects missing file, separator, question, and legacy subcommands", () => {
  for (const value of [
    "query",
    "query context.txt",
    "query  -- question",
    "query context.txt -- ",
    "query context.txt --contract -- question",
    "query context.txt --contract contract.json extra -- question",
    "query 'unterminated -- question",
    "rlm context.txt -- question",
  ]) {
    assert.throws(
      () => parseSheperdNativeCommandArguments(value),
      /Usage: \/sheperd query/u,
    );
  }
});
