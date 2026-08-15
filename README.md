# Sheperd

Sheperd is an independent, evidence-bound recursive agent runtime for [Pi](https://github.com/badlogic/pi-mono). It indexes a selected file or tracked Git directory and keeps the context read-only while the bounded RLM runtime gathers evidence. Sheperd is the public CLI; RLM is the recursive runtime technique underneath, not a public command name.

Pi exposes the following native commands:

- `/sheperd query <file-or-directory> [--contract <contract.json>] -- <question>` asks an evidence-bound question.
- `/sheperd check <directory> --contract <contract.json>` deterministically checks source facts before a query.

The shell/bin interface exposes the same capabilities:

```text
sheperd query <file-or-directory> --question <text> [--contract <contract.json>] [--model provider/model] [--isolation subprocess|docker] [--json]
sheperd check <directory> --contract <contract.json> [--isolation subprocess|docker] [--json]
```

The package exposes exactly one executable, `sheperd`; there are no compatibility aliases or deprecated public commands.

## What it provides

- File-indexed, read-only source context rather than raw directory dumps in the outer agent.
- Shared depth, token, cost, concurrency, turn, and timeout limits across recursive calls.
- Subprocess isolation by default and an optional Docker worker mode when Docker is configured.
- Versioned contracts with typed fact extractors, grounding evidence, finalization templates, and answer patterns. `sheperd check` performs this deterministic gate without model calls.

## Agent skills

Skill names describe the task; Sheperd is the public CLI and RLM is the recursive runtime technique underneath. The same canonical skills are exposed to Pi, OMP, Claude, and Agents:

| Skill | Use |
|---|---|
| `query-large-source` | Ask bounded questions over large files or Git directories. |
| `check-source-contract` | Validate a versioned source-fact contract with zero model calls. |
| `check-api-boundaries` | Check HTTP routes, middleware groups, and exceptions. |
| `check-cli-registrations` | Check command registration order, cardinality, and drift. |
| `check-config-mappings` | Check defaults, config fields, and constructor wiring. |
| `check-generated-code` | Extract bounded facts from large generated files. |
| `check-registration-inventory` | Check plugin, controller, route, provider, or handler inventories. |
| `check-sdk-wiring` | Check handwritten SDK services against generated request builders. |

## Use from source

Sheperd requires Node.js 24 or newer. Clone this repository, then install the locked dependencies:

```bash
npm ci
```

Pi discovers the extension and skills through the root `pi` configuration. From the checkout root, run the direct Sheperd CLI:

```bash
node src/sheperd-cli.ts check <context> \
  --contract examples/contracts/exact-source-value.v1.json --json

node src/sheperd-cli.ts query <context> \
  --question "What does this source do?" --json
```

The installed equivalents are `sheperd check` and `sheperd query` with the shell options shown above. Run `npm run typecheck` and `npm test` before contributing. The bundled contract is a small repository-neutral parser example; contracts for another repository belong with that repository's reviewed source.

## Current limits

Default limits are intentionally conservative: recursion depth is 2, root turns are 6, concurrent model calls are 4, subcall input is capped at 8,000 tokens, provider output at 512 tokens, total use at 20,000 tokens and USD 0.05, and the runtime timeout is 180 seconds. Contract-free queries are best effort; contract mode provides the stronger typed-fact and finalization guarantees. The patch runtime is experimental.

## Security boundaries

Choose the context path deliberately: the runtime reads indexed source context and does not grant write access through the query flow. Do not pass credentials on the command line; use the configured Pi provider authentication. Subprocess and optional Docker isolation constrain the worker execution path, but they do not replace host policy, container policy, code review, or normal test coverage. A passing deterministic contract only proves its declared source facts.

## Attribution

Sheperd is independently implemented and is inspired by [alexzhang13/rlm](https://github.com/alexzhang13/rlm) and the paper [Recursive Language Models (arXiv:2512.24601)](https://arxiv.org/abs/2512.24601). It is not affiliated with that project or its authors.

There is no npm or PyPI release yet. Captured real-workload artifacts are intentionally excluded from this repository.
