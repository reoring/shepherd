# Shepherd

**Ask focused questions about large codebases—and get answers tied to the source that supports them.**

Shepherd helps [Pi](https://github.com/badlogic/pi-mono), OMP, and checkout automation inspect only the files you choose. Ask a model a focused question, or verify a source fact deterministically—without loading an entire repository into the outer model's context.

Query and check inspect source read-only. Shepherd is the public command name; RLM is the recursive-runtime technique underneath, not a public command.

Quick links: [Why Shepherd?](#why-shepherd) · [Try it](#try-it-in-60-seconds) · [Install](#install) · [Common workflows](#common-workflows) · [Choose a path](#which-path-should-i-use) · [How it works](#how-shepherd-works) · [Benchmark](#benchmark-at-a-glance) · [Scope](#current-scope) · [Contracts](#contracts) · [Limits and safety](#limits-and-security)

## Why Shepherd?

| When you need to… | Shepherd helps by… |
| --- | --- |
| inspect a selected file or tracked Git directory | indexing only that source and grounding an answer in bounded evidence |
| confirm a known source fact before spending provider budget | checking a versioned source-fact contract locally with zero model calls |
| ask a model a focused source question | sharing limits across the run for depth, turns, calls, tokens, cost, and time |
| make a narrowly bounded source change | using an experimental staged-patch flow with host-selected targets and verification |

Use `check` when the fact is known and needs a deterministic answer. Use `query` when a model must interpret selected source. A contract-free query is best effort.

## Try it in 60 seconds

With Node.js 24 or newer, this deterministic check runs from a fresh checkout, needs no provider credential, and uses the real exact-source-value contract:

```bash
git clone https://github.com/reoring/shepherd.git
cd shepherd
npm ci
node src/shepherd-cli.ts check . --contract examples/contracts/exact-source-value.v1.json --json
```

Representative output:

```json
{"status":"passed","answer":"query-entrypoint=./shepherd-cli.ts","modelCalls":0}
```

`check` reads the selected source and evaluates the contract locally. It makes zero model calls.

### Watch the demo

[![asciicast](https://asciinema.org/a/1263156.svg)](https://asciinema.org/a/1263156)

<sub>Interactive asciinema player — pause, seek, rewind, replay, or copy text · [Download the asciicast](media/shepherd-demo.cast)</sub>

## Install

### Choose your path

| You use | Start here | What you get |
| --- | --- | --- |
| Pi | [Install in Pi](#pi) | Native `/shepherd` commands and the bundled skills |
| OMP | [Install in OMP](#omp) | Native `/shepherd` commands and the bundled skills |
| a repository checkout or automation | [Use the checkout CLI](#checkout-cli-for-automation) | The same direct CLI without conversational routing |

### Pi

Install Pi first if `pi` is not already available:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Install the native Shepherd extension and its eight skills:

```bash
pi install git:github.com/reoring/shepherd --approve
```

`/shepherd check` makes zero model calls and needs no provider authentication. A model-backed query does need configured provider authentication. The value below is a placeholder; provide the credential through the shell environment and never commit it:

```bash
export OPENAI_API_KEY="..."
pi auth check --model openai/gpt-5.6-luna --json --no-refresh
```

In the target repository, start Pi with the intended model:

```bash
pi --model openai/gpt-5.6-luna
```

Then use the native commands:

```text
/shepherd check <directory> --contract <contract.json>
/shepherd query <file-or-directory> [--contract <contract.json>] -- <question>
```

### OMP

Install Shepherd directly from GitHub as a user plugin:

```bash
omp plugin install github:reoring/shepherd
omp plugin doctor --json
```

Restart OMP after installation or update. The plugin manifest loads the native `/shepherd` command and bundled skills. Conversational source requests may select `query-large-source` automatically; invoke it explicitly with:

```text
/skill:query-large-source <source question>
```

Re-run `omp plugin install github:reoring/shepherd` to update the installed Git revision. Use `omp plugin list --json` to inspect the installed version and enabled state.

### Checkout CLI for automation

The checkout setup in [Try it in 60 seconds](#try-it-in-60-seconds) is also the automation installation. From that checkout, use:

```text
node src/shepherd-cli.ts query <file-or-directory> --question <text> [--contract <contract.json>] [--model provider/model] [--isolation subprocess|docker] [--json]
node src/shepherd-cli.ts check <directory> --contract <contract.json> [--isolation subprocess|docker] [--json]
```

The package also defines these public shell command forms:

```text
shepherd query <file-or-directory> --question <text> [--contract <contract.json>] [--model provider/model] [--isolation subprocess|docker] [--json]
shepherd check <directory> --contract <contract.json> [--isolation subprocess|docker] [--json]
```

There is no package release yet, so the runnable examples below use the checkout entry point directly.

For a contract-backed query, run `check` first and stop if it fails.

## Common workflows

### Validate a known source fact

From the Shepherd checkout, use the contract check when the fact needs to stay stable:

```text
node src/shepherd-cli.ts check <directory> --contract <contract.json> [--isolation subprocess|docker] [--json]
```

This is deterministic and makes zero model calls.

### Ask a bounded source question

From the Shepherd checkout, use a model-backed query over the selected file or directory:

```text
node src/shepherd-cli.ts query <file-or-directory> --question <text> [--contract <contract.json>] [--model provider/model] [--isolation subprocess|docker] [--json]
```

Provider authentication is required for a model-backed query. Add a reviewed contract when the answer needs typed source facts or configured finalization guarantees; without one, the answer is best effort.

### Route a conversational large-source question

Use `query-large-source` when a frontier model is answering a broad source question conversationally. It chooses ordinary reads, search, language-service queries, focused tests, or bounded Shepherd evidence, then synthesizes an answer from the observations and receipts. It does not treat one contract-free Shepherd answer as a complete summary, design review, or root-cause conclusion.

## Which path should I use?

| Path | Use it when | Choose something else when |
| --- | --- | --- |
| Direct tools | a read, search, language-service query, or test is smaller and clearer | you need a repeatable contract check or a bounded model question |
| `check` | a versioned contract can state the source fact | the task needs model interpretation |
| `query` | a model needs to answer about a selected file or tracked Git directory | a direct tool answers the question more simply |
| `query-large-source` | a conversational request needs routing across tools and evidence before synthesis | the task is already a small, direct command |

## How Shepherd works

1. **Select source.** Shepherd indexes the file or tracked Git directory you name. Query and check flows inspect that source read-only.
2. **Ground an answer.** A query gathers bounded source evidence. With a contract, it uses typed capture and reduction; an optional deterministic finalizer and answer pattern apply only when configured. Without a contract, the query is best effort.
3. **Verify a contract.** A check evaluates a versioned source-fact contract locally with zero model calls, so source or contract drift can fail before a query spends provider budget.

The staged-patch runtime is separate from these read-only query and check flows. It is experimental: the host owns targets, operations, ranges, constraints, and verification; the staged flow accepts a patch only after selected source evidence and focused checks pass.

## Benchmark at a glance

The cited GPT-5.6 Luna matched-patch aggregate ran three tasks five times per harness. Shepherd accepted **15/15** results versus Direct Pi's **9/15**, with **0 versus 6 false successes**, **0 versus 4 scope violations**, **43.8% fewer tokens**, and **40.8% lower cost**. Shepherd was **11.6% slower** in that Luna aggregate.

This is directional benchmark evidence, not a universal performance guarantee. Read the [full benchmark evidence](docs/benchmark.md) for detailed Luna and Qwen results, the cross-model comparison, historical evidence, methodology, caveats, and rerun commands.

## Current scope

| Area | Current fit |
| --- | --- |
| **Good fit** | Registration inventories, API boundaries, config mappings, SDK/generated wiring, exact extractive facts, and source-drift checks are GO. |
| **Experimental** | Staged patches are limited to host-targeted replacement, insertion, exact multi-file wiring, and seeded one-file repair with observed evidence and a host-owned verification profile. |
| **Use direct tools** | Prefer a source read, search, language-service query, or test when it is smaller and clearer. A single Shepherd primitive is not GO for open-ended summaries, design review, root-cause analysis, general freeform writing, replacing Direct Pi, or blindly trusting contract-free answers. |

## Contracts

Keep contracts in the target repository, recommended under `.rlm/contracts/`, and review and version them with its source. A contract defines source selection and typed capture and reduction. It can also define a deterministic finalizer and answer pattern; those guarantees apply only when the corresponding fields are configured.

The bundled [`examples/contracts/exact-source-value.v1.json`](examples/contracts/exact-source-value.v1.json) is a minimal parser/runtime example, not a universal contract. For a contract-backed query, run `check` first and stop if it fails.

## Bundled skills

The same canonical skills are exposed to Pi, OMP, Claude, and Agents:

| Skill | Use |
| --- | --- |
| `query-large-source` | Conversationally orchestrate bounded source questions, direct inspection tools, Shepherd receipts, and evidence-backed synthesis. |
| `check-source-contract` | Validate a versioned source-fact contract with zero model calls. |
| `check-api-boundaries` | Check HTTP routes, middleware groups, and exceptions. |
| `check-cli-registrations` | Check command registration order, cardinality, and drift. |
| `check-config-mappings` | Check defaults, config fields, and constructor wiring. |
| `check-generated-code` | Extract bounded facts from large generated files. |
| `check-registration-inventory` | Check plugin, controller, route, provider, or handler inventories. |
| `check-sdk-wiring` | Check handwritten SDK services against generated request builders. |

## Limits and security

Default limits are intentionally conservative:

| Limit | Default |
| --- | ---: |
| Recursion depth | 2 |
| Root turns | 6 |
| Concurrent model calls | 4 |
| Subcall input | 8,000 tokens |
| Provider output | 512 tokens |
| Total use | 20,000 tokens and USD 0.05 |
| Runtime timeout | 180 seconds |

Choose the context path deliberately. The runtime reads indexed source context and does not grant write access through the query flow; query and check source inspection remains read-only. Do not pass credentials on the command line; use configured Pi provider authentication. Subprocess isolation is the default and Docker is an explicit optional worker mode. They constrain the worker execution path, but do not replace host policy, container policy, code review, or normal test coverage. A passing deterministic contract proves only its declared source facts.

## Attribution

Shepherd is independently implemented and is inspired by [alexzhang13/rlm](https://github.com/alexzhang13/rlm) and the paper [Recursive Language Models (arXiv:2512.24601)](https://arxiv.org/abs/2512.24601). It is not affiliated with that project or its authors.

## Release availability

There is no npm or PyPI release yet.

## License

Shepherd is licensed under [Apache-2.0](LICENSE).
