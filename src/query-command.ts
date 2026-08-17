import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { parseRlmContractFile, type RlmContractFile } from "./contract-file.ts";
import { loadIndexedPathContext, type FileIndexedContext } from "./file-context.ts";
import { DEFAULT_RLM_LIMITS } from "./rlm-defaults.ts";
import type { ShepherdQueryCliArguments } from "./shepherd-command.ts";
import { PiRlmRunError, PiRlmRunner } from "./runner.ts";
import type { PiRlmFactStateSnapshot } from "./worker-protocol.ts";

interface QueryInput {
  context: FileIndexedContext;
  contractFile?: RlmContractFile;
  answerPattern?: RegExp;
}
export interface QueryEvidenceReceipt {
  corpusId: string;
  answerEvidenceIds: string[];
  evidence: Array<{
    id: string;
    path: string;
    startLine: number;
    endLine: number;
    sha256: string;
    truncated: boolean;
  }>;
}

export function createQueryEvidenceReceipt(
  context: FileIndexedContext,
  answerEvidenceIds: readonly string[],
  facts: PiRlmFactStateSnapshot | undefined,
): QueryEvidenceReceipt {
  const selectedIds = new Set(answerEvidenceIds);
  for (const fact of facts?.facts ?? []) {
    if (fact.status !== "grounded") continue;
    for (const evidenceId of fact.evidenceIds) selectedIds.add(evidenceId);
  }
  const resolved = context.resolveEvidence([...selectedIds]);
  return {
    corpusId: context.corpusId,
    answerEvidenceIds: [...selectedIds],
    evidence: resolved.map(({ id, path, startLine, endLine, sha256, truncated }) => ({
      id,
      path,
      startLine,
      endLine,
      sha256,
      truncated,
    })),
  };
}

function modelParts(spec: string): { provider: string; modelId: string } {
  const separator = spec.indexOf("/");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error(`Shepherd model must be provider/model: ${spec}`);
  }
  return {
    provider: spec.slice(0, separator),
    modelId: spec.slice(separator + 1),
  };
}

async function loadQueryInput(
  parsed: ShepherdQueryCliArguments,
): Promise<QueryInput> {
  const absoluteContextPath = resolve(process.cwd(), parsed.contextPath);
  const contextPathInfo = await stat(absoluteContextPath);
  if (!contextPathInfo.isFile() && !contextPathInfo.isDirectory()) {
    throw new Error(`Shepherd context path is not a file or directory: ${parsed.contextPath}`);
  }
  if (parsed.contractPath && !contextPathInfo.isDirectory()) {
    throw new Error("Shepherd contract files require a directory context");
  }

  const contractFile = parsed.contractPath
    ? parseRlmContractFile(
        await readFile(resolve(process.cwd(), parsed.contractPath), "utf8"),
      )
    : undefined;
  return {
    context: await loadIndexedPathContext(absoluteContextPath),
    ...(contractFile ? { contractFile } : {}),
    ...(contractFile?.answerContract?.pattern
      ? { answerPattern: new RegExp(contractFile.answerContract.pattern, "u") }
      : {}),
  };
}

function writeQueryFailure(
  outputFormat: ShepherdQueryCliArguments["outputFormat"],
  error: unknown,
): void {
  const detail = error instanceof PiRlmRunError
    ? {
        status: "failed" as const,
        error: error.message,
        usage: error.usage,
        executionCount: error.trace.executionCount,
        pendingFacts: error.trace.facts.finalState?.pendingFactIds ?? [],
      }
    : {
        status: "failed" as const,
        error: error instanceof Error ? error.message : String(error),
      };
  if (outputFormat === "json") {
    process.stderr.write(`${JSON.stringify(detail, null, 2)}\n`);
    return;
  }
  process.stderr.write(`${detail.error}\n`);
}

export async function runShepherdQueryCommand(
  parsed: ShepherdQueryCliArguments,
): Promise<number> {
  let input: QueryInput;
  try {
    input = await loadQueryInput(parsed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Shepherd configuration or file error: ${detail}\n`);
    return 2;
  }

  try {
    const modelRuntime = await ModelRuntime.create();
    const spec = parsed.modelSpec ?? process.env.SHEPHERD_MODEL ?? "openai/gpt-5.6-luna";
    const { provider, modelId } = modelParts(spec);
    const model = modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Shepherd model is unavailable: ${spec}`);
    if (!modelRuntime.hasConfiguredAuth(model.provider)) {
      throw new Error(`Authentication is unavailable for ${model.provider}/${model.id}`);
    }
    const answerPattern = input.answerPattern;

    const result = await new PiRlmRunner(model, {
      cwd: process.cwd(),
      modelRuntime,
      isolation: { mode: parsed.isolationMode },
      limits: DEFAULT_RLM_LIMITS,
    }).run(input.context, parsed.question, {
      factContract: input.contractFile?.factContract,
      publicAnswerContract: input.contractFile?.answerContract,
      requireEvidenceProjection: input.contractFile === undefined,
      validateAnswer: answerPattern
        ? (candidate) => ({
            valid: answerPattern.test(candidate),
            reason: "The answer does not match the contract file pattern.",
          })
        : undefined,
    });
    const finalFacts = result.trace.facts.finalState;
    const evidenceReceipt = createQueryEvidenceReceipt(
      input.context,
      result.answerEvidenceIds,
      finalFacts,
    );
    const output = {
      status: "passed" as const,
      contextPath: parsed.contextPath,
      ...(parsed.contractPath ? { contractPath: parsed.contractPath } : {}),
      model: `${model.provider}/${model.id}`,
      isolationMode: parsed.isolationMode,
      context: {
        type: "files" as const,
        sourceRevision: input.context.sourceRevision,
        corpusId: evidenceReceipt.corpusId,
        files: input.context.files.length,
        totalBytes: input.context.totalBytes,
      },
      answerEvidenceIds: evidenceReceipt.answerEvidenceIds,
      evidence: evidenceReceipt.evidence,
      answer: result.response,
      executionCount: result.executionCount,
      answerRejections: result.answerRejections,
      usage: result.usage,
      facts: {
        grounded: finalFacts?.facts.filter((fact) => fact.status === "grounded").length ?? 0,
        pending: finalFacts?.pendingFactIds.length ?? 0,
        extractorFailures: result.trace.facts.extractions.filter(
          (event) => event.status === "failed",
        ).length,
        runtimeFinalizations: result.trace.facts.runtimeFinalizations,
      },
    };
    process.stdout.write(
      parsed.outputFormat === "json"
        ? `${JSON.stringify(output, null, 2)}\n`
        : `${result.response}\n\nShepherd completed: ${result.usage.modelCalls} model calls, ${result.usage.totalTokens} tokens\n`,
    );
    return 0;
  } catch (error) {
    writeQueryFailure(parsed.outputFormat, error);
    return 1;
  }
}
