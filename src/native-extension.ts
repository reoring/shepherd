import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { parseShepherdNativeCommandArguments } from "./shepherd-command.ts";

const SHEPHERD_ENTRYPOINT = fileURLToPath(
  new URL("./shepherd-cli.ts", import.meta.url),
);

interface CliExecution {
  stdout: string;
  stderr: string;
}

interface ShepherdQueryOutput {
  status: "passed";
  answer: string;
  usage: {
    modelCalls: number;
    totalTokens: number;
  };
  [key: string]: unknown;
}

interface ShepherdCheckOutput {
  status: "passed" | "failed";
  modelCalls: number;
  [key: string]: unknown;
}

function shepherdIsolationMode(): "subprocess" | "docker" {
  const value = process.env.SHEPHERD_ISOLATION ?? "subprocess";
  if (value !== "subprocess" && value !== "docker") {
    throw new Error(`Unsupported SHEPHERD_ISOLATION: ${value}`);
  }
  return value;
}

function executeShepherdCli(
  args: readonly string[],
  cwd: string,
  acceptedExitCodes: readonly number[],
): Promise<CliExecution> {
  const { promise, resolve: complete, reject } =
    Promise.withResolvers<CliExecution>();
  execFile(
    process.execPath,
    [SHEPHERD_ENTRYPOINT, ...args],
    { cwd, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout, stderr) => {
      const exitCode = error && typeof error.code === "number" ? error.code : 0;
      if (error && !acceptedExitCodes.includes(exitCode)) {
        reject(new Error(stderr.trim() || stdout.trim() || error.message, { cause: error }));
        return;
      }
      complete({ stdout, stderr });
    },
  );
  return promise;
}

function parseObject(value: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} returned invalid JSON`);
  }
  return parsed as Record<string, unknown>;
}

function parseShepherdQueryOutput(value: string): ShepherdQueryOutput {
  const output = parseObject(value, "Shepherd query");
  if (
    output.status !== "passed" ||
    typeof output.answer !== "string" ||
    !output.usage ||
    typeof output.usage !== "object" ||
    typeof (output.usage as Record<string, unknown>).modelCalls !== "number" ||
    typeof (output.usage as Record<string, unknown>).totalTokens !== "number"
  ) {
    throw new Error("Shepherd query returned an invalid success payload");
  }
  return output as ShepherdQueryOutput;
}

function parseShepherdCheckOutput(value: string): ShepherdCheckOutput {
  const output = parseObject(value, "Shepherd check");
  if (
    (output.status !== "passed" && output.status !== "failed") ||
    typeof output.modelCalls !== "number"
  ) {
    throw new Error("Shepherd check returned an invalid result payload");
  }
  return output as ShepherdCheckOutput;
}

export default function registerShepherdExtension(pi: ExtensionAPI): void {
  pi.registerCommand("shepherd", {
    description: "Run Shepherd queries and contract checks without an outer-agent model turn",
    handler: async (args, ctx) => {
      const parsed = parseShepherdNativeCommandArguments(args);
      const mode = shepherdIsolationMode();
      if (parsed.command === "query") {
        const model = ctx.model;
        if (!model) throw new Error("/shepherd query requires an active model");
        const { contextPath, contractPath, question } = parsed.arguments;
        ctx.ui.setStatus("shepherd", `Shepherd query ${mode}: ${contextPath}`);
        try {
          const execution = await executeShepherdCli(
            [
              "query",
              contextPath,
              ...(contractPath ? ["--contract", contractPath] : []),
              "--question",
              question,
              "--model",
              `${model.provider}/${model.id}`,
              "--isolation",
              mode,
              "--json",
            ],
            ctx.cwd,
            [0],
          );
          const output = parseShepherdQueryOutput(execution.stdout);
          pi.sendMessage(
            {
              customType: "shepherd-query-result",
              content: output.answer,
              display: true,
              details: output,
            },
            { triggerTurn: false },
          );
          ctx.ui.notify(
            `Shepherd query completed: ${output.usage.modelCalls} model calls, ${output.usage.totalTokens} tokens`,
            "info",
          );
        } finally {
          ctx.ui.setStatus("shepherd", undefined);
        }
        return;
      }

      const { contextPath, contractPath } = parsed.arguments;
      ctx.ui.setStatus("shepherd", `Shepherd check ${mode}: ${contextPath}`);
      try {
        const execution = await executeShepherdCli(
          [
            "check",
            contextPath,
            "--contract",
            contractPath,
            "--isolation",
            mode,
            "--json",
          ],
          ctx.cwd,
          [0, 1],
        );
        const output = parseShepherdCheckOutput(execution.stdout);
        pi.sendMessage(
          {
            customType: "shepherd-check-result",
            content: JSON.stringify(output, null, 2),
            display: true,
            details: output,
          },
          { triggerTurn: false },
        );
        ctx.ui.notify(
          `Shepherd check ${output.status}: ${output.modelCalls} model calls`,
          output.status === "passed" ? "info" : "error",
        );
      } finally {
        ctx.ui.setStatus("shepherd", undefined);
      }
    },
  });
}
