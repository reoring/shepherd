import { execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

export interface FileContextLimits {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxSliceLines?: number;
  maxSliceCharacters?: number;
  maxObservationCharactersPerTurn?: number;
  maxObservedCharactersPerRun?: number;
}

export interface FileContextSource {
  path: string;
  content: string;
}

export interface FileContextMetadata {
  path: string;
  bytes: number;
  characters: number;
  lines: number;
  language: string;
}


export interface IndexedSearchOptions {
  maxResults?: number;
}

export interface IndexedTextMatch {
  path: string;
  line: number;
  text: string;
}

export interface IndexedSymbolMatch extends IndexedTextMatch {
  id: string;
  preview: string;
  kind: "definition" | "reference";
}

export interface IndexedFileSearchRequest {
  literal: string;
  pathPrefix?: string;
  caseSensitive?: boolean;
  maxResults?: number;
}

export interface IndexedSearchOpenRequest
  extends IndexedFileSearchRequest,
    IndexedOpenMatchOptions {}

export interface IndexedSearchOpenItem {
  match: IndexedSearchHit;
  slice: IndexedSourceSlice;
}

export interface IndexedSearchOpenResult {
  results: readonly IndexedSearchOpenItem[];
  truncated: boolean;
}

export interface IndexedSearchHit {
  id: string;
  path: string;
  line: number;
  preview: string;
}

export interface IndexedSourceSlice {
  id: string;
  revision: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  sha256: string;
  truncated: boolean;
}

export interface IndexedOpenMatchOptions {
  before?: number;
  after?: number;
}

export interface IndexedReadSymbolOptions
  extends IndexedSearchOptions,
    IndexedOpenMatchOptions {}

export type IndexedReadSymbolResult =
  | {
      status: "resolved";
      match: IndexedSymbolMatch;
      slice: IndexedSourceSlice;
    }
  | {
      status: "not_found" | "ambiguous";
      matches: IndexedSymbolMatch[];
    };

export interface IndexedObservationResult {
  evidence: IndexedSourceSlice[];
  omittedDuplicateIds: string[];
  remainingObservationCharacters: number;
  truncated: boolean;
}

interface IndexedFile extends FileContextMetadata {
  content: string;
}

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_SLICE_LINES = 200;
const DEFAULT_MAX_SLICE_CHARACTERS = 16 * 1024;
const DEFAULT_MAX_OBSERVATION_CHARACTERS_PER_TURN = 4 * 1024;
const DEFAULT_MAX_OBSERVED_CHARACTERS_PER_RUN = 12 * 1024;
const DEFAULT_MAX_RESULTS = 100;
const MAX_RESULTS = 1_000;
const MAX_PATTERN_CHARACTERS = 256;
const MAX_RESULT_LINE_CHARACTERS = 500;

const TEXT_EXTENSIONS = new Set([
  ".bash",
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".css",
  ".cue",
  ".fish",
  ".go",
  ".graphql",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".kts",
  ".lock",
  ".md",
  ".mod",
  ".proto",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".sum",
  ".text",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);
const TEXT_BASENAMES = new Set([
  "CODEOWNERS",
  "Dockerfile",
  "LICENSE",
  "Makefile",
  "Tiltfile",
]);

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return resolved;
}

function resolveLimits(limits: FileContextLimits = {}): Required<FileContextLimits> {
  return {
    maxFiles: positiveInteger(limits.maxFiles, DEFAULT_MAX_FILES, "maxFiles"),
    maxFileBytes: positiveInteger(limits.maxFileBytes, DEFAULT_MAX_FILE_BYTES, "maxFileBytes"),
    maxTotalBytes: positiveInteger(limits.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, "maxTotalBytes"),
    maxSliceLines: positiveInteger(limits.maxSliceLines, DEFAULT_MAX_SLICE_LINES, "maxSliceLines"),
    maxSliceCharacters: positiveInteger(
      limits.maxSliceCharacters,
      DEFAULT_MAX_SLICE_CHARACTERS,
      "maxSliceCharacters",
    ),
    maxObservationCharactersPerTurn: positiveInteger(
      limits.maxObservationCharactersPerTurn,
      DEFAULT_MAX_OBSERVATION_CHARACTERS_PER_TURN,
      "maxObservationCharactersPerTurn",
    ),
    maxObservedCharactersPerRun: positiveInteger(
      limits.maxObservedCharactersPerRun,
      DEFAULT_MAX_OBSERVED_CHARACTERS_PER_RUN,
      "maxObservedCharactersPerRun",
    ),
  };
}

function canonicalRelativePath(path: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    throw new Error(`File context path must be a canonical relative path: ${String(path)}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`File context path must be a canonical relative path: ${path}`);
  }
  return path;
}

function canonicalPathPrefix(prefix: string | undefined): string | undefined {
  if (prefix === undefined || prefix === "") return undefined;
  const withoutTrailingSlash = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return canonicalRelativePath(withoutTrailingSlash);
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return resolved;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableId(prefix: "match" | "evidence", ...parts: readonly string[]): string {
  return `${prefix}_${hashText(parts.join("\0")).slice(0, 32)}`;
}

function languageForPath(path: string): string {
  const extension = extname(path).toLowerCase();
  switch (extension) {
    case ".go": return "go";
    case ".ts": return "typescript";
    case ".tsx": return "typescriptreact";
    case ".js": return "javascript";
    case ".jsx": return "javascriptreact";
    case ".py": return "python";
    case ".rs": return "rust";
    case ".java": return "java";
    case ".yaml":
    case ".yml": return "yaml";
    case ".json": return "json";
    case ".md": return "markdown";
    case ".sh":
    case ".bash":
    case ".zsh":
    case ".fish": return "shell";
    default: return extension.slice(1) || "text";
  }
}

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

function normalizeMaxResults(value: number | undefined): number {
  const maxResults = value ?? DEFAULT_MAX_RESULTS;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) {
    throw new RangeError(`maxResults must be an integer from 1 to ${MAX_RESULTS}`);
  }
  return maxResults;
}

function renderResultLine(line: string): string {
  return line.length <= MAX_RESULT_LINE_CHARACTERS
    ? line
    : `${line.slice(0, MAX_RESULT_LINE_CHARACTERS)}…`;
}


function forEachLine(content: string, visit: (line: string, lineNumber: number) => boolean): void {
  let lineNumber = 1;
  let start = 0;
  for (let index = 0; index <= content.length; index += 1) {
    if (index < content.length && content.charCodeAt(index) !== 10) continue;
    const end = index > start && content.charCodeAt(index - 1) === 13 ? index - 1 : index;
    if (!visit(content.slice(start, end), lineNumber)) return;
    start = index + 1;
    lineNumber += 1;
  }
}

function collectLineRange(
  content: string,
  startLine: number,
  endLine: number,
  maxCharacters: number,
): { text: string; endLine: number; truncated: boolean } {
  const selected: string[] = [];
  let characters = 0;
  let actualEnd = startLine - 1;
  let truncated = false;
  forEachLine(content, (line, lineNumber) => {
    if (lineNumber < startLine) return true;
    if (lineNumber > endLine) return false;
    const separatorCharacters = selected.length === 0 ? 0 : 1;
    const remaining = maxCharacters - characters - separatorCharacters;
    if (remaining <= 0) {
      truncated = true;
      return false;
    }
    if (line.length > remaining) {
      selected.push(line.slice(0, remaining));
      characters += separatorCharacters + remaining;
      actualEnd = lineNumber;
      truncated = true;
      return false;
    }
    selected.push(line);
    characters += separatorCharacters + line.length;
    actualEnd = lineNumber;
    return true;
  });
  return { text: selected.join("\n"), endLine: actualEnd, truncated };
}

function isPotentialTextPath(path: string): boolean {
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || TEXT_BASENAMES.has(basename(path));
}

function isInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

const GIT_CONTEXT_TIMEOUT_MS = 10_000;

interface GitContextCommandOptions {
  signal?: AbortSignal;
}

function execFileText(
  command: string,
  args: readonly string[],
  cwd: string,
  options: GitContextCommandOptions = {},
): Promise<string> {
  const { signal } = options;
  signal?.throwIfAborted();
  const { promise, resolve: resolvePromise, reject } = Promise.withResolvers<string>();
  let aborted = false;
  let child: ChildProcess;
  const onAbort = (): void => {
    aborted = true;
    child.kill("SIGKILL");
  };
  child = execFile(
    command,
    [...args],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: GIT_CONTEXT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
    (error, stdout, stderr) => {
      signal?.removeEventListener("abort", onAbort);
      if (aborted || signal?.aborted) {
        reject(signal?.reason ?? new DOMException("Git context loading aborted", "AbortError"));
        return;
      }
      if (error) {
        const detail = stderr.trim();
        reject(new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`, { cause: error }));
        return;
      }
      resolvePromise(stdout);
    },
  );
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return promise;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function definitionPattern(path: string, symbol: string): RegExp {
  const escaped = escapeRegExp(symbol);
  const extension = extname(path).toLowerCase();
  if (extension === ".go") {
    return new RegExp(`^\\s*(?:func\\s+(?:\\([^)]*\\)\\s*)?|type\\s+|var\\s+|const\\s+)${escaped}(?![A-Za-z0-9_$])`, "u");
  }
  if ([".ts", ".tsx", ".js", ".jsx"].includes(extension)) {
    return new RegExp(
      `^\\s*(?:(?:export|declare|default|async|abstract)\\s+)*(?:(?:function|class|interface|type|enum|namespace|const|let|var)\\s+${escaped}(?![A-Za-z0-9_$])|(?:public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+)*${escaped}\\s*\\()`,
      "u",
    );
  }
  if (extension === ".py") {
    return new RegExp(`^\\s*(?:async\\s+def|def|class)\\s+${escaped}(?![A-Za-z0-9_$])`, "u");
  }
  if (extension === ".rs") {
    return new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:fn|struct|enum|trait|type|const|static|mod)\\s+${escaped}(?![A-Za-z0-9_$])`, "u");
  }
  return new RegExp(`^\\s*(?:class|interface|type|func|function|def|const|var|let)\\s+${escaped}(?![A-Za-z0-9_$])`, "u");
}

export class FileIndexedContext {
  readonly kind = "files" as const;
  readonly files: readonly FileContextMetadata[];
  readonly totalBytes: number;
  readonly sourceRoot: string | undefined;
  readonly sourceRevision: string;
  readonly corpusId: string;
  readonly limits: Required<FileContextLimits>;
  private readonly indexedFiles: readonly IndexedFile[];
  private readonly byPath: ReadonlyMap<string, IndexedFile>;
  private readonly searchHits = new Map<string, IndexedSearchHit>();
  private readonly evidence = new Map<string, IndexedSourceSlice>();

  constructor(
    files: readonly FileContextSource[],
    options: FileContextLimits & { sourceRoot?: string; sourceRevision?: string } = {},
  ) {
    const limits = resolveLimits(options);
    if (files.length > limits.maxFiles) {
      throw new Error(`File context exceeds maxFiles: ${files.length}/${limits.maxFiles}`);
    }
    const indexed: IndexedFile[] = [];
    const paths = new Set<string>();
    let totalBytes = 0;
    for (const file of files) {
      const path = canonicalRelativePath(file.path);
      if (paths.has(path)) throw new Error(`File context contains duplicate path: ${path}`);
      paths.add(path);
      if (file.content.includes("\0")) throw new Error(`File context contains NUL bytes: ${path}`);
      const bytes = Buffer.byteLength(file.content, "utf8");
      if (bytes > limits.maxFileBytes) {
        throw new Error(`File context file exceeds maxFileBytes: ${path} ${bytes}/${limits.maxFileBytes}`);
      }
      totalBytes += bytes;
      if (totalBytes > limits.maxTotalBytes) {
        throw new Error(`File context exceeds maxTotalBytes: ${totalBytes}/${limits.maxTotalBytes}`);
      }
      indexed.push({
        path,
        content: file.content,
        bytes,
        characters: file.content.length,
        lines: lineCount(file.content),
        language: languageForPath(path),
      });
    }
    indexed.sort((left, right) => left.path.localeCompare(right.path));
    const corpusHash = createHash("sha256");
    for (const file of indexed) {
      corpusHash.update(file.path).update("\0").update(file.content).update("\0");
    }
    this.corpusId = corpusHash.digest("hex");
    this.sourceRevision = options.sourceRevision ?? `sha256:${this.corpusId}`;
    this.indexedFiles = indexed;
    this.byPath = new Map(indexed.map((file) => [file.path, file]));
    this.files = indexed.map(({ content: _content, ...metadata }) => Object.freeze(metadata));
    this.totalBytes = totalBytes;
    this.sourceRoot = options.sourceRoot;
    this.limits = limits;
  }

  read(path: string): string {
    const canonicalPath = canonicalRelativePath(path);
    const file = this.byPath.get(canonicalPath);
    if (!file) throw new Error(`Indexed file does not exist: ${canonicalPath}`);
    return file.content;
  }

  search(request: IndexedFileSearchRequest): IndexedSearchHit[] {
    if (typeof request.literal !== "string" || request.literal.length === 0) {
      throw new TypeError("search_files literal must not be empty");
    }
    if (request.literal.length > MAX_PATTERN_CHARACTERS) {
      throw new RangeError(`search_files literal exceeds ${MAX_PATTERN_CHARACTERS} characters`);
    }
    const maxResults = normalizeMaxResults(request.maxResults);
    const pathPrefix = canonicalPathPrefix(request.pathPrefix);
    const caseSensitive = request.caseSensitive ?? true;
    const needle = caseSensitive
      ? request.literal
      : request.literal.toLocaleLowerCase("en-US");
    const matches: IndexedSearchHit[] = [];
    for (const file of this.indexedFiles) {
      if (
        pathPrefix &&
        file.path !== pathPrefix &&
        !file.path.startsWith(`${pathPrefix}/`)
      ) {
        continue;
      }
      forEachLine(file.content, (line, lineNumber) => {
        const haystack = caseSensitive ? line : line.toLocaleLowerCase("en-US");
        if (haystack.includes(needle)) {
          const id = stableId(
            "match",
            this.sourceRevision,
            file.path,
            String(lineNumber),
            request.literal,
          );
          const hit = {
            id,
            path: file.path,
            line: lineNumber,
            preview: renderResultLine(line),
          };
          this.searchHits.set(id, hit);
          matches.push(hit);
        }
        return matches.length < maxResults;
      });
      if (matches.length >= maxResults) break;
    }
    return matches;
  }

  readLines(path: string, startLine: number, endLine: number): IndexedSourceSlice {
    const canonicalPath = canonicalRelativePath(path);
    const file = this.byPath.get(canonicalPath);
    if (!file) throw new Error(`Indexed file does not exist: ${canonicalPath}`);
    if (!Number.isInteger(startLine) || startLine < 1) {
      throw new RangeError("read_lines startLine must be a positive integer");
    }
    if (!Number.isInteger(endLine) || endLine < startLine) {
      throw new RangeError("read_lines endLine must be an integer at least startLine");
    }
    if (startLine > file.lines) {
      throw new RangeError(`read_lines startLine exceeds file lines: ${startLine}/${file.lines}`);
    }
    const requestedEnd = Math.min(endLine, file.lines);
    const boundedEnd = Math.min(
      requestedEnd,
      startLine + this.limits.maxSliceLines - 1,
    );
    const range = collectLineRange(
      file.content,
      startLine,
      boundedEnd,
      this.limits.maxSliceCharacters,
    );
    const sha256 = hashText(range.text);
    const id = stableId(
      "evidence",
      this.sourceRevision,
      canonicalPath,
      String(startLine),
      String(range.endLine),
      sha256,
    );
    const slice: IndexedSourceSlice = Object.freeze({
      id,
      revision: this.sourceRevision,
      path: canonicalPath,
      startLine,
      endLine: range.endLine,
      text: range.text,
      sha256,
      truncated: endLine > boundedEnd || range.truncated,
    });
    this.evidence.set(id, slice);
    return slice;
  }

  openMatch(matchId: string, options: IndexedOpenMatchOptions = {}): IndexedSourceSlice {
    const hit = this.searchHits.get(matchId);
    if (!hit) throw new Error(`Unknown or stale match ID: ${matchId}`);
    const before = nonNegativeInteger(options.before, 0, "open_match before");
    const after = nonNegativeInteger(options.after, 0, "open_match after");
    return this.readLines(
      hit.path,
      Math.max(1, hit.line - before),
      hit.line + after,
    );
  }

  resolveEvidence(ids: readonly string[]): IndexedSourceSlice[] {
    const seen = new Set<string>();
    const resolved: IndexedSourceSlice[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const slice = this.evidence.get(id);
      if (!slice || slice.revision !== this.sourceRevision) {
        throw new Error(`Unknown, stale, or foreign evidence ID: ${id}`);
      }
      resolved.push(slice);
    }
    return resolved;
  }


  findSymbol(name: string, options: IndexedSearchOptions = {}): IndexedSymbolMatch[] {
    if (typeof name !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name)) {
      throw new TypeError("find_symbol name must be one source identifier");
    }
    const maxResults = normalizeMaxResults(options.maxResults);
    const exactSymbol = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(name)}(?![A-Za-z0-9_$])`, "u");
    const definitions: IndexedSymbolMatch[] = [];
    const references: IndexedSymbolMatch[] = [];
    for (const file of this.indexedFiles) {
      const definition = definitionPattern(file.path, name);
      forEachLine(file.content, (line, lineNumber) => {
        if (!exactSymbol.test(line)) return true;
        const preview = renderResultLine(line);
        const id = stableId(
          "match",
          this.sourceRevision,
          file.path,
          String(lineNumber),
          `symbol:${name}`,
        );
        const match: IndexedSymbolMatch = {
          id,
          path: file.path,
          line: lineNumber,
          text: preview,
          preview,
          kind: definition.test(line) ? "definition" : "reference",
        };
        this.searchHits.set(id, { id, path: file.path, line: lineNumber, preview });
        if (match.kind === "definition") definitions.push(match);
        else if (references.length < maxResults) references.push(match);
        return true;
      });
    }
    return [...definitions, ...references].slice(0, maxResults);
  }
}

export class FileIndexedEvidenceSession {
  readonly context: FileIndexedContext;
  private readonly matches = new Set<string>();
  private readonly issuedEvidence = new Set<string>();
  private readonly observed = new Map<string, IndexedSourceSlice>();
  private observedCharacters = 0;
  private turnObservationCharacters = 0;

  constructor(context: FileIndexedContext) {
    this.context = context;
  }

  beginTurn(): void {
    this.turnObservationCharacters = 0;
  }

  search(request: IndexedFileSearchRequest): IndexedSearchHit[] {
    const hits = this.context.search(request);
    for (const hit of hits) this.matches.add(hit.id);
    return hits;
  }

  searchOpen(request: IndexedSearchOpenRequest): IndexedSearchOpenResult {
    const maxResults = request.maxResults ?? 1;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 2) {
      throw new RangeError("search_open maxResults must be an integer at most 2");
    }
    const hits = this.search({
      literal: request.literal,
      pathPrefix: request.pathPrefix,
      caseSensitive: request.caseSensitive,
      maxResults: maxResults + 1,
    });
    const results = hits.slice(0, maxResults).map((match) =>
      Object.freeze({
        match,
        slice: this.openMatch(match.id, {
          before: request.before ?? 8,
          after: request.after ?? 40,
        }),
      }),
    );
    return Object.freeze({
      results: Object.freeze(results),
      truncated: hits.length > maxResults,
    });
  }

  findSymbol(name: string, options?: IndexedSearchOptions): IndexedSymbolMatch[] {
    const hits = this.context.findSymbol(name, options);
    for (const hit of hits) this.matches.add(hit.id);
    return hits;
  }

  readSymbol(
    name: string,
    options: IndexedReadSymbolOptions = {},
  ): IndexedReadSymbolResult {
    const resolutionMatches = this.findSymbol(name, { maxResults: 2 });
    const definitions = resolutionMatches.filter(
      (match) => match.kind === "definition",
    );
    if (definitions.length === 1) {
      const match = definitions[0]!;
      const slice = this.openMatch(match.id, {
        before: options.before ?? 8,
        after: options.after ?? 80,
      });
      return Object.freeze({ status: "resolved", match, slice });
    }

    const matches = this.findSymbol(name, { maxResults: options.maxResults });
    return Object.freeze({
      status: definitions.length === 0 ? "not_found" : "ambiguous",
      matches:
        definitions.length === 0
          ? matches
          : matches.filter((match) => match.kind === "definition"),
    });
  }

  readLines(path: string, startLine: number, endLine: number): IndexedSourceSlice {
    const slice = this.context.readLines(path, startLine, endLine);
    this.issuedEvidence.add(slice.id);
    return slice;
  }

  openMatch(
    matchId: string,
    options?: IndexedOpenMatchOptions,
  ): IndexedSourceSlice {
    if (!this.matches.has(matchId)) {
      throw new Error(`Unknown or stale match ID in this evidence session: ${matchId}`);
    }
    const slice = this.context.openMatch(matchId, options);
    this.issuedEvidence.add(slice.id);
    return slice;
  }

  resolveEvidence(ids: readonly string[]): IndexedSourceSlice[] {
    for (const id of new Set(ids)) {
      if (!this.issuedEvidence.has(id)) {
        throw new Error(`Unknown, stale, or foreign evidence ID in this session: ${id}`);
      }
    }
    return this.context.resolveEvidence(ids);
  }
  resolveObservedEvidence(ids: readonly string[]): IndexedSourceSlice[] {
    const resolved = this.resolveEvidence(ids);
    return resolved.map((slice) => {
      const observed = this.observed.get(slice.id);
      if (!observed) {
        throw new Error(`Evidence ID was issued but not observed in this session: ${slice.id}`);
      }
      return observed;
    });
  }


  observe(ids: readonly string[]): IndexedObservationResult {
    const slices = this.resolveEvidence(ids);
    const evidence: IndexedSourceSlice[] = [];
    const omittedDuplicateIds: string[] = [];
    let truncated = false;
    for (const slice of slices) {
      if (this.observed.has(slice.id)) {
        omittedDuplicateIds.push(slice.id);
        continue;
      }
      const turnRemaining =
        this.context.limits.maxObservationCharactersPerTurn -
        this.turnObservationCharacters;
      const runRemaining =
        this.context.limits.maxObservedCharactersPerRun -
        this.observedCharacters;
      const allowed = Math.min(turnRemaining, runRemaining, slice.text.length);
      if (allowed <= 0) {
        truncated = true;
        break;
      }
      const observedSlice = Object.freeze({
        ...slice,
        text: slice.text.slice(0, allowed),
        truncated: slice.truncated || allowed < slice.text.length,
      });
      evidence.push(observedSlice);
      this.observed.set(slice.id, observedSlice);
      this.turnObservationCharacters += allowed;
      this.observedCharacters += allowed;
      if (allowed < slice.text.length) truncated = true;
    }
    return {
      evidence,
      omittedDuplicateIds,
      remainingObservationCharacters: Math.max(
        0,
        Math.min(
          this.context.limits.maxObservationCharactersPerTurn -
            this.turnObservationCharacters,
          this.context.limits.maxObservedCharactersPerRun -
            this.observedCharacters,
        ),
      ),
      truncated,
    };
  }
}

const defaultEvidenceSessions = new WeakMap<FileIndexedContext, FileIndexedEvidenceSession>();

function defaultEvidenceSession(context: FileIndexedContext): FileIndexedEvidenceSession {
  let session = defaultEvidenceSessions.get(context);
  if (!session) {
    session = new FileIndexedEvidenceSession(context);
    defaultEvidenceSessions.set(context, session);
  }
  return session;
}

export function createFileIndexedContext(
  files: readonly FileContextSource[],
  options: FileContextLimits & { sourceRoot?: string; sourceRevision?: string } = {},
): FileIndexedContext {
  return new FileIndexedContext(files, options);
}

export async function loadIndexedPathContext(
  path: string,
  limits: FileContextLimits = {},
): Promise<FileIndexedContext> {
  const sourcePath = await realpath(path);
  const info = await lstat(sourcePath);
  if (info.isDirectory()) return loadGitDirectoryContext(sourcePath, limits);
  if (!info.isFile()) {
    throw new Error(`RLM context path is not a file or directory: ${path}`);
  }
  return createFileIndexedContext(
    [{ path: basename(sourcePath), content: await readFile(sourcePath, "utf8") }],
    {
      ...limits,
      sourceRoot: dirname(sourcePath),
    },
  );
}

export interface GitDirectoryContextOptions {
  signal?: AbortSignal;
}

export async function loadGitDirectoryContext(
  directory: string,
  limits: FileContextLimits = {},
  options: GitDirectoryContextOptions = {},
): Promise<FileIndexedContext> {
  const sourceRoot = await realpath(directory);
  const rootInfo = await lstat(sourceRoot);
  if (!rootInfo.isDirectory()) throw new Error(`RLM directory context is not a directory: ${directory}`);

  let repositoryRoot: string;
  try {
    repositoryRoot = (await execFileText(
      "git",
      ["rev-parse", "--show-toplevel"],
      sourceRoot,
      options,
    )).trim();
  } catch (error) {
    throw new Error(`RLM directory context must be inside a Git working tree: ${directory}`, { cause: error });
  }
  repositoryRoot = await realpath(repositoryRoot);
  if (!isInside(repositoryRoot, sourceRoot)) {
    throw new Error(`RLM directory context escapes its Git working tree: ${directory}`);
  }
  const selectedPath = relative(repositoryRoot, sourceRoot).split(sep).join("/") || ".";
  const trackedOutput = await execFileText(
    "git",
    ["ls-files", "-z", "--cached", "--", selectedPath],
    repositoryRoot,
    options,
  );
  const trackedPaths = trackedOutput.split("\0").filter(Boolean).sort();
  const candidates = trackedPaths.filter((path) => isPotentialTextPath(path));
  const resolvedLimits = resolveLimits(limits);
  if (candidates.length > resolvedLimits.maxFiles) {
    throw new Error(`File context exceeds maxFiles: ${candidates.length}/${resolvedLimits.maxFiles}`);
  }

  const files: FileContextSource[] = [];
  for (const trackedPath of candidates) {
    const absolutePath = resolve(repositoryRoot, trackedPath);
    const relativeToSelection = relative(sourceRoot, absolutePath);
    if (!isInside(sourceRoot, absolutePath) || relativeToSelection.startsWith(`..${sep}`)) continue;
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) continue;
    if (!info.isFile()) continue;
    if (info.size > resolvedLimits.maxFileBytes) {
      throw new Error(
        `File context file exceeds maxFileBytes: ${trackedPath} ${info.size}/${resolvedLimits.maxFileBytes}`,
      );
    }
    const resolvedFile = await realpath(absolutePath);
    if (!isInside(sourceRoot, resolvedFile)) {
      throw new Error(`RLM directory context file escapes selected root: ${trackedPath}`);
    }
    const content = await readFile(resolvedFile, "utf8");
    files.push({
      path: relative(sourceRoot, resolvedFile).split(sep).join("/"),
      content,
    });
  }
  const sourceRevision = (
    await execFileText("git", ["rev-parse", "HEAD"], repositoryRoot, options)
  ).trim();
  return createFileIndexedContext(files, {
    ...resolvedLimits,
    sourceRoot,
    sourceRevision,
  });
}

export function readIndexedFile(context: FileIndexedContext, path: string): string {
  return context.read(path);
}


export function findIndexedSymbol(
  context: FileIndexedContext,
  name: string,
  options?: IndexedSearchOptions,
): IndexedSymbolMatch[] {
  return context.findSymbol(name, options);
}

export function createFileIndexedEvidenceSession(
  context: FileIndexedContext,
): FileIndexedEvidenceSession {
  return new FileIndexedEvidenceSession(context);
}

export function searchIndexedFiles(
  context: FileIndexedContext,
  request: IndexedFileSearchRequest,
): IndexedSearchHit[] {
  return defaultEvidenceSession(context).search(request);
}

export function readIndexedLines(
  context: FileIndexedContext,
  path: string,
  startLine: number,
  endLine: number,
): IndexedSourceSlice {
  return defaultEvidenceSession(context).readLines(path, startLine, endLine);
}

export function openIndexedMatch(
  context: FileIndexedContext,
  matchId: string,
  options?: IndexedOpenMatchOptions,
): IndexedSourceSlice {
  return defaultEvidenceSession(context).openMatch(matchId, options);
}

export function beginIndexedObservationTurn(context: FileIndexedContext): void {
  defaultEvidenceSession(context).beginTurn();
}

export function observeIndexedEvidence(
  context: FileIndexedContext,
  evidenceIds: readonly string[],
): IndexedObservationResult {
  return defaultEvidenceSession(context).observe(evidenceIds);
}
