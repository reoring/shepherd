#!/usr/bin/env node

import { runSheperdCheckCommand } from "./check-command.ts";
import { runSheperdQueryCommand } from "./query-command.ts";
import {
  parseSheperdCliArguments,
  type SheperdCliCommand,
} from "./sheperd-command.ts";

export async function runSheperdCli(args: readonly string[]): Promise<number> {
  let parsed: SheperdCliCommand;
  try {
    parsed = parseSheperdCliArguments(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  return parsed.command === "query"
    ? runSheperdQueryCommand(parsed.arguments)
    : runSheperdCheckCommand(parsed.arguments);
}

process.exitCode = await runSheperdCli(process.argv.slice(2));
