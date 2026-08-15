import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { parseSheperdNativeCommandArguments } from "./sheperd-command.ts";

const SHEPERD_ENTRYPOINT = fileURLToPath(
  new URL("./sheperd-cli.ts", import.meta.url),
);

interface CliExecution {
  stdout: string;
  stderr: string;
}

interface SheperdQueryOutput {
  status: "passed";
  answer: string;
  usage: {
    modelCalls: number;
    totalTokens: number;
  };
  [key: string]: unknown;
}

interface SheperdCheckOutput {
  status: "passed" | "failed";
  modelCalls: number;
  [key: string]: unknown;
}

function sheperdIsolationMode(): "subprocess" | "docker" {
  const value = process.env.SHEPERD_ISOLATION ?? "subprocess";
  if (value !== "subprocess" && value !== "docker") {
    throw new Error(`Unsupported SHEPERD_ISOLATION: ${value}`);
  }
  return value;
}

function executeSheperdCli(
  args: readonly string[],
  cwd: string,
  acceptedExitCodes: readonly number[],
): Promise<CliExecution> {
  const { promise, resolve: complete, reject } =
    Promise.withResolvers<CliExecution>();
  execFile(
    process.execPath,
    [SHEPERD_ENTRYPOINT, ...args],
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

function parseSheperdQueryOutput(value: string): SheperdQueryOutput {
  const output = parseObject(value, "Sheperd query");
  if (
    output.status !== "passed" ||
    typeof output.answer !== "string" ||
    !output.usage ||
    typeof output.usage !== "object" ||
    typeof (output.usage as Record<string, unknown>).modelCalls !== "number" ||
    typeof (output.usage as Record<string, unknown>).totalTokens !== "number"
  ) {
    throw new Error("Sheperd query returned an invalid success payload");
  }
  return output as SheperdQueryOutput;
}

function parseSheperdCheckOutput(value: string): SheperdCheckOutput {
  const output = parseObject(value, "Sheperd check");
  if (
    (output.status !== "passed" && output.status !== "failed") ||
    typeof output.modelCalls !== "number"
  ) {
    throw new Error("Sheperd check returned an invalid result payload");
  }
  return output as SheperdCheckOutput;
}

export default function registerSheperdExtension(pi: ExtensionAPI): void {
  pi.registerCommand("sheperd", {
    description: "Run Sheperd queries and contract checks without an outer-agent model turn",
    handler: async (args, ctx) => {
      const parsed = parseSheperdNativeCommandArguments(args);
      const mode = sheperdIsolationMode();
      if (parsed.command === "query") {
        const model = ctx.model;
        if (!model) throw new Error("/sheperd query requires an active model");
        const { contextPath, contractPath, question } = parsed.arguments;
        ctx.ui.setStatus("sheperd", `Sheperd query ${mode}: ${contextPath}`);
        try {
          const execution = await executeSheperdCli(
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
          const output = parseSheperdQueryOutput(execution.stdout);
          pi.sendMessage(
            {
              customType: "sheperd-query-result",
              content: output.answer,
              display: true,
              details: output,
            },
            { triggerTurn: false },
          );
          ctx.ui.notify(
            `Sheperd query completed: ${output.usage.modelCalls} model calls, ${output.usage.totalTokens} tokens`,
            "info",
          );
        } finally {
          ctx.ui.setStatus("sheperd", undefined);
        }
        return;
      }

      const { contextPath, contractPath } = parsed.arguments;
      ctx.ui.setStatus("sheperd", `Sheperd check ${mode}: ${contextPath}`);
      try {
        const execution = await executeSheperdCli(
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
        const output = parseSheperdCheckOutput(execution.stdout);
        pi.sendMessage(
          {
            customType: "sheperd-check-result",
            content: JSON.stringify(output, null, 2),
            display: true,
            details: output,
          },
          { triggerTurn: false },
        );
        ctx.ui.notify(
          `Sheperd check ${output.status}: ${output.modelCalls} model calls`,
          output.status === "passed" ? "info" : "error",
        );
      } finally {
        ctx.ui.setStatus("sheperd", undefined);
      }
    },
  });
}
