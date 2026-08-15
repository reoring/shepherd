import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { inspect } from "node:util";
import { createContext, Script, type Context as VmContext } from "node:vm";
import type {
  IndexedFileSearchRequest,
  IndexedObservationResult,
  IndexedOpenMatchOptions,
  IndexedReadSymbolOptions,
  IndexedSearchOpenRequest,
  IndexedSearchOpenResult,
  IndexedReadSymbolResult,
  IndexedSearchOptions,
  IndexedSearchHit,
  IndexedSymbolMatch,
  IndexedSourceSlice,
} from "./file-context.ts";
import {
  applyFactExtractor,
  FactExtractorError,
  validateFactExtractor,
} from "./fact-extractor.ts";
import {
  renderFactFinalizer,
  validateFactFinalizer,
} from "./fact-finalizer.ts";


import { parsePatchPlan } from "./patch-plan.ts";
import type {
  PatchPlan,
  PatchPrecondition,
  PatchPreconditionRequest,
} from "./patch-plan.ts";
import type {
  CorpusCallRequest,
  CorpusHistoryEntry,
  EvidenceQuery,
  ParentToWorkerMessage,
  PiRlmFactClaimInput,
  PiRlmFactClaimSnapshot,
  PiRlmFactContract,
  PiRlmEvidenceProjectionRequest,
  PiRlmFactExtractionEvent,
  PiRlmFactExtractionResult,
  PiRlmFactEvent,
  PiRlmFactFinalizationBlock,
  PiRlmFactExtractor,
  PiRlmFactRequirement,
  PiRlmFactSnapshot,
  PiRlmFactStateSnapshot,
  PreparedPatchReplace,
  ReplBudgetSnapshot,
  SubcallReplan,
  WorkerCallKind,
  WorkerCallResult,
  WorkerContextDescriptor,
  WorkerToParentMessage,
} from "./worker-protocol.ts";

const MAX_STDOUT_CHARS = 1_024;
const MAX_FACT_REQUIREMENTS = 16;
const MAX_FACT_ID_CHARACTERS = 64;
const MAX_FACT_DESCRIPTION_CHARACTERS = 240;
const MAX_FACT_SOURCE_HINT_CHARACTERS = 512;
const MAX_FACT_VALUE_CHARACTERS = 2_048;
const MAX_FACT_RATIONALE_CHARACTERS = 512;
const MAX_FACT_QUOTE_CHARACTERS = 512;
const MAX_FACT_SUPPORTS = 16;
const MAX_FACT_QUOTE_PREVIEW_CHARACTERS = 160;

interface PendingCall {
  resolve: (results: WorkerCallResult[]) => void;
  reject: (error: Error) => void;
}
interface PendingCorpusCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}
interface AnswerState {
  content: unknown;
  ready: boolean;
}

type AnswerHandle = AnswerState & ((value: unknown) => void);

class ReplanRequiredError extends Error {
  readonly replan: SubcallReplan;

  constructor(replan: SubcallReplan) {
    super(replan.message);
    this.name = "ReplanRequiredError";
    this.replan = replan;
  }
}


let vmContext: VmContext | undefined;
let answer: AnswerHandle | undefined;
let requireEvidenceProjection = false;
let projectedAnswerContent: string | undefined;
let stdout: string[] = [];
let observations: IndexedObservationResult[] = [];
let searchResults: IndexedSearchHit[] = [];
let nextCallId = 0;
let indexedFilePaths: readonly string[] = [];
let budgetSnapshot: ReplBudgetSnapshot = {
  maxObservationCharacters: 0,
  finalizationReserveTokens: 0,
};

function getBudget(): ReplBudgetSnapshot {
  return Object.freeze({ ...budgetSnapshot });
}
const pendingCalls = new Map<string, PendingCall>();
const pendingCorpusCalls = new Map<string, PendingCorpusCall>();

interface MutableCorpusHistoryEntry extends CorpusHistoryEntry {}

type CachedCorpusAction =
  | {
      value: unknown;
      history: MutableCorpusHistoryEntry;
    }
  | {
      error: string;
      history: MutableCorpusHistoryEntry;
    };


interface FactClaimRecord {
  canonical: string;
  snapshot: PiRlmFactClaimSnapshot;
}

interface MutableFact {
  requirement: PiRlmFactRequirement;
  claims: FactClaimRecord[];
}

const reviewedEvidence = new Set<string>();
const observedEvidence = new Map<string, IndexedSourceSlice>();
let evidenceSourceRevision: string | undefined;
const facts = new Map<string, MutableFact>();
let factSourceRevision: string | undefined;
let emptyFactState: PiRlmFactStateSnapshot | undefined;
let factContract: PiRlmFactContract | undefined;
let factEvents: PiRlmFactEvent[] = [];
let factExtractionEvents: PiRlmFactExtractionEvent[] = [];
let automaticFactExtractionAttempted = false;

let patchPlanningEnabled = false;
let patchSourceRevision: string | undefined;
let submittedPatchPlan: PatchPlan | undefined;
let preparedPatchReplace: PatchPrecondition | undefined;
const patchPreconditions = new Map<string, PatchPrecondition>();
let patchSubmitAttempts = 0;
let patchSubmitRejections = 0;
let patchSubmissionExhausted = false;
let patchSubmissionInProgress = false;

function initializeFactState(
  sourceRevision: string,
  contract: PiRlmFactContract | undefined,
): void {
  reviewedEvidence.clear();
  observedEvidence.clear();
  evidenceSourceRevision = sourceRevision;
  facts.clear();
  factExtractionEvents = [];
  factEvents = [];
  automaticFactExtractionAttempted = false;
  emptyFactState = Object.freeze({
    sourceRevision,
    facts: Object.freeze([]),
    values: Object.freeze({}),
    pendingFactIds: Object.freeze([]),
    factsById: Object.freeze({}),
  });
  factContract = contract ? structuredClone(contract) : undefined;
  factSourceRevision = factContract ? sourceRevision : undefined;
  if (!factContract) return;
  if (
    !Array.isArray(factContract.requirements) ||
    factContract.requirements.length < 1 ||
    factContract.requirements.length > MAX_FACT_REQUIREMENTS
  ) {
    throw new RangeError(
      `fact contract requirements must contain 1-${MAX_FACT_REQUIREMENTS} entries`,
    );
  }
  for (const requirement of factContract.requirements) {
    if (
      typeof requirement.id !== "string" ||
      requirement.id.length > MAX_FACT_ID_CHARACTERS ||
      !/^[a-z][a-z0-9-]*$/u.test(requirement.id)
    ) {
      throw new TypeError(
        `fact id must be a lowercase kebab-case identifier up to ${MAX_FACT_ID_CHARACTERS} characters`,
      );
    }
    if (facts.has(requirement.id)) {
      throw new Error(`fact contract contains duplicate id: ${requirement.id}`);
    }
    if (
      typeof requirement.description !== "string" ||
      requirement.description.trim().length === 0 ||
      requirement.description.length > MAX_FACT_DESCRIPTION_CHARACTERS
    ) {
      throw new TypeError(
        `fact description must contain 1-${MAX_FACT_DESCRIPTION_CHARACTERS} characters`,
      );
    }
    if (
      requirement.sourceHint !== undefined &&
      (typeof requirement.sourceHint !== "string" ||
        requirement.sourceHint.trim().length === 0 ||
        requirement.sourceHint.length > MAX_FACT_SOURCE_HINT_CHARACTERS)
    ) {
      throw new TypeError(
        `fact sourceHint must contain 1-${MAX_FACT_SOURCE_HINT_CHARACTERS} characters`,
      );
    }
    if (requirement.sourceHint !== undefined && requirement.extractor !== undefined) {
      throw new Error(`fact ${requirement.id} cannot define both sourceHint and extractor`);
    }
    if (requirement.extractor !== undefined) {
      validateFactExtractor(requirement.extractor);
    }
    if (!["quoted", "derived", "quoted-list"].includes(requirement.grounding)) {
      throw new TypeError(`fact grounding is invalid for ${requirement.id}`);
    }
    if (
      !Number.isInteger(requirement.minSupports) ||
      requirement.minSupports < 1 ||
      requirement.minSupports > MAX_FACT_SUPPORTS
    ) {
      throw new RangeError(
        `fact minSupports must be an integer from 1-${MAX_FACT_SUPPORTS}`,
      );
    }
    facts.set(requirement.id, {
      requirement: Object.freeze({
        ...requirement,
        status: "pending",
        claimCount: 0,
      }),
      claims: [],
    });
  }
  validateFactFinalizer(factContract);
}

function factStateSnapshot(): PiRlmFactStateSnapshot | undefined {
  if (!factSourceRevision) return undefined;
  const snapshots = [...facts.values()].map(({ requirement, claims }) => {
    const latestClaim = claims.at(-1)?.snapshot;
    return Object.freeze({
      factId: requirement.id,
      description: requirement.description,
      grounding: requirement.grounding,
      minSupports: requirement.minSupports,
      ...(requirement.sourceHint !== undefined
        ? { sourceHint: requirement.sourceHint }
        : {}),
      status: latestClaim ? "grounded" as const : "pending" as const,
      claimCount: claims.length,
      evidenceIds: Object.freeze(
        latestClaim
          ? [...new Set(latestClaim.supports.map((support) => support.evidenceId))]
          : [],
      ),
      ...(latestClaim ? { latestClaim } : {}),
    });
  });
  const values = Object.freeze(
    Object.fromEntries(
      snapshots.flatMap((fact) =>
        fact.latestClaim ? [[fact.factId, fact.latestClaim.value]] : [],
      ),
    ),
  );
  const pendingFactIds = Object.freeze(
    snapshots
      .filter((fact) => fact.status === "pending")
      .map((fact) => fact.factId),
  );
  const factsById = Object.freeze(
    Object.fromEntries(snapshots.map((fact) => [fact.factId, fact])),
  );
  return Object.freeze({
    sourceRevision: factSourceRevision,
    facts: Object.freeze(snapshots),
    values,
    pendingFactIds,
    factsById,
  });
}

function getFactState(): PiRlmFactStateSnapshot {
  const snapshot = factStateSnapshot() ?? emptyFactState;
  if (!snapshot) throw new Error("fact state is not initialized");
  return snapshot;
}

function getObservedEvidence(
  evidenceId: string,
): IndexedSourceSlice & { evidenceId: string } {
  if (typeof evidenceId !== "string") {
    throw new TypeError("get_observed_evidence evidenceId must be a string");
  }
  const evidence = observedEvidence.get(evidenceId);
  if (!evidence || evidence.revision !== evidenceSourceRevision) {
    throw new Error(
      `get_observed_evidence requires current observed evidence: ${evidenceId}`,
    );
  }
  if (!reviewedEvidence.has(evidenceId)) {
    reviewedEvidence.add(evidenceId);
    observations.push({
      evidence: [evidence],
      omittedDuplicateIds: [],
      remainingObservationCharacters: 0,
      truncated: evidence.truncated,
    });
  }
  return Object.freeze({ ...evidence, evidenceId: evidence.id });
}

function factInputEvidenceIds(input: unknown): string[] {
  if (!input || typeof input !== "object" || !("supports" in input)) return [];
  const supports = (input as { supports?: unknown }).supports;
  if (!Array.isArray(supports)) return [];
  return supports.flatMap((support) =>
    support &&
    typeof support === "object" &&
    "evidenceId" in support &&
    typeof support.evidenceId === "string"
      ? [support.evidenceId]
      : [],
  );
}

function recordFact(input: unknown): PiRlmFactSnapshot {
  let factId = "<invalid>";
  try {
    if (!factSourceRevision) throw new Error("fact contract is not configured");
    if (!input || typeof input !== "object") {
      throw new TypeError("record_fact input must be an object");
    }
    const candidate = input as PiRlmFactClaimInput;
    if (typeof candidate.factId !== "string") {
      throw new TypeError("record_fact factId must be a string");
    }
    factId = candidate.factId;
    const fact = facts.get(candidate.factId);
    if (!fact) throw new Error(`record_fact unknown fact id: ${candidate.factId}`);
    if (
      typeof candidate.value !== "string" ||
      candidate.value.trim().length === 0 ||
      candidate.value.length > MAX_FACT_VALUE_CHARACTERS
    ) {
      throw new TypeError(
        `record_fact value must contain 1-${MAX_FACT_VALUE_CHARACTERS} characters`,
      );
    }
    if (
      candidate.rationale !== undefined &&
      (typeof candidate.rationale !== "string" ||
        candidate.rationale.length > MAX_FACT_RATIONALE_CHARACTERS)
    ) {
      throw new TypeError(
        `record_fact rationale must not exceed ${MAX_FACT_RATIONALE_CHARACTERS} characters`,
      );
    }
    if (
      !Array.isArray(candidate.supports) ||
      candidate.supports.length < 1 ||
      candidate.supports.length > MAX_FACT_SUPPORTS
    ) {
      throw new RangeError(
        `record_fact supports must contain 1-${MAX_FACT_SUPPORTS} entries`,
      );
    }
    const uniqueSupports = new Set<string>();
    const supports = candidate.supports.map((support) => {
      if (
        !support ||
        typeof support !== "object" ||
        typeof support.evidenceId !== "string" ||
        typeof support.quote !== "string"
      ) {
        throw new TypeError(
          "record_fact supports require string evidenceId and quote fields",
        );
      }
      if (
        support.quote.length < 1 ||
        support.quote.length > MAX_FACT_QUOTE_CHARACTERS
      ) {
        throw new RangeError(
          `record_fact quote must contain 1-${MAX_FACT_QUOTE_CHARACTERS} characters`,
        );
      }
      const evidence = observedEvidence.get(support.evidenceId);
      if (!evidence || evidence.revision !== factSourceRevision) {
        throw new Error(
          `record_fact requires current observed evidence: ${support.evidenceId}`,
        );
      }
      if (!evidence.text.includes(support.quote)) {
        throw new Error(
          `record_fact quote is not present in observed evidence: ${support.evidenceId}. ` +
          `Inspect the exact bounded text with get_observed_evidence("${support.evidenceId}")`,
        );
      }
      if (
        fact.requirement.grounding === "quoted-list" &&
        !evidence.text
          .split("\n")
          .some((line) => line.trim() === support.quote.trim())
      ) {
        throw new Error(
          `record_fact quoted-list support must be one complete observed source line: ${support.evidenceId}`,
        );
      }
      uniqueSupports.add(`${support.evidenceId}\0${support.quote}`);
      return Object.freeze({
        evidenceId: support.evidenceId,
        path: evidence.path,
        startLine: evidence.startLine,
        endLine: evidence.endLine,
        quoteHash: createHash("sha256").update(support.quote).digest("hex"),
        quotePreview: support.quote.slice(0, MAX_FACT_QUOTE_PREVIEW_CHARACTERS),
      });
    });
    if (uniqueSupports.size < fact.requirement.minSupports) {
      throw new Error(
        `record_fact requires ${fact.requirement.minSupports} unique supports for ${factId}`,
      );
    }
    if (
      fact.requirement.grounding === "quoted" &&
      !candidate.supports.some((support) => support.quote.includes(candidate.value))
    ) {
      throw new Error(`record_fact quoted fact value is absent from its supports`);
    }
    if (fact.requirement.grounding === "quoted-list") {
      const values = candidate.value.split(",").map((value) => value.trim());
      const quotedValues = candidate.supports.map((support) =>
        support.quote.trim().replace(/,$/u, "").trim(),
      );
      if (
        values.some((value) => value.length === 0) ||
        new Set(values).size !== values.length ||
        values.length !== uniqueSupports.size ||
        values.some((value) => !quotedValues.includes(value))
      ) {
        throw new Error(
          "record_fact quoted-list values must exactly match distinct complete-line supports",
        );
      }
    }
    const canonical = JSON.stringify({
      value: candidate.value,
      supports: candidate.supports,
      rationale: candidate.rationale,
    });
    const latest = fact.claims.at(-1);
    if (latest?.canonical === canonical) {
      return factStateSnapshot()!.facts.find((snapshot) => snapshot.factId === factId)!;
    }
    const version = fact.claims.length + 1;
    const snapshot = Object.freeze({
      version,
      value: candidate.value,
      supports: Object.freeze(supports),
      ...(candidate.rationale !== undefined
        ? { rationale: candidate.rationale }
        : {}),
    });
    fact.claims.push({ canonical, snapshot });
    factEvents.push({
      factId,
      event: version === 1 ? "grounded" : "revised",
      version,
      evidenceIds: [...new Set(candidate.supports.map((support) => support.evidenceId))],
    });
    return factStateSnapshot()!.facts.find((factSnapshot) => factSnapshot.factId === factId)!;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    factEvents.push({
      factId,
      event: "rejected",
      reason,
      evidenceIds: factInputEvidenceIds(input),
    });
    throw error;
  }
}

async function extractFact(factId: string): Promise<PiRlmFactExtractionResult> {
  let sourceKind: PiRlmFactExtractionEvent["sourceKind"];
  let sourcePath: string | undefined;
  let evidenceIds: string[] = [];
  let scopedLines = 0;
  let selectedLines = 0;
  let capturedValues = 0;
  try {
    if (typeof factId !== "string") {
      throw new FactExtractorError(
        "INVALID_EXTRACTOR",
        "extract_fact factId must be a string",
      );
    }
    const fact = facts.get(factId);
    if (!fact) {
      throw new FactExtractorError(
        "INVALID_EXTRACTOR",
        `extract_fact unknown fact id: ${factId}`,
      );
    }
    if (fact.claims.length > 0) {
      factExtractionEvents.push({
        factId,
        sourceKind: fact.requirement.extractor?.source.kind,
        evidenceIds: [],
        scopedLines: 0,
        selectedLines: 0,
        capturedValues: 0,
        status: "unchanged",
      });
      return { status: "unchanged", factId };
    }
    const extractor = fact.requirement.extractor;
    if (!extractor) {
      factExtractionEvents.push({
        factId,
        evidenceIds: [],
        scopedLines: 0,
        selectedLines: 0,
        capturedValues: 0,
        status: "skipped",
      });
      return { status: "skipped", factId };
    }
    validateFactExtractor(extractor);
    sourceKind = extractor.source.kind;
    let issuedSlice: IndexedSourceSlice;
    if (extractor.source.kind === "symbol") {
      const result = await readSymbol(extractor.source.name, {
        before: extractor.source.before,
        after: extractor.source.after,
      });
      if (result.status !== "resolved") {
        throw new FactExtractorError(
          result.status === "not_found"
            ? "SOURCE_NOT_FOUND"
            : "SOURCE_AMBIGUOUS",
          result.status === "not_found"
            ? `extractor symbol was not found: ${extractor.source.name}`
            : `extractor symbol is ambiguous: ${extractor.source.name}`,
        );
      }
      issuedSlice = result.slice;
    } else {
      const result = await searchOpen({
        literal: extractor.source.literal,
        pathPrefix: extractor.source.path,
        maxResults: 1,
        before: extractor.source.before,
        after: extractor.source.after,
      });
      if (result.results.length === 0) {
        throw new FactExtractorError(
          "SOURCE_NOT_FOUND",
          `extractor search was not found: ${extractor.source.literal}`,
        );
      }
      if (result.truncated) {
        throw new FactExtractorError(
          "SOURCE_AMBIGUOUS",
          `extractor search is ambiguous: ${extractor.source.literal}`,
        );
      }
      issuedSlice = result.results[0]!.slice;
    }
    const evidence = observedEvidence.get(issuedSlice.id);
    if (!evidence) {
      throw new FactExtractorError(
        "SOURCE_NOT_FOUND",
        `extractor source was not observed: ${issuedSlice.id}`,
      );
    }
    sourcePath = evidence.path;
    evidenceIds = [evidence.id];
    const output = applyFactExtractor(extractor, evidence.text);
    scopedLines = output.scopedLineCount;
    selectedLines = output.selectedLineCount;
    capturedValues = output.capturedValueCount;
    recordFact({
      factId,
      value: output.value,
      supports: output.supportQuotes.map((quote) => ({
        evidenceId: evidence.id,
        quote,
      })),
      rationale: `typed-extractor:${factId}`,
    });
    factExtractionEvents.push({
      factId,
      sourceKind,
      sourcePath,
      evidenceIds,
      scopedLines,
      selectedLines,
      capturedValues,
      status: "grounded",
    });
    return {
      status: "grounded",
      factId,
      value: output.value,
      evidenceIds,
      matchCount: output.capturedValueCount,
    };
  } catch (error) {
    const extractorError =
      error instanceof FactExtractorError
        ? error
        : new FactExtractorError(
            "GROUNDING_REJECTED",
            error instanceof Error ? error.message : String(error),
          );
    factExtractionEvents.push({
      factId: typeof factId === "string" ? factId : "<invalid>",
      sourceKind,
      sourcePath,
      evidenceIds,
      scopedLines,
      selectedLines,
      capturedValues,
      status: "failed",
      failureCode: extractorError.code,
    });
    return {
      status: "failed",
      factId: typeof factId === "string" ? factId : "<invalid>",
      code: extractorError.code,
      message: extractorError.message,
    };
  }
}

async function extractPendingFacts(): Promise<{
  results: readonly PiRlmFactExtractionResult[];
  state: PiRlmFactStateSnapshot;
}> {
  const results: PiRlmFactExtractionResult[] = [];
  for (const factId of getFactState().pendingFactIds) {
    results.push(await extractFact(factId));
  }
  return Object.freeze({
    results: Object.freeze(results),
    state: getFactState(),
  });
}

async function extractTypedPendingFactsOnce(): Promise<void> {
  if (automaticFactExtractionAttempted) return;
  automaticFactExtractionAttempted = true;
  for (const [factId, fact] of facts) {
    if (fact.claims.length === 0 && fact.requirement.extractor !== undefined) {
      await extractFact(factId);
    }
  }
}

function applyFactFinalizer(): boolean {
  if (!factContract || !answer) return false;
  const state = factStateSnapshot();
  if (!state) return false;
  const content = renderFactFinalizer(factContract, state);
  if (content === undefined) return false;
  answer.content = content;
  answer.ready = true;
  if (vmContext) vmContext.answer = answer;
  return true;
}

function incompleteFactBlock(): PiRlmFactFinalizationBlock | undefined {
  if (!answer) return undefined;
  const snapshot = factStateSnapshot();
  if (!snapshot || !answer.ready) return undefined;
  const pendingFactIds = snapshot.facts
    .filter((fact) => fact.status === "pending")
    .map((fact) => fact.factId);
  if (pendingFactIds.length === 0) return undefined;
  answer.content = "";
  answer.ready = false;
  if (vmContext) vmContext.answer = answer;
  return { code: "RLM_FACTS_INCOMPLETE", pendingFactIds };
}
const corpusActionCache = new Map<string, CachedCorpusAction>();
const corpusHistoryEntries: MutableCorpusHistoryEntry[] = [];
const MAX_VISIBLE_CORPUS_HISTORY = 12;
function resetAnswerSubmission(): void {
  if (!answer) return;
  answer.content = "";
  answer.ready = false;
  projectedAnswerContent = undefined;
  if (vmContext) vmContext.answer = answer;
}

function projectAnswer(input: unknown): Readonly<{
  value: string;
  evidenceId: string;
  supportQuotes: readonly string[];
}> {
  if (!answer) throw new Error("answer state is not initialized");
  if (!input || typeof input !== "object") {
    throw new TypeError("project_answer input must be an object");
  }
  const request = input as Partial<PiRlmEvidenceProjectionRequest>;
  if (typeof request.evidenceId !== "string") {
    throw new TypeError("project_answer evidenceId must be a string");
  }
  if (typeof request.lineContains !== "string" || request.lineContains.length === 0) {
    throw new TypeError("project_answer lineContains must not be empty");
  }
  let capture: PiRlmFactExtractor["capture"];
  if (request.valueKind === "number" || request.valueKind === "identifier") {
    if (typeof request.valueAfter !== "string" || request.valueAfter.length === 0) {
      throw new TypeError("project_answer valueAfter must not be empty");
    }
    capture = {
      kind: request.valueKind === "number" ? "number-after" : "identifier-after",
      literal: request.valueAfter,
    };
  } else if (request.valueKind === "quoted") {
    const quotedIndex = request.quotedIndex;
    if (typeof quotedIndex !== "number" || !Number.isInteger(quotedIndex)) {
      throw new TypeError("project_answer quotedIndex must be an integer");
    }
    capture = { kind: "quoted-string", index: quotedIndex };
  } else {
    throw new TypeError(
      "project_answer valueKind must be number, identifier, or quoted",
    );
  }
  const evidence = observedEvidence.get(request.evidenceId);
  if (!evidence || evidence.revision !== evidenceSourceRevision) {
    throw new Error(
      `project_answer requires current observed evidence: ${request.evidenceId}`,
    );
  }
  const extractor: PiRlmFactExtractor = {
    source: {
      kind: "search-open",
      literal: "project_answer",
      path: evidence.path,
      before: 0,
      after: 0,
    },
    select: { kind: "contains-all", literals: [request.lineContains] },
    capture,
    reduce: { kind: "single", exactCount: 1 },
  };
  const output = applyFactExtractor(extractor, evidence.text);
  answer.content = output.value;
  answer.ready = true;
  projectedAnswerContent = output.value;
  if (vmContext) vmContext.answer = answer;
  return Object.freeze({
    value: output.value,
    evidenceId: request.evidenceId,
    supportQuotes: output.supportQuotes,
  });
}

function enforceEvidenceProjection(): void {
  if (!requireEvidenceProjection || !answer?.ready) return;
  const candidate =
    answer.content === undefined ? undefined : String(answer.content);
  if (
    projectedAnswerContent !== undefined &&
    candidate === projectedAnswerContent
  ) {
    return;
  }
  resetAnswerSubmission();
  throw new Error(
    "RLM_EVIDENCE_PROJECTION_REQUIRED: contract-free file answers must use project_answer({evidenceId,lineContains,valueKind,valueAfter|quotedIndex}). Direct answer.content submissions are rejected.",
  );
}

function applyAnswerValue(value: unknown): void {
  if (!answer) return;
  projectedAnswerContent = undefined;
  if (value !== null && typeof value === "object" && "content" in value) {
    const candidate = value as { content: unknown; ready?: unknown };
    answer.content = candidate.content;
    answer.ready = "ready" in candidate ? candidate.ready === true : true;
    return;
  }
  answer.content = value;
  answer.ready = true;
}

function createAnswerHandle(): AnswerHandle {
  const handle = ((value: unknown) => applyAnswerValue(value)) as AnswerHandle;
  handle.content = "";
  handle.ready = false;
  return handle;
}

function syncAnswerBinding(): void {
  if (!vmContext || !answer) return;
  const binding = vmContext.answer as unknown;
  if (binding === answer) return;
  applyAnswerValue(binding);
  vmContext.answer = answer;
}


function send(message: WorkerToParentMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function requestCalls(
  kind: WorkerCallKind,
  queries: EvidenceQuery[],
  model?: string,
): Promise<WorkerCallResult[]> {
  const id = `call-${nextCallId}`;
  nextCallId += 1;
  const { promise, resolve, reject } = Promise.withResolvers<WorkerCallResult[]>();
  pendingCalls.set(id, { resolve, reject });
  send({ type: "call", id, kind, queries, model });
  return promise;
}
function requestCorpus(request: CorpusCallRequest): Promise<unknown> {
  const id = `corpus-${nextCallId}`;
  nextCallId += 1;
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  pendingCorpusCalls.set(id, { resolve, reject });
  send({ type: "corpus_call", id, request });
  return promise;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => [
        key,
        canonicalValue((value as Record<string, unknown>)[key]),
      ]),
  );
}

function corpusActionKey(request: CorpusCallRequest): string {
  return JSON.stringify(canonicalValue(request));
}

function collectEvidenceIds(
  value: unknown,
  ids = new Set<string>(),
  depth = 0,
): Set<string> {
  if (depth > 5 || value === null || value === undefined) return ids;
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceIds(item, ids, depth + 1);
    return ids;
  }
  if (typeof value !== "object") return ids;
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" && record.id.startsWith("evidence_")) {
    ids.add(record.id);
  }
  for (const nested of Object.values(record)) {
    collectEvidenceIds(nested, ids, depth + 1);
  }
  return ids;
}

function resultLabel(value: unknown): string {
  if (Array.isArray(value)) return `results=${value.length}`;
  if (!value || typeof value !== "object") return "ok";
  const record = value as Record<string, unknown>;
  if (typeof record.status === "string") return `status=${record.status}`;
  if (Array.isArray(record.results)) return `results=${record.results.length}`;
  return "ok";
}

function corpusHistorySnapshot(): CorpusHistoryEntry[] {
  const visible = corpusHistoryEntries
    .slice(-MAX_VISIBLE_CORPUS_HISTORY)
    .map((entry) =>
      Object.freeze({
        ...entry,
        evidenceIds: Object.freeze([...entry.evidenceIds]) as unknown as string[],
      }),
    );
  return Object.freeze(visible) as unknown as CorpusHistoryEntry[];
}

function getCorpusHistory(): CorpusHistoryEntry[] {
  return corpusHistorySnapshot();
}

async function requestCachedCorpus(
  request: CorpusCallRequest,
): Promise<{ value: unknown; cached: boolean }> {
  const key = corpusActionKey(request);
  const cached = corpusActionCache.get(key);
  if (cached) {
    cached.history.cacheHits += 1;
    if ("error" in cached) throw new Error(cached.error);
    return { value: structuredClone(cached.value), cached: true };
  }

  try {
    const value = await requestCorpus(request);
    const history: MutableCorpusHistoryEntry = {
      sequence: corpusHistoryEntries.length + 1,
      operation: request.operation,
      key,
      summary: `${key} ${resultLabel(value)}`.slice(0, 320),
      evidenceIds: [...collectEvidenceIds(value)],
      cacheHits: 0,
    };
    corpusHistoryEntries.push(history);
    corpusActionCache.set(key, { value: structuredClone(value), history });
    return { value, cached: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const history: MutableCorpusHistoryEntry = {
      sequence: corpusHistoryEntries.length + 1,
      operation: request.operation,
      key,
      summary: `${key} error=${message}`.slice(0, 320),
      evidenceIds: [],
      cacheHits: 0,
    };
    corpusHistoryEntries.push(history);
    corpusActionCache.set(key, { error: message, history });
    throw error;
  }
}

function listFiles(prefix?: string): string[] {
  if (prefix === undefined) return [...indexedFilePaths];
  if (typeof prefix !== "string") throw new TypeError("list_files prefix must be a string");
  return indexedFilePaths.filter((path) => path.startsWith(prefix));
}

function normalizeReadFilePath(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("read_file path must be a string or { path }");
  }
  const record = input as Record<string, unknown>;
  for (const field in record) {
    if (!Object.hasOwn(record, field)) {
      throw new TypeError(`read_file input contains inherited field ${field}`);
    }
    if (field !== "path") {
      throw new TypeError(`read_file input contains unknown field ${field}`);
    }
  }
  if (!Object.hasOwn(record, "path") || typeof record.path !== "string") {
    throw new TypeError("read_file path must be a string or { path }");
  }
  return record.path;
}

const SEARCH_FILE_REQUEST_FIELDS: Record<string, true> = {
  literal: true,
  query: true,
  pathPrefix: true,
  caseSensitive: true,
  maxResults: true,
};

function normalizeSearchFilesRequest(input: unknown): IndexedFileSearchRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("search_files request must be an object");
  }
  const record = input as Record<string, unknown>;
  for (const field in record) {
    if (!Object.hasOwn(record, field)) {
      throw new TypeError(`search_files request contains inherited field ${field}`);
    }
    if (SEARCH_FILE_REQUEST_FIELDS[field] !== true) {
      throw new TypeError(`search_files request contains unknown field ${field}`);
    }
  }
  const hasLiteral = Object.hasOwn(record, "literal");
  const hasQuery = Object.hasOwn(record, "query");
  if (hasLiteral === hasQuery || typeof (hasLiteral ? record.literal : record.query) !== "string") {
    throw new TypeError("search_files requires exactly one string literal or query");
  }
  if (record.pathPrefix !== undefined && typeof record.pathPrefix !== "string") {
    throw new TypeError("search_files pathPrefix must be a string");
  }
  if (record.caseSensitive !== undefined && typeof record.caseSensitive !== "boolean") {
    throw new TypeError("search_files caseSensitive must be a boolean");
  }
  if (record.maxResults !== undefined && typeof record.maxResults !== "number") {
    throw new TypeError("search_files maxResults must be a number");
  }
  return {
    literal: (hasLiteral ? record.literal : record.query) as string,
    ...(record.pathPrefix !== undefined ? { pathPrefix: record.pathPrefix as string } : {}),
    ...(record.caseSensitive !== undefined ? { caseSensitive: record.caseSensitive as boolean } : {}),
    ...(record.maxResults !== undefined ? { maxResults: record.maxResults as number } : {}),
  };
}

async function readFile(input: unknown): Promise<string> {
  const path = normalizeReadFilePath(input);
  const value = await requestCorpus({ operation: "read_file", path });
  if (typeof value !== "string") throw new TypeError("read_file received a non-string result");
  return value;
}

async function searchFiles(input: unknown): Promise<IndexedSearchHit[]> {
  const request = normalizeSearchFilesRequest(input);
  const { value, cached } = await requestCachedCorpus({
    operation: "search_files",
    request,
  });
  if (!Array.isArray(value)) throw new TypeError("search_files received a non-array result");
  const hits = value as IndexedSearchHit[];
  if (!cached) searchResults.push(...hits);
  return hits;
}

async function searchOpen(
  request: IndexedSearchOpenRequest,
): Promise<IndexedSearchOpenResult> {
  if (!request || typeof request !== "object") {
    throw new TypeError("search_open request must be an object");
  }
  const { value, cached } = await requestCachedCorpus({
    operation: "search_open",
    request,
  });
  if (!value || typeof value !== "object" || !("results" in value)) {
    throw new TypeError("search_open received an invalid result");
  }
  const result = value as IndexedSearchOpenResult;
  if (!cached) {
    searchResults.push(...result.results.map(({ match }) => match));
    await observeEvidence(result.results.map(({ slice }) => slice.id));
  }
  return result;
}
async function readLines(
  path: string,
  startLine: number,
  endLine: number,
): Promise<IndexedSourceSlice> {
  const { value, cached } = await requestCachedCorpus({
    operation: "read_lines",
    path,
    startLine,
    endLine,
  });
  if (!value || typeof value !== "object" || !("id" in value)) {
    throw new TypeError("read_lines received an invalid source slice");
  }
  const slice = value as IndexedSourceSlice;
  if (!cached) await observeEvidence([slice.id]);
  return slice;
}

async function openMatch(
  matchId: string,
  options?: IndexedOpenMatchOptions,
): Promise<IndexedSourceSlice> {
  const { value, cached } = await requestCachedCorpus({
    operation: "open_match",
    matchId,
    options,
  });
  if (!value || typeof value !== "object" || !("id" in value)) {
    throw new TypeError("open_match received an invalid source slice");
  }
  const slice = value as IndexedSourceSlice;
  if (!cached) await observeEvidence([slice.id]);
  return slice;
}

async function readSymbol(
  name: string,
  options?: IndexedReadSymbolOptions,
): Promise<IndexedReadSymbolResult> {
  if (typeof name !== "string") throw new TypeError("read_symbol name must be a string");
  const { value, cached } = await requestCachedCorpus({
    operation: "read_symbol",
    name,
    options,
  });
  if (
    !value ||
    typeof value !== "object" ||
    !("status" in value) ||
    !["resolved", "not_found", "ambiguous"].includes(String(value.status))
  ) {
    throw new TypeError("read_symbol received an invalid result");
  }
  const result = value as IndexedReadSymbolResult;
  const matches =
    result.status === "resolved" ? [result.match] : result.matches;
  if (!cached) {
    searchResults.push(
      ...matches.map(({ id, path, line, preview }) => ({ id, path, line, preview })),
    );
    if (result.status === "resolved") {
      await observeEvidence([result.slice.id]);
    }
  }
  return result;
}

async function observeEvidence(evidenceIds: string[]): Promise<IndexedObservationResult> {
  if (!Array.isArray(evidenceIds) || evidenceIds.some((id) => typeof id !== "string")) {
    throw new TypeError("observe evidenceIds must be an array of strings");
  }
  const value = await requestCorpus({ operation: "observe", evidenceIds });
  if (!value || typeof value !== "object" || !("evidence" in value)) {
    throw new TypeError("observe received an invalid observation result");
  }
  const observation = value as IndexedObservationResult;
  for (const slice of observation.evidence) {
    observedEvidence.set(slice.id, Object.freeze({ ...slice }));
  }
  observations.push(observation);
  return observation;
}

async function findSymbol(
  name: string,
  options?: IndexedSearchOptions,
): Promise<IndexedSymbolMatch[]> {
  if (typeof name !== "string") throw new TypeError("find_symbol name must be a string");
  const { value, cached } = await requestCachedCorpus({
    operation: "find_symbol",
    name,
    options,
  });
  if (!Array.isArray(value)) throw new TypeError("find_symbol received a non-array result");
  const hits = value as IndexedSymbolMatch[];
  if (!cached) {
    searchResults.push(
      ...hits.map(({ id, path, line, preview }) => ({ id, path, line, preview })),
    );
  }
  return hits;
}

function patchPreconditionKey(request: PatchPreconditionRequest): string {
  return [
    request.path,
    request.evidenceId,
    request.operation,
    String(request.startLine),
    String(request.endLine),
  ].join("\0");
}

type FieldSet = Readonly<Record<string, true>>;

const PATCH_PRECONDITION_FIELDS: FieldSet = {
  path: true,
  evidenceId: true,
  operation: true,
  startLine: true,
  endLine: true,
};
const PATCH_PRECONDITION_OPERATIONS: Readonly<
  Record<PatchPreconditionRequest["operation"], true>
> = {
  "replace-range": true,
  "insert-before": true,
  "insert-after": true,
};
const PATCH_PRECONDITION_VALUE_FIELDS: FieldSet = {
  path: true,
  evidenceId: true,
  operation: true,
  startLine: true,
  endLine: true,
  sourceRevision: true,
  expectedOldHash: true,
};
const PATCH_PLAN_DRAFT_FIELDS: FieldSet = {
  version: true,
  intent: true,
  edits: true,
};
const PATCH_PLAN_DRAFT_EDIT_FIELDS: FieldSet = {
  path: true,
  operation: true,
  startLine: true,
  endLine: true,
  replacement: true,
  precondition: true,
};

function canonicalizePlannerPatchPlan(input: unknown): unknown {
  const plan = structuredClone(input);
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return plan;
  const edits = (plan as Record<string, unknown>).edits;
  if (!Array.isArray(edits)) return plan;
  for (const edit of edits) {
    if (!edit || typeof edit !== "object" || Array.isArray(edit)) continue;
    const record = edit as Record<string, unknown>;
    if (record.operation === "replace") record.operation = "replace-range";
  }
  return plan;
}

function requireExactOwnFields(
  input: unknown,
  fields: FieldSet,
  subject: string,
): Record<string, unknown> {
  const record = structuredClone(input);
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError(`${subject} must be an object`);
  }
  for (const field of Object.keys(record)) {
    if (fields[field] !== true) {
      throw new TypeError(`${subject} contains unknown field ${field}`);
    }
  }
  for (const field of Object.keys(fields)) {
    if (!Object.hasOwn(record, field)) {
      throw new TypeError(`${subject} is missing own field ${field}`);
    }
  }
  return record as Record<string, unknown>;
}

function resolveDraftPrecondition(
  draft: Record<string, unknown>,
  index: number,
): PatchPrecondition {
  const supplied = requireExactOwnFields(
    draft.precondition,
    PATCH_PRECONDITION_VALUE_FIELDS,
    `PatchPlan draft edit ${index} precondition`,
  );
  const request = normalizePatchPreconditionRequest({
    path: draft.path,
    evidenceId: supplied.evidenceId,
    operation: draft.operation,
    startLine: draft.startLine,
    endLine: draft.endLine,
  });
  const bound = patchPreconditions.get(patchPreconditionKey(request));
  if (
    !bound ||
    supplied.path !== bound.path ||
    supplied.evidenceId !== bound.evidenceId ||
    supplied.operation !== bound.operation ||
    supplied.startLine !== bound.startLine ||
    supplied.endLine !== bound.endLine ||
    supplied.sourceRevision !== bound.sourceRevision ||
    supplied.expectedOldHash !== bound.expectedOldHash
  ) {
    throw new Error(
      `PatchPlan draft edit ${index} requires the exact host-derived precondition for its edit span`,
    );
  }
  return bound;
}

function expandPlannerPatchDraft(input: unknown): unknown {
  const plan = structuredClone(input);
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return plan;
  const record = plan as Record<string, unknown>;
  if (Object.hasOwn(record, "sourceRevision")) return plan;
  for (const field of Object.keys(record)) {
    if (PATCH_PLAN_DRAFT_FIELDS[field] !== true) {
      throw new TypeError(`PatchPlan draft contains unknown field ${field}`);
    }
  }
  if (!Object.hasOwn(record, "intent") || !Object.hasOwn(record, "edits")) {
    throw new TypeError("PatchPlan draft requires explicit intent and edits");
  }
  if (record.version !== undefined && record.version !== 1) {
    throw new TypeError("PatchPlan draft version must be 1 when provided");
  }
  if (typeof record.intent !== "string" || record.intent.trim().length === 0) {
    throw new TypeError("PatchPlan draft intent must be a non-empty string");
  }
  if (!Array.isArray(record.edits) || record.edits.length === 0) {
    throw new TypeError("PatchPlan draft edits must be a non-empty array");
  }
  return {
    version: 1,
    sourceRevision: patchSourceRevision,
    intent: record.intent,
    edits: record.edits.map((edit, index) => {
      const draft = requireExactOwnFields(
        edit,
        PATCH_PLAN_DRAFT_EDIT_FIELDS,
        `PatchPlan draft edit ${index}`,
      );
      const precondition = resolveDraftPrecondition(draft, index);
      return {
        path: precondition.path,
        evidenceId: precondition.evidenceId,
        expectedOldHash: precondition.expectedOldHash,
        operation: precondition.operation,
        startLine: precondition.startLine,
        endLine: precondition.endLine,
        replacement: draft.replacement,
      };
    }),
  };
}

function normalizePatchPreconditionRequest(input: unknown): PatchPreconditionRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("get_patch_precondition input must be an object");
  }
  const record = input as Record<string, unknown>;
  for (const field in record) {
    if (!Object.hasOwn(record, field)) {
      throw new TypeError(`get_patch_precondition input contains inherited field ${field}`);
    }
    if (PATCH_PRECONDITION_FIELDS[field] !== true) {
      throw new TypeError(`get_patch_precondition input contains unknown field ${field}`);
    }
  }
  for (const field of Object.keys(PATCH_PRECONDITION_FIELDS)) {
    if (!Object.hasOwn(record, field)) {
      throw new TypeError(`get_patch_precondition input is missing own field ${field}`);
    }
  }
  const { path, evidenceId, startLine, endLine } = record;
  const operation = record.operation === "replace" ? "replace-range" : record.operation;
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("get_patch_precondition path must be a non-empty string");
  }
  if (typeof evidenceId !== "string" || evidenceId.length === 0) {
    throw new TypeError("get_patch_precondition evidenceId must be a non-empty string");
  }
  if (typeof operation !== "string") {
    throw new TypeError("get_patch_precondition operation is unsupported");
  }
  const parsedOperation = operation as PatchPreconditionRequest["operation"];
  if (PATCH_PRECONDITION_OPERATIONS[parsedOperation] !== true) {
    throw new TypeError("get_patch_precondition operation is unsupported");
  }
  if (
    typeof startLine !== "number" ||
    !Number.isInteger(startLine) ||
    startLine < 1 ||
    typeof endLine !== "number" ||
    !Number.isInteger(endLine) ||
    endLine < startLine
  ) {
    throw new TypeError("get_patch_precondition line range is invalid");
  }
  if (parsedOperation !== "replace-range" && startLine !== endLine) {
    throw new TypeError("get_patch_precondition insertions require one anchor line");
  }
  return { path, evidenceId, operation: parsedOperation, startLine, endLine };
}


async function getPatchPrecondition(input: unknown): Promise<PatchPrecondition> {
  if (!patchPlanningEnabled || !patchSourceRevision) {
    throw new Error("get_patch_precondition is available only to the root patch planner");
  }
  const sourceRevision = patchSourceRevision;
  const request = normalizePatchPreconditionRequest(input);
  const { value } = await requestCachedCorpus({
    operation: "get_patch_precondition",
    request,
  });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("get_patch_precondition received an invalid host result");
  }
  const precondition = value as Partial<PatchPrecondition>;
  if (
    precondition.path !== request.path ||
    precondition.evidenceId !== request.evidenceId ||
    precondition.operation !== request.operation ||
    precondition.startLine !== request.startLine ||
    precondition.endLine !== request.endLine ||
    precondition.sourceRevision !== sourceRevision ||
    typeof precondition.expectedOldHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(precondition.expectedOldHash)
  ) {
    throw new Error("get_patch_precondition host result did not bind the requested source span");
  }
  const bound = Object.freeze({
    path: request.path,
    evidenceId: request.evidenceId,
    operation: request.operation,
    startLine: request.startLine,
    endLine: request.endLine,
    sourceRevision,
    expectedOldHash: precondition.expectedOldHash,
  });
  patchPreconditions.set(patchPreconditionKey(request), bound);
  return bound;
}

function submitPatchPlan(input: unknown): Readonly<{ status: "submitted"; edits: number }> {
  patchSubmitAttempts += 1;
  let ownsSubmissionGuard = false;
  try {
    if (!patchPlanningEnabled || !patchSourceRevision) {
      throw new Error("submit_patch_plan is available only to the root patch planner");
    }
    if (patchSubmissionExhausted) {
      throw new Error("submit_patch_plan is permanently exhausted after multiple rejected submissions");
    }
    if (submittedPatchPlan) {
      throw new Error("submit_patch_plan accepts exactly one root PatchPlan");
    }
    if (patchSubmissionInProgress) {
      throw new Error("submit_patch_plan rejects reentrant submission while validation is in progress");
    }

    patchSubmissionInProgress = true;
    ownsSubmissionGuard = true;
    const plan = parsePatchPlan(
      expandPlannerPatchDraft(canonicalizePlannerPatchPlan(input)),
    );
    if (plan.sourceRevision !== patchSourceRevision) {
      throw new Error("submit_patch_plan sourceRevision does not match the root source revision");
    }
    for (const edit of plan.edits) {
      const precondition = patchPreconditions.get(patchPreconditionKey(edit));
      if (!precondition || precondition.expectedOldHash !== edit.expectedOldHash) {
        throw new Error(
          "submit_patch_plan requires get_patch_precondition for every exact edit span",
        );
      }
    }
    submittedPatchPlan = structuredClone(plan);
    return Object.freeze({ status: "submitted", edits: plan.edits.length });
  } catch (error) {
    patchSubmitRejections += 1;
    if (patchSubmitRejections > 1) patchSubmissionExhausted = true;
    if (ownsSubmissionGuard && !submittedPatchPlan && !patchSubmissionExhausted) {
      patchSubmissionInProgress = false;
    }
    throw error;
  }
}

async function preparePatchReplace(
  path: unknown,
  startLine: unknown,
  endLine: unknown,
): Promise<PatchPrecondition> {
  if (!patchPlanningEnabled || !patchSourceRevision) {
    throw new Error("prepare_patch_replace is available only to the root patch planner");
  }
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    typeof startLine !== "number" ||
    !Number.isInteger(startLine) ||
    startLine < 1 ||
    typeof endLine !== "number" ||
    !Number.isInteger(endLine) ||
    endLine < startLine
  ) {
    throw new TypeError("prepare_patch_replace requires path and an exact positive line range");
  }
  const slice = await readLines(path, startLine, endLine);
  const prepared = await getPatchPrecondition({
    path,
    evidenceId: slice.id,
    operation: "replace-range",
    startLine,
    endLine,
  });
  preparedPatchReplace = prepared;
  return prepared;
}

function preparedPatchReplaceSnapshot(): PreparedPatchReplace | undefined {
  if (!preparedPatchReplace) return undefined;
  return {
    path: preparedPatchReplace.path,
    startLine: preparedPatchReplace.startLine,
    endLine: preparedPatchReplace.endLine,
  };
}
function preparedPatchReplaceResult(): { preparedPatchReplace?: PreparedPatchReplace } {
  const prepared = preparedPatchReplaceSnapshot();
  return prepared ? { preparedPatchReplace: prepared } : {};
}


function submitPreparedPatchReplace(
  intent: unknown,
  preparedOrReplacement: unknown,
  replacement?: unknown,
): Readonly<{ status: "submitted"; edits: number }> {
  if (!patchPlanningEnabled || !patchSourceRevision) {
    throw new Error("submit_prepared_patch_replace is available only to the root patch planner");
  }
  if (typeof intent !== "string" || intent.trim().length === 0) {
    throw new TypeError("submit_prepared_patch_replace intent must be a non-empty string");
  }
  const useRuntimePrepared = replacement === undefined;
  const replacementValue = useRuntimePrepared ? preparedOrReplacement : replacement;
  if (typeof replacementValue !== "string") {
    throw new TypeError("submit_prepared_patch_replace replacement must be a string");
  }
  const prepared = structuredClone(
    useRuntimePrepared ? preparedPatchReplace : preparedOrReplacement,
  );
  if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) {
    throw new TypeError("submit_prepared_patch_replace requires a prepared replacement");
  }
  const record = prepared as Record<string, unknown>;
  return submitPatchPlan({
    version: 1,
    sourceRevision: patchSourceRevision,
    intent,
    edits: [{
      path: record.path,
      evidenceId: record.evidenceId,
      expectedOldHash: record.expectedOldHash,
      operation: "replace-range",
      startLine: record.startLine,
      endLine: record.endLine,
      replacement: replacementValue,
    }],
  });
}

function requireReplan(replan: SubcallReplan): never {
  if (vmContext) vmContext.last_replan = structuredClone(replan);
  throw new ReplanRequiredError(replan);
}

function chunkText(text: string, maxCharacters?: number): string[] {
  if (typeof text !== "string") throw new TypeError("chunk_text input must be a string");
  const lastReplan = vmContext?.last_replan as SubcallReplan | null | undefined;
  const chunkCharacters = maxCharacters ?? lastReplan?.maxChunkCharacters;
  if (!Number.isInteger(chunkCharacters) || (chunkCharacters ?? 0) <= 0) {
    throw new RangeError(
      "chunk_text requires a positive maxCharacters or last_replan.maxChunkCharacters",
    );
  }
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += chunkCharacters!) {
    chunks.push(text.slice(offset, offset + chunkCharacters!));
  }
  return chunks;
}

function normalizeEvidenceQuery(input: unknown): EvidenceQuery {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(
      "model query must use {question,evidenceIds,inlineContext?,notes?}; raw string queries are unsupported",
    );
  }
  const query = input as Partial<EvidenceQuery>;
  if (typeof query.question !== "string") {
    throw new TypeError("model query must provide a string question");
  }
  if (query.question.trim().length === 0) {
    throw new TypeError("model query question must not be empty");
  }
  if (
    !Array.isArray(query.evidenceIds) ||
    query.evidenceIds.some((id) => typeof id !== "string")
  ) {
    throw new TypeError("model query evidenceIds must be an array of strings");
  }
  if (query.inlineContext !== undefined && typeof query.inlineContext !== "string") {
    throw new TypeError("model query inlineContext must be a string");
  }
  if (query.notes !== undefined && typeof query.notes !== "string") {
    throw new TypeError("model query notes must be a string");
  }
  return {
    question: query.question,
    evidenceIds: [...query.evidenceIds],
    inlineContext: query.inlineContext,
    notes: query.notes,
  };
}

async function queryOne(
  kind: WorkerCallKind,
  query: EvidenceQuery,
  model?: string,
): Promise<string> {
  const [result] = await requestCalls(kind, [normalizeEvidenceQuery(query)], model);
  if (result?.replan) requireReplan(result.replan);
  if (!result?.ok) throw new Error(result?.error ?? `${kind}_query failed without an error`);
  return result.value ?? "";
}

async function queryBatch(
  kind: WorkerCallKind,
  queries: EvidenceQuery[],
  model?: string,
): Promise<string[]> {
  if (!Array.isArray(queries)) {
    throw new TypeError(`${kind}_query_batched queries must be an array`);
  }
  const results = await requestCalls(
    kind,
    queries.map((query) => normalizeEvidenceQuery(query)),
    model,
  );
  const replan = results.find((result) => result.replan)?.replan;
  if (replan) requireReplan(replan);
  return results.map((result) =>
    result.ok ? (result.value ?? "") : `Error: ${result.error ?? "unknown"}`,
  );
}

function appendConsole(values: unknown[]): void {
  const rendered = values.map((value) => inspect(value, { depth: 4 })).join(" ");
  const currentCharacters = stdout.reduce((total, value) => total + value.length, 0);
  const remaining = MAX_STDOUT_CHARS - currentCharacters;
  if (remaining <= 0) return;
  if (rendered.length > remaining) {
    stdout.push(
      `[console output omitted: ${rendered.length} characters exceeds diagnostic limit]`,
    );
    return;
  }
  stdout.push(rendered);
}

function initialize(descriptor: WorkerContextDescriptor): void {
  requireEvidenceProjection =
    descriptor.kind === "files" && descriptor.answerMode === "evidence-projected";
  projectedAnswerContent = undefined;
  answer = createAnswerHandle();
  corpusActionCache.clear();
  corpusHistoryEntries.length = 0;
  initializeFactState(
    descriptor.kind === "files" ? descriptor.sourceRevision : "",
    descriptor.kind === "files" ? descriptor.factContract : undefined,
  );
  patchPlanningEnabled =
    descriptor.kind === "files" && descriptor.patchPlanning?.root === true;
  patchSourceRevision = patchPlanningEnabled && descriptor.kind === "files"
    ? descriptor.sourceRevision
    : undefined;
  submittedPatchPlan = undefined;
  preparedPatchReplace = undefined;
  patchPreconditions.clear();
  patchSubmitAttempts = 0;
  patchSubmitRejections = 0;
  patchSubmissionExhausted = false;
  patchSubmissionInProgress = false;
  const state: Record<string, unknown> = {};
  const fileMetadata =
    descriptor.kind === "files"
      ? descriptor.files.map((file) => Object.freeze({ ...file }))
      : [];
  indexedFilePaths = fileMetadata.map((file) => file.path);
  vmContext = createContext(
    {
      answer,
      context: descriptor.kind === "text" ? descriptor.text : "",
      files: Object.freeze(fileMetadata),
      list_files: listFiles,
      read_file: readFile,
      search_files: searchFiles,
      read_lines: readLines,
      open_match: openMatch,
      search_open: searchOpen,
      read_symbol: readSymbol,
      observe: observeEvidence,
      find_symbol: findSymbol,
      state,
      get_corpus_history: getCorpusHistory,
      get_budget: getBudget,
      get_fact_state: getFactState,
      get_observed_evidence: getObservedEvidence,
      project_answer: projectAnswer,
      record_fact: recordFact,
      extract_fact: extractFact,
      extract_pending_facts: extractPendingFacts,
      last_replan: null,
      chunk_text: chunkText,
      console: { log: (...values: unknown[]) => appendConsole(values) },
      llm_query: (query: EvidenceQuery, model?: string) =>
        queryOne("llm", query, model),
      llm_query_batched: (queries: EvidenceQuery[], model?: string) =>
        queryBatch("llm", queries, model),
      rlm_query: (query: EvidenceQuery, model?: string) =>
        queryOne("rlm", query, model),
      rlm_query_batched: (queries: EvidenceQuery[], model?: string) =>
        queryBatch("rlm", queries, model),
      ...(patchPlanningEnabled
        ? {
            get_patch_precondition: getPatchPrecondition,
            submit_patch_plan: submitPatchPlan,
            prepare_patch_replace: preparePatchReplace,
            submit_prepared_patch_replace: submitPreparedPatchReplace,
          }
        : {}),
    },
    {
      codeGeneration: { strings: false, wasm: false },
      name: "pi-rlm-worker",
    },
  );
  send({ type: "ready" });
}

async function execute(
  id: string,
  code: string,
  syncTimeoutMs: number,
  budget: ReplBudgetSnapshot,
): Promise<void> {
  if (!vmContext || !answer) {
    send({
      type: "execute_result",
      id,
      stdout: "",
      stdoutCharacters: 0,
      observations: [],
      corpusHistory: corpusHistorySnapshot(),
      searchResults: [],
      ready: false,
      error: "Worker is not initialized",
      factState: factStateSnapshot(),
      factEvents: [],
      factExtractions: [],
      factFinalized: false,
    });
    return;
  }

  stdout = [];
  observations = [];
  searchResults = [];
  factEvents = [];
  factExtractionEvents = [];
  budgetSnapshot = structuredClone(budget);
  let factFinalized = false;
  try {
    await extractTypedPendingFactsOnce();
    factFinalized = applyFactFinalizer();
    if (!factFinalized) {
      const script = new Script(`(async () => {\n${code}\n})()`, {
        filename: "pi-rlm-repl.js",
      });
      await script.runInContext(vmContext, { timeout: syncTimeoutMs });
      syncAnswerBinding();
      factFinalized = applyFactFinalizer();
    }
    enforceEvidenceProjection();
    const factFinalizationBlock = incompleteFactBlock();
    const fullStdout = stdout.join("\n");
    send({
      type: "execute_result",
      id,
      stdout: fullStdout.slice(0, MAX_STDOUT_CHARS),
      stdoutCharacters: fullStdout.length,
      observations: structuredClone(observations),
      corpusHistory: corpusHistorySnapshot(),
      searchResults: structuredClone(searchResults),
      ready: answer.ready,
      answerContentDefined: answer.ready ? answer.content !== undefined : undefined,
      answerContent:
        answer.ready && answer.content !== undefined ? String(answer.content) : undefined,
      factState: factStateSnapshot(),
      factEvents: structuredClone(factEvents),
      factExtractions: structuredClone(factExtractionEvents),
      factFinalized,
      factFinalizationBlock,
      ...(submittedPatchPlan
        ? { submittedPatchPlan: structuredClone(submittedPatchPlan) }
        : {}),
      ...preparedPatchReplaceResult(),
      patchSubmitAttempts,
      patchSubmitRejections,
    });
  } catch (error) {
    if (requireEvidenceProjection) resetAnswerSubmission();
    const fullStdout = stdout.join("\n").slice(0, MAX_STDOUT_CHARS);
    if (error instanceof ReplanRequiredError) {
      send({
        type: "execute_result",
        id,
        stdout: fullStdout,
        stdoutCharacters: fullStdout.length,
        observations: structuredClone(observations),
        corpusHistory: corpusHistorySnapshot(),
        searchResults: structuredClone(searchResults),
        ready: false,
        replan: error.replan,
        factState: factStateSnapshot(),
        factEvents: structuredClone(factEvents),
        factExtractions: structuredClone(factExtractionEvents),
        factFinalized,
        ...(submittedPatchPlan
          ? { submittedPatchPlan: structuredClone(submittedPatchPlan) }
          : {}),
        ...preparedPatchReplaceResult(),
        patchSubmitAttempts,
        patchSubmitRejections,
      });
      return;
    }
    send({
      type: "execute_result",
      id,
      stdout: fullStdout,
      stdoutCharacters: fullStdout.length,
      observations: structuredClone(observations),
      corpusHistory: corpusHistorySnapshot(),
      searchResults: structuredClone(searchResults),
      ready: false,
      error: error instanceof Error ? error.message : String(error),
      factState: factStateSnapshot(),
      factEvents: structuredClone(factEvents),
      factExtractions: structuredClone(factExtractionEvents),
      factFinalized,
      ...(submittedPatchPlan
        ? { submittedPatchPlan: structuredClone(submittedPatchPlan) }
        : {}),
      ...preparedPatchReplaceResult(),
      patchSubmitAttempts,
      patchSubmitRejections,
    });
  }
}

async function handleMessage(message: ParentToWorkerMessage): Promise<void> {
  if (message.type === "init") {
    initialize(message.context);
    return;
  }
  if (message.type === "reset_answer") {
    resetAnswerSubmission();
    return;
  }
  if (message.type === "execute") {
    await execute(message.id, message.code, message.syncTimeoutMs, message.budget);
    return;
  }
  if (message.type === "call_result") {
    const pending = pendingCalls.get(message.id);
    if (!pending) return;
    pendingCalls.delete(message.id);
    pending.resolve(message.results);
    return;
  }
  if (message.type === "corpus_result") {
    const pending = pendingCorpusCalls.get(message.id);
    if (!pending) return;
    pendingCorpusCalls.delete(message.id);
    if (message.result.ok) pending.resolve(message.result.value);
    else pending.reject(new Error(message.result.error ?? "Corpus call failed without an error"));
    return;
  }
  for (const pending of pendingCalls.values()) {
    pending.reject(new Error("Worker is shutting down"));
  }
  pendingCalls.clear();
  for (const pending of pendingCorpusCalls.values()) {
    pending.reject(new Error("Worker is shutting down"));
  }
  pendingCorpusCalls.clear();
  process.exit(0);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  try {
    const message = JSON.parse(line) as ParentToWorkerMessage;
    void handleMessage(message);
  } catch (error) {
    process.stderr.write(`Invalid worker message: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
});
lines.on("close", () => process.exit(0));
