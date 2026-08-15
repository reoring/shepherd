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

test("ships one valid Pi skill for each declared source use case", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("package.json", packageRoot), "utf8"),
  ) as { pi?: { extensions?: string[]; skills?: string[] } };
  assert.deepEqual(packageJson.pi?.extensions, ["./src/native-extension.ts"]);
  assert.deepEqual(packageJson.pi?.skills, ["./skills"]);

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

test("exposes native Sheperd command adapters for OMP and Pi", async () => {
  const ompExtension = await realpath(
    new URL(".omp/extensions/sheperd.ts", repositoryRoot),
  );
  const piExtension = await realpath(
    new URL(".pi/extensions/sheperd.ts", repositoryRoot),
  );
  assert.notEqual(ompExtension, piExtension);
});
