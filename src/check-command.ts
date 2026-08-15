import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  renderRlmContractCheckResult,
  runRlmContractCheck,
} from "./contract-check.ts";
import { parseRlmContractFile } from "./contract-file.ts";
import { loadGitDirectoryContext } from "./file-context.ts";
import type { SheperdCheckCliArguments } from "./sheperd-command.ts";

export async function runSheperdCheckCommand(
  parsed: SheperdCheckCliArguments,
): Promise<number> {
  try {
    const contextPath = resolve(process.cwd(), parsed.contextPath);
    const contextPathInfo = await stat(contextPath);
    if (!contextPathInfo.isDirectory()) {
      throw new Error(`Sheperd check context path is not a directory: ${parsed.contextPath}`);
    }
    const contractPath = resolve(process.cwd(), parsed.contractPath);
    const contractPathInfo = await stat(contractPath);
    if (!contractPathInfo.isFile()) {
      throw new Error(`Sheperd contract path is not a file: ${parsed.contractPath}`);
    }

    const contractFile = parseRlmContractFile(await readFile(contractPath, "utf8"));
    const context = await loadGitDirectoryContext(contextPath);
    const result = await runRlmContractCheck(context, contractFile, {
      isolation: { mode: parsed.isolationMode },
    });
    const output = parsed.outputFormat === "json"
      ? JSON.stringify(
          {
            contextPath: parsed.contextPath,
            contractPath: parsed.contractPath,
            isolationMode: parsed.isolationMode,
            ...result,
          },
          null,
          2,
        )
      : renderRlmContractCheckResult(parsed.contractPath, result);
    process.stdout.write(`${output}\n`);
    return result.status === "passed" ? 0 : 1;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Sheperd configuration or file error: ${detail}\n`);
    return 2;
  }
}
