import { createHash } from "node:crypto";

import type { PatchEdit, PatchOperation, PatchPlan, PatchPrecondition } from "./patch-plan.ts";
import { parsePatchPlan } from "./patch-plan.ts";

const NATIVE_EDIT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const NATIVE_EDIT_FIELDS = new Set(["id", "path", "operation", "startLine", "endLine", "replacementConstraint"]);
const NATIVE_REPLACEMENT_CONSTRAINT_FIELDS = new Set(["description", "source", "flags"]);
const NATIVE_REPLACEMENT_FIELDS = new Set(["id", "replacement"]);
const PATCH_OPERATIONS = new Set<PatchOperation>([
  "replace-range",
  "insert-before",
  "insert-after",
]);

const MAX_REPLACEMENT_CONSTRAINT_DESCRIPTION_CHARACTERS = 280;
const MAX_REPLACEMENT_CONSTRAINT_SOURCE_CHARACTERS = 512;
const SAFE_REPLACEMENT_CONSTRAINT_FLAGS = /^[imu]*$/u;

/** A host-owned replacement requirement. Only its safe description reaches the model. */
export interface NativeReplacementConstraint {
  readonly description: string;
  readonly source: string;
  readonly flags: string;
}

/** A host-selected, immutable edit shape. The model never supplies these fields. */
export interface NativePatchEditTarget {
  readonly id: string;
  readonly path: string;
  readonly operation: PatchOperation;
  readonly startLine: number;
  readonly endLine: number;
  readonly replacementConstraint?: NativeReplacementConstraint;
}

/** Compatibility input for Phase B native-replacement callers. */
export interface NativePatchReplacementTarget {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** The sole model-authored mutable part of a native edit submission. */
export interface NativeEditReplacement {
  readonly id: string;
  readonly replacement: string;
}

/** Host-private preparation material. The prompt receives only structural requirements and bounded current text. */
export interface PreparedNativePatchEdit {
  readonly target: NativePatchEditTarget;
  readonly currentText: string;
  readonly requiresLeadingNewlineSeparator: boolean;
  readonly requiresTerminalNewline: boolean;
  readonly evidenceId: string;
  readonly precondition: PatchPrecondition;
}

function requirePlainRecord(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${subject} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key in record) {
    if (!Object.hasOwn(record, key)) {
      throw new TypeError(`${subject} contains an inherited field ${key}`);
    }
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) {
    throw new TypeError(`${subject} must be a plain object`);
  }
  return record;
}

function requireOnlyFields(
  record: Record<string, unknown>,
  fields: ReadonlySet<string>,
  subject: string,
  optionalFields: ReadonlySet<string> = new Set(),
): void {
  for (const key of Object.keys(record)) {
    if (!fields.has(key)) throw new TypeError(`${subject} contains an unknown field ${key}`);
  }
  for (const key of fields) {
    if (!optionalFields.has(key) && !Object.hasOwn(record, key)) {
      throw new TypeError(`${subject} is missing ${key}`);
    }
  }
}

function canonicalPath(value: unknown, subject: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(value)
  ) {
    throw new TypeError(`${subject} must be a canonical relative path`);
  }
  if (value.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new TypeError(`${subject} must be a canonical relative path`);
  }
  return value;
}

function positiveInteger(value: unknown, subject: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${subject} must be a positive integer`);
  }
  return value;
}

function nativeId(value: unknown, subject: string): string {
  if (typeof value !== "string" || !NATIVE_EDIT_ID_PATTERN.test(value)) {
    throw new TypeError(`${subject} must be a stable native edit id`);
  }
  return value;
}

function nativeReplacementConstraint(
  value: unknown,
  subject: string,
): NativeReplacementConstraint | undefined {
  if (value === undefined) return undefined;
  const record = requirePlainRecord(value, `${subject}.replacementConstraint`);
  requireOnlyFields(
    record,
    NATIVE_REPLACEMENT_CONSTRAINT_FIELDS,
    `${subject}.replacementConstraint`,
  );
  if (
    typeof record.description !== "string" ||
    record.description.length === 0 ||
    record.description.length > MAX_REPLACEMENT_CONSTRAINT_DESCRIPTION_CHARACTERS ||
    /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(record.description)
  ) {
    throw new TypeError(`${subject}.replacementConstraint.description must be safe bounded text`);
  }
  if (
    typeof record.source !== "string" ||
    record.source.length === 0 ||
    record.source.length > MAX_REPLACEMENT_CONSTRAINT_SOURCE_CHARACTERS
  ) {
    throw new TypeError(`${subject}.replacementConstraint.source must be bounded non-empty text`);
  }
  if (
    typeof record.flags !== "string" ||
    !SAFE_REPLACEMENT_CONSTRAINT_FLAGS.test(record.flags) ||
    new Set(record.flags).size !== record.flags.length
  ) {
    throw new TypeError(`${subject}.replacementConstraint.flags must use unique i, m, or u flags`);
  }
  try {
    new RegExp(record.source, record.flags);
  } catch {
    throw new TypeError(`${subject}.replacementConstraint must compile as a regular expression`);
  }
  return Object.freeze({
    description: record.description,
    source: record.source,
    flags: record.flags,
  });
}

export function nativeReplacementConstraintDigest(
  constraint: NativeReplacementConstraint,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      description: constraint.description,
      source: constraint.source,
      flags: constraint.flags,
    }), "utf8")
    .digest("hex");
}

export function nativeReplacementConstraintMetadata(
  target: NativePatchEditTarget,
): { readonly description: string; readonly digest: string } | undefined {
  const constraint = target.replacementConstraint;
  return constraint === undefined
    ? undefined
    : Object.freeze({
        description: constraint.description,
        digest: nativeReplacementConstraintDigest(constraint),
      });
}

export interface NativePatchEditTargetMetadata {
  readonly id: string;
  readonly path: string;
  readonly operation: PatchOperation;
  readonly startLine: number;
  readonly endLine: number;
  readonly replacementConstraint?: { readonly description: string; readonly digest: string };
}

export function nativeEditTargetMetadata(
  target: NativePatchEditTarget,
): NativePatchEditTargetMetadata {
  const replacementConstraint = nativeReplacementConstraintMetadata(target);
  return Object.freeze({
    id: target.id,
    path: target.path,
    operation: target.operation,
    startLine: target.startLine,
    endLine: target.endLine,
    ...(replacementConstraint ? { replacementConstraint } : {}),
  });
}

function sameTarget(left: NativePatchEditTarget, right: NativePatchEditTarget): boolean {
  const leftConstraint = nativeReplacementConstraintMetadata(left);
  const rightConstraint = nativeReplacementConstraintMetadata(right);
  return left.id === right.id &&
    left.path === right.path &&
    left.operation === right.operation &&
    left.startLine === right.startLine &&
    left.endLine === right.endLine &&
    leftConstraint?.digest === rightConstraint?.digest;
}

export function validateNativeEditTargets(
  targets: readonly NativePatchEditTarget[],
): readonly NativePatchEditTarget[] {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new TypeError("native-edits requires one or more exact host targets");
  }
  const ids = new Set<string>();
  return Object.freeze(targets.map((candidate, index) => {
    const record = requirePlainRecord(candidate, `Native edit target ${index}`);
    requireOnlyFields(
      record,
      NATIVE_EDIT_FIELDS,
      `Native edit target ${index}`,
      new Set(["replacementConstraint"]),
    );
    const id = nativeId(record.id, `Native edit target ${index}.id`);
    if (ids.has(id)) throw new TypeError(`native-edits target id is duplicated: ${id}`);
    ids.add(id);
    const path = canonicalPath(record.path, `Native edit target ${id}.path`);
    if (typeof record.operation !== "string" || !PATCH_OPERATIONS.has(record.operation as PatchOperation)) {
      throw new TypeError(`Native edit target ${id}.operation is unsupported`);
    }
    const operation = record.operation as PatchOperation;
    const startLine = positiveInteger(record.startLine, `Native edit target ${id}.startLine`);
    const endLine = positiveInteger(record.endLine, `Native edit target ${id}.endLine`);
    if (endLine < startLine) {
      throw new TypeError(`Native edit target ${id}.endLine must not precede startLine`);
    }
    if (operation !== "replace-range" && startLine !== endLine) {
      throw new TypeError(`Native edit target ${id} insertion must use one anchor line`);
    }
    const replacementConstraint = nativeReplacementConstraint(record.replacementConstraint, `Native edit target ${id}`);
    return Object.freeze({
      id,
      path,
      operation,
      startLine,
      endLine,
      ...(replacementConstraint ? { replacementConstraint } : {}),
    });
  }));
}

/** Normalizes both native modes to the same host-owned target list. */
export function resolveNativeEditTargets(
  mode: "native-edits" | "native-replacement",
  nativeEdits: readonly NativePatchEditTarget[] | undefined,
  nativeReplacementTarget: NativePatchReplacementTarget | undefined,
): readonly NativePatchEditTarget[] {
  if (mode === "native-edits") {
    if (nativeReplacementTarget !== undefined) {
      throw new TypeError("native-edits does not accept a nativeReplacementTarget");
    }
    if (nativeEdits === undefined) {
      throw new TypeError("native-edits requires exact host nativeEdits");
    }
    return validateNativeEditTargets(nativeEdits);
  }

  if (nativeEdits !== undefined) {
    throw new TypeError("native-replacement does not accept nativeEdits");
  }
  if (nativeReplacementTarget === undefined) {
    throw new TypeError("Native replacement requires an exact host nativeReplacementTarget");
  }
  const target = requirePlainRecord(nativeReplacementTarget, "Native replacement target");
  requireOnlyFields(target, new Set(["path", "startLine", "endLine"]), "Native replacement target");
  return validateNativeEditTargets([{
    id: "native-replacement",
    path: canonicalPath(target.path, "Native replacement target.path"),
    operation: "replace-range",
    startLine: positiveInteger(target.startLine, "Native replacement target.startLine"),
    endLine: positiveInteger(target.endLine, "Native replacement target.endLine"),
  }]);
}

/** Whether the exact replace-range source span ends with a line terminator. */
export function requiresTerminalNewline(
  content: string,
  target: NativePatchEditTarget,
): boolean {
  if (typeof content !== "string") {
    throw new TypeError("Native edit source content must be a string");
  }
  const [exactTarget] = validateNativeEditTargets([target]);
  if (!exactTarget || exactTarget.operation !== "replace-range") return false;

  let lineNumber = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 10) continue;
    if (lineNumber === exactTarget.endLine) return true;
    lineNumber += 1;
  }
  return false;
}

/** Whether insert-after must separate an unterminated EOF anchor from new text. */
export function requiresLeadingNewlineSeparator(
  content: string,
  target: NativePatchEditTarget,
): boolean {
  if (typeof content !== "string") {
    throw new TypeError("Native edit source content must be a string");
  }
  const [exactTarget] = validateNativeEditTargets([target]);
  if (!exactTarget || exactTarget.operation !== "insert-after" || content.endsWith("\n")) {
    return false;
  }
  let lineNumber = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lineNumber += 1;
  }
  return lineNumber === exactTarget.endLine;
}

function normalizeReplacements(
  replacements: unknown,
  targetIds: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  if (!Array.isArray(replacements) || replacements.length !== targetIds.size) {
    throw new TypeError("submit_native_edits requires exactly one replacement for every host target id");
  }
  const normalized = new Map<string, string>();
  for (const [index, candidate] of replacements.entries()) {
    const record = requirePlainRecord(candidate, `Native edit replacement ${index}`);
    requireOnlyFields(record, NATIVE_REPLACEMENT_FIELDS, `Native edit replacement ${index}`);
    const id = nativeId(record.id, `Native edit replacement ${index}.id`);
    if (!targetIds.has(id)) throw new TypeError(`submit_native_edits received an unknown target id: ${id}`);
    if (normalized.has(id)) throw new TypeError(`submit_native_edits received a duplicate target id: ${id}`);
    if (typeof record.replacement !== "string") {
      throw new TypeError(`Native edit replacement ${id}.replacement must be a string`);
    }
    normalized.set(id, record.replacement);
  }
  if (normalized.size !== targetIds.size) {
    throw new TypeError("submit_native_edits is missing one or more host target ids");
  }
  return normalized;
}

function assertNativeReplacement(
  target: NativePatchEditTarget,
  prepared: PreparedNativePatchEdit,
  replacement: string,
): void {
  if (target.operation === "replace-range") {
    if (prepared.requiresTerminalNewline && !replacement.endsWith("\n")) {
      throw new TypeError(`Native replacement ${target.id} must end with a newline`);
    }
  } else {
    if (replacement.length === 0) {
      throw new TypeError(`Native insertion replacement ${target.id} must contain new text`);
    }
    if (!replacement.endsWith("\n")) {
      throw new TypeError(`Native insertion replacement ${target.id} must end with a newline`);
    }
    if (prepared.requiresLeadingNewlineSeparator && !replacement.startsWith("\n")) {
      throw new TypeError(`Native insertion replacement ${target.id} must start with a newline separator`);
    }
    const anchorText = prepared.currentText.trimEnd();
    if (anchorText.length > 0 && replacement.includes(anchorText)) {
      throw new TypeError(
        `Native insertion replacement ${target.id} must contain only new text, not the current anchor text`,
      );
    }
  }
  const constraint = target.replacementConstraint;
  if (constraint && !new RegExp(constraint.source, constraint.flags).test(replacement)) {
    throw new TypeError(
      `Native replacement ${target.id} does not satisfy its host replacement constraint`,
    );
  }
}

function assertPreparedTarget(
  prepared: PreparedNativePatchEdit,
  target: NativePatchEditTarget,
  sourceRevision: string,
): void {
  if (!sameTarget(prepared.target, target)) {
    throw new TypeError(`Prepared native edit does not match host target ${target.id}`);
  }
  if (
    typeof prepared.requiresLeadingNewlineSeparator !== "boolean" ||
    typeof prepared.requiresTerminalNewline !== "boolean"
  ) {
    throw new TypeError(`Prepared native edit is missing newline requirements for ${target.id}`);
  }
  if (
    prepared.precondition.path !== target.path ||
    prepared.precondition.operation !== target.operation ||
    prepared.precondition.startLine !== target.startLine ||
    prepared.precondition.endLine !== target.endLine ||
    prepared.precondition.evidenceId !== prepared.evidenceId ||
    prepared.precondition.sourceRevision !== sourceRevision
  ) {
    throw new TypeError(`Prepared native edit precondition is not bound to host target ${target.id}`);
  }
}

/**
 * Creates the only PatchPlan native mode can submit. All location, operation,
 * evidence, CAS, and source-revision fields stay host-owned.
 */
export function buildNativeEditsPatchPlan(
  intent: unknown,
  targets: readonly NativePatchEditTarget[],
  preparedEdits: readonly PreparedNativePatchEdit[],
  replacements: unknown,
): PatchPlan {
  if (typeof intent !== "string" || intent.trim().length === 0) {
    throw new TypeError("submit_native_edits intent must be a non-empty string");
  }
  const hostTargets = validateNativeEditTargets(targets);
  if (!Array.isArray(preparedEdits) || preparedEdits.length !== hostTargets.length) {
    throw new TypeError("submit_native_edits requires every host target to be prepared exactly once");
  }
  const sourceRevision = preparedEdits[0]?.precondition.sourceRevision;
  if (typeof sourceRevision !== "string" || sourceRevision.length === 0) {
    throw new TypeError("submit_native_edits requires prepared source revision");
  }
  const preparedById = new Map<string, PreparedNativePatchEdit>();
  for (const prepared of preparedEdits) {
    if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) {
      throw new TypeError("submit_native_edits received an invalid prepared edit");
    }
    if (preparedById.has(prepared.target.id)) {
      throw new TypeError(`submit_native_edits prepared target is duplicated: ${prepared.target.id}`);
    }
    preparedById.set(prepared.target.id, prepared);
  }
  for (const target of hostTargets) {
    const prepared = preparedById.get(target.id);
    if (!prepared) throw new TypeError(`submit_native_edits missing prepared target ${target.id}`);
    assertPreparedTarget(prepared, target, sourceRevision);
  }
  const replacementById = normalizeReplacements(
    replacements,
    new Set(hostTargets.map((target) => target.id)),
  );
  const edits: PatchEdit[] = hostTargets.map((target) => {
    const prepared = preparedById.get(target.id)!;
    const replacement = replacementById.get(target.id)!;
    assertNativeReplacement(target, prepared, replacement);
    return {
      path: target.path,
      evidenceId: prepared.precondition.evidenceId,
      expectedOldHash: prepared.precondition.expectedOldHash,
      operation: target.operation,
      startLine: target.startLine,
      endLine: target.endLine,
      replacement,
    };
  });
  return parsePatchPlan({ version: 1, sourceRevision, intent, edits });
}

export function nativeEditTargetSummary(targets: readonly NativePatchEditTarget[]): string {
  return validateNativeEditTargets(targets)
    .map((target) => {
      const constraint = nativeReplacementConstraintMetadata(target);
      return `${target.id}=${target.path}:${target.startLine}-${target.endLine} (${target.operation})${
        constraint ? `; replacement constraint: ${constraint.description}` : ""
      }`;
    })
    .join(", ");
}
