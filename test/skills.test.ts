import assert from "node:assert/strict";
import { readFile, readdir, realpath } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);
const packageRoot = repositoryRoot;
const expectedSkills = [
  "check-api-boundaries",
  "check-cli-registrations",
  "check-config-mappings",
  "check-generated-code",
  "check-registration-inventory",
  "check-sdk-wiring",
  "check-source-contract",
  "query-large-source",
];

test("ships one valid skill for each declared Shepherd source use case", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("package.json", packageRoot), "utf8"),
  ) as {
    pi?: { extensions?: string[]; skills?: string[] };
    omp?: { extensions?: string[]; skills?: string[] };
  };
  assert.deepEqual(packageJson.pi?.extensions, ["./src/native-extension.ts"]);
  assert.deepEqual(packageJson.pi?.skills, ["./skills"]);
  assert.deepEqual(packageJson.omp?.extensions, ["./src/native-extension.ts"]);
  assert.deepEqual(packageJson.omp?.skills, ["./skills"]);

  const entries = await readdir(new URL("skills/", packageRoot), {
    withFileTypes: true,
  });
  assert.deepEqual(
    entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(),
    expectedSkills,
  );

  const names = new Set<string>();
  for (const directory of expectedSkills) {
    const content = await readFile(
      new URL(`skills/${directory}/SKILL.md`, packageRoot),
      "utf8",
    );
    const frontmatter = content.match(
      /^---\nname: ([a-z0-9-]+)\ndescription: ([^\n]+)\n---\n/u,
    );
    assert.ok(frontmatter, `${directory} requires name and description frontmatter`);
    const [, name, description] = frontmatter;
    assert.equal(name, directory);
    assert.match(name!, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    assert.equal(names.has(name!), false, `duplicate skill name: ${name}`);
    names.add(name!);
    assert.equal(description!.length <= 1_024, true);
    assert.match(content, /## (Use When|Workflow)/u);
    assert.match(content, /## Acceptance/u);
    assert.match(content, /model calls?|modelCalls|model-free/iu);
  }
});

test("documents query-large-source as a conversational evidence orchestrator", async () => {
  const content = await readFile(
    new URL("skills/query-large-source/SKILL.md", packageRoot),
    "utf8",
  );

  for (const [requirement, pattern] of [
    ["material ambiguity clarification", /materially ambiguous/iu],
    ["clarification action", /\bclarif(?:y|ication)\b/iu],
    ["frontier-model flow", /\bfrontier model\b/iu],
    ["bounded-question decomposition", /\bdecompos(?:e|ed|ition)\b/iu],
    ["ordinary read selection", /normal `read`/iu],
    ["ordinary search selection", /`search`/u],
    ["LSP selection", /\bLSP\b/u],
    ["focused test selection", /focused test/iu],
    ["evidence receipt", /evidence receipt/iu],
    ["receipt corpus identity", /context\.corpusId/u],
    ["final answer evidence IDs", /answerEvidenceIds/u],
    ["evidence metadata", /\bsha256\b/u],
    ["evidence-supported synthesis", /evidence-supported synthesis/iu],
    ["native query primitive", /\/shepherd query <file-or-directory>/u],
    ["automation escape hatch", /automation escape hatches/iu],
  ] as const) {
    assert.match(content, pattern, `query-large-source requires ${requirement}`);
  }
});


test("exposes the same skills to OMP, Claude, and Pi", async () => {
  for (const skillsPath of [
    ".agents/skills/",
    ".claude/skills/",
    ".pi/skills/",
    ".omp/skills/",
  ]) {
    for (const skill of expectedSkills) {
      assert.equal(
        await realpath(
          new URL(`${skillsPath}${skill}/SKILL.md`, repositoryRoot),
        ),
        await realpath(new URL(`skills/${skill}/SKILL.md`, packageRoot)),
      );
    }
  }
});

test("exposes native Shepherd command adapters for OMP and Pi", async () => {
  const ompExtension = await realpath(
    new URL(".omp/extensions/shepherd.ts", repositoryRoot),
  );
  const piExtension = await realpath(
    new URL(".pi/extensions/shepherd.ts", repositoryRoot),
  );
  assert.notEqual(ompExtension, piExtension);
});
