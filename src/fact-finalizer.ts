import type {
  PiRlmFactContract,
  PiRlmFactFinalizer,
  PiRlmFactStateSnapshot,
} from "./worker-protocol.ts";

const MAX_TEMPLATE_CHARACTERS = 4_096;
const MAX_FINAL_ANSWER_CHARACTERS = 32_768;
const FACT_PLACEHOLDER = /\{\{([a-z][a-z0-9-]{0,63})\}\}/gu;

function finalizerFactIds(template: string): string[] {
  const ids = [...template.matchAll(FACT_PLACEHOLDER)].map((match) => match[1]!);
  const staticText = template.replace(FACT_PLACEHOLDER, "");
  if (staticText.includes("{") || staticText.includes("}")) {
    throw new Error("fact finalizer contains a malformed fact placeholder");
  }
  return ids;
}

export function validateFactFinalizer(
  contract: PiRlmFactContract,
): PiRlmFactFinalizer | undefined {
  const finalizer = contract.finalizer;
  if (finalizer === undefined) return undefined;
  if (!finalizer || typeof finalizer !== "object" || finalizer.kind !== "template") {
    throw new Error("fact finalizer kind must be template");
  }
  if (
    typeof finalizer.template !== "string" ||
    finalizer.template.length === 0 ||
    finalizer.template.length > MAX_TEMPLATE_CHARACTERS
  ) {
    throw new Error(
      `fact finalizer template must contain 1-${MAX_TEMPLATE_CHARACTERS} characters`,
    );
  }

  const requiredIds = new Set(contract.requirements.map((requirement) => requirement.id));
  const seenIds = new Set<string>();
  for (const factId of finalizerFactIds(finalizer.template)) {
    if (seenIds.has(factId)) {
      throw new Error(`duplicate fact placeholder: ${factId}`);
    }
    if (!requiredIds.has(factId)) {
      throw new Error(`unknown fact placeholder: ${factId}`);
    }
    seenIds.add(factId);
  }
  for (const factId of requiredIds) {
    if (!seenIds.has(factId)) {
      throw new Error(`missing required fact placeholder: ${factId}`);
    }
  }
  return finalizer;
}

export function renderFactFinalizer(
  contract: PiRlmFactContract,
  state: PiRlmFactStateSnapshot,
): string | undefined {
  const finalizer = validateFactFinalizer(contract);
  if (!finalizer || state.pendingFactIds.length > 0) return undefined;

  const answer = finalizer.template.replace(
    FACT_PLACEHOLDER,
    (_placeholder, factId: string) => {
      const value = state.values[factId];
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(`grounded fact value is unavailable: ${factId}`);
      }
      return value;
    },
  );
  if (answer.length === 0 || answer.length > MAX_FINAL_ANSWER_CHARACTERS) {
    throw new Error(
      `fact finalizer answer must contain 1-${MAX_FINAL_ANSWER_CHARACTERS} characters`,
    );
  }
  return answer;
}
