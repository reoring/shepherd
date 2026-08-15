import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import type {
  FileIndexedContext,
  FileIndexedEvidenceSession,
  IndexedSourceSlice,
} from "./file-context.ts";

export type PatchOperation = "replace-range" | "insert-before" | "insert-after";

export interface PatchPlan {
  version: 1;
  sourceRevision: string;
  intent: string;
  edits: PatchEdit[];
}

export interface PatchEdit {
  path: string;
  evidenceId: string;
  expectedOldHash: string;
  operation: PatchOperation;
  startLine: number;
  endLine: number;
  replacement: string;
}

export interface PatchPreconditionRequest {
  path: string;
  evidenceId: string;
  operation: PatchOperation;
  startLine: number;
  endLine: number;
}

export interface PatchPrecondition extends PatchPreconditionRequest {
  sourceRevision: string;
  expectedOldHash: string;
}

export interface MutationLimits {
  maxPatchPlans: number;
  maxPlanRevisions: number;
  maxChangedFiles: number;
  maxEdits: number;
  maxInsertedLines: number;
  maxDeletedLines: number;
  maxReplacementCharacters: number;
  allowedPathPrefixes: string[];
  forbiddenPathPatterns: string[];
}

export const DEFAULT_MUTATION_LIMITS: MutationLimits = Object.freeze({
  maxPatchPlans: 1,
  maxPlanRevisions: 1,
  maxChangedFiles: 2,
  maxEdits: 4,
  maxInsertedLines: 40,
  maxDeletedLines: 40,
  maxReplacementCharacters: 8 * 1024,
  allowedPathPrefixes: ["src/"],
  forbiddenPathPatterns: [
    ".git/**",
    "node_modules/**",
    "vendor/**",
    "**/vendor/**",
    "generated/**",
    "**/generated/**",
    "**/*.gen.*",
    "**/*.generated.*",
    ".env",
    ".env.*",
    "**/.env",
    "**/.env.*",
    "**/*credential*",
    "**/*secret*",
    "**/*.lock",
    "**/*.pem",
    "**/*.key",
  ],
});

export type PatchFailureCode =
  | "PATCH_SCHEMA_INVALID"
  | "SOURCE_REVISION_MISMATCH"
  | "EVIDENCE_NOT_OBSERVED"
  | "EVIDENCE_REVISION_MISMATCH"
  | "PATH_OUT_OF_SCOPE"
  | "FILE_NOT_TRACKED"
  | "FILE_KIND_UNSUPPORTED"
  | "OLD_SOURCE_MISMATCH"
  | "EDIT_OUTSIDE_EVIDENCE"
  | "EDIT_OVERLAP"
  | "AMBIGUOUS_INSERTION"
  | "MUTATION_BUDGET_EXCEEDED"
  | "APPLY_FAILED"
  | "POST_WRITE_INDEX_FAILED"
  | "DIFF_POLICY_FAILED"
  | "CONTRACT_CHECK_FAILED"
  | "FOCUSED_CHECK_FAILED"
  | "VERIFICATION_TIMEOUT"
  | "VERIFICATION_SETUP_FAILED"
  | "CLEANUP_FAILED"
  | "ABORTED";

export class PatchPlanError extends Error {
  readonly code: PatchFailureCode;

  constructor(code: PatchFailureCode, message: string) {
    super(message);
    this.name = "PatchPlanError";
    this.code = code;
  }
}
export interface RootPatchAuthority {
  readonly role: "root";
}
const trustedRootAuthorities = new WeakSet<RootPatchAuthority>();

export function createRootPatchAuthority(): RootPatchAuthority {
  const authority = Object.freeze({ role: "root" as const });
  trustedRootAuthorities.add(authority);
  return authority;
}




export interface PatchEditHash {
  path: string;
  operation: PatchOperation;
  startLine: number;
  endLine: number;
  oldHash: string;
  newHash: string;
}

export interface ValidatedPatchEdit extends PatchEdit {
  readonly evidence: IndexedSourceSlice;
  readonly oldHash: string;
  readonly newHash: string;
}

export interface ValidatedPatchPlan {
  readonly plan: PatchPlan;
  readonly edits: readonly ValidatedPatchEdit[];
  readonly changedPaths: readonly string[];
  readonly editHashes: readonly PatchEditHash[];
}

export interface PatchPlanValidationRequest {
  plan: unknown;
  context: FileIndexedContext;
  evidenceSession: FileIndexedEvidenceSession;
  limits?: MutationLimits;
  authority?: RootPatchAuthority;
  submittedPlanCount?: number;
  planRevisionCount?: number;
}

interface SourceLineSpan {
  start: number;
  end: number;
}

interface EditLocation {
  start: number;
  end: number;
  insertion: boolean;
}

const PLAN_FIELDS = new Set(["version", "sourceRevision", "intent", "edits"]);
const EDIT_FIELDS = new Set([
  "path",
  "evidenceId",
  "expectedOldHash",
  "operation",
  "startLine",
  "endLine",
  "replacement",
]);
const OPERATIONS = new Set<PatchOperation>([
  "replace-range",
  "insert-before",
  "insert-after",
]);
const PATCH_PRECONDITION_FIELDS = new Set([
  "path",
  "evidenceId",
  "operation",
  "startLine",
  "endLine",
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireRecord(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PatchPlanError("PATCH_SCHEMA_INVALID", `${subject} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const field in record) {
    if (!Object.hasOwn(record, field)) {
      throw new PatchPlanError("PATCH_SCHEMA_INVALID", `${subject} contains inherited field ${field}`);
    }
  }
  const prototype = Object.getPrototypeOf(value);
  // Ordinary object records may originate in the isolated VM, whose
  // Object.prototype is necessarily a different identity. A plain object's
  // direct prototype is the terminal prototype of that realm; class instances
  // have an additional prototype level.
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) {
    throw new PatchPlanError("PATCH_SCHEMA_INVALID", `${subject} must be a plain object`);
  }
  return record;
}

function requireOnlyFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  subject: string,
): void {
  for (const field in record) {
    if (!Object.hasOwn(record, field)) {
      throw new PatchPlanError("PATCH_SCHEMA_INVALID", `${subject} contains inherited field ${field}`);
    }
    if (!allowed.has(field)) {
      throw new PatchPlanError("PATCH_SCHEMA_INVALID", `${subject} contains unknown field ${field}`);
    }
  }
  for (const field of allowed) {
    if (!Object.hasOwn(record, field)) {
      throw new PatchPlanError("PATCH_SCHEMA_INVALID", `${subject} is missing ${field}`);
    }
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new PatchPlanError("PATCH_SCHEMA_INVALID", `${name} must be a string`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new PatchPlanError("PATCH_SCHEMA_INVALID", `${name} must be a positive integer`);
  }
  return value;
}

function canonicalRelativePath(path: string): string {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(path)
  ) {
    throw new PatchPlanError("PATCH_SCHEMA_INVALID", "path must be a canonical relative path");
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new PatchPlanError("PATCH_SCHEMA_INVALID", "path must be a canonical relative path");
  }
  return path;
}

function parseEdit(value: unknown): PatchEdit {
  const record = requireRecord(value, "PatchEdit");
  requireOnlyFields(record, EDIT_FIELDS, "PatchEdit");
  const path = canonicalRelativePath(requireString(record.path, "PatchEdit.path"));
  const evidenceId = requireString(record.evidenceId, "PatchEdit.evidenceId");
  const expectedOldHash = requireString(record.expectedOldHash, "PatchEdit.expectedOldHash");
  if (!SHA256_PATTERN.test(expectedOldHash)) {
    throw new PatchPlanError("PATCH_SCHEMA_INVALID", "PatchEdit.expectedOldHash must be a SHA-256 hex digest");
  }
  const operationValue = requireString(record.operation, "PatchEdit.operation");
  if (!OPERATIONS.has(operationValue as PatchOperation)) {
    throw new PatchPlanError("PATCH_SCHEMA_INVALID", "PatchEdit.operation is unsupported");
  }
  const operation = operationValue as PatchOperation;
  const startLine = requirePositiveInteger(record.startLine, "PatchEdit.startLine");
  const endLine = requirePositiveInteger(record.endLine, "PatchEdit.endLine");
  if (endLine < startLine) {
    throw new PatchPlanError("PATCH_SCHEMA_INVALID", "PatchEdit.endLine must not precede startLine");
  }
  const replacement = requireString(record.replacement, "PatchEdit.replacement");
  if (
    replacement.includes("\0") ||
    Buffer.from(replacement, "utf8").toString("utf8") !== replacement
  ) {
    throw new PatchPlanError("PATCH_SCHEMA_INVALID", "PatchEdit.replacement must be valid UTF-8 text without NUL bytes");
  }
  if (operation !== "replace-range" && startLine !== endLine) {
    throw new PatchPlanError("PATCH_SCHEMA_INVALID", "insert edits must use one anchor line");
  }
  return { path, evidenceId, expectedOldHash, operation, startLine, endLine, replacement };
}

export function parsePatchPlan(value: unknown): PatchPlan {
  const record = requireRecord(value, "PatchPlan");
  requireOnlyFields(record, PLAN_FIELDS, "PatchPlan");
  if (record.version !== 1) {
    throw new PatchPlanError("PATCH_SCHEMA_INVALID", "PatchPlan.version must be 1");
  }
  const sourceRevision = requireString(record.sourceRevision, "PatchPlan.sourceRevision");
  const intent = requireString(record.intent, "PatchPlan.intent");
  if (intent.trim().length === 0) {
    throw new PatchPlanError("PATCH_SCHEMA_INVALID", "PatchPlan.intent must not be empty");
  }
  if (!Array.isArray(record.edits) || record.edits.length === 0) {
    throw new PatchPlanError("PATCH_SCHEMA_INVALID", "PatchPlan.edits must be a non-empty array");
  }
  return {
    version: 1,
    sourceRevision,
    intent,
    edits: Array.from(record.edits, parseEdit),
  };
}

function resolveLimits(limits: MutationLimits | undefined): MutationLimits {
  const resolved = limits ?? DEFAULT_MUTATION_LIMITS;
  const numericFields: Array<keyof Omit<MutationLimits, "allowedPathPrefixes" | "forbiddenPathPatterns">> = [
    "maxPatchPlans",
    "maxPlanRevisions",
    "maxChangedFiles",
    "maxEdits",
    "maxInsertedLines",
    "maxDeletedLines",
    "maxReplacementCharacters",
  ];
  for (const field of numericFields) {
    if (!Number.isInteger(resolved[field]) || resolved[field] < 0) {
      throw new PatchPlanError("MUTATION_BUDGET_EXCEEDED", `Mutation limit ${field} must be a non-negative integer`);
    }
  }
  if (resolved.allowedPathPrefixes.length === 0) {
    throw new PatchPlanError("PATH_OUT_OF_SCOPE", "No mutation path prefixes are allowlisted");
  }
  return resolved;
}

function allowedPath(path: string, prefixes: readonly string[]): boolean {
  for (const configuredPrefix of prefixes) {
    const prefix = configuredPrefix.endsWith("/")
      ? configuredPrefix.slice(0, -1)
      : configuredPrefix;
    if (prefix === "" || path === prefix || path.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

function globMatches(path: string, pattern: string): boolean {
  const escaped = pattern
    .split("*")
    .map((segment) => segment.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "iu").test(path);
}

function ensurePathPolicy(path: string, limits: MutationLimits): void {
  if (!allowedPath(path, limits.allowedPathPrefixes)) {
    throw new PatchPlanError("PATH_OUT_OF_SCOPE", `Patch path is outside the configured scope: ${path}`);
  }
  if (limits.forbiddenPathPatterns.some((pattern) => globMatches(path, pattern))) {
    throw new PatchPlanError("PATH_OUT_OF_SCOPE", `Patch path matches a forbidden policy: ${path}`);
  }
}

function lineSpans(content: string): SourceLineSpan[] {
  if (content.length === 0) return [];
  const spans: SourceLineSpan[] = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    const end = newline === -1 ? content.length : newline + 1;
    spans.push({ start, end });
    start = end;
  }
  if (content.endsWith("\n")) spans.push({ start: content.length, end: content.length });
  return spans;
}

function spanForLines(content: string, startLine: number, endLine: number): SourceLineSpan {
  const spans = lineSpans(content);
  if (startLine > spans.length || endLine > spans.length) {
    throw new PatchPlanError("EDIT_OUTSIDE_EVIDENCE", "Patch line range is outside the indexed file");
  }
  return {
    start: spans[startLine - 1]!.start,
    end: spans[endLine - 1]!.end,
  };
}

function editLocation(content: string, edit: PatchEdit): EditLocation {
  const span = spanForLines(content, edit.startLine, edit.endLine);
  if (edit.operation === "replace-range") return { ...span, insertion: false };
  const anchor = spanForLines(content, edit.startLine, edit.startLine);
  const offset = edit.operation === "insert-before" ? anchor.start : anchor.end;
  return { start: offset, end: offset, insertion: true };
}

function hashEditSpan(content: string, edit: PatchEdit): string {
  const location = editLocation(content, edit);
  if (location.insertion) {
    const anchor = spanForLines(content, edit.startLine, edit.startLine);
    return digest(content.slice(anchor.start, anchor.end));
  }
  return digest(content.slice(location.start, location.end));
}

function replacementLineCount(replacement: string): number {
  if (replacement.length === 0) return 0;
  const newlines = [...replacement].filter((character) => character === "\n").length;
  return replacement.endsWith("\n") ? newlines : newlines + 1;
}

function assertEvidenceScope(edit: PatchEdit, evidence: IndexedSourceSlice): void {
  if (evidence.truncated || evidence.path !== edit.path) {
    throw new PatchPlanError("EDIT_OUTSIDE_EVIDENCE", "Patch target is not fully covered by observed evidence");
  }
  if (
    edit.startLine < evidence.startLine ||
    edit.endLine > evidence.endLine
  ) {
    throw new PatchPlanError("EDIT_OUTSIDE_EVIDENCE", "Patch range is outside observed evidence");
  }
}

function compareEdits(left: ValidatedPatchEdit, right: ValidatedPatchEdit): number {
  const pathOrder = left.path.localeCompare(right.path);
  if (pathOrder !== 0) return pathOrder;
  const lineOrder = left.startLine - right.startLine;
  if (lineOrder !== 0) return lineOrder;
  const endOrder = left.endLine - right.endLine;
  if (endOrder !== 0) return endOrder;
  return left.operation.localeCompare(right.operation);
}

function assertNoAmbiguity(
  edits: readonly ValidatedPatchEdit[],
  context: FileIndexedContext,
): void {
  const editsByPath = new Map<string, ValidatedPatchEdit[]>();
  for (const edit of edits) {
    const byPath = editsByPath.get(edit.path) ?? [];
    byPath.push(edit);
    editsByPath.set(edit.path, byPath);
  }
  for (const [path, fileEdits] of editsByPath) {
    const content = context.read(path);
    const locations = fileEdits
      .map((edit) => ({ edit, location: editLocation(content, edit) }))
      .sort((left, right) => left.location.start - right.location.start || left.location.end - right.location.end);
    for (let index = 0; index < locations.length; index += 1) {
      const current = locations[index]!;
      for (let nextIndex = index + 1; nextIndex < locations.length; nextIndex += 1) {
        const next = locations[nextIndex]!;
        if (next.location.start > current.location.end && !current.location.insertion) break;
        if (current.location.insertion && next.location.insertion && current.location.start === next.location.start) {
          throw new PatchPlanError("AMBIGUOUS_INSERTION", `Multiple edits target one insertion gap in ${path}`);
        }
        if (current.location.insertion || next.location.insertion) {
          const insertion = current.location.insertion ? current.location : next.location;
          const range = current.location.insertion ? next.location : current.location;
          if (!range.insertion && insertion.start >= range.start && insertion.start <= range.end) {
            throw new PatchPlanError("EDIT_OVERLAP", `Insertion overlaps a replaced range in ${path}`);
          }
          continue;
        }
        if (next.location.start < current.location.end) {
          throw new PatchPlanError("EDIT_OVERLAP", `Patch ranges overlap in ${path}`);
        }
      }
    }
  }
}

function assertBudget(
  plan: PatchPlan,
  edits: readonly ValidatedPatchEdit[],
  limits: MutationLimits,
  submittedPlanCount: number,
  planRevisionCount: number,
): void {
  const changedFiles = new Set(edits.map((edit) => edit.path)).size;
  const insertedLines = edits.reduce((total, edit) => total + replacementLineCount(edit.replacement), 0);
  const deletedLines = edits.reduce(
    (total, edit) => total + (edit.operation === "replace-range" ? edit.endLine - edit.startLine + 1 : 0),
    0,
  );
  const replacementCharacters = edits.reduce((total, edit) => total + edit.replacement.length, 0);
  if (
    submittedPlanCount > limits.maxPatchPlans ||
    planRevisionCount > limits.maxPlanRevisions ||
    changedFiles > limits.maxChangedFiles ||
    plan.edits.length > limits.maxEdits ||
    insertedLines > limits.maxInsertedLines ||
    deletedLines > limits.maxDeletedLines ||
    replacementCharacters > limits.maxReplacementCharacters
  ) {
    throw new PatchPlanError("MUTATION_BUDGET_EXCEEDED", "Patch plan exceeds configured mutation limits");
  }
}

export function hashPatchSpan(
  content: string,
  operation: PatchOperation,
  startLine: number,
  endLine: number,
): string {
  const edit: PatchEdit = {
    path: "placeholder",
    evidenceId: "placeholder",
    expectedOldHash: "0".repeat(64),
    operation,
    startLine,
    endLine,
    replacement: "",
  };
  return hashEditSpan(content, edit);
}

/**
 * Derives an edit CAS condition from the host's current indexed source and the
 * same evidence session that observed the edit target. The model may request
 * this value but cannot provide an unobserved source span.
 */
export function derivePatchPrecondition(
  context: FileIndexedContext,
  evidenceSession: FileIndexedEvidenceSession,
  request: PatchPreconditionRequest,
): PatchPrecondition {
  const record = requireRecord(request, "Patch precondition");
  requireOnlyFields(record, PATCH_PRECONDITION_FIELDS, "Patch precondition");
  const path = canonicalRelativePath(
    requireString(record.path, "Patch precondition path"),
  );
  const evidenceId = requireString(
    record.evidenceId,
    "Patch precondition evidenceId",
  );
  const operation = requireString(
    record.operation,
    "Patch precondition operation",
  );
  if (!OPERATIONS.has(operation as PatchOperation)) {
    throw new PatchPlanError("PATCH_SCHEMA_INVALID", "Patch precondition operation is unsupported");
  }
  const startLine = requirePositiveInteger(
    record.startLine,
    "Patch precondition startLine",
  );
  const endLine = requirePositiveInteger(
    record.endLine,
    "Patch precondition endLine",
  );
  if (endLine < startLine) {
    throw new PatchPlanError(
      "PATCH_SCHEMA_INVALID",
      "Patch precondition endLine must not precede startLine",
    );
  }
  if (operation !== "replace-range" && startLine !== endLine) {
    throw new PatchPlanError(
      "PATCH_SCHEMA_INVALID",
      "Patch insertion preconditions require one anchor line",
    );
  }
  if (evidenceSession.context !== context) {
    throw new PatchPlanError(
      "EVIDENCE_NOT_OBSERVED",
      "Patch precondition requires the root evidence session",
    );
  }
  let evidence: IndexedSourceSlice;
  try {
    [evidence] = evidenceSession.resolveObservedEvidence([evidenceId]);
  } catch {
    throw new PatchPlanError(
      "EVIDENCE_NOT_OBSERVED",
      "Patch precondition evidence was not observed by this root session",
    );
  }
  if (!evidence || evidence.revision !== context.sourceRevision) {
    throw new PatchPlanError(
      "EVIDENCE_REVISION_MISMATCH",
      "Patch precondition evidence belongs to another source revision",
    );
  }
  const edit: PatchEdit = {
    path,
    evidenceId,
    expectedOldHash: "0".repeat(64),
    operation: operation as PatchOperation,
    startLine,
    endLine,
    replacement: "",
  };
  assertEvidenceScope(edit, evidence);
  let content: string;
  try {
    content = context.read(path);
  } catch {
    throw new PatchPlanError(
      "FILE_NOT_TRACKED",
      `Patch precondition path is not tracked by the indexed source: ${path}`,
    );
  }
  return Object.freeze({
    path,
    evidenceId,
    operation: edit.operation,
    startLine,
    endLine,
    sourceRevision: context.sourceRevision,
    expectedOldHash: hashEditSpan(content, edit),
  });
}

export function validatePatchPlan(request: PatchPlanValidationRequest): ValidatedPatchPlan {
  const plan = parsePatchPlan(request.plan);
  const limits = resolveLimits(request.limits);
  if (!request.authority || !trustedRootAuthorities.has(request.authority)) {
    throw new PatchPlanError("PATCH_SCHEMA_INVALID", "Patch plan requires a trusted root authority");
  }
  if (plan.sourceRevision !== request.context.sourceRevision) {
    throw new PatchPlanError("SOURCE_REVISION_MISMATCH", "Patch plan source revision does not match the indexed source");
  }
  const observedById = new Map<string, IndexedSourceSlice>();
  for (const evidenceId of new Set(plan.edits.map((edit) => edit.evidenceId))) {
    try {
      const [evidence] = request.evidenceSession.resolveObservedEvidence([evidenceId]);
      if (!evidence) {
        throw new PatchPlanError("EVIDENCE_NOT_OBSERVED", "Patch evidence was not observed");
      }
      if (evidence.revision !== request.context.sourceRevision) {
        throw new PatchPlanError("EVIDENCE_REVISION_MISMATCH", "Patch evidence belongs to another source revision");
      }
      observedById.set(evidenceId, evidence);
    } catch (error) {
      if (error instanceof PatchPlanError) throw error;
      throw new PatchPlanError("EVIDENCE_NOT_OBSERVED", "Patch evidence was not observed by this root session");
    }
  }

  const validated = plan.edits.map((edit) => {
    ensurePathPolicy(edit.path, limits);
    let content: string;
    try {
      content = request.context.read(edit.path);
    } catch {
      throw new PatchPlanError("FILE_NOT_TRACKED", `Patch path is not tracked by the indexed source: ${edit.path}`);
    }
    const evidence = observedById.get(edit.evidenceId)!;
    assertEvidenceScope(edit, evidence);
    const oldHash = hashEditSpan(content, edit);
    if (oldHash !== edit.expectedOldHash) {
      throw new PatchPlanError("OLD_SOURCE_MISMATCH", "Patch edit no longer matches the observed source bytes");
    }
    return {
      ...edit,
      evidence,
      oldHash,
      newHash: digest(edit.replacement),
    } satisfies ValidatedPatchEdit;
  });

  assertNoAmbiguity(validated, request.context);
  assertBudget(
    plan,
    validated,
    limits,
    request.submittedPlanCount ?? 1,
    request.planRevisionCount ?? 1,
  );
  const edits = [...validated].sort(compareEdits);
  return {
    plan,
    edits,
    changedPaths: [...new Set(edits.map((edit) => edit.path))],
    editHashes: edits.map(({ path, operation, startLine, endLine, oldHash, newHash }) => ({
      path,
      operation,
      startLine,
      endLine,
      oldHash,
      newHash,
    })),
  };
}

export interface PatchCandidate {
  readonly files: ReadonlyMap<string, string>;
  readonly changedPaths: readonly string[];
  readonly normalizedDiffHash: string;
  readonly editHashes: readonly PatchEditHash[];
}

export function generatePatchCandidate(
  context: FileIndexedContext,
  plan: ValidatedPatchPlan,
): PatchCandidate {
  const files = new Map<string, string>();
  const normalizedChanges: Array<{ path: string; oldHash: string; newHash: string }> = [];
  const postHashes = new Map<ValidatedPatchEdit, PatchEditHash>();
  for (const path of plan.changedPaths) {
    const original = context.read(path);
    const transformations = plan.edits
      .filter((edit) => edit.path === path)
      .map((edit) => {
        const location = editLocation(original, edit);
        return { edit, start: location.start, end: location.end };
      })
      .sort((left, right) => left.start - right.start || left.end - right.end);
    let candidate = original;
    let offset = 0;
    for (const transformation of transformations) {
      const start = transformation.start + offset;
      const end = transformation.end + offset;
      const { edit } = transformation;
      candidate = `${candidate.slice(0, start)}${edit.replacement}${candidate.slice(end)}`;
      const replacementEnd = start + edit.replacement.length;
      postHashes.set(edit, {
        path: edit.path,
        operation: edit.operation,
        startLine: edit.startLine,
        endLine: edit.endLine,
        oldHash: edit.oldHash,
        newHash: digest(candidate.slice(start, replacementEnd)),
      });
      offset += edit.replacement.length - (end - start);
    }
    if (candidate !== original) {
      files.set(path, candidate);
      normalizedChanges.push({ path, oldHash: digest(original), newHash: digest(candidate) });
    }
  }
  normalizedChanges.sort((left, right) => left.path.localeCompare(right.path));
  return {
    files,
    changedPaths: normalizedChanges.map((change) => change.path),
    normalizedDiffHash: digest(JSON.stringify(normalizedChanges)),
    editHashes: plan.edits.map((edit) => postHashes.get(edit)!),
  };
}
