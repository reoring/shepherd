const SHEPERD_QUERY_USAGE =
  "Usage: /sheperd query <file-or-directory> [--contract <contract.json>] -- <question>";
const SHEPERD_CHECK_USAGE =
  "Usage: /sheperd check <directory> --contract <contract.json>";
const SHEPERD_CHECK_CLI_USAGE =
  "Usage: sheperd check <directory> --contract <contract.json> [--isolation subprocess|docker] [--json]";
const SHEPERD_QUERY_CLI_USAGE =
  "Usage: sheperd query <file-or-directory> --question <text> [--contract <contract.json>] [--model provider/model] [--isolation subprocess|docker] [--json]";

export interface SheperdQueryCommandArguments {
  contextPath: string;
  contractPath?: string;
  question: string;
}

export interface SheperdCheckCommandArguments {
  contextPath: string;
  contractPath: string;
}

export interface SheperdCheckCliArguments extends SheperdCheckCommandArguments {
  isolationMode: "subprocess" | "docker";
  outputFormat: "text" | "json";
}

export interface SheperdQueryCliArguments extends SheperdQueryCommandArguments {
  modelSpec?: string;
  isolationMode: "subprocess" | "docker";
  outputFormat: "text" | "json";
}

export type SheperdNativeCommand =
  | { command: "query"; arguments: SheperdQueryCommandArguments }
  | { command: "check"; arguments: SheperdCheckCommandArguments };

export type SheperdCliCommand =
  | { command: "query"; arguments: SheperdQueryCliArguments }
  | { command: "check"; arguments: SheperdCheckCliArguments };

function usageError(usage: string): Error {
  return new Error(usage);
}

function questionSeparatorIndex(value: string, usage: string): number {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < value.length - 1; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (
      character === "-" &&
      value[index + 1] === "-" &&
      /\s/u.test(value[index - 1] ?? "") &&
      /\s/u.test(value[index + 2] ?? "")
    ) {
      return index;
    }
  }
  if (quote) throw usageError(usage);
  return -1;
}

function tokenizePrefix(value: string, usage: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: '"' | "'" | undefined;
  for (const character of value) {
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += character;
  }
  if (quote) throw usageError(usage);
  if (token) tokens.push(token);
  return tokens;
}

function normalizePathToken(value: string, usage: string): string {
  const path = value.startsWith("@") ? value.slice(1) : value;
  if (!path) throw usageError(usage);
  return path;
}

export function parseSheperdQueryCommandArguments(
  args: string,
): SheperdQueryCommandArguments {
  const separatorIndex = questionSeparatorIndex(args, SHEPERD_QUERY_USAGE);
  if (separatorIndex < 0) throw usageError(SHEPERD_QUERY_USAGE);
  const prefix = args.slice(0, separatorIndex).trim();
  const question = args.slice(separatorIndex + 2).trim();
  if (!prefix || !question) throw usageError(SHEPERD_QUERY_USAGE);

  const tokens = tokenizePrefix(prefix, SHEPERD_QUERY_USAGE);
  if (tokens.length === 1) {
    return {
      contextPath: normalizePathToken(tokens[0]!, SHEPERD_QUERY_USAGE),
      question,
    };
  }
  if (tokens.length === 3 && tokens[1] === "--contract") {
    return {
      contextPath: normalizePathToken(tokens[0]!, SHEPERD_QUERY_USAGE),
      contractPath: normalizePathToken(tokens[2]!, SHEPERD_QUERY_USAGE),
      question,
    };
  }
  throw usageError(SHEPERD_QUERY_USAGE);
}

export function parseSheperdCheckCommandArguments(
  args: string,
): SheperdCheckCommandArguments {
  const tokens = tokenizePrefix(args.trim(), SHEPERD_CHECK_USAGE);
  if (tokens.length !== 3 || tokens[1] !== "--contract") {
    throw usageError(SHEPERD_CHECK_USAGE);
  }
  return {
    contextPath: normalizePathToken(tokens[0]!, SHEPERD_CHECK_USAGE),
    contractPath: normalizePathToken(tokens[2]!, SHEPERD_CHECK_USAGE),
  };
}

export function parseSheperdNativeCommandArguments(args: string): SheperdNativeCommand {
  const trimmed = args.trim();
  const separatorIndex = trimmed.search(/\s/u);
  const command = separatorIndex < 0 ? trimmed : trimmed.slice(0, separatorIndex);
  const commandArguments = separatorIndex < 0 ? "" : trimmed.slice(separatorIndex).trim();

  if (command === "query") {
    return {
      command,
      arguments: parseSheperdQueryCommandArguments(commandArguments),
    };
  }
  if (command === "check") {
    return {
      command,
      arguments: parseSheperdCheckCommandArguments(commandArguments),
    };
  }
  throw usageError(SHEPERD_QUERY_USAGE);
}

export function parseSheperdCheckCliArguments(
  args: readonly string[],
): SheperdCheckCliArguments {
  if (args.length < 3 || !args[0] || args[0].startsWith("--")) {
    throw usageError(SHEPERD_CHECK_CLI_USAGE);
  }
  let contractPath: string | undefined;
  let isolationMode: SheperdCheckCliArguments["isolationMode"] = "subprocess";
  let outputFormat: SheperdCheckCliArguments["outputFormat"] = "text";
  let isolationConfigured = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--contract" && contractPath === undefined) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw usageError(SHEPERD_CHECK_CLI_USAGE);
      contractPath = normalizePathToken(value, SHEPERD_CHECK_CLI_USAGE);
      index += 1;
      continue;
    }
    if (argument === "--isolation" && !isolationConfigured) {
      const value = args[index + 1];
      if (value !== "subprocess" && value !== "docker") {
        throw usageError(SHEPERD_CHECK_CLI_USAGE);
      }
      isolationMode = value;
      isolationConfigured = true;
      index += 1;
      continue;
    }
    if (argument === "--json" && outputFormat === "text") {
      outputFormat = "json";
      continue;
    }
    throw usageError(SHEPERD_CHECK_CLI_USAGE);
  }
  if (!contractPath) throw usageError(SHEPERD_CHECK_CLI_USAGE);
  return {
    contextPath: normalizePathToken(args[0], SHEPERD_CHECK_CLI_USAGE),
    contractPath,
    isolationMode,
    outputFormat,
  };
}

export function parseSheperdQueryCliArguments(
  args: readonly string[],
): SheperdQueryCliArguments {
  if (args.length < 3 || !args[0] || args[0].startsWith("--")) {
    throw usageError(SHEPERD_QUERY_CLI_USAGE);
  }
  let contractPath: string | undefined;
  let question: string | undefined;
  let modelSpec: string | undefined;
  let isolationMode: SheperdQueryCliArguments["isolationMode"] = "subprocess";
  let outputFormat: SheperdQueryCliArguments["outputFormat"] = "text";
  let isolationConfigured = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--contract" && contractPath === undefined) {
      if (!value || value.startsWith("--")) throw usageError(SHEPERD_QUERY_CLI_USAGE);
      contractPath = normalizePathToken(value, SHEPERD_QUERY_CLI_USAGE);
      index += 1;
      continue;
    }
    if (argument === "--question" && question === undefined) {
      if (!value || value.startsWith("--") || value.trim().length === 0) {
        throw usageError(SHEPERD_QUERY_CLI_USAGE);
      }
      question = value;
      index += 1;
      continue;
    }
    if (argument === "--model" && modelSpec === undefined) {
      if (
        !value ||
        value.startsWith("--") ||
        value.indexOf("/") <= 0 ||
        value.endsWith("/")
      ) {
        throw usageError(SHEPERD_QUERY_CLI_USAGE);
      }
      modelSpec = value;
      index += 1;
      continue;
    }
    if (argument === "--isolation" && !isolationConfigured) {
      if (value !== "subprocess" && value !== "docker") {
        throw usageError(SHEPERD_QUERY_CLI_USAGE);
      }
      isolationMode = value;
      isolationConfigured = true;
      index += 1;
      continue;
    }
    if (argument === "--json" && outputFormat === "text") {
      outputFormat = "json";
      continue;
    }
    throw usageError(SHEPERD_QUERY_CLI_USAGE);
  }
  if (!question) throw usageError(SHEPERD_QUERY_CLI_USAGE);
  return {
    contextPath: normalizePathToken(args[0], SHEPERD_QUERY_CLI_USAGE),
    ...(contractPath ? { contractPath } : {}),
    question,
    ...(modelSpec ? { modelSpec } : {}),
    isolationMode,
    outputFormat,
  };
}

export function parseSheperdCliArguments(args: readonly string[]): SheperdCliCommand {
  const [command, ...commandArguments] = args;
  if (command === "query") {
    return {
      command,
      arguments: parseSheperdQueryCliArguments(commandArguments),
    };
  }
  if (command === "check") {
    return {
      command,
      arguments: parseSheperdCheckCliArguments(commandArguments),
    };
  }
  throw usageError(SHEPERD_QUERY_CLI_USAGE);
}
