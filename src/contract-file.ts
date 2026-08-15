import { validateFactExtractor } from "./fact-extractor.ts";
import { validateFactFinalizer } from "./fact-finalizer.ts";
import type {
  PiRlmFactContract,
  PiRlmFactExtractor,
  PiRlmFactRequirement,
} from "./worker-protocol.ts";

const MAX_CONTRACT_BYTES = 256 * 1024;
const MAX_FACT_REQUIREMENTS = 16;
const MAX_FACT_ID_CHARACTERS = 64;
const MAX_DESCRIPTION_CHARACTERS = 512;
const MAX_PATTERN_CHARACTERS = 1_024;
const MAX_SOURCE_HINT_CHARACTERS = 512;

export interface RlmAnswerContract {
  description: string;
  pattern?: string;
}

export interface RlmContractFile {
  version: 1;
  factContract: PiRlmFactContract;
  answerContract?: RlmAnswerContract;
}

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as JsonObject;
}

function assertKeys(
  value: JsonObject,
  allowed: readonly string[],
  path: string,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`unknown field: ${path}.${key}`);
  }
}

function boundedString(
  value: unknown,
  path: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${path} must contain 1-${maximum} characters`);
  }
  return value;
}

function validateStrictExtractor(value: unknown, path: string): PiRlmFactExtractor {
  const extractor = objectValue(value, path);
  assertKeys(extractor, ["source", "scope", "select", "capture", "reduce"], path);

  const source = objectValue(extractor.source, `${path}.source`);
  if (source.kind === "symbol") {
    assertKeys(source, ["kind", "name", "before", "after"], `${path}.source`);
  } else if (source.kind === "search-open") {
    assertKeys(
      source,
      ["kind", "literal", "path", "before", "after"],
      `${path}.source`,
    );
  }

  if (extractor.scope !== undefined) {
    assertKeys(
      objectValue(extractor.scope, `${path}.scope`),
      ["afterLiteral", "beforeLiteral", "maxLines"],
      `${path}.scope`,
    );
  }

  const select = objectValue(extractor.select, `${path}.select`);
  if (select.kind === "contains-all") {
    assertKeys(select, ["kind", "literals"], `${path}.select`);
  } else if (select.kind === "identifier-chain-line") {
    assertKeys(select, ["kind", "trailingDelimiter"], `${path}.select`);
  }

  const capture = objectValue(extractor.capture, `${path}.capture`);
  if (capture.kind === "quoted-string") {
    assertKeys(capture, ["kind", "index"], `${path}.capture`);
  } else if (capture.kind === "identifier-chain") {
    assertKeys(
      capture,
      ["kind", "stripTrailingDelimiter"],
      `${path}.capture`,
    );
  } else if (capture.kind === "identifier-after") {
    assertKeys(capture, ["kind", "literal"], `${path}.capture`);
  }

  const reduce = objectValue(extractor.reduce, `${path}.reduce`);
  if (reduce.kind === "single") {
    assertKeys(reduce, ["kind", "exactCount"], `${path}.reduce`);
  } else if (reduce.kind === "join") {
    assertKeys(
      reduce,
      ["kind", "exactCount", "separator"],
      `${path}.reduce`,
    );
  }

  return validateFactExtractor(extractor as unknown as PiRlmFactExtractor);
}

function validateRequirement(value: unknown, path: string): PiRlmFactRequirement {
  const requirement = objectValue(value, path);
  assertKeys(
    requirement,
    ["id", "description", "grounding", "minSupports", "sourceHint", "extractor"],
    path,
  );
  const id = boundedString(requirement.id, `${path}.id`, MAX_FACT_ID_CHARACTERS);
  if (!/^[a-z][a-z0-9-]*$/u.test(id)) {
    throw new Error(`${path}.id must be a lowercase kebab-case identifier`);
  }
  const description = boundedString(
    requirement.description,
    `${path}.description`,
    MAX_DESCRIPTION_CHARACTERS,
  );
  if (!["quoted", "derived", "quoted-list"].includes(String(requirement.grounding))) {
    throw new Error(`${path}.grounding is invalid`);
  }
  if (
    !Number.isInteger(requirement.minSupports) ||
    Number(requirement.minSupports) < 1 ||
    Number(requirement.minSupports) > 16
  ) {
    throw new Error(`${path}.minSupports must be an integer from 1-16`);
  }
  if (requirement.sourceHint !== undefined && requirement.extractor !== undefined) {
    throw new Error(`${path} cannot define both sourceHint and extractor`);
  }
  const sourceHint =
    requirement.sourceHint === undefined
      ? undefined
      : boundedString(
          requirement.sourceHint,
          `${path}.sourceHint`,
          MAX_SOURCE_HINT_CHARACTERS,
        );
  const extractor =
    requirement.extractor === undefined
      ? undefined
      : validateStrictExtractor(requirement.extractor, `${path}.extractor`);
  return {
    id,
    description,
    grounding: requirement.grounding as PiRlmFactRequirement["grounding"],
    minSupports: Number(requirement.minSupports),
    ...(sourceHint !== undefined ? { sourceHint } : {}),
    ...(extractor !== undefined ? { extractor } : {}),
  };
}

function validateFactContract(value: unknown): PiRlmFactContract {
  const factContract = objectValue(value, "contract.factContract");
  assertKeys(factContract, ["requirements", "finalizer"], "contract.factContract");
  if (
    !Array.isArray(factContract.requirements) ||
    factContract.requirements.length < 1 ||
    factContract.requirements.length > MAX_FACT_REQUIREMENTS
  ) {
    throw new Error(
      `contract.factContract.requirements must contain 1-${MAX_FACT_REQUIREMENTS} entries`,
    );
  }
  const requirements = factContract.requirements.map((requirement, index) =>
    validateRequirement(
      requirement,
      `contract.factContract.requirements[${index}]`,
    ),
  );
  if (new Set(requirements.map((requirement) => requirement.id)).size !== requirements.length) {
    throw new Error("contract.factContract contains duplicate fact ids");
  }

  let finalizer: PiRlmFactContract["finalizer"];
  if (factContract.finalizer !== undefined) {
    const candidate = objectValue(
      factContract.finalizer,
      "contract.factContract.finalizer",
    );
    assertKeys(candidate, ["kind", "template"], "contract.factContract.finalizer");
    finalizer = candidate as unknown as NonNullable<PiRlmFactContract["finalizer"]>;
  }
  const contract: PiRlmFactContract = {
    requirements,
    ...(finalizer !== undefined ? { finalizer } : {}),
  };
  validateFactFinalizer(contract);
  return contract;
}

function validateAnswerContract(value: unknown): RlmAnswerContract {
  const answerContract = objectValue(value, "contract.answerContract");
  assertKeys(answerContract, ["description", "pattern"], "contract.answerContract");
  const description = boundedString(
    answerContract.description,
    "contract.answerContract.description",
    MAX_DESCRIPTION_CHARACTERS,
  );
  if (answerContract.pattern === undefined) return { description };
  const pattern = boundedString(
    answerContract.pattern,
    "contract.answerContract.pattern",
    MAX_PATTERN_CHARACTERS,
  );
  try {
    new RegExp(pattern, "u");
  } catch {
    throw new Error("answerContract pattern is invalid");
  }
  return { description, pattern };
}

export function parseRlmContractFile(text: string): RlmContractFile {
  if (typeof text !== "string") throw new Error("RLM contract must be text");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_CONTRACT_BYTES) {
    throw new Error(`RLM contract exceeds ${MAX_CONTRACT_BYTES} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("RLM contract must contain valid JSON");
  }
  const root = objectValue(parsed, "contract");
  assertKeys(root, ["version", "factContract", "answerContract"], "contract");
  if (root.version !== 1) throw new Error("RLM contract version must be 1");
  const factContract = validateFactContract(root.factContract);
  const answerContract =
    root.answerContract === undefined
      ? undefined
      : validateAnswerContract(root.answerContract);
  return {
    version: 1,
    factContract,
    ...(answerContract !== undefined ? { answerContract } : {}),
  };
}
