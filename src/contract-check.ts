import type { RlmContractFile } from "./contract-file.ts";
import type { FileIndexedContext } from "./file-context.ts";
import {
  ReplWorkerClient,
  type ReplIsolationOptions,
} from "./repl-client.ts";
import type {
  FactExtractionFailureCode,
  PiRlmFactExtractionResult,
} from "./worker-protocol.ts";

export interface RlmContractCheckFact {
  factId: string;
  status: "pending" | "grounded";
  value?: string;
  evidenceIds: readonly string[];
  extractionStatus?: PiRlmFactExtractionResult["status"];
  failureCode?: FactExtractionFailureCode | "NO_TYPED_EXTRACTOR";
  sourcePath?: string;
  selectedLines?: number;
  capturedValues?: number;
}

export interface RlmContractCheckResult {
  status: "passed" | "failed";
  contractVersion: 1;
  sourceRevision: string;
  facts: readonly RlmContractCheckFact[];
  answer?: string;
  answerPattern: "passed" | "failed" | "not-configured";
  runtimeFinalized: boolean;
  extractionFailures: number;
  corpusActions: number;
  observedCharacters: number;
  modelCalls: 0;
  executionError?: string;
}

export interface RlmContractCheckOptions {
  isolation?: ReplIsolationOptions;
}

export async function runRlmContractCheck(
  context: FileIndexedContext,
  contractFile: RlmContractFile,
  options: RlmContractCheckOptions = {},
): Promise<RlmContractCheckResult> {
  let corpusActions = 0;
  const worker = await ReplWorkerClient.create(
    context,
    async () => {
      throw new Error("rlm-check must not dispatch model calls");
    },
    {
      isolation: options.isolation,
      factContract: contractFile.factContract,
      corpusCallObserver: () => {
        corpusActions += 1;
      },
    },
  );

  try {
    const execution = await worker.execute("void 0;");
    const factState = execution.factState;
    if (!factState) throw new Error("rlm-check worker did not return fact state");
    const extractionByFact = new Map(
      execution.factExtractions.map((event) => [event.factId, event]),
    );
    const facts = factState.facts.map((fact): RlmContractCheckFact => {
      const extraction = extractionByFact.get(fact.factId);
      const failureCode = extraction?.failureCode ??
        (fact.status === "pending" && fact.extractor === undefined
          ? "NO_TYPED_EXTRACTOR"
          : undefined);
      return {
        factId: fact.factId,
        status: fact.status,
        ...(fact.latestClaim ? { value: fact.latestClaim.value } : {}),
        evidenceIds: [...fact.evidenceIds],
        ...(extraction ? { extractionStatus: extraction.status } : {}),
        ...(failureCode ? { failureCode } : {}),
        ...(extraction?.sourcePath ? { sourcePath: extraction.sourcePath } : {}),
        ...(extraction ? { selectedLines: extraction.selectedLines } : {}),
        ...(extraction ? { capturedValues: extraction.capturedValues } : {}),
      };
    });
    const answer =
      execution.answerContentDefined === true ? execution.answerContent : undefined;
    const answerPattern = contractFile.answerContract?.pattern
      ? answer !== undefined &&
        new RegExp(contractFile.answerContract.pattern, "u").test(answer)
        ? "passed"
        : "failed"
      : "not-configured";
    const extractionFailures = execution.factExtractions.filter(
      (event) => event.status === "failed",
    ).length;
    const passed =
      execution.error === undefined &&
      factState.pendingFactIds.length === 0 &&
      extractionFailures === 0 &&
      answerPattern !== "failed" &&
      (contractFile.factContract.finalizer === undefined || execution.factFinalized);
    return {
      status: passed ? "passed" : "failed",
      contractVersion: contractFile.version,
      sourceRevision: factState.sourceRevision,
      facts,
      ...(answer !== undefined ? { answer } : {}),
      answerPattern,
      runtimeFinalized: execution.factFinalized,
      extractionFailures,
      corpusActions,
      observedCharacters: execution.observations.reduce(
        (total, observation) =>
          total +
          observation.evidence.reduce(
            (subtotal, evidence) => subtotal + evidence.text.length,
            0,
          ),
        0,
      ),
      modelCalls: 0,
      ...(execution.error ? { executionError: execution.error } : {}),
    };
  } finally {
    await worker.close();
  }
}

export function renderRlmContractCheckResult(
  contractPath: string,
  result: RlmContractCheckResult,
): string {
  const lines = [
    `${result.status === "passed" ? "PASS" : "FAIL"} ${contractPath}`,
    `revision: ${result.sourceRevision}`,
    "facts:",
  ];
  for (const fact of result.facts) {
    const details = [
      fact.extractionStatus ? `extraction=${fact.extractionStatus}` : undefined,
      fact.failureCode ? `failure=${fact.failureCode}` : undefined,
      fact.sourcePath ? `source=${fact.sourcePath}` : undefined,
      fact.selectedLines !== undefined ? `selected=${fact.selectedLines}` : undefined,
      fact.capturedValues !== undefined ? `captured=${fact.capturedValues}` : undefined,
      fact.evidenceIds.length > 0 ? `evidence=${fact.evidenceIds.join(",")}` : undefined,
    ].filter((value): value is string => value !== undefined);
    lines.push(
      `  ${fact.factId} ${fact.status}${fact.value ? ` value=${fact.value.slice(0, 160)}` : ""}` +
        `${details.length > 0 ? ` ${details.join(" ")}` : ""}`,
    );
  }
  if (result.answer !== undefined) {
    lines.push("answer:", `  ${result.answer}`);
  }
  lines.push(
    `answer pattern: ${result.answerPattern}`,
    `runtime finalized: ${String(result.runtimeFinalized)}`,
    `corpus actions: ${result.corpusActions}`,
    `observed characters: ${result.observedCharacters}`,
    `model calls: ${result.modelCalls}`,
  );
  if (result.executionError) lines.push(`execution error: ${result.executionError}`);
  return lines.join("\n");
}
