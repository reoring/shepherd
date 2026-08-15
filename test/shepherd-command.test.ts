import assert from "node:assert/strict";
import test from "node:test";

import {
  parseShepherdCliArguments,
  parseShepherdNativeCommandArguments,
} from "../src/shepherd-command.ts";

test("routes Pi query and check subcommands through /shepherd", () => {
  assert.deepEqual(
    parseShepherdNativeCommandArguments(
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
    parseShepherdNativeCommandArguments(
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

  for (const value of ["", "context.txt -- question", "legacy context.txt -- question"]) {
    assert.throws(
      () => parseShepherdNativeCommandArguments(value),
      /Usage: \/shepherd (?:query|check)/u,
    );
  }
});

test("routes shell query and check subcommands through shepherd", () => {
  assert.deepEqual(
    parseShepherdCliArguments([
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
    parseShepherdCliArguments([
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

  for (const args of [[], ["legacy"], ["query"], ["check"]]) {
    assert.throws(
      () => parseShepherdCliArguments(args),
      /Usage: shepherd (?:query|check)/u,
    );
  }
});
