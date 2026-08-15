import type {
  FactExtractionFailureCode,
  FactLineScope,
  PiRlmFactExtractor,
} from "./worker-protocol.ts";

const MAX_SOURCE_LINES = 200;
const MAX_LITERAL_CHARACTERS = 128;
const MAX_SELECT_LITERALS = 4;
const MAX_CAPTURE_COUNT = 16;
const MAX_SEPARATOR_CHARACTERS = 8;
const MAX_CAPTURED_CHARACTERS = 2_048;

export interface FactExtractorOutput {
  value: string;
  supportQuotes: readonly string[];
  scopedLineCount: number;
  selectedLineCount: number;
  capturedValueCount: number;
}

export class FactExtractorError extends Error {
  readonly code: FactExtractionFailureCode;

  constructor(code: FactExtractionFailureCode, message: string) {
    super(message);
    this.name = "FactExtractorError";
    this.code = code;
  }
}

function boundedString(value: unknown, name: string, max = MAX_LITERAL_CHARACTERS): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new FactExtractorError(
      "INVALID_EXTRACTOR",
      `${name} must contain 1-${max} characters`,
    );
  }
  return value;
}

function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new FactExtractorError(
      "INVALID_EXTRACTOR",
      `${name} must be an integer from ${minimum}-${maximum}`,
    );
  }
  return Number(value);
}

export function validateFactExtractor(
  extractor: PiRlmFactExtractor,
): PiRlmFactExtractor {
  if (!extractor || typeof extractor !== "object") {
    throw new FactExtractorError("INVALID_EXTRACTOR", "extractor must be an object");
  }
  if (extractor.source.kind === "symbol") {
    boundedString(extractor.source.name, "source symbol name");
    boundedInteger(extractor.source.before, "source before", 0, MAX_SOURCE_LINES);
    boundedInteger(extractor.source.after, "source after", 0, MAX_SOURCE_LINES);
  } else if (extractor.source.kind === "search-open") {
    boundedString(extractor.source.literal, "source search literal");
    boundedString(extractor.source.path, "source search path", 512);
    boundedInteger(extractor.source.before, "source before", 0, MAX_SOURCE_LINES);
    boundedInteger(extractor.source.after, "source after", 0, MAX_SOURCE_LINES);
  } else {
    throw new FactExtractorError("INVALID_EXTRACTOR", "source kind is unsupported");
  }

  validateScope(extractor.scope);

  if (extractor.select.kind === "contains-all") {
    if (
      !Array.isArray(extractor.select.literals) ||
      extractor.select.literals.length < 1 ||
      extractor.select.literals.length > MAX_SELECT_LITERALS
    ) {
      throw new FactExtractorError(
        "INVALID_EXTRACTOR",
        `selector literals must contain 1-${MAX_SELECT_LITERALS} entries`,
      );
    }
    for (const literal of extractor.select.literals) {
      boundedString(literal, "selector literal");
    }
  } else if (extractor.select.kind === "identifier-chain-line") {
    boundedString(
      extractor.select.trailingDelimiter,
      "selector trailingDelimiter",
      MAX_SEPARATOR_CHARACTERS,
    );
  } else {
    throw new FactExtractorError("INVALID_EXTRACTOR", "selector kind is unsupported");
  }

  if (extractor.capture.kind === "quoted-string") {
    boundedInteger(extractor.capture.index, "quoted-string index", 0, 7);
  } else if (extractor.capture.kind === "identifier-chain") {
    if (typeof extractor.capture.stripTrailingDelimiter !== "boolean") {
      throw new FactExtractorError(
        "INVALID_EXTRACTOR",
        "identifier-chain stripTrailingDelimiter must be boolean",
      );
    }
  } else if (
    extractor.capture.kind === "identifier-after" ||
    extractor.capture.kind === "number-after"
  ) {
    boundedString(extractor.capture.literal, "capture literal");
  } else {
    throw new FactExtractorError("INVALID_EXTRACTOR", "capture kind is unsupported");
  }

  if (extractor.reduce.kind === "single") {
    if (extractor.reduce.exactCount !== 1) {
      throw new FactExtractorError(
        "INVALID_EXTRACTOR",
        "single reducer exactCount must be 1",
      );
    }
  } else if (extractor.reduce.kind === "join") {
    boundedInteger(
      extractor.reduce.exactCount,
      "join reducer exactCount",
      1,
      MAX_CAPTURE_COUNT,
    );
    boundedString(
      extractor.reduce.separator,
      "join reducer separator",
      MAX_SEPARATOR_CHARACTERS,
    );
  } else {
    throw new FactExtractorError("INVALID_EXTRACTOR", "reducer kind is unsupported");
  }
  return extractor;
}

function validateScope(scope: FactLineScope | undefined): void {
  if (!scope) return;
  if (scope.afterLiteral !== undefined) {
    boundedString(scope.afterLiteral, "scope afterLiteral");
  }
  if (scope.beforeLiteral !== undefined) {
    boundedString(scope.beforeLiteral, "scope beforeLiteral");
  }
  if (scope.maxLines !== undefined) {
    boundedInteger(scope.maxLines, "scope maxLines", 1, MAX_SOURCE_LINES);
  }
}

function scopeLines(lines: readonly string[], scope: FactLineScope | undefined): string[] {
  let start = 0;
  let end = lines.length;
  if (scope?.afterLiteral !== undefined) {
    const index = lines.findIndex((line) => line.includes(scope.afterLiteral!));
    if (index < 0) {
      throw new FactExtractorError(
        "SCOPE_NOT_FOUND",
        `afterLiteral was not found: ${scope.afterLiteral}`,
      );
    }
    start = index + 1;
  }
  if (scope?.beforeLiteral !== undefined) {
    const relativeIndex = lines
      .slice(start)
      .findIndex((line) => line.includes(scope.beforeLiteral!));
    if (relativeIndex < 0) {
      throw new FactExtractorError(
        "SCOPE_NOT_FOUND",
        `beforeLiteral was not found: ${scope.beforeLiteral}`,
      );
    }
    end = start + relativeIndex;
  }
  const scoped = lines.slice(start, end);
  if (scope?.maxLines !== undefined && scoped.length > scope.maxLines) {
    throw new FactExtractorError(
      "SCOPE_NOT_FOUND",
      `scoped lines exceed maxLines: ${scoped.length}/${scope.maxLines}`,
    );
  }
  return scoped;
}

function isIdentifierStart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z_$]/u.test(character);
}

function isIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_$]/u.test(character);
}

function isIdentifierChain(value: string): boolean {
  if (value.length === 0) return false;
  for (const segment of value.split(".")) {
    if (!isIdentifierStart(segment[0])) return false;
    for (const character of segment.slice(1)) {
      if (!isIdentifierPart(character)) return false;
    }
  }
  return true;
}

function selectLines(extractor: PiRlmFactExtractor, lines: readonly string[]): string[] {
  if (extractor.select.kind === "contains-all") {
    return lines.filter((line) =>
      extractor.select.kind === "contains-all" &&
      extractor.select.literals.every((literal) => line.includes(literal)),
    );
  }
  const delimiter = extractor.select.trailingDelimiter;
  return lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed.endsWith(delimiter)) return false;
    const candidate = trimmed.slice(0, -delimiter.length).trim();
    return isIdentifierChain(candidate);
  });
}

function quotedStrings(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let delimiter: "'" | '"' | undefined;
  let escaped = false;
  for (const character of line) {
    if (delimiter === undefined) {
      if (character === '"' || character === "'") {
        delimiter = character;
        current = "";
      }
      continue;
    }
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === delimiter) {
      values.push(current);
      delimiter = undefined;
      continue;
    }
    current += character;
  }
  if (delimiter !== undefined || escaped) {
    throw new FactExtractorError("CAPTURE_FAILED", "unterminated quoted string");
  }
  return values;
}

function captureValue(extractor: PiRlmFactExtractor, line: string): string {
  if (extractor.capture.kind === "quoted-string") {
    const value = quotedStrings(line)[extractor.capture.index];
    if (value === undefined || value.length === 0) {
      throw new FactExtractorError("CAPTURE_FAILED", "quoted string capture is absent");
    }
    return value;
  }
  if (extractor.capture.kind === "identifier-chain") {
    let value = line.trim();
    if (extractor.capture.stripTrailingDelimiter) {
      if (extractor.select.kind !== "identifier-chain-line") {
        throw new FactExtractorError(
          "INVALID_EXTRACTOR",
          "identifier-chain delimiter stripping requires identifier-chain-line selector",
        );
      }
      const delimiter = extractor.select.trailingDelimiter;
      if (!value.endsWith(delimiter)) {
        throw new FactExtractorError("CAPTURE_FAILED", "trailing delimiter is absent");
      }
      value = value.slice(0, -delimiter.length).trim();
    }
    if (!isIdentifierChain(value)) {
      throw new FactExtractorError("CAPTURE_FAILED", "identifier chain is invalid");
    }
    return value;
  }
  if (extractor.capture.kind === "number-after") {
    const index = line.indexOf(extractor.capture.literal);
    if (index < 0) {
      throw new FactExtractorError("CAPTURE_FAILED", "capture literal is absent");
    }
    let start = index + extractor.capture.literal.length;
    while (/\s/u.test(line[start] ?? "")) start += 1;
    const match = line.slice(start).match(
      /^[+-]?(?:\d(?:_?\d)*(?:\.\d(?:_?\d)*)?|\.\d(?:_?\d)*)/u,
    );
    if (!match) {
      throw new FactExtractorError("CAPTURE_FAILED", "number does not follow literal");
    }
    return match[0];
  }
  const index = line.indexOf(extractor.capture.literal);
  if (index < 0) {
    throw new FactExtractorError("CAPTURE_FAILED", "capture literal is absent");
  }
  const start = index + extractor.capture.literal.length;
  if (!isIdentifierStart(line[start])) {
    throw new FactExtractorError("CAPTURE_FAILED", "identifier does not follow literal");
  }
  let end = start + 1;
  while (isIdentifierPart(line[end])) end += 1;
  while (line[end] === "." && isIdentifierStart(line[end + 1])) {
    end += 2;
    while (isIdentifierPart(line[end])) end += 1;
  }
  const value = line.slice(start, end);
  if (!isIdentifierChain(value)) {
    throw new FactExtractorError("CAPTURE_FAILED", "identifier chain is invalid");
  }
  return value;
}

export function applyFactExtractor(
  extractor: PiRlmFactExtractor,
  text: string,
): FactExtractorOutput {
  validateFactExtractor(extractor);
  if (typeof text !== "string") {
    throw new FactExtractorError("CAPTURE_FAILED", "source text must be a string");
  }
  const scoped = scopeLines(text.split("\n"), extractor.scope);
  const selected = selectLines(extractor, scoped);
  const expectedCount = extractor.reduce.exactCount;
  if (selected.length !== expectedCount) {
    throw new FactExtractorError(
      "CARDINALITY_MISMATCH",
      `selected line count is ${selected.length}; expected ${expectedCount}`,
    );
  }
  const captured = selected.map((line) => captureValue(extractor, line));
  if (new Set(captured).size !== captured.length) {
    throw new FactExtractorError("CAPTURE_FAILED", "captured values contain duplicates");
  }
  const value =
    extractor.reduce.kind === "single"
      ? captured[0]!
      : captured.join(extractor.reduce.separator);
  if (value.length === 0 || value.length > MAX_CAPTURED_CHARACTERS) {
    throw new FactExtractorError(
      "CAPTURE_FAILED",
      `captured value must contain 1-${MAX_CAPTURED_CHARACTERS} characters`,
    );
  }
  return Object.freeze({
    value,
    supportQuotes: Object.freeze([...selected]),
    scopedLineCount: scoped.length,
    selectedLineCount: selected.length,
    capturedValueCount: captured.length,
  });
}
