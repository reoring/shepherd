#!/usr/bin/env node

import { runShepherdCheckCommand } from "./check-command.ts";
import { runShepherdQueryCommand } from "./query-command.ts";
import {
  parseShepherdCliArguments,
  type ShepherdCliCommand,
} from "./shepherd-command.ts";

export async function runShepherdCli(args: readonly string[]): Promise<number> {
  let parsed: ShepherdCliCommand;
  try {
    parsed = parseShepherdCliArguments(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  return parsed.command === "query"
    ? runShepherdQueryCommand(parsed.arguments)
    : runShepherdCheckCommand(parsed.arguments);
}

process.exitCode = await runShepherdCli(process.argv.slice(2));
