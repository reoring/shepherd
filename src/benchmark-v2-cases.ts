export const BENCHMARK_V2_FAMILIES = [
  "retrieval",
  "semantic-aggregation",
  "multi-hop",
  "codeqa",
] as const;

export type BenchmarkV2Family = (typeof BENCHMARK_V2_FAMILIES)[number];
export type BenchmarkV2Tier = "small" | "medium" | "large";

export const BENCHMARK_V2_TIER_CHARACTERS: Record<BenchmarkV2Tier, number> = {
  small: 64_000,
  medium: 512_000,
  large: 3_200_000,
};

export interface BenchmarkV2Case {
  id: string;
  family: BenchmarkV2Family;
  tier: BenchmarkV2Tier;
  seed: number;
  fileName: string;
  content: string;
  question: string;
  expected: string;
  contextCharacters: number;
  estimatedContextTokens: number;
}

class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (Math.imul(this.state, 1_664_525) + 1_013_904_223) >>> 0;
    return this.state / 0x1_0000_0000;
  }

  integer(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  shuffle<T>(values: T[]): T[] {
    for (let index = values.length - 1; index > 0; index -= 1) {
      const other = this.integer(index + 1);
      [values[index], values[other]] = [values[other]!, values[index]!];
    }
    return values;
  }
}

function seedFor(
  family: BenchmarkV2Family,
  tier: BenchmarkV2Tier,
  benchmarkSeed: number,
): number {
  const source =
    benchmarkSeed === 0 ? `${family}:${tier}` : `${family}:${tier}:seed:${benchmarkSeed}`;
  let seed = 2_166_136_261;
  for (const character of source) {
    seed ^= character.codePointAt(0) ?? 0;
    seed = Math.imul(seed, 16_777_619);
  }
  return seed >>> 0;
}

function makeCase(
  family: BenchmarkV2Family,
  tier: BenchmarkV2Tier,
  benchmarkSeed: number,
  content: string,
  question: string,
  expected: string,
): BenchmarkV2Case {
  const baseId = `${family}-${tier}`;
  const id = benchmarkSeed === 0 ? baseId : `${baseId}-seed-${benchmarkSeed}`;
  return {
    id,
    family,
    tier,
    seed: benchmarkSeed,
    fileName: `${id}.txt`,
    content,
    question,
    expected,
    contextCharacters: content.length,
    estimatedContextTokens: Math.ceil(content.length / 4),
  };
}

function createRetrievalCase(
  tier: BenchmarkV2Tier,
  benchmarkSeed: number,
): BenchmarkV2Case {
  const target = BENCHMARK_V2_TIER_CHARACTERS[tier];
  const suffix = benchmarkSeed === 0 ? "" : `_S${benchmarkSeed}`;
  const expected = `V2_RETRIEVAL_${tier.toUpperCase()}_7F3A9C${suffix}`;
  const before: string[] = [];
  const after: string[] = [];
  let beforeLength = 0;
  let afterLength = 0;
  let index = 0;
  const halfTarget = Math.floor(target / 2);
  while (beforeLength < halfTarget) {
    const line = `DOC ${index.toString().padStart(7, "0")}: ordinary retrieval control text without the requested key.\n`;
    before.push(line);
    beforeLength += line.length;
    index += 1;
  }
  const needle = `V2_NEEDLE_TOKEN=${expected}\n`;
  while (beforeLength + needle.length + afterLength < target) {
    const line = `DOC ${index.toString().padStart(7, "0")}: ordinary retrieval control text without the requested key.\n`;
    after.push(line);
    afterLength += line.length;
    index += 1;
  }
  return makeCase(
    "retrieval",
    tier,
    benchmarkSeed,
    `${before.join("")}${needle}${after.join("")}`,
    "Return only the exact token from the line whose key is V2_NEEDLE_TOKEN.",
    expected,
  );
}

const SEMANTIC_TEMPLATES = {
  PERSON: [
    "Who developed the archival method used for the expedition?",
    "Who wrote the reference biography about the observatory?",
    "Who designed the instrument used in the survey?",
  ],
  LOCATION: [
    "Where was the ceramic fragment discovered?",
    "Where is the northern research archive located?",
    "Where did the annual field study take place?",
  ],
  NUMBER: [
    "How many samples were catalogued during the expedition?",
    "How many instruments remained operational after the trial?",
    "How many volumes were added to the collection?",
  ],
  DESCRIPTION: [
    "Why does the alloy change color under ultraviolet light?",
    "Explain why the migration pattern shifts during winter.",
    "Why did the preservation process fail in humid storage?",
  ],
} as const;

type SemanticLabel = keyof typeof SEMANTIC_TEMPLATES;
const SEMANTIC_LABELS = Object.keys(SEMANTIC_TEMPLATES) as SemanticLabel[];

function createSemanticAggregationCase(
  tier: BenchmarkV2Tier,
  benchmarkSeed: number,
): BenchmarkV2Case {
  const target = BENCHMARK_V2_TIER_CHARACTERS[tier];
  const random = new SeededRandom(
    seedFor("semantic-aggregation", tier, benchmarkSeed),
  );
  const counts: Record<SemanticLabel, number> = {
    PERSON: 0,
    LOCATION: 0,
    NUMBER: 0,
    DESCRIPTION: 0,
  };
  const lines: string[] = [];
  let length = 0;
  let index = 0;
  while (length < target) {
    const label = SEMANTIC_LABELS[random.integer(SEMANTIC_LABELS.length)]!;
    const templates = SEMANTIC_TEMPLATES[label];
    const text = templates[random.integer(templates.length)]!;
    const line = `REC ${index.toString().padStart(7, "0")}: ${text}\n`;
    lines.push(line);
    length += line.length;
    counts[label] += 1;
    index += 1;
  }
  const expected = SEMANTIC_LABELS.map((label) => `${label}=${counts[label]}`).join(";");
  return makeCase(
    "semantic-aggregation",
    tier,
    benchmarkSeed,
    lines.join(""),
    [
      "Classify every REC by question type: PERSON for Who, LOCATION for Where, NUMBER for How many, and DESCRIPTION for Why or Explain.",
      "Return the exact counts in this order and format: PERSON=<n>;LOCATION=<n>;NUMBER=<n>;DESCRIPTION=<n>.",
    ].join(" "),
    expected,
  );
}

function createMultiHopCase(
  tier: BenchmarkV2Tier,
  benchmarkSeed: number,
): BenchmarkV2Case {
  const target = BENCHMARK_V2_TIER_CHARACTERS[tier];
  const random = new SeededRandom(seedFor("multi-hop", tier, benchmarkSeed));
  const suffix = benchmarkSeed === 0 ? "" : `_S${benchmarkSeed}`;
  const expected = `V2_MULTIHOP_${tier.toUpperCase()}_C4D2E1${suffix}`;
  const lines: string[] = [];
  const chainLength = 12;
  const chainNodes = Array.from(
    { length: chainLength + 1 },
    (_, index) => `CHAIN_${tier.toUpperCase()}_${index.toString().padStart(2, "0")}`,
  );
  lines.push(`START_NODE=${chainNodes[0]}\n`);
  for (let index = 0; index < chainLength; index += 1) {
    lines.push(`LINK ${chainNodes[index]} -> ${chainNodes[index + 1]}\n`);
  }
  lines.push(`TERMINAL ${chainNodes.at(-1)} = ${expected}\n`);

  let length = lines.reduce((total, line) => total + line.length, 0);
  let decoy = 0;
  while (length < target) {
    const from = `DECOY_${tier}_${decoy.toString().padStart(7, "0")}`;
    const to = `DECOY_${tier}_${(decoy + 1 + random.integer(97)).toString().padStart(7, "0")}`;
    const line = `LINK ${from} -> ${to}\n`;
    lines.push(line);
    length += line.length;
    decoy += 1;
  }
  random.shuffle(lines);
  return makeCase(
    "multi-hop",
    tier,
    benchmarkSeed,
    lines.join(""),
    "Find START_NODE, follow LINK edges until the chain has a TERMINAL entry, and return only that terminal value.",
    expected,
  );
}

function createCodeQaCase(
  tier: BenchmarkV2Tier,
  benchmarkSeed: number,
): BenchmarkV2Case {
  const target = BENCHMARK_V2_TIER_CHARACTERS[tier];
  const random = new SeededRandom(seedFor("codeqa", tier, benchmarkSeed));
  const suffix = benchmarkSeed === 0 ? "" : `_S${benchmarkSeed}`;
  const expected = `V2_CODEQA_${tier.toUpperCase()}_A81B6D${suffix}`;
  const blocks: string[] = [];
  const chainLength = 10;
  blocks.push(
    [
      "=== FILE: src/benchmark-entry.ts ===",
      'import { chain00 } from "./chain-00.js";',
      "export function benchmarkEntry(): string { return chain00(); }",
      "",
    ].join("\n"),
  );
  for (let index = 0; index < chainLength; index += 1) {
    const current = `chain${index.toString().padStart(2, "0")}`;
    const next = `chain${(index + 1).toString().padStart(2, "0")}`;
    blocks.push(
      [
        `=== FILE: src/chain-${index.toString().padStart(2, "0")}.ts ===`,
        `import { ${next} } from "./chain-${(index + 1).toString().padStart(2, "0")}.js";`,
        `export function ${current}(): string { return ${next}(); }`,
        "",
      ].join("\n"),
    );
  }
  blocks.push(
    [
      `=== FILE: src/chain-${chainLength.toString().padStart(2, "0")}.ts ===`,
      `export function chain${chainLength.toString().padStart(2, "0")}(): string { return "${expected}"; }`,
      "",
    ].join("\n"),
  );

  let length = blocks.reduce((total, block) => total + block.length, 0);
  let distractor = 0;
  while (length < target) {
    const name = `distractor${distractor.toString().padStart(7, "0")}`;
    const block = [
      `=== FILE: src/distractors/${name}.ts ===`,
      `export function ${name}(): string { return "IGNORED_${random.integer(1_000_000)}"; }`,
      "",
    ].join("\n");
    blocks.push(block);
    length += block.length;
    distractor += 1;
  }
  random.shuffle(blocks);
  return makeCase(
    "codeqa",
    tier,
    benchmarkSeed,
    blocks.join(""),
    "Starting at benchmarkEntry, follow the direct function-call chain and return only the terminal string literal.",
    expected,
  );
}

const CASE_FACTORIES: Record<
  BenchmarkV2Family,
  (tier: BenchmarkV2Tier, benchmarkSeed: number) => BenchmarkV2Case
> = {
  retrieval: createRetrievalCase,
  "semantic-aggregation": createSemanticAggregationCase,
  "multi-hop": createMultiHopCase,
  codeqa: createCodeQaCase,
};

export function createBenchmarkV2Cases(
  tiers: readonly BenchmarkV2Tier[] = ["small", "medium", "large"],
  seeds: readonly number[] = [0],
): BenchmarkV2Case[] {
  const uniqueSeeds = [...new Set(seeds)];
  if (
    uniqueSeeds.length === 0 ||
    uniqueSeeds.some((seed) => !Number.isInteger(seed) || seed < 0)
  ) {
    throw new RangeError("Benchmark seeds must be non-negative integers");
  }
  return tiers.flatMap((tier) =>
    uniqueSeeds.flatMap((benchmarkSeed) =>
      BENCHMARK_V2_FAMILIES.map((family) =>
        CASE_FACTORIES[family](tier, benchmarkSeed),
      ),
    ),
  );
}

export function isExactBenchmarkV2Answer(answer: string, expected: string): boolean {
  return answer.trim() === expected;
}
