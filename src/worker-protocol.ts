import type {
  FileContextMetadata,
  IndexedFileSearchRequest,
  IndexedListSymbolsRequest,
  IndexedObservationResult,
  IndexedOpenMatchOptions,
  IndexedSearchHit,
  IndexedSearchOpenRequest,
  IndexedReadSymbolOptions,
  IndexedSearchOptions,
} from "./file-context.ts";

import type {
  PatchPlan,
  PatchPreconditionRequest,
} from "./patch-plan.ts";

export type WorkerCallKind = "llm" | "rlm";

export type EvidenceId = string;
export type MatchId = string;

export type FactGrounding = "quoted" | "derived" | "quoted-list";

export type FactSourceSelector =
  | {
      kind: "symbol";
      name: string;
      before: number;
      after: number;
    }
  | {
      kind: "search-open";
      literal: string;
      path: string;
      before: number;
      after: number;
    };

export interface FactLineScope {
  afterLiteral?: string;
  beforeLiteral?: string;
  maxLines?: number;
}

export type FactLineSelector =
  | {
      kind: "contains-all";
      literals: readonly string[];
    }
  | {
      kind: "identifier-chain-line";
      trailingDelimiter: string;
    };

export type FactCapture =
  | {
      kind: "quoted-string";
      index: number;
    }
  | {
      kind: "identifier-chain";
      stripTrailingDelimiter: boolean;
    }
  | {
      kind: "identifier-after";
      literal: string;
    }
  | {
      kind: "number-after";
      literal: string;
    };

export type FactReducer =
  | {
      kind: "single";
      exactCount: 1;
    }
  | {
      kind: "join";
      exactCount: number;
      separator: string;
    };

export interface PiRlmFactExtractor {
  source: FactSourceSelector;
  scope?: FactLineScope;
  select: FactLineSelector;
  capture: FactCapture;
  reduce: FactReducer;
}

export type FactExtractionFailureCode =
  | "INVALID_EXTRACTOR"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_AMBIGUOUS"
  | "SCOPE_NOT_FOUND"
  | "CARDINALITY_MISMATCH"
  | "CAPTURE_FAILED"
  | "GROUNDING_REJECTED";

export type PiRlmFactExtractionResult =
  | {
      status: "grounded";
      factId: string;
      value: string;
      evidenceIds: readonly EvidenceId[];
      matchCount: number;
    }
  | {
      status: "failed";
      factId: string;
      code: FactExtractionFailureCode;
      message: string;
    }
  | {
      status: "skipped" | "unchanged";
      factId: string;
    };

export interface PiRlmFactExtractionEvent {
  factId: string;
  sourceKind?: FactSourceSelector["kind"];
  sourcePath?: string;
  evidenceIds: EvidenceId[];
  scopedLines: number;
  selectedLines: number;
  capturedValues: number;
  status: "grounded" | "failed" | "skipped" | "unchanged";
  failureCode?: FactExtractionFailureCode;
}

export interface PiRlmFactRequirement {
  id: string;
  description: string;
  grounding: FactGrounding;
  minSupports: number;
  sourceHint?: string;
  extractor?: PiRlmFactExtractor;
}

export interface PiRlmFactFinalizer {
  kind: "template";
  template: string;
}

export interface PiRlmFactContract {
  requirements: readonly PiRlmFactRequirement[];
  finalizer?: PiRlmFactFinalizer;
}

export interface PiRlmFactSupportInput {
  evidenceId: EvidenceId;
  quote: string;
}

export interface PiRlmFactClaimInput {
  factId: string;
  value: string;
  supports: PiRlmFactSupportInput[];
  rationale?: string;
}

export interface PiRlmFactSupportSnapshot {
  evidenceId: EvidenceId;
  path: string;
  startLine: number;
  endLine: number;
  quoteHash: string;
  quotePreview: string;
}

export interface PiRlmFactClaimSnapshot {
  version: number;
  value: string;
  supports: readonly PiRlmFactSupportSnapshot[];
  rationale?: string;
}

export interface PiRlmFactSnapshot
  extends Omit<PiRlmFactRequirement, "id"> {
  factId: string;
  status: "pending" | "grounded";
  claimCount: number;
  evidenceIds: readonly EvidenceId[];
  latestClaim?: PiRlmFactClaimSnapshot;
}

export interface PiRlmFactStateSnapshot {
  sourceRevision: string;
  facts: readonly PiRlmFactSnapshot[];
  values: Readonly<Record<string, string>>;
  pendingFactIds: readonly string[];
  factsById: Readonly<Record<string, PiRlmFactSnapshot>>;
}

export interface PiRlmFactEvent {
  factId: string;
  event: "grounded" | "revised" | "rejected";
  version?: number;
  reason?: string;
  evidenceIds: EvidenceId[];
}

export interface PiRlmFactFinalizationBlock {
  code: "RLM_FACTS_INCOMPLETE";
  pendingFactIds: string[];
}

export interface EvidenceQuery {
  question: string;
  evidenceIds: EvidenceId[];
  inlineContext?: string;
  notes?: string;
}

export interface ReplBudgetSnapshot {
  remainingTokens?: number;
  remainingCostUsd?: number;
  remainingRootTurns?: number;
  maxObservationCharacters: number;
  finalizationReserveTokens: number;
}

export type SubcallReplanReason =
  | "single_call_input_limit"
  | "remaining_token_budget"
  | "remaining_cost_budget";

export interface SubcallReplan {
  code: "RLM_SUBCALL_REPLAN_REQUIRED";
  queryKind: WorkerCallKind;
  reason: SubcallReplanReason;
  estimatedInputTokens: number;
  estimatedInputCostUsd: number;
  maxInputTokens: number;
  maxChunkCharacters: number;
  remainingTokenBudget?: number;
  remainingCostBudgetUsd?: number;
  strategies: [
    "process_locally",
    "chunk_text_then_llm_query_batched",
    "rlm_query",
  ];
  message: string;
}

export interface WorkerCallResult {
  ok: boolean;
  value?: string;
  error?: string;
  replan?: SubcallReplan;
}

export type WorkerAnswerMode = "freeform" | "evidence-projected";

export type PiRlmEvidenceProjectionRequest =
  | {
      evidenceId: EvidenceId;
      lineContains: string;
      valueKind: "number" | "identifier";
      valueAfter: string;
    }
  | {
      evidenceId: EvidenceId;
      lineContains: string;
      valueKind: "quoted";
      quotedIndex: number;
    };

export type WorkerContextDescriptor =
  | { kind: "text"; text: string }
  | {
      kind: "files";
      files: readonly FileContextMetadata[];
      totalBytes: number;
      sourceRevision: string;
      corpusId: string;
      factContract?: PiRlmFactContract;
      answerMode?: WorkerAnswerMode;
      patchPlanning?: { root: true };
    };

export type CorpusCallRequest =
  | { operation: "read_file"; path: string }
  | { operation: "search_files"; request: IndexedFileSearchRequest }
  | { operation: "search_open"; request: IndexedSearchOpenRequest }
  | { operation: "read_lines"; path: string; startLine: number; endLine: number }
  | { operation: "open_match"; matchId: MatchId; options?: IndexedOpenMatchOptions }
  | { operation: "read_symbol"; name: string; options?: IndexedReadSymbolOptions }
  | { operation: "observe"; evidenceIds: EvidenceId[] }
  | { operation: "find_symbol"; name: string; options?: IndexedSearchOptions }
  | { operation: "list_symbols"; request: IndexedListSymbolsRequest }
  | {
      operation: "get_patch_precondition";
      request: PatchPreconditionRequest;
    };

export interface CorpusCallResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface CorpusHistoryEntry {
  sequence: number;
  operation: CorpusCallRequest["operation"];
  key: string;
  summary: string;
  evidenceIds: EvidenceId[];
  cacheHits: number;
}
export interface PreparedPatchReplace {
  path: string;
  startLine: number;
  endLine: number;
}


export type ParentToWorkerMessage =
  | { type: "init"; context: WorkerContextDescriptor }
  | { type: "reset_answer" }
  | {
      type: "execute";
      id: string;
      code: string;
      syncTimeoutMs: number;
      budget: ReplBudgetSnapshot;
    }
  | { type: "call_result"; id: string; results: WorkerCallResult[] }
  | { type: "corpus_result"; id: string; result: CorpusCallResult }
  | { type: "shutdown" };

export type WorkerToParentMessage =
  | { type: "ready" }
  | {
      type: "execute_result";
      id: string;
      stdout: string;
      stdoutCharacters: number;
      observations: IndexedObservationResult[];
      corpusHistory: CorpusHistoryEntry[];
      ready: boolean;
      answerContentDefined?: boolean;
      searchResults: IndexedSearchHit[];
      answerContent?: string;
      answerEvidenceIds: EvidenceId[];
      error?: string;
      replan?: SubcallReplan;
      factState?: PiRlmFactStateSnapshot;
      factEvents: PiRlmFactEvent[];
      factExtractions: PiRlmFactExtractionEvent[];
      factFinalized: boolean;
      factFinalizationBlock?: PiRlmFactFinalizationBlock;
      submittedPatchPlan?: PatchPlan;
      preparedPatchReplace?: PreparedPatchReplace;
      patchSubmitAttempts?: number;
      patchSubmitRejections?: number;
    }
  | {
      type: "call";
      id: string;
      kind: WorkerCallKind;
      queries: EvidenceQuery[];
      model?: string;
    }
  | {
      type: "corpus_call";
      id: string;
      request: CorpusCallRequest;
    };
