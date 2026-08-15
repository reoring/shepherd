import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSheperdCliArguments,
  parseSheperdNativeCommandArguments,
} from "../src/sheperd-command.ts";

test("routes Pi query and check subcommands through /sheperd", () => {
  assert.deepEqual(
    parseSheperdNativeCommandArguments(
      'query @"fixtures/large context" --contract @"contracts/source.json" -- Find the value',
    ),
    {
      command: "query",
      arguments: {
        contextPath: "fixtures/large context",
        contractPath: "contracts/source.json",
        question: "Find the value",
      },
    },
  );
  assert.deepEqual(
    parseSheperdNativeCommandArguments(
      'check @"fixtures/large context" --contract @"contracts/source.json"',
    ),
    {
      command: "check",
      arguments: {
        contextPath: "fixtures/large context",
        contractPath: "contracts/source.json",
      },
    },
  );

  for (const value of ["", "context.txt -- question", "rlm context.txt -- question"]) {
    assert.throws(
      () => parseSheperdNativeCommandArguments(value),
      /Usage: \/sheperd (?:query|check)/u,
    );
  }
});

test("routes shell query and check subcommands through sheperd", () => {
  assert.deepEqual(
    parseSheperdCliArguments([
      "query",
      "/workspace/repository",
      "--question",
      "Trace the timeout boundary.",
      "--model",
      "openai/gpt-5.6-luna",
      "--json",
    ]),
    {
      command: "query",
      arguments: {
        contextPath: "/workspace/repository",
        question: "Trace the timeout boundary.",
        modelSpec: "openai/gpt-5.6-luna",
        isolationMode: "subprocess",
        outputFormat: "json",
      },
    },
  );
  assert.deepEqual(
    parseSheperdCliArguments([
      "check",
      "/workspace/repository",
      "--contract",
      "contracts/source.json",
      "--isolation",
      "docker",
      "--json",
    ]),
    {
      command: "check",
      arguments: {
        contextPath: "/workspace/repository",
        contractPath: "contracts/source.json",
        isolationMode: "docker",
        outputFormat: "json",
      },
    },
  );

  for (const args of [[], ["rlm"], ["query"], ["check"]]) {
    assert.throws(
      () => parseSheperdCliArguments(args),
      /Usage: sheperd (?:query|check)/u,
    );
  }
});
