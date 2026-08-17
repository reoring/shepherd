import { randomUUID } from "node:crypto";
import { inspect } from "node:util";

import {
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  type ResourceLoader,
  type SessionStats,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  FileIndexedContext,
  type FileIndexedEvidenceSession,
  type IndexedObservationResult,
  type IndexedSearchHit,
  type IndexedSourceSlice,
} from "./file-context.ts";
import { createLimitedModelProvider } from "./limited-provider.ts";
import { validateFactFinalizer } from "./fact-finalizer.ts";

import { parsePatchPlan } from "./patch-plan.ts";
import type { PatchPlan } from "./patch-plan.ts";
import {
  buildNativeEditsPatchPlan,
  nativeEditTargetSummary,
  nativeReplacementConstraintMetadata,
  resolveNativeEditTargets,
} from "./native-edits.ts";
import type {
  NativePatchEditTarget,
  NativePatchReplacementTarget,
  PreparedNativePatchEdit,
} from "./native-edits.ts";

export type {
  NativePatchEditTarget,
  NativePatchReplacementTarget,
} from "./native-edits.ts";

import { ReplWorkerClient } from "./repl-client.ts";
import type {
  ReplExecutionResult,
  ReplIsolationOptions,
  WorkerCallHandler,
} from "./repl-client.ts";
import {
  type PiRlmLimits,
  type PiRlmProviderCallTrace,
  type PiRlmUsage,
  SharedRunLimits,
  SubcallPreflightError,
} from "./shared-limits.ts";
import type {
  CorpusCallRequest,
  CorpusHistoryEntry,
  EvidenceQuery,
  PiRlmFactContract,
  PiRlmFactExtractionEvent,
  PiRlmFactEvent,
  PiRlmFactStateSnapshot,
  ReplBudgetSnapshot,
  SubcallReplan,
  WorkerCallKind,
  WorkerCallResult,
} from "./worker-protocol.ts";

const EVIDENCE_PROJECTION_INSTRUCTIONS =
  'direct answer.content/answer.ready submissions are rejected. read_file does not issue observed evidence; use search_open, read_lines, open_match, a resolved read_symbol, or observe to obtain bounded evidence IDs. ' +
  'For an exact single source value, call project_answer({evidenceId, lineContains, valueKind, valueAfter|quotedIndex}). ' +
  'For a JSON quoted value, call project_answer({evidenceId, lineContains: \'"name":\', valueKind: "quoted", quotedIndex: 1}). ' +
  'For bounded synthesis over explicitly selected evidence, call submit_grounded_answer({content, evidenceIds}) with a non-empty string and non-empty array of unique current observed evidence IDs. Immediately before submit_grounded_answer, call list_observed_evidence() and use only IDs returned by that inventory; get_corpus_history() IDs may have been issued but unobserved. Every claim in content must be supported by those selected slices. project_answer requires exactly one matching source line and owns answer.content/answer.ready; do not overwrite the projected answer.';

const ROOT_SYSTEM_PROMPT = `You are the controller of a Recursive Language Model. The external context is not present in chat and exists only inside the isolated REPL.
Your first and every subsequent response MUST invoke the rlm_exec tool. Plain text, prose, Markdown, and JSON responses are invalid. The answer object exists only inside the tool, so writing {"content": ..., "ready": true} as assistant text does not finish the task.
The REPL has two context modes. Text mode exposes the raw string as context. File-indexed mode intentionally leaves context empty and exposes immutable metadata as files plus get_corpus_history(), list_files(), await read_file(path), await search_files({literal,pathPrefix?,maxResults?}), await search_open({literal,pathPrefix?,caseSensitive?,maxResults?,before?,after?}), await read_lines(path,startLine,endLine), await open_match(matchId,{before?,after?}), await read_symbol(name,{before?,after?,maxResults?}), await observe(evidenceIds), list_observed_evidence(), and await find_symbol(name). get_corpus_history() returns the read-only runtime action ledger. search_files metadata is returned automatically; search_open, read_lines, open_match, and a resolved read_symbol automatically return a bounded evidence slice. observe(evidenceIds) retrieves already-issued evidence under the observation budget. list_observed_evidence() synchronously returns a frozen deterministic inventory of currently observed evidence metadata ({evidenceId,path,startLine,endLine,truncated}) without source text; get_corpus_history() IDs may have been issued but not observed.
For source-symbol inventory, await list_symbols({pathPrefix?,maxResults?}) returns deterministic bounded definition metadata (default 40, maximum 100). It does not read or observe source; use a bounded evidence helper to inspect a selected definition.
Use JavaScript in rlm_exec to inspect the external context and persist intermediate values in state. Call get_budget() for an immutable snapshot of remaining tokens, cost, root turns, and observation capacity. Call get_corpus_history() before every corpus helper call; both are functions and no budget or corpus_history binding exists. Exact bounded calls are cached; repeating one returns its prior local result without new corpus I/O or observation. Do not repeat an action only to rediscover it. Follow the exact context-mode subcall API in the task prompt and do not invent keys or argument shapes. Exact extraction, counting, and formatting should be completed locally when possible.
read_symbol accepts one source identifier. A resolved result contains match and slice; an ambiguous or not_found result contains matches and never selects a definition. search_open returns bounded evidence for a literal. Avoid repeated broad searches and duplicate observations. Submit through answer unless the task requires evidence projection. If a normal answer submission is rejected, revise answer.content inside the REPL and set answer.ready = true again; never substitute a direct chat answer.
When the task prompt requires evidence projection, ${EVIDENCE_PROJECTION_INSTRUCTIONS}
When a public fact contract is present, get_fact_state() and record_fact({factId,value,supports:[{evidenceId,quote}],rationale?}) are available. Inspect the first pending fact before each new source action and record supported facts immediately after observing their source. Never invent a quote or ground a fact from unobserved source. A dot-qualified name is not a valid read_symbol input; extract one source identifier first. Do not set answer.ready until every required fact is grounded.
Use get_observed_evidence(evidenceId) to recover the exact bounded text of evidence already observed in an earlier turn. This is local, cached, and does not perform new corpus I/O. list_observed_evidence() is also local and synchronous; immediately before submit_grounded_answer, use only IDs in its current inventory, never IDs recovered from get_corpus_history(). Consume helper return values and call record_fact in the same rlm_exec execution; bare expressions and returned objects are discarded rather than printed.
get_fact_state() returns facts as an array plus values keyed by fact ID and pendingFactIds. Read final values as get_fact_state().values["fact-id"]; do not treat facts as an object map or read value directly from a fact.
Typed pending facts are extracted by the runtime before the first model-authored REPL action. When the fact contract declares a runtime finalizer, the worker renders the answer from grounded facts and skips model-authored code; never attempt a parallel submission path. Without a finalizer, inspect get_fact_state() and use its grounded values. extract_pending_facts() remains available for explicit inspection of facts that are still pending after the automatic attempt.
If rlm_exec returns RLM_SUBCALL_REPLAN_REQUIRED, do not retry the same call. Inspect last_replan and either process locally, select smaller evidence slices, or use an evidence-bound child RLM.`;

const SUBCALL_SYSTEM_PROMPT =
  "Answer the supplied focused subproblem from only the supplied evidence. Be direct and preserve exact source spelling. You have no tools.";

const PATCH_PLANNER_SYSTEM_PROMPT = `You are the root controller of an evidence-bound patch planner. The source is not present in chat. Never return a patch, JSON, diff, command, or answer in chat.
Call rlm_exec to inspect the source through the read-only REPL helpers, derive host-bound preconditions, and submit one strict PatchPlan. Children are read-only and receive no patch-planning helpers. Do not set answer.content or answer.ready, do not infer unobserved source, and do not claim a patch in chat.`;

const NATIVE_EDITS_PREPARATION_SYSTEM_PROMPT = `You are the root controller of an evidence-bound patch planner. The source is not present in chat. Never return a patch, JSON, diff, command, or answer in chat.
The only active tool is prepare_native_edits. It takes no arguments and prepares every exact host-selected target. Do not request paths, ranges, operations, profiles, hashes, or source in chat. Do not answer in chat.`;

const NATIVE_EDITS_SUBMISSION_SYSTEM_PROMPT = `You are the root controller of an evidence-bound patch planner. The source is not present in chat. Never return a patch, JSON, diff, command, or answer in chat.
The host has prepared every exact target and returned only their bounded current text plus structural requirements. A target-specific host replacement constraint may be supplied as a human-readable description; satisfy it exactly, but the host never reveals the validator or an expected full replacement. The only active tool is submit_native_edits. Call it once with a non-empty model-authored intent and exactly one replacement per supplied target ID. For every replacement target whose requiresTerminalNewline is true, replacement must end with a newline. If an insertion target has requiresLeadingNewlineSeparator true, its replacement must start with a newline separator. For every insert-before or insert-after target, replacement is only the new inserted text: write source code derived directly from the question and target ID, never a task description or placeholder; it must end with a newline and must not repeat, wrap, or include currentText. The host retains all evidence, hash, operation, range, and source-revision bindings. Do not use any other tool and do not answer in chat.`;

const SETTINGS = {
  compaction: { enabled: false },
  retry: { enabled: false, maxRetries: 0 },
} as const;
const MAX_NON_TOOL_RECOVERIES = 2;
const MAX_ANSWER_RESUBMISSIONS = 1;
const NON_TOOL_RECOVERY_PROMPT =
  "Invalid RLM response: direct text cannot access the external context and is not an answer. Invoke rlm_exec now, inspect context in code, and set answer.content plus answer.ready inside the tool.";
const MAX_PATCH_PLAN_RESUBMISSIONS = 1;
const MAX_PATCH_EXPLORATION_RECOVERIES = 1;

export interface PiRlmRunResult {
  response: string;
  rootMessages: unknown[];
  rootPrompt: string;
  executionCount: number;
  answerRejections: number;
  subcallPrompts: string[];
  stats: SessionStats;
  trace: PiRlmFailureTrace;
  answerEvidenceIds: string[];
  usage: PiRlmUsage;
}

export interface PiRlmRunnerOptions {
  cwd?: string;
  modelRuntime?: ModelRuntime;
  limits?: PiRlmLimits;
  isolation?: ReplIsolationOptions;
}

export interface PiRlmAnswerValidation {
  valid: boolean;
  reason?: string;
}

export type PiRlmAnswerValidator = (
  candidate: string,
) => PiRlmAnswerValidation | Promise<PiRlmAnswerValidation>;

export interface PiRlmPublicAnswerContract {
  description: string;
  pattern?: string;
}

export interface PiRlmRunOptions {
  signal?: AbortSignal;
  validateAnswer?: PiRlmAnswerValidator;
  publicAnswerContract?: PiRlmPublicAnswerContract;
  factContract?: PiRlmFactContract;
  requireEvidenceProjection?: boolean;
}

export interface PiRlmPatchPlanResult {
  plan: PatchPlan;
  evidenceSession: FileIndexedEvidenceSession;
  rootMessages: unknown[];
  rootPrompt: string;
  executionCount: number;
  trace: PiRlmFailureTrace;
  stats: SessionStats;
  usage: PiRlmUsage;
}

export type PatchPlanningMode = "repl" | "native-replacement" | "native-edits";

export interface PiRlmPatchPlanOptions {
  signal?: AbortSignal;
  mode?: PatchPlanningMode;
  /** Host-selected exact edits. Required only in native-edits mode. */
  nativeEdits?: readonly NativePatchEditTarget[];
  /** Phase B compatibility input; normalized to one native edit internally. */
  nativeReplacementTarget?: NativePatchReplacementTarget;
}
export interface PiRlmRejectedAnswerTrace {
  depth: number;
  candidateDefined: boolean;
  candidatePreview: string;
  candidateLength: number;
  reason: string;
}

export interface PiRlmCorpusCallTrace {
  depth: number;
  request: CorpusCallRequest;
}

export interface PiRlmExecutionTrace {
  depth: number;
  execution: number;
  stdoutCharacters: number;
  searchResultCount: number;
  observationCharacters: number;
  compactedToolResults: number;
  observedEvidenceIds: string[];
  corpusHistoryEntries: number;
  corpusCacheHits: number;
  budgetBefore: ReplBudgetSnapshot;
  error?: string;
  pendingFactIds: string[];
  groundedFactIds: string[];
  factFinalizationBlocked: boolean;
  patchSubmitAttempts?: number;
  patchSubmitRejections?: number;
  patchSubmitAttemptDelta?: number;
  patchSubmitRejectionDelta?: number;
  preparedPatchReplace?: {
    path: string;
    startLine: number;
    endLine: number;
  };
}

export interface PiRlmPatchToolTrace {
  tool:
    | "prepare_patch_replace"
    | "submit_patch_replacement"
    | "prepare_native_edits"
    | "submit_native_edits";
  status: "prepared" | "submitted" | "rejected";
  path?: string;
  startLine?: number;
  endLine?: number;
  evidenceId?: string;
  currentTextCharacters?: number;
  targets?: Array<{
    id: string;
    path: string;
    operation: NativePatchEditTarget["operation"];
    startLine: number;
    endLine: number;
    evidenceId?: string;
    currentTextCharacters?: number;
  }>;
  reason?: string;
}

export interface PiRlmFactEventTrace extends PiRlmFactEvent {
  depth: number;
  execution: number;
}

export interface PiRlmFactExtractionEventTrace
  extends PiRlmFactExtractionEvent {
  depth: number;
  execution: number;
}

export interface PiRlmFactTrace {
  contractPresent: boolean;
  events: PiRlmFactEventTrace[];
  extractions: PiRlmFactExtractionEventTrace[];
  finalState?: PiRlmFactStateSnapshot;
  finalizationBlocks: number;
  progressBlocks: number;
  actionBlocks: number;
  runtimeFinalizations: number;
}

export interface PiRlmFailureTrace {
  executionCount: number;
  answerRejections: number;
  rejectedAnswers: PiRlmRejectedAnswerTrace[];
  corpusCalls: PiRlmCorpusCallTrace[];
  executions: PiRlmExecutionTrace[];
  subcallPrompts: string[];
  providerCalls: PiRlmProviderCallTrace[];
  facts: PiRlmFactTrace;
  patchPlanRejections: number;
  patchTools?: PiRlmPatchToolTrace[];
}

export class PiRlmRunError extends Error {
  readonly usage: PiRlmUsage;
  readonly trace: PiRlmFailureTrace;

  constructor(message: string, usage: PiRlmUsage, trace: PiRlmFailureTrace, cause: unknown) {
    super(message, { cause });
    this.name = "PiRlmRunError";
    this.usage = usage;
    this.trace = structuredClone(trace);
  }
}

interface NodeRunResult {
  response: string;
  messages: unknown[];
  prompt: string;
  executionCount: number;
  answerRejections: number;
  stats: SessionStats;
  patchPlan?: PatchPlan;
  evidenceSession?: FileIndexedEvidenceSession;
  answerEvidenceIds?: string[];
}

interface RunTrace extends PiRlmFailureTrace {}

const MAX_REJECTED_ANSWER_PREVIEW_CHARACTERS = 4_000;
function createResourceLoader(systemPrompt: string): ResourceLoader {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function extractLastAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || !("role" in message)) continue;
    if (message.role !== "assistant" || !("content" in message)) continue;

    const content = message.content;
    if (!Array.isArray(content)) continue;

    const text = content
      .filter(
        (block): block is { type: "text"; text: string } =>
          Boolean(
            block &&
              typeof block === "object" &&
              "type" in block &&
              block.type === "text" &&
              "text" in block &&
              typeof block.text === "string",
          ),
      )
      .map((block) => block.text)
      .join("");
    if (text) return text;
  }
  throw new Error("Pi subcall completed without assistant text");
}




function questionIdentifiers(question: string): string[] {
  return [
    ...new Set(
      question
        .match(/[A-Za-z_$][A-Za-z0-9_$]{3,}/gu)
        ?.filter(
          (token) =>
            /[A-Z]/u.test(token.slice(1)) ||
            /^[A-Z][A-Za-z0-9_$]+$/u.test(token),
        ) ?? [],
    ),
  ].slice(0, 12);
}

interface InitialMatch {
  path: string;
  line: number;
  preview: string;
  kind: "definition" | "reference";
}

function collectInitialMatches(
  context: FileIndexedContext,
  identifiers: readonly string[],
): InitialMatch[] {
  const matches: InitialMatch[] = [];
  for (const identifier of identifiers) {
    matches.push(
      ...context.findSymbol(identifier, { maxResults: 5 }).map((match) => ({
        path: match.path,
        line: match.line,
        preview: match.preview,
        kind: match.kind,
      })),
      ...context.search({ literal: identifier, maxResults: 5 }).map((match) => ({
        path: match.path,
        line: match.line,
        preview: match.preview,
        kind: "reference" as const,
      })),
    );
  }
  const unique = new Map<string, InitialMatch>();
  const sorted = matches.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "definition" ? -1 : 1;
    return left.path.localeCompare(right.path) || left.line - right.line;
  });
  for (const match of sorted) {
    const key = `${match.path}\0${match.line}`;
    if (!unique.has(key)) unique.set(key, match);
  }
  return [...unique.values()];
}

function initialIndexedHints(
  context: FileIndexedContext,
  question: string,
): string | undefined {
  const matches = collectInitialMatches(context, questionIdentifiers(question));
  if (matches.length === 0) return undefined;
  return [
    "Initial indexed hints; verify with read_lines(path,start,end):",
    ...matches.slice(0, 8).map(
      (match) => `${match.path}:${match.line} ${match.kind} ${match.preview.slice(0, 160)}`,
    ),
  ].join("\n");
}

function renderFactContract(contract: PiRlmFactContract | undefined): string | undefined {
  if (!contract) return undefined;
  const hasExtractors = contract.requirements.some(
    (requirement) => requirement.extractor !== undefined,
  );
  return [
    "Public fact contract (requirements only; values must come from observed source):",
    ...contract.requirements.map(
      (requirement) =>
        `${requirement.id} grounding=${requirement.grounding} ` +
        `minSupports=${requirement.minSupports} requirement=${requirement.description}` +
        `${requirement.extractor ? " extractor=typed" : ""}` +
        `${requirement.sourceHint ? ` sourceHint=${requirement.sourceHint}` : ""}`,
    ),
    contract.finalizer
      ? "A runtime finalizer is declared. Once every fact is grounded, the worker renders and submits the declared template without executing model-authored formatting code."
      : hasExtractors
        ? "Typed extractors run automatically before model-authored REPL code. Inspect get_fact_state(); if all pendingFactIds are gone, format the answer from its values."
        : "Call get_fact_state() before each new source action. Record supported facts with record_fact({factId,value,supports:[{evidenceId,quote}],rationale?}).",
  ].join("\n");
}

function formatMetadata(
  context: string | FileIndexedContext,
  question: string,
  depth: number,
  maxDepth: number,
  publicAnswerContract?: PiRlmPublicAnswerContract,
  factContract?: PiRlmFactContract,
  requireEvidenceProjection = false,
  patchPlanningMode?: PatchPlanningMode,
  nativeEdits?: readonly NativePatchEditTarget[],
): string {
  const patchPlanning = patchPlanningMode !== undefined;
  const nativeEditMode =
    patchPlanningMode === "native-edits" || patchPlanningMode === "native-replacement";
  const targetSummary = nativeEdits ? nativeEditTargetSummary(nativeEdits) : undefined;
  const contextMetadata =
    context instanceof FileIndexedContext
      ? nativeEditMode
        ? `Context metadata: type=file-index, files=${context.files.length}, bytes=${context.totalBytes}. Host-selected native edit targets: ${targetSummary}. Source remains intentionally absent from chat.`
        : patchPlanning
          ? `Context metadata: type=file-index, files=${context.files.length}, bytes=${context.totalBytes}, revision=${context.sourceRevision}. Use rlm_exec to inspect source through the file-indexed REPL helpers; context is intentionally empty.`
          : `Context metadata: type=file-index, files=${context.files.length}, bytes=${context.totalBytes}, revision=${context.sourceRevision}. Use files/list_files/read_file/search_files/search_open/read_lines/open_match/read_symbol/observe/find_symbol/list_symbols; context is intentionally empty.`
      : `Context metadata: type=string, characters=${context.length}, lines=${context.split("\n").length}.`;
  const hints =
    context instanceof FileIndexedContext && !nativeEditMode
      ? initialIndexedHints(context, question)
      : undefined;
  const subcallContract =
    nativeEditMode
      ? undefined
      : context instanceof FileIndexedContext
        ? 'File-indexed source API: calls are bounded and read-only. Call get_corpus_history() before each source action to avoid repeating an action. list_symbols returns metadata only; acquire selected evidence with read_lines, open_match, search_open, a resolved read_symbol, or observe. read_symbol returns resolved, ambiguous, or not_found: only a resolved result has slice; ambiguous and not_found return matches and never select a definition. Use the selected slice with await llm_query({question: "...", evidenceIds: [slice.id]}) or await rlm_query({question: "...", evidenceIds: [slice.id]}): raw source stays outside model chat. search_open({literal, pathPrefix?, caseSensitive?, maxResults?, before?, after?}) returns at most two bounded slices.'
        : 'Text subcall API: await llm_query({question: "...", evidenceIds: [], inlineContext: text}) or await rlm_query({question: "...", evidenceIds: [], inlineContext: text}).';
  const contract = publicAnswerContract
    ? `Public answer contract: ${publicAnswerContract.description}${
        publicAnswerContract.pattern
          ? ` Pattern: ${publicAnswerContract.pattern}`
          : ""
      }`
    : undefined;
  const facts = renderFactContract(factContract);
  const projection = requireEvidenceProjection
    ? `Evidence projection required: ${EVIDENCE_PROJECTION_INSTRUCTIONS}`
    : undefined;
  const planning = nativeEditMode
    ? "Patch planning mode is host-selected native-edits. Do not submit answer.content or inspect source in chat. Call only prepare_native_edits; the host owns every target."
    : patchPlanning
      ? "Patch planning mode is host-selected repl. Do not submit answer.content. Call rlm_exec to inspect source through the REPL helpers, then submit one strict PatchPlan with host-derived preconditions."
      : undefined;
  return [
    `Question: ${question}`,
    contract,
    facts,
    projection,
    planning,
    contextMetadata,
    hints,
    subcallContract,
    `Recursion metadata: depth=${depth}, maxDepth=${maxDepth}.`,
    nativeEditMode
      ? "Call prepare_native_edits now. Do not answer in chat."
      : patchPlanning
        ? "Call rlm_exec now. Do not answer in chat."
        : "Call rlm_exec now. Do not answer directly.",
    nativeEditMode ? undefined : "Inspect the external context programmatically using bounded source slices.",
  ].filter((line): line is string => line !== undefined).join("\n");
}

function renderSearchResults(results: readonly IndexedSearchHit[]): string {
  if (results.length === 0) return "";
  const lines = ["SEARCH RESULTS"];
  let characters = lines[0]!.length;
  for (const hit of results.slice(0, 20)) {
    const line = `${hit.id} ${hit.path}:${hit.line} ${hit.preview.slice(0, 160)}`;
    if (characters + line.length + 1 > 2_048) break;
    lines.push(line);
    characters += line.length + 1;
  }
  if (results.length > lines.length - 1) {
    lines.push(`[${results.length - (lines.length - 1)} additional matches omitted]`);
  }
  return lines.join("\n");
}

function renderCorpusHistory(history: readonly CorpusHistoryEntry[]): string {
  if (history.length === 0) return "";
  const lines = ["CORPUS HISTORY (read-only; exact bounded calls are cached)"];
  let characters = lines[0]!.length;
  for (const entry of history) {
    const evidence =
      entry.evidenceIds.length > 0 ? ` evidence=${entry.evidenceIds.join(",")}` : "";
    const line =
      `${entry.sequence} ${entry.operation} cacheHits=${entry.cacheHits}${evidence} ` +
      entry.summary;
    if (characters + line.length + 1 > 2_048) break;
    lines.push(line);
    characters += line.length + 1;
  }
  return lines.join("\n");
}

function renderFactState(state: PiRlmFactStateSnapshot | undefined): string {
  if (!state) return "";
  const lines = [`FACT STATE revision=${state.sourceRevision}`];
  let characters = lines[0]!.length;
  for (const fact of state.facts) {
    const claim = fact.latestClaim;
    const evidence = claim
      ? ` evidence=${claim.supports.map((support) => support.evidenceId).join(",")}`
      : "";
    const value = claim ? ` value=${claim.value.slice(0, 160)}` : "";
    const requirement = claim ? "" : ` requirement=${fact.description.slice(0, 200)}`;
    const sourceHint =
      !claim && fact.sourceHint ? ` sourceHint=${fact.sourceHint.slice(0, 200)}` : "";
    const line = `${fact.factId} ${fact.status}${value}${evidence}${requirement}${sourceHint}`;
    if (characters + line.length + 1 > 2_048) break;
    lines.push(line);
    characters += line.length + 1;
  }
  return lines.join("\n");
}

function renderFactExtractions(
  events: readonly PiRlmFactExtractionEvent[],
): string {
  if (events.length === 0) return "";
  const lines = ["FACT EXTRACTIONS"];
  let characters = lines[0]!.length;
  for (const event of events) {
    const failure = event.failureCode ? ` failure=${event.failureCode}` : "";
    const line =
      `${event.factId} status=${event.status}${failure} ` +
      `selected=${event.selectedLines} captured=${event.capturedValues}`;
    if (characters + line.length + 1 > 2_048) break;
    lines.push(line);
    characters += line.length + 1;
  }
  return lines.join("\n");
}


function renderObservations(observations: readonly IndexedObservationResult[]): string {
  if (observations.length === 0) return "";
  return observations
    .flatMap((observation) =>
      observation.evidence.map(
        (slice) =>
          `EVIDENCE ${slice.id} ${slice.path}:${slice.startLine}-${slice.endLine}` +
          `${slice.truncated ? " [truncated]" : ""}\n${slice.text}`,
      ),
    )
    .join("\n\n");
}

function renderEvidenceManifest(slices: readonly IndexedSourceSlice[]): string {
  return slices
    .map(
      (slice) =>
        `--- EVIDENCE ${slice.id} ${slice.path}:${slice.startLine}-${slice.endLine} ` +
        `sha256=${slice.sha256}${slice.truncated ? " truncated=true" : ""} ---\n${slice.text}`,
    )
    .join("\n\n");
}

interface PreparedWorkerQuery {
  prompt: string;
  childContext: string;
  childQuestion: string;
}

function prepareWorkerQuery(
  query: EvidenceQuery,
  fileContext: FileIndexedContext | undefined,
): PreparedWorkerQuery {
  if (query.notes !== undefined && query.notes.length > 1_024) {
    throw new Error("Evidence query notes exceed 1024 characters");
  }
  if (fileContext) {
    if (query.inlineContext !== undefined) {
      throw new Error(
        "FILE_INDEX_INLINE_CONTEXT_FORBIDDEN: use evidenceIds from read_lines or open_match",
      );
    }
    if (!query.evidenceIds || query.evidenceIds.length === 0) {
      throw new Error(
        "FILE_INDEX_EVIDENCE_REQUIRED: model subcalls require current source evidence IDs",
      );
    }
    const slices = fileContext.resolveEvidence(query.evidenceIds);
    const manifest = renderEvidenceManifest(slices);
    const notes = query.notes ? `\n\nNotes:\n${query.notes}` : "";
    return {
      prompt: `${query.question}${notes}\n\nEvidence manifest:\n${manifest}`,
      childContext: manifest,
      childQuestion: query.question,
    };
  }
  if (query.evidenceIds && query.evidenceIds.length > 0) {
    throw new Error("Evidence IDs require a file-indexed context");
  }
  const inlineContext = query.inlineContext;
  return {
    prompt: inlineContext
      ? `${query.question}\n\nInline context:\n${inlineContext}`
      : query.question,
    childContext: inlineContext ?? query.question,
    childQuestion: query.question,
  };
}

interface ValidatedAnswer {
  valid: boolean;
  answer?: string;
  reason?: string;
}

async function validateSubmittedAnswer(
  result: ReplExecutionResult,
  validator: PiRlmAnswerValidator | undefined,
  evidenceSession: FileIndexedEvidenceSession | undefined,
  requireEvidenceProjection: boolean,
): Promise<ValidatedAnswer> {
  if (result.answerContentDefined !== true) {
    return { valid: false, reason: "answer.content is undefined" };
  }
  const candidate = result.answerContent ?? "";
  if (candidate.trim().length === 0) {
    return { valid: false, reason: "answer.content must not be empty" };
  }
  if (result.answerEvidenceIds.length > 0) {
    if (!evidenceSession) {
      return { valid: false, reason: "answer evidence IDs require an evidence session" };
    }
    try {
      evidenceSession.resolveObservedEvidence(result.answerEvidenceIds);
    } catch (error) {
      return {
        valid: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  } else if (requireEvidenceProjection) {
    return { valid: false, reason: "evidence projection requires answer evidence IDs" };
  }
  if (!validator) return { valid: true, answer: candidate };

  const validation = await validator(candidate);
  if (validation.valid) return { valid: true, answer: candidate };
  return {
    valid: false,
    reason:
      validation.reason?.trim() ||
      "The submitted answer does not satisfy the requested output contract.",
  };
}


export class PiRlmRunner {
  private readonly sourceModel: Model<Api>;
  private readonly model: Model<Api>;
  private readonly modelRuntimePromise: Promise<ModelRuntime>;
  private readonly cwd: string;
  private readonly limits: PiRlmLimits;
  private readonly isolation: ReplIsolationOptions;
  private readonly providerRegistrationName: string;
  private running = false;

  constructor(model: Model<Api>, options: PiRlmRunnerOptions = {}) {
    const runId = randomUUID();
    this.sourceModel = model;
    this.providerRegistrationName = `pi-rlm-${runId}`;
    this.model = { ...model, provider: this.providerRegistrationName };
    this.modelRuntimePromise = options.modelRuntime
      ? Promise.resolve(options.modelRuntime)
      : ModelRuntime.create();
    this.cwd = options.cwd ?? process.cwd();
    this.limits = options.limits ?? {};
    this.isolation = options.isolation ?? {};
  }
  async planPatch(
    context: FileIndexedContext,
    question: string,
    options: PiRlmPatchPlanOptions = {},
  ): Promise<PiRlmPatchPlanResult> {
    options.signal?.throwIfAborted();
    const patchPlanningMode = options.mode ?? "repl";
    const nativeEdits =
      patchPlanningMode === "native-edits" || patchPlanningMode === "native-replacement"
        ? resolveNativeEditTargets(
            patchPlanningMode,
            options.nativeEdits,
            options.nativeReplacementTarget,
          )
        : undefined;
    if (
      patchPlanningMode === "repl" &&
      (options.nativeEdits !== undefined || options.nativeReplacementTarget !== undefined)
    ) {
      throw new Error("Native edit targets require native-edits or native-replacement mode");
    }
    if (this.isolation.mode !== "docker") {
      throw new Error("Patch planning requires Docker REPL isolation");
    }
    if (this.running) throw new Error("PiRlmRunner does not support concurrent planning calls");
    this.running = true;

    const modelRuntime = await this.modelRuntimePromise;
    const sharedLimits = new SharedRunLimits(this.limits, options.signal);
    const trace: RunTrace = {
      executionCount: 0,
      answerRejections: 0,
      rejectedAnswers: [],
      corpusCalls: [],
      executions: [],
      subcallPrompts: [],
      providerCalls: [],
      facts: {
        contractPresent: false,
        events: [],
        extractions: [],
        finalizationBlocks: 0,
        progressBlocks: 0,
        actionBlocks: 0,
        runtimeFinalizations: 0,
      },
      patchPlanRejections: 0,
      patchTools: [],
    };
    let providerRegistered = false;

    try {
      const { provider } = await createLimitedModelProvider(
        modelRuntime,
        this.sourceModel,
        this.providerRegistrationName,
        sharedLimits,
      );
      modelRuntime.registerNativeProvider(provider);
      providerRegistered = true;
      const root = await this.runNode(
        context,
        question,
        0,
        sharedLimits,
        trace,
        modelRuntime,
        undefined,
        undefined,
        undefined,
        false,
        patchPlanningMode,
        nativeEdits,
      );
      if (!root.patchPlan || !root.evidenceSession) {
        throw new Error("Patch planner ended without a root PatchPlan and evidence session");
      }
      if (root.evidenceSession.context !== context) {
        throw new Error("Patch planner returned a foreign evidence session");
      }
      trace.providerCalls = sharedLimits.providerTraces();
      return {
        plan: root.patchPlan,
        evidenceSession: root.evidenceSession,
        rootMessages: root.messages,
        rootPrompt: root.prompt,
        executionCount: root.executionCount,
        trace: structuredClone(trace),
        stats: root.stats,
        usage: sharedLimits.snapshot(),
      };
    } catch (error) {
      trace.providerCalls = sharedLimits.providerTraces();
      const message = error instanceof Error ? error.message : String(error);
      throw new PiRlmRunError(message, sharedLimits.snapshot(), trace, error);
    } finally {
      if (providerRegistered) modelRuntime.unregisterProvider(this.providerRegistrationName);
      sharedLimits.dispose();
      this.running = false;
    }
  }

  async run(
    context: string | FileIndexedContext,
    question: string,
    options: PiRlmRunOptions = {},
  ): Promise<PiRlmRunResult> {
    if (options.factContract && !(context instanceof FileIndexedContext)) {
      throw new Error("fact contracts require a file-indexed context");
    }
    if (options.factContract) validateFactFinalizer(options.factContract);
    if (options.requireEvidenceProjection && !(context instanceof FileIndexedContext)) {
      throw new Error("evidence projection requires a file-indexed context");
    }
    if (options.requireEvidenceProjection && options.factContract) {
      throw new Error("evidence projection cannot be combined with a fact contract");
    }
    if (this.running) throw new Error("PiRlmRunner does not support concurrent run() calls");
    this.running = true;

    const modelRuntime = await this.modelRuntimePromise;
    const sharedLimits = new SharedRunLimits(this.limits, options.signal);
    const trace: RunTrace = {
      executionCount: 0,
      answerRejections: 0,
      rejectedAnswers: [],
      corpusCalls: [],
      executions: [],
      subcallPrompts: [],
      providerCalls: [],
      facts: {
        contractPresent: options.factContract !== undefined,
        events: [],
        extractions: [],
        finalizationBlocks: 0,
        progressBlocks: 0,
        actionBlocks: 0,
        runtimeFinalizations: 0,
      },
      patchPlanRejections: 0,
      patchTools: [],
    };
    let providerRegistered = false;

    try {
      const { provider } = await createLimitedModelProvider(
        modelRuntime,
        this.sourceModel,
        this.providerRegistrationName,
        sharedLimits,
      );
      modelRuntime.registerNativeProvider(provider);
      providerRegistered = true;
      const root = await this.runNode(
        context,
        question,
        0,
        sharedLimits,
        trace,
        modelRuntime,
        options.validateAnswer,
        options.publicAnswerContract,
        options.factContract,
        options.requireEvidenceProjection,
      );
      trace.providerCalls = sharedLimits.providerTraces();
      return {
        response: root.response,
        rootMessages: root.messages,
        rootPrompt: root.prompt,
        executionCount: root.executionCount,
        answerRejections: root.answerRejections,
        answerEvidenceIds: root.answerEvidenceIds ?? [],
        subcallPrompts: trace.subcallPrompts,
        stats: root.stats,
        trace: structuredClone(trace),
        usage: sharedLimits.snapshot(),
      };
    } catch (error) {
      trace.providerCalls = sharedLimits.providerTraces();
      const message = error instanceof Error ? error.message : String(error);
      throw new PiRlmRunError(message, sharedLimits.snapshot(), trace, error);
    } finally {
      if (providerRegistered) modelRuntime.unregisterProvider(this.providerRegistrationName);
      sharedLimits.dispose();
      this.running = false;
    }
  }

  private async runNode(
    context: string | FileIndexedContext,
    question: string,
    depth: number,
    sharedLimits: SharedRunLimits,
    trace: RunTrace,
    modelRuntime: ModelRuntime,
    validateAnswer?: PiRlmAnswerValidator,
    publicAnswerContract?: PiRlmPublicAnswerContract,
    factContract?: PiRlmFactContract,
    requireEvidenceProjection = false,
    patchPlanningMode?: PatchPlanningMode,
    nativeEdits?: readonly NativePatchEditTarget[],
  ): Promise<NodeRunResult> {
    const patchPlanning = patchPlanningMode !== undefined;
    const nativeEditMode =
      patchPlanningMode === "native-edits" || patchPlanningMode === "native-replacement";
    if (nativeEditMode && (!nativeEdits || nativeEdits.length === 0)) {
      throw new Error("Native edits requires exact host nativeEdits");
    }
    sharedLimits.throwIfAborted();
    sharedLimits.recordNode();

    const fileIndexedContext =
      context instanceof FileIndexedContext ? context : undefined;
    if (patchPlanning && (depth !== 0 || !fileIndexedContext)) {
      throw new Error("Patch planning is available only at the file-indexed root node");
    }
    const callHandler: WorkerCallHandler = (kind, queries, model) =>
      this.handleWorkerCalls(
        kind,
        queries,
        model,
        depth,
        fileIndexedContext,
        sharedLimits,
        trace,
        modelRuntime,
      );
    const remainingTimeMs = sharedLimits.remainingTimeMs();
    const configuredExecutionTimeout = this.isolation.executionTimeoutMs;
    const executionTimeoutMs =
      remainingTimeMs === undefined
        ? configuredExecutionTimeout
        : Math.min(configuredExecutionTimeout ?? remainingTimeMs, remainingTimeMs);
    const worker = await ReplWorkerClient.create(context, callHandler, {
      isolation: {
        ...this.isolation,
        executionTimeoutMs,
      },
      patchPlanning,
      factContract,
      answerMode: requireEvidenceProjection ? "evidence-projected" : "freeform",
      corpusCallObserver: (request) => {
        trace.corpusCalls.push({ depth, request: structuredClone(request) });
      },
      ...(patchPlanning ? { signal: sharedLimits.signal } : {}),
    });

    let executionCount = 0;
    let answerRejections = 0;
    let answerContractError: string | undefined;
    let finalAnswer: string | undefined;
    let finalAnswerEvidenceIds: string[] | undefined;
    let toolInvoked = false;
    let latestToolResult = "";
    let patchPlan: PatchPlan | undefined;
    let patchEvidenceSession: FileIndexedEvidenceSession | undefined;
    let preparedPatchReplace: ReplExecutionResult["preparedPatchReplace"];
    let nativePreparedEdits: readonly PreparedNativePatchEdit[] | undefined;
    let nativePatchPreparationRejections = 0;
    let nativePatchPreparationExhausted = false;
    let nativePatchSubmissionInProgress = false;
    let nativePatchSubmissionRejections = 0;
    let nativePatchSubmissionExhausted = false;
    let patchPlanRejections = 0;
    let observedPatchSubmitAttempts = 0;
    let observedPatchSubmitRejections = 0;
    let patchExplorationRecoveries = 0;
    let droppedControllerResults = 0;
    const controllerResults: string[] = [];
    const allMessages: unknown[] = [];
    let finalStats: SessionStats | undefined;
    let activeSessionAbort: (() => void) | undefined;
    const rlmExec = defineTool({
      name: "rlm_exec",
      label: "RLM REPL",
      description: "Execute JavaScript in the persistent isolated RLM REPL.",
      parameters: Type.Object({
        code: Type.String({ description: "JavaScript body; top-level await is supported." }),
      }),
      async execute(_toolCallId, params, toolSignal) {
        if (nativeEditMode) {
          throw new Error("rlm_exec is unavailable in native-edits patch planning");
        }
        if (executionCount >= sharedLimits.maxRootTurns) {
          throw new Error(
            `RLM root turn limit exceeded: ${executionCount}/${sharedLimits.maxRootTurns}`,
          );
        }
        toolInvoked = true;
        executionCount += 1;
        trace.executionCount += 1;
        const signals = [sharedLimits.signal];
        if (toolSignal) signals.push(toolSignal);
        const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
        const budgetBefore = sharedLimits.replBudgetSnapshot(
          executionCount - 1,
          fileIndexedContext?.limits.maxObservationCharactersPerTurn ?? 0,
        );
        const corpusCallsBefore = trace.corpusCalls.length;
        const result = await worker.execute(params.code, signal, budgetBefore);
        preparedPatchReplace = result.preparedPatchReplace;
        const searchText = renderSearchResults(result.searchResults);
        const observationText = renderObservations(result.observations);
        const historyText = renderCorpusHistory(result.corpusHistory);
        const factText = renderFactState(result.factState);
        const extractionText = renderFactExtractions(result.factExtractions);
        const observedEvidenceIds = result.observations.flatMap((observation) =>
          observation.evidence.map((slice) => slice.id),
        );
        const pendingFactIds =
          result.factState?.facts
            .filter((fact) => fact.status === "pending")
            .map((fact) => fact.factId) ?? [];
        const recordedFact = result.factEvents.some(
          (event) => event.event === "grounded" || event.event === "revised",
        );
        const factProgressRequired =
          observedEvidenceIds.length > 0 &&
          pendingFactIds.length > 0 &&
          !recordedFact;
        const newCorpusAction = trace.corpusCalls.length > corpusCallsBefore;
        const factActionRequired =
          pendingFactIds.length > 0 &&
          !newCorpusAction &&
          !recordedFact &&
          result.factFinalizationBlock === undefined &&
          result.ready === false;
        const nextPendingFact = result.factState?.facts.find(
          (fact) => fact.status === "pending",
        );
        const nextAction = nextPendingFact?.extractor
          ? "Call await extract_pending_facts() now. Do not write source extraction JavaScript."
          : "Use the initial indexed hints: call read_symbol(identifier) for a hinted source identifier, search_open({literal, pathPrefix?, maxResults: 1, before: 0, after: 0}) for a bounded literal search, or read_lines(path,startLine,endLine) for a hinted file location. For earlier evidence, call get_observed_evidence(evidenceId). Consume its text and call record_fact in the same execution. Do not inspect globalThis, return a bare object, or repeat get_fact_state without progress.";
        const factActionText = factActionRequired
          ? [
              "RLM_FACT_ACTION_REQUIRED",
              `No source or fact progress was made. Next pending fact: ${nextPendingFact?.factId ?? pendingFactIds[0]}`,
              nextPendingFact
                ? `Requirement: ${nextPendingFact.description}`
                : undefined,
              nextAction,
            ].filter((line): line is string => line !== undefined).join("\n")
          : "";
        const factProgressText = factProgressRequired
          ? [
              "RLM_FACT_PROGRESS_REQUIRED",
              `New evidence was observed but no fact was recorded. Pending facts: ${pendingFactIds.join(",")}`,
              "Before another source action, inspect this evidence and call record_fact for every supported pending fact. If get_observed_evidence(evidenceId) is needed later, consume its text and record facts in the same execution; bare return values are discarded. Do not postpone extraction.",
            ].join("\n")
          : "";
        const factBlockText = result.factFinalizationBlock
          ? [
              result.factFinalizationBlock.code,
              `Pending facts: ${result.factFinalizationBlock.pendingFactIds.join(",")}`,
              "Use get_fact_state(), ground the pending facts from observed evidence, then submit again. Do not guess.",
            ].join("\n")
          : "";
        const preparedPatchText = patchPlanning && preparedPatchReplace
          ? [
              "PATCH_REPLACEMENT_PREPARED",
              `Prepared span: ${preparedPatchReplace.path}:${preparedPatchReplace.startLine}-${preparedPatchReplace.endLine}.`,
              'Submit it with model-authored intent and replacement: submit_prepared_patch_replace("intent", "replacement\\n").',
              "The runtime will not infer either value or apply without this explicit submission.",
            ].join("\n")
          : "";
        const executionText = [
          patchPlanning ? "" : result.stdout,
          patchPlanning ? "" : searchText,
          patchPlanning ? "" : observationText,
          patchPlanning ? "" : historyText,
          patchPlanning ? "" : factText,
          patchPlanning ? "" : extractionText,
          patchPlanning ? "" : factProgressText,
          patchPlanning ? "" : factActionText,
          patchPlanning ? "" : factBlockText,
          preparedPatchText,
        ]
          .filter((value) => value.length > 0)
          .join("\n");
        const traceExecutionError = result.error?.slice(0, 1_024);
        const executionError = traceExecutionError === undefined
          ? undefined
          : patchPlanning
            ? "REPL execution failed before a PatchPlan submission."
            : traceExecutionError;
        const patchSubmitAttempts = result.patchSubmitAttempts ?? 0;
        const patchSubmitRejections = result.patchSubmitRejections ?? 0;
        if (
          (patchPlanning && (
            result.patchSubmitAttempts === undefined ||
            result.patchSubmitRejections === undefined
          )) ||
          !Number.isInteger(patchSubmitAttempts) ||
          !Number.isInteger(patchSubmitRejections) ||
          patchSubmitAttempts < 0 ||
          patchSubmitRejections < 0 ||
          patchSubmitAttempts < observedPatchSubmitAttempts ||
          patchSubmitRejections < observedPatchSubmitRejections ||
          patchSubmitRejections > patchSubmitAttempts
        ) {
          throw new Error("REPL worker reported invalid patch submission counters");
        }
        const patchSubmitAttemptDelta = patchSubmitAttempts - observedPatchSubmitAttempts;
        const patchSubmitRejectionDelta = patchSubmitRejections - observedPatchSubmitRejections;
        observedPatchSubmitAttempts = patchSubmitAttempts;
        observedPatchSubmitRejections = patchSubmitRejections;
        if (patchPlanning) {
          patchPlanRejections += patchSubmitRejectionDelta;
          trace.patchPlanRejections += patchSubmitRejectionDelta;
        }
        const groundedFactIds =
          result.factState?.facts
            .filter((fact) => fact.status === "grounded")
            .map((fact) => fact.factId) ?? [];
        trace.facts.events.push(
          ...result.factEvents.map((event) => ({
            ...event,
            depth,
            execution: executionCount,
          })),
        );
        trace.facts.extractions.push(
          ...result.factExtractions.map((event) => ({
            ...event,
            depth,
            execution: executionCount,
          })),
        );
        if (result.factState) {
          trace.facts.finalState = structuredClone(result.factState);
        }
        if (result.factFinalizationBlock) {
          trace.facts.finalizationBlocks += 1;
        }
        if (result.factFinalized) {
          trace.facts.runtimeFinalizations += 1;
        }
        if (factProgressRequired) {
          trace.facts.progressBlocks += 1;
        }
        if (factActionRequired) {
          trace.facts.actionBlocks += 1;
        }
        trace.executions.push({
          depth,
          execution: executionCount,
          stdoutCharacters: result.stdoutCharacters,
          searchResultCount: result.searchResults.length,
          compactedToolResults: droppedControllerResults,
          observationCharacters: result.observations.reduce(
            (total, observation) =>
              total +
              observation.evidence.reduce(
                (subtotal, slice) => subtotal + slice.text.length,
                0,
              ),
            0,
          ),
          observedEvidenceIds,
          corpusHistoryEntries: result.corpusHistory.length,
          corpusCacheHits: result.corpusHistory.reduce(
            (total, entry) => total + entry.cacheHits,
            0,
          ),
          budgetBefore,
          error: traceExecutionError,
          pendingFactIds,
          groundedFactIds,
          factFinalizationBlocked: result.factFinalizationBlock !== undefined,
          ...(preparedPatchReplace ? { preparedPatchReplace } : {}),
          ...(patchPlanning
            ? {
                patchSubmitAttempts,
                patchSubmitRejections,
                patchSubmitAttemptDelta,
                patchSubmitRejectionDelta,
              }
            : {}),
        });
        if (patchPlanning && result.submittedPatchPlan) {
          patchPlan = parsePatchPlan(result.submittedPatchPlan);
          patchEvidenceSession = worker.getEvidenceSession();
          if (!patchEvidenceSession) {
            throw new Error("Root patch planner submitted without a host evidence session");
          }
          latestToolResult = executionText || "Patch plan submitted.";
          activeSessionAbort?.();
          return {
            content: [{ type: "text" as const, text: latestToolResult }],
            details: {
              ready: false,
              answerRejected: false,
              answerRejections,
              replan: undefined as SubcallReplan | undefined,
            },
            terminate: true,
          };
        }
        if (executionError) {
          const errorInstruction = `Execution error: ${executionError}`;
          if (
            patchPlanning &&
            patchSubmitRejectionDelta > 0 &&
            patchPlanRejections <= MAX_PATCH_PLAN_RESUBMISSIONS
          ) {
            latestToolResult = [
              executionText,
              errorInstruction,
              "Patch submission was rejected before host execution. Correct the plan once inside the REPL, including host-derived preconditions. Do not submit an answer.",
            ].filter((line): line is string => line.length > 0).join("\n");
          } else if (
            patchPlanning &&
            patchSubmitRejectionDelta === 0 &&
            patchExplorationRecoveries < MAX_PATCH_EXPLORATION_RECOVERIES
          ) {
            patchExplorationRecoveries += 1;
            latestToolResult = [
              executionText,
              errorInstruction,
              "The REPL failed before a PatchPlan submission. Correct the source-helper call once: read_file returns source text, not an evidence slice; read_lines takes positional path/start/end and returns observed slice.id. Continue in rlm_exec; do not submit an answer.",
            ].filter((line): line is string => line.length > 0).join("\n");
          } else {
            if (patchPlanning) {
              answerContractError =
                patchPlanRejections > MAX_PATCH_PLAN_RESUBMISSIONS
                  ? `Patch planner permanently exhausted after ${patchPlanRejections} rejected submissions at depth ${depth}: ${executionError}`
                  : patchSubmitRejectionDelta > 0
                    ? `Patch planner rejected ${patchPlanRejections} submissions at depth ${depth}: ${executionError}`
                    : `Patch planner stopped after a non-submission REPL error at depth ${depth}: ${executionError}`;
            }
            latestToolResult = executionText
              ? `${executionText}\n${errorInstruction}`
              : errorInstruction;
          }
          activeSessionAbort?.();
          return {
            content: [{ type: "text" as const, text: latestToolResult }],
            details: {
              ready: false,
              answerRejected: false,
              answerRejections,
              replan: undefined as SubcallReplan | undefined,
            },
            terminate: true,
          };
        }
        if (result.replan) {
          const replanInstruction = [
            "RLM_SUBCALL_REPLAN_REQUIRED",
            JSON.stringify(result.replan),
            "Structured state is available as last_replan.",
            "Do not retry the same oversized call.",
            "Process locally, select smaller evidence slices, or use evidence-bound rlm_query({question,evidenceIds}).",
          ].join("\n");
          latestToolResult = executionText
            ? `${executionText}\n${replanInstruction}`
            : replanInstruction;
          activeSessionAbort?.();
          return {
            content: [{ type: "text" as const, text: latestToolResult }],
            details: {
              ready: false,
              answerRejected: false,
              answerRejections,
              replan: result.replan as SubcallReplan | undefined,
            },
            terminate: true,
          };
        }
        if (patchPlanning) {
          latestToolResult = executionText || (
            result.ready
              ? "Patch planning ignores answer submissions. Prefer prepare_patch_replace followed by submit_patch_replacement; submit_patch_plan remains valid only for the REPL fallback after host-derived preconditions."
              : "No PatchPlan was submitted. Prefer the native replacement tools; continue REPL source investigation only when the fallback is necessary."
          );
          activeSessionAbort?.();
          return {
            content: [{ type: "text" as const, text: latestToolResult }],
            details: {
              ready: false,
              answerRejected: false,
              answerRejections,
              replan: undefined as SubcallReplan | undefined,
            },
            terminate: true,
          };
        }
        if (!result.ready) {
          latestToolResult =
            executionText || "Execution completed without observations.";
          activeSessionAbort?.();
          return {
            content: [{ type: "text" as const, text: latestToolResult }],
            details: {
              ready: false,
              answerRejected: false,
              answerRejections,
              replan: undefined as SubcallReplan | undefined,
            },
            terminate: true,
          };
        }

        const validation = await validateSubmittedAnswer(
          result,
          validateAnswer,
          worker.getEvidenceSession(),
          requireEvidenceProjection,
        );
        if (validation.valid) {
          finalAnswer = validation.answer;
          finalAnswerEvidenceIds = [...result.answerEvidenceIds];
          latestToolResult = executionText || "Answer submitted.";
          activeSessionAbort?.();
          return {
            content: [{ type: "text" as const, text: latestToolResult }],
            details: {
              ready: true,
              answerRejected: false,
              answerRejections,
              replan: undefined as SubcallReplan | undefined,
            },
            terminate: true,
          };
        }

        answerRejections += 1;
        trace.answerRejections += 1;
        const reason = validation.reason ?? "The answer contract rejected the submission.";
        const candidate = result.answerContent ?? "";
        trace.rejectedAnswers.push({
          depth,
          candidateDefined: result.answerContentDefined === true,
          candidatePreview: candidate.slice(0, MAX_REJECTED_ANSWER_PREVIEW_CHARACTERS),
          candidateLength: candidate.length,
          reason,
        });
        if (answerRejections > MAX_ANSWER_RESUBMISSIONS) {
          answerContractError =
            `Answer contract rejected ${answerRejections} submissions at depth ${depth}: ${reason}`;
          latestToolResult = `${answerContractError}. No resubmissions remain.`;
          activeSessionAbort?.();
          return {
            content: [{ type: "text" as const, text: latestToolResult }],
            details: {
              ready: false,
              answerRejected: true,
              answerRejections,
              replan: undefined as SubcallReplan | undefined,
            },
            terminate: true,
          };
        }

        await worker.resetAnswer();
        const rejectionInstruction =
          `Answer submission rejected: ${reason}. ` +
          "Revise it inside the REPL and submit again by setting answer.content and answer.ready = true. " +
          "Do not answer directly in chat.";
        latestToolResult = executionText
          ? `${executionText}\n${rejectionInstruction}`
          : rejectionInstruction;
        activeSessionAbort?.();
        return {
          content: [{ type: "text" as const, text: latestToolResult }],
          details: {
            ready: false,
            answerRejected: true,
            answerRejections,
            replan: undefined as SubcallReplan | undefined,
          },
          terminate: true,
        };
      },
    });

    const prepareNativeEditsTool = defineTool({
      name: "prepare_native_edits",
      label: "Prepare Native Edits",
      description:
        "Prepare every exact host-selected edit and return only each target's bounded current text.",
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: "sequential",
      async execute() {
        toolInvoked = true;
        try {
          if (!nativeEditMode || !fileIndexedContext || !nativeEdits) {
            throw new Error("prepare_native_edits is available only to the native root patch planner");
          }
          if (nativePatchPreparationExhausted) {
            throw new Error(
              "prepare_native_edits is permanently exhausted after multiple rejected preparations",
            );
          }
          if (nativePreparedEdits) {
            throw new Error("prepare_native_edits accepts the host target set exactly once");
          }
          const prepared = worker.prepareNativeEdits(nativeEdits);
          nativePreparedEdits = prepared;
          const targets = prepared.map((entry) => ({
            id: entry.target.id,
            path: entry.target.path,
            operation: entry.target.operation,
            startLine: entry.target.startLine,
            endLine: entry.target.endLine,
            evidenceId: entry.evidenceId,
            currentTextCharacters: entry.currentText.length,
          }));
          trace.patchTools?.push({
            tool: "prepare_native_edits",
            status: "prepared",
            targets,
          });
          const result = {
            targets: prepared.map((entry) => {
              const replacementConstraint = nativeReplacementConstraintMetadata(entry.target);
              return {
                id: entry.target.id,
                path: entry.target.path,
                operation: entry.target.operation,
                startLine: entry.target.startLine,
                endLine: entry.target.endLine,
                currentText: entry.currentText,
                requiresLeadingNewlineSeparator: entry.requiresLeadingNewlineSeparator,
                requiresTerminalNewline: entry.requiresTerminalNewline,
                ...(replacementConstraint ? { replacementConstraint } : {}),
              };
            }),
          };
          latestToolResult = JSON.stringify(result);
          activeSessionAbort?.();
          return {
            content: [{ type: "text" as const, text: latestToolResult }],
            details: result,
            terminate: true,
          };
        } catch (error) {
          nativePatchPreparationRejections += 1;
          if (nativePatchPreparationRejections > MAX_PATCH_EXPLORATION_RECOVERIES) {
            nativePatchPreparationExhausted = true;
            answerContractError =
              `Patch planner rejected ${nativePatchPreparationRejections} native preparations at depth ${depth}`;
          }
          trace.patchTools?.push({
            tool: "prepare_native_edits",
            status: "rejected",
            ...(nativeEdits
              ? {
                  targets: nativeEdits.map((target) => ({
                    id: target.id,
                    path: target.path,
                    operation: target.operation,
                    startLine: target.startLine,
                    endLine: target.endLine,
                  })),
                }
              : {}),
            reason: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
    });

    const submitNativeEditsTool = defineTool({
      name: "submit_native_edits",
      label: "Submit Native Edits",
      description:
        "Submit one explicit replacement for every prepared host target. When a replacement target has requiresTerminalNewline true, its replacement must end with a newline. When an insertion target has requiresLeadingNewlineSeparator true, its replacement must start with a newline separator. For insertion targets, replacement must be new source text derived from the question and target ID, end with a newline, and never repeat currentText, a task description, or a placeholder. Paths, operations, ranges, evidence, hashes, and profiles remain host-owned.",
      parameters: Type.Object(
        {
          intent: Type.String({ minLength: 1 }),
          replacements: Type.Array(
            Type.Object(
              {
                id: Type.String({ minLength: 1 }),
                replacement: Type.String(),
              },
              { additionalProperties: false },
            ),
            { minItems: 1 },
          ),
        },
        { additionalProperties: false },
      ),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        toolInvoked = true;
        let ownsSubmissionGuard = false;
        try {
          if (!nativeEditMode || !nativeEdits) {
            throw new Error("submit_native_edits is available only to the native root patch planner");
          }
          if (nativePatchSubmissionExhausted) {
            throw new Error(
              "submit_native_edits is permanently exhausted after multiple rejected submissions",
            );
          }
          if (patchPlan) {
            throw new Error("submit_native_edits accepts exactly one root PatchPlan");
          }
          if (nativePatchSubmissionInProgress) {
            throw new Error("submit_native_edits rejects reentrant submission while validation is in progress");
          }
          if (!nativePreparedEdits) {
            throw new Error("submit_native_edits requires prepare_native_edits first");
          }
          nativePatchSubmissionInProgress = true;
          ownsSubmissionGuard = true;
          const evidenceSession = worker.getEvidenceSession();
          if (!evidenceSession || evidenceSession.context !== fileIndexedContext) {
            throw new Error("Root patch planner submitted without its exact host evidence session");
          }
          patchPlan = buildNativeEditsPatchPlan(
            params.intent,
            nativeEdits,
            nativePreparedEdits,
            params.replacements,
          );
          patchEvidenceSession = evidenceSession;
          trace.patchTools?.push({
            tool: "submit_native_edits",
            status: "submitted",
            targets: nativePreparedEdits.map((entry) => ({
              id: entry.target.id,
              path: entry.target.path,
              operation: entry.target.operation,
              startLine: entry.target.startLine,
              endLine: entry.target.endLine,
              evidenceId: entry.evidenceId,
            })),
          });
          latestToolResult = "Host-bound native edits submitted.";
          activeSessionAbort?.();
          return {
            content: [{ type: "text" as const, text: latestToolResult }],
            details: { status: "submitted", edits: patchPlan.edits.length },
            terminate: true,
          };
        } catch (error) {
          nativePatchSubmissionRejections += 1;
          patchPlanRejections += 1;
          trace.patchPlanRejections += 1;
          if (nativePatchSubmissionRejections > MAX_PATCH_PLAN_RESUBMISSIONS) {
            nativePatchSubmissionExhausted = true;
            answerContractError =
              `Patch planner rejected ${nativePatchSubmissionRejections} native submissions at depth ${depth}`;
          }
          trace.patchTools?.push({
            tool: "submit_native_edits",
            status: "rejected",
            ...(nativePreparedEdits
              ? {
                  targets: nativePreparedEdits.map((entry) => ({
                    id: entry.target.id,
                    path: entry.target.path,
                    operation: entry.target.operation,
                    startLine: entry.target.startLine,
                    endLine: entry.target.endLine,
                    evidenceId: entry.evidenceId,
                  })),
                }
              : {}),
            reason: error instanceof Error ? error.message : String(error),
          });
          latestToolResult = nativePatchSubmissionExhausted
            ? "Native edit submission was rejected before host execution. No resubmissions remain."
            : "Native edit submission was rejected before host execution. Correct the replacement once using the active target contract; do not answer in chat.";
          if (
            ownsSubmissionGuard &&
            !patchPlan &&
            !nativePatchSubmissionExhausted
          ) {
            nativePatchSubmissionInProgress = false;
          }
          throw error;
        }
      },
    });

    const nativePreparationInstruction = nativeEditMode
      ? "Call only prepare_native_edits. The host owns the complete target set; do not request or infer source locations."
      : "";
    const nativeInsertionReplacementInstruction =
      nativeEditMode && nativeEdits?.some((target) => target.operation !== "replace-range")
        ? "For every insertion target, submit only new source text derived from the question and target ID. It must end with a newline and must not repeat, wrap, or include currentText, a task description, or a placeholder."
        : "";
    const nativeTerminalNewlineReplacementInstruction =
      nativePreparedEdits?.some((entry) => entry.requiresTerminalNewline)
        ? "For every prepared replacement target whose requiresTerminalNewline is true, the replacement must end with a newline."
        : "";
    const nativeLeadingNewlineSeparatorInstruction =
      nativePreparedEdits?.some((entry) => entry.requiresLeadingNewlineSeparator)
        ? "For every prepared insertion target whose requiresLeadingNewlineSeparator is true, the replacement must start with a newline separator."
        : "";
    const nativeReplacementConstraintInstructions = nativePreparedEdits
      ? nativePreparedEdits.flatMap((entry) => {
          const constraint = nativeReplacementConstraintMetadata(entry.target);
          return constraint
            ? [`Target ${entry.target.id} replacement constraint: ${constraint.description}`]
            : [];
        })
      : [];
    const prompt = formatMetadata(
      context,
      question,
      depth,
      sharedLimits.maxDepth,
      publicAnswerContract,
      factContract,
      requireEvidenceProjection,
      patchPlanningMode,
      nativeEdits,
    );
    const recurringFactHints =
      factContract && fileIndexedContext
        ? initialIndexedHints(fileIndexedContext, question)
        : undefined;
    let nonToolRecoveries = 0;
    let terminalError: string | undefined;
    try {
      for (
        let controllerTurn = 0;
        controllerTurn < sharedLimits.maxRootTurns &&
        finalAnswer === undefined &&
        patchPlan === undefined;
        controllerTurn += 1
      ) {
        toolInvoked = false;
        latestToolResult = "";
        const isFinalizationTurn =
          controllerTurn === sharedLimits.maxRootTurns - 1;
        const preparedNativeInstruction = nativePreparedEdits
          ? [
              `The host prepared exactly ${nativePreparedEdits.length} native edit targets.`,
              `Target IDs: ${nativePreparedEdits.map((entry) => entry.target.id).join(", ")}.`,
              ...nativeReplacementConstraintInstructions,
              nativeTerminalNewlineReplacementInstruction,
              nativeLeadingNewlineSeparatorInstruction,
              nativeInsertionReplacementInstruction,
              "Call only submit_native_edits with a non-empty intent and exactly one replacement for every target ID. Do not answer in chat.",
            ].filter((line) => line.length > 0).join("\n")
          : undefined;
        const baseTurnPrompt =
          controllerTurn === 0
            ? prompt
            : [
                `Question: ${question}`,
                publicAnswerContract
                  ? `Public answer contract: ${publicAnswerContract.description}${
                      publicAnswerContract.pattern
                        ? ` Pattern: ${publicAnswerContract.pattern}`
                        : ""
                    }`
                  : undefined,
                requireEvidenceProjection
                  ? "Evidence projection remains required."
                  : undefined,
                patchPlanning
                  ? nativeEditMode
                    ? preparedNativeInstruction ?? nativePreparationInstruction
                    : preparedPatchReplace
                      ? `A runtime-owned replacement is prepared for ${preparedPatchReplace.path}:${preparedPatchReplace.startLine}-${preparedPatchReplace.endLine}. Call submit_prepared_patch_replace inside rlm_exec with explicit intent and replacement.`
                      : "Patch planning remains active. Call rlm_exec to inspect source and submit one PatchPlan."
                  : undefined,
                recurringFactHints,
                "Recent bounded tool results:",
                ...controllerResults,
                nativeEditMode
                  ? nativePreparedEdits
                    ? "Call only submit_native_edits now; do not answer in chat."
                    : nativePreparationInstruction
                  : patchPlanning
                    ? "Call rlm_exec now; do not answer in chat."
                    : "Use the persistent REPL state. Call rlm_exec now; do not answer directly.",
              ].filter((line): line is string => line !== undefined).join("\n\n");
        const finalizationInstruction = nativeEditMode
          ? nativePreparedEdits
            ? `FINALIZATION TURN: call only submit_native_edits with a non-empty intent and exactly one replacement for every target ID. ${nativeTerminalNewlineReplacementInstruction} ${nativeInsertionReplacementInstruction} Do not answer in chat.`
            : `FINALIZATION TURN: ${nativePreparationInstruction}`
          : patchPlanning
            ? preparedPatchReplace
              ? `FINALIZATION TURN: the runtime owns the prepared span ${preparedPatchReplace.path}:${preparedPatchReplace.startLine}-${preparedPatchReplace.endLine}. Call submit_prepared_patch_replace inside rlm_exec with a model-authored non-empty intent and replacement.`
              : "FINALIZATION TURN: call rlm_exec to inspect source and submit one strict PatchPlan."
            : factContract?.finalizer
              ? "FINALIZATION TURN: the runtime finalizer owns answer rendering. Call rlm_exec without constructing or correcting an answer; it will submit only if every required fact is grounded."
              : factContract?.requirements.some(
                    (requirement) => requirement.extractor !== undefined,
                  )
                ? "FINALIZATION TURN: inspect automatically extracted facts. If every pendingFactId is gone, read get_fact_state().values and submit the exact requested format. Do not guess or auto-correct values."
                : factContract
                  ? "FINALIZATION TURN: use only existing REPL state and observed evidence. Do not search, read, or delegate again. Call get_fact_state(), use get_observed_evidence for pending facts, consume helper results and call record_fact in this same rlm_exec execution, then read final values from get_fact_state().values[\"fact-id\"] and submit only when all pendingFactIds are gone. The facts field is an array and bare returned objects are discarded. Do not guess a missing fact."
                  : requireEvidenceProjection
                    ? "FINALIZATION TURN: use only existing observed evidence. Do not search, read, or delegate again. Submit through project_answer or submit_grounded_answer using only existing observed evidence; do not submit answer.content directly."
                    : "FINALIZATION TURN: use only existing REPL state and observed evidence. Do not search, read, or delegate again. In this rlm_exec call, compute the source-grounded answer, set answer.content, and set answer.ready = true.";
        const turnPrompt =
          isFinalizationTurn && finalizationInstruction
            ? [baseTurnPrompt, finalizationInstruction].join("\n\n")
            : baseTurnPrompt;
        const { session } = await createAgentSession({
          cwd: this.cwd,
          model: this.model,
          thinkingLevel: "off",
          modelRuntime,
          resourceLoader: createResourceLoader(
            nativeEditMode
              ? nativePreparedEdits
                ? NATIVE_EDITS_SUBMISSION_SYSTEM_PROMPT
                : NATIVE_EDITS_PREPARATION_SYSTEM_PROMPT
              : patchPlanning
                ? PATCH_PLANNER_SYSTEM_PROMPT
                : ROOT_SYSTEM_PROMPT,
          ),
          tools: nativeEditMode ? undefined : ["rlm_exec"],
          customTools: nativeEditMode
            ? [prepareNativeEditsTool, submitNativeEditsTool]
            : [rlmExec],
          sessionManager: SessionManager.inMemory(this.cwd),
          settingsManager: SettingsManager.inMemory(SETTINGS),
        });
        activeSessionAbort = () => void session.abort();
        if (nativeEditMode) {
          const expectedPatchToolNames = nativePreparedEdits
            ? ["submit_native_edits"]
            : ["prepare_native_edits"];
          session.setActiveToolsByName(expectedPatchToolNames);
          const activePatchToolNames = session.getActiveToolNames();
          if (
            activePatchToolNames.length !== expectedPatchToolNames.length ||
            activePatchToolNames.some(
              (name, index) => name !== expectedPatchToolNames[index],
            )
          ) {
            throw new Error(
              `Root patch planner activated unexpected tools: ${activePatchToolNames.join(", ")}`,
            );
          }
        }
        const abortSession = () => void session.abort();
        sharedLimits.signal.addEventListener("abort", abortSession, { once: true });
        try {
          await (isFinalizationTurn
            ? sharedLimits.withFinalizationProviderCall(() =>
                session.prompt(turnPrompt, { expandPromptTemplates: false }),
              )
            : session.prompt(turnPrompt, { expandPromptTemplates: false }));
          finalStats = session.getSessionStats();
          allMessages.push(...structuredClone(session.messages));
          terminalError = toolInvoked ? undefined : session.state.errorMessage;
        } finally {
          activeSessionAbort = undefined;
          sharedLimits.signal.removeEventListener("abort", abortSession);
          session.dispose();
        }
        sharedLimits.throwIfAborted();
        if (answerContractError || finalAnswer !== undefined || patchPlan || terminalError) break;
        if (!toolInvoked) {
          nonToolRecoveries += 1;
          if (nonToolRecoveries > MAX_NON_TOOL_RECOVERIES) break;
          latestToolResult = nativeEditMode
            ? nativePreparedEdits
              ? "The host prepared native edits but no tool was invoked. Call only submit_native_edits; no chat plan is accepted."
              : "No tool was invoked. Call only prepare_native_edits; no chat plan is accepted."
            : patchPlanning
              ? "Patch planner did not invoke rlm_exec. Call rlm_exec; no chat plan is accepted."
              : NON_TOOL_RECOVERY_PROMPT;
        }
        controllerResults.push(latestToolResult);
        if (controllerResults.length > 2) {
          droppedControllerResults += controllerResults.length - 2;
          controllerResults.splice(0, controllerResults.length - 2);
        }
      }
      if (answerContractError) throw new Error(answerContractError);
      if (patchPlanning && patchPlan && patchEvidenceSession) {
        if (!finalStats) throw new Error("Patch planner completed without session statistics");
        return {
          response: "",
          messages: allMessages,
          prompt,
          executionCount,
          answerRejections,
          stats: finalStats,
          patchPlan,
          evidenceSession: patchEvidenceSession,
        };
      }
      if (finalAnswer === undefined) {
        const lastExecution = trace.executions.at(-1);
        const lastAssistant = allMessages.findLast(
          (message) =>
            Boolean(
              message &&
                typeof message === "object" &&
                "role" in message &&
                message.role === "assistant",
            ),
        );
        const diagnostic =
          lastExecution?.error ??
          terminalError ??
          (lastAssistant
            ? inspect(lastAssistant, { depth: 4 }).slice(0, 4_000)
            : "The final REPL execution completed without submitting an answer.");
        throw new Error(
          `Pi RLM node at depth ${depth} stopped before the REPL submitted ${
            patchPlanning ? "a PatchPlan" : "an answer"
          } after ${executionCount} executions: ${diagnostic}`,
        );
      }
      if (!finalStats) throw new Error("Pi RLM completed without session statistics");
      return {
        response: finalAnswer,
        messages: allMessages,
        prompt,
        executionCount,
        answerRejections,
        stats: finalStats,
        answerEvidenceIds: finalAnswerEvidenceIds ?? [],
      };
    } finally {
      await worker.close();
    }
  }

  private async handleWorkerCalls(
    kind: WorkerCallKind,
    queries: EvidenceQuery[],
    model: string | undefined,
    depth: number,
    fileIndexedContext: FileIndexedContext | undefined,
    sharedLimits: SharedRunLimits,
    trace: RunTrace,
    modelRuntime: ModelRuntime,
  ): Promise<WorkerCallResult[]> {
    if (model && model !== this.model.id) {
      return queries.map(() => ({
        ok: false,
        error: `Model override ${model} is unavailable; configured model is ${this.model.id}`,
      }));
    }

    const results = new Array<WorkerCallResult>(queries.length);
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(queries.length, sharedLimits.maxParallelSubcalls) },
      async () => {
        while (nextIndex < queries.length) {
          const index = nextIndex;
          nextIndex += 1;
          const query = queries[index];
          if (query === undefined) return;

          sharedLimits.recordSubcall(kind);
          try {
            sharedLimits.throwIfAborted();
            const prepared = prepareWorkerQuery(query, fileIndexedContext);
            trace.subcallPrompts.push(prepared.prompt);
            const nextDepth = depth + 1;
            if (kind === "llm" || nextDepth >= sharedLimits.maxDepth) {
              const preflight = sharedLimits.reserveSubcall(
                prepared.prompt,
                this.model,
                kind,
              );
              preflight.release();
              results[index] = {
                ok: true,
                value: await this.runOneShotSubcall(
                  prepared.prompt,
                  sharedLimits,
                  modelRuntime,
                ),
              };
              continue;
            }
            const child = await this.runNode(
              prepared.childContext,
              prepared.childQuestion,
              nextDepth,
              sharedLimits,
              trace,
              modelRuntime,
            );
            results[index] = { ok: true, value: child.response };
          } catch (error) {
            results[index] =
              error instanceof SubcallPreflightError
                ? {
                    ok: false,
                    error: error.message,
                    replan: error.replan,
                  }
                : {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                  };
          }
        }
      },
    );
    await Promise.all(workers);
    return results;
  }

  private async runOneShotSubcall(
    prompt: string,
    sharedLimits: SharedRunLimits,
    modelRuntime: ModelRuntime,
  ): Promise<string> {
    sharedLimits.throwIfAborted();
    const { session } = await createAgentSession({
      cwd: this.cwd,
      model: this.model,
      thinkingLevel: "off",
      modelRuntime,
      resourceLoader: createResourceLoader(SUBCALL_SYSTEM_PROMPT),
      tools: [],
      sessionManager: SessionManager.inMemory(this.cwd),
      settingsManager: SettingsManager.inMemory(SETTINGS),
    });

    const abort = () => void session.abort();
    sharedLimits.signal.addEventListener("abort", abort, { once: true });
    try {
      await session.prompt(prompt, { expandPromptTemplates: false });
      sharedLimits.throwIfAborted();
      return extractLastAssistantText(session.messages);
    } finally {
      sharedLimits.signal.removeEventListener("abort", abort);
      session.dispose();
    }
  }
}
