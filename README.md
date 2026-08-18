# Shepherd

Shepherd is an independent, evidence-bound recursive runtime for [Pi](https://github.com/badlogic/pi-mono). It indexes selected source for bounded answers and deterministic checks without loading an entire repository into an outer model context. Its experimental staged-patch path limits writes to host-selected targets and accepts them only after source evidence and verification pass. Shepherd is the public CLI; RLM is the recursive-runtime technique underneath, not a public command name.

[![asciicast](https://asciinema.org/a/1263156.svg)](https://asciinema.org/a/1263156)

<sub>Interactive asciinema player — pause, seek, rewind, replay, or copy text · [Download the asciicast](media/shepherd-demo.cast)</sub>

## One concrete before/after

The live demo runs one repeat of three source-change tasks. One asks the agent to change `timeout: 10` to `timeout: 20`, preserve its consumer contract, and modify only `src/config.ts`. Direct Pi and Shepherd receive the same GPT-5.6 Luna model, source, task, limits, and verifier.

Both paths happened to be correct in the recorded repeat. Shepherd reached the same accepted result with **6 instead of 12 model calls**, **3,179 instead of 6,688 tokens**, and **$0.0008778 instead of $0.0017546**—roughly half the inference work. One repeat is illustrative, not stability evidence.

Across the public-SHA benchmark's five repeats of all three tasks, Shepherd completed **15/15** correctly versus Direct Pi's **9/15**, with **0 versus 6 false successes**, **0 versus 4 scope violations**, **43.8% fewer tokens**, and **40.8% lower cost**. Shepherd was **11.6% slower**. The difference is not a better prompt: the host bounds paths, operations, ranges, and verification; Shepherd accepts a patch only after the selected source evidence and focused checks pass.

## 60-second first success

With Node.js 24 or newer, this deterministic check works from a fresh checkout and needs no provider credentials:

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

`check` reads the selected source and evaluates the contract locally; it makes zero model calls.

## Problem

Large repositories do not fit safely or economically in direct model context. Repeatedly loading source burns tokens and cost, while a process-level `PASS` can still conceal a semantically false answer. For source changes, a freeform model write also needs a bounded authority boundary rather than open-ended filesystem control.

## Solution

| Problem | Shepherd mechanism |
|---|---|
| A repository is too large to place in outer-model context. | File-indexed, read-only source context selects bounded evidence instead of dumping a directory. |
| A plausible answer can be semantically wrong even when a process reports `PASS`. | Typed evidence and fact contracts ground source facts; runtime finalization owns the contracted answer. |
| Recursive work can exceed a budget through independent calls. | Shared reservations and limits bound depth, turns, concurrency, tokens, cost, and time across the run. |
| A worker should not inherit host authority. | Subprocess isolation is the default; Docker is an explicit optional worker mode. |
| A generated source change needs constrained, reviewable authority. | Observed-evidence staged patches bind host-owned targets, operations, ranges, constraints, and verification before application. |

`shepherd query` asks a bounded model question over a selected file or tracked Git directory. With a contract, it uses typed facts and runtime finalization; without one, it is best effort. `shepherd check` is different: it deterministically validates a versioned source-fact contract with **zero model calls**, so source or contract drift can fail before a query spends provider budget.

## Measured evidence

### Current public-SHA evidence — [c9b0c94](https://github.com/reoring/shepherd/commit/c9b0c9461e63a588c37f1f48ab5040619352c169)

These sanitized aggregates were measured from a clean checkout of public commit [c9b0c94](https://github.com/reoring/shepherd/commit/c9b0c9461e63a588c37f1f48ab5040619352c169) with GPT-5.6 Luna on **2026-08-15**.

#### Query stability — subprocess, two scenarios × 10

| Scenario | Correct | False `PASS` | Median | p95 | Model calls | Tokens | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| Plain file | 10/10 | 0 | 4.94 s | 5.99 s | 18 | 27,428 | $0.0085852 |
| Directory | 10/10 | 0 | 5.03 s | 6.26 s | 17 | 24,959 | $0.0077363 |
| **Aggregate** | **20/20** | **0** | — | — | **35** | **52,387** | **$0.0163215** |

#### Matched patch tasks — Shepherd versus Direct Pi, thinking off, three tasks × 5 per harness

The Direct Pi baseline was benchmark-specific: it had only host-allowlisted `read`, `edit`, and `write` tools, with no shell, search, network, extensions, or skills. Both paths used the same source, task, model, limits, and verification profile; Direct Pi ran first for each case and repeat.

| Aggregate metric | Shepherd (15 runs) | Direct Pi (15 runs) | Result |
|---|---:|---:|---:|
| Accepted-correct | 15/15 | 9/15 | **+40 percentage points** |
| False successes | 0 | 6 | 6 fewer |
| Scope violations | 0 | 4 | 4 fewer |
| Model calls | 30 | 52 | **42.3% lower** |
| Total tokens | 15,899 | 28,278 | **43.8% lower** |
| Total cost | $0.0043738 | $0.0073866 | **40.8% lower** |
| Aggregate latency | 102,149.7 ms | 91,562.7 ms | **Shepherd 11.6% higher (latency regression)** |

The joint benchmark exits nonzero by design unless **both** harnesses meet acceptance. Direct Pi does not meet it; Shepherd's own per-harness result is **15/15** accepted-correct runs.

This supports a **limited GO** only for host-targeted replacement, insertion, exact multi-file wiring, and seeded one-file repair. It does not support general writing: the host owns target paths, operations, ranges, replacement constraints, and verification; the model supplies intent and replacement through the staged flow.

### Local-model evidence — matched patch tasks on Qwen3.8-27B — [f1189f8](https://github.com/reoring/shepherd/commit/f1189f8769a6bee06da2dc38960d3a078e0e25f6)

The same matched-patch benchmark (three tasks × 5 repeats per harness, thinking off, identical limits) was re-run on **2026-08-18** from public commit [f1189f8](https://github.com/reoring/shepherd/commit/f1189f8769a6bee06da2dc38960d3a078e0e25f6) on a local Qwen3.8-27B-GGUF (UD-Q4_K_XL, OpenAI-compatible endpoint, `reasoning_effort: none` for thinking off).

| Aggregate metric | Shepherd (15 runs) | Direct Pi (15 runs) | Result |
|---|---:|---:|---:|
| Accepted-correct | 15/15 | 14/15 | **+6.7 percentage points** |
| False successes | 0 | 1 | 1 fewer |
| Scope violations | 0 | 1 | 1 fewer |
| Model calls | 30 | 50 | **40.0% lower** |
| Total tokens (cache-read inclusive) | 24,147 | 46,762 | 48.4% lower |
| Fresh tokens (non-cached) | 14,763 | 12,086 | Direct Pi 18.1% lower |
| Total cost | $0 (local) | $0 (local) | no pricing configured |
| Aggregate latency | 84,044 ms | 146,830 ms | **Shepherd 42.8% lower** |

Token accounting: the local endpoint reports prompt-cache reads. The Direct Pi agent session accumulates history without compaction, so later calls resend the growing prefix and it is billed as cache reads (34,676 tokens, 74% of its total). `totalTokens` includes cache reads 1:1, so the headline token gap is inflated; on fresh (non-cached) tokens Direct Pi is actually lower. The Luna table above has zero cache reads on both harnesses, so its token delta is entirely fresh.

Model robustness: Shepherd's 15/15 accepted-correct, zero false successes, zero scope violations, and 30 model calls hold on both Luna and Qwen. Direct Pi's quality (9/15 on Luna, 14/15 on Qwen) and the latency winner (Direct Pi on Luna, Shepherd on Qwen) are model-dependent. `contextWindow` is not used in any Shepherd limit; `maxTokens` is a per-run reservation budget, not a context cap.

### Luna versus Qwen — same matched-patch benchmark, two models

The two tables above re-run the same matched-patch benchmark (three tasks × 5 repeats per harness, thinking off, identical limits) on two different models. They are bound to different harness commits (Luna at [c9b0c94](https://github.com/reoring/shepherd/commit/c9b0c9461e63a588c37f1f48ab5040619352c169), Qwen at [f1189f8](https://github.com/reoring/shepherd/commit/f1189f8769a6bee06da2dc38960d3a078e0e25f6)); the harness changed between them, so this is a cross-model comparison, not a controlled A/B.

| Metric | Luna (c9b0c94) | Qwen (f1189f8) |
|---|---:|---:|
| Shepherd accepted-correct | 15/15 | 15/15 |
| Direct Pi accepted-correct | 9/15 | 14/15 |
| Direct Pi false successes | 6 | 1 |
| Direct Pi scope violations | 4 | 1 |
| Shepherd model calls | 30 | 30 |
| Direct Pi model calls | 52 | 50 |
| Shepherd latency | 102.1 s | 84.0 s |
| Direct Pi latency | 91.6 s | 146.8 s |
| Latency winner | Direct Pi (Shepherd +11.6%) | Shepherd (−42.8%) |

What holds on both models (model-robust): Shepherd's 15/15 accepted-correct, zero false successes, zero scope violations, and 30 model calls.

What changes with the model (model-dependent): Direct Pi's quality (9/15 on Luna, 14/15 on Qwen) and which harness is faster (Direct Pi on Luna, Shepherd on Qwen).

### Historical pre-release evidence — matched large-source extraction

With GPT-5.6 Luna, thinking off, the same model, questions, exact source, and limits, three cases were repeated three times per harness (9 runs per harness). The pre-release runtime then labelled Pi-RLM, now shipped as Shepherd, completed **9/9** correctly versus Direct Pi's **3/9**: **+66.7 percentage points**.

| Aggregate metric | Shepherd/Pi-RLM (9 runs) | Direct Pi (9 runs) | Shepherd/Pi-RLM result |
|---|---:|---:|---:|
| Correct | 9/9 | 3/9 | +66.7 percentage points |
| Total cost | $0.0044154 | $0.00552401 | 20.1% lower |
| Total tokens | 14,969 | 20,027 | 25.3% lower |
| Model calls | 9 | 14 | 5 fewer |

Direct Pi's six failures were fail-closed input-budget preflight rejections, not semantic wrong answers. The pre-release Shepherd/Pi-RLM run used task-specific typed contracts; Direct Pi did not have an equivalent contract.

### Historical pre-release evidence — evidence projection before/after

A runtime-owned evidence-projection improvement was measured on the same two scenarios, with 10 repeats each before and after (20 runs per condition). It improved extractive correctness from **16/20 to 20/20**, reduced false `PASS` from **2 to 0**, cut model calls from **70 to 36** (**48.6% lower**), and cut total cost from **$0.0264207 to $0.0167854** (**36.5% lower**).

This result applies to **single-line extractive answers**. It is neither a Direct Pi comparison nor evidence for freeform summaries, design review, or reasoning across multiple evidence items.

### Methodology and caveats

The current tables are public-SHA-bound sanitized aggregates. Raw outputs were deleted and are not published because they may include source or transcripts. Historical external-source captures remain unpublished. These measurements are not a universal performance guarantee.

The local-model Qwen run reports $0 cost (no pricing configured) and its token totals include prompt-cache reads; compare that run on fresh tokens, model calls, and latency rather than total tokens.

The [benchmark-v3 runner](src/benchmark-v3.ts) and [matched-patch benchmark runner](src/matched-patch-benchmark-cli.ts) can re-evaluate the current harness with configured provider authentication:

```bash
npm run benchmark:v3
npm run benchmark:matched-patch
```

Those commands incur provider cost. They exercise the current harness rather than byte-for-byte reproducing the historical tables, whose external source snapshots are not published.

## Scope

| Status | Current scope |
|---|---|
| **GO** | Registration inventories; API boundaries; config mappings; SDK/generated wiring; exact extractive facts; and source-drift checks. |
| **Conditional** | Staged patches only for host-targeted replacement, insertion, exact multi-file wiring, and seeded one-file repair with observed evidence and a host-owned verification profile. |
| **Not GO (primitive)** | A single Shepherd primitive is not GO for open-ended summaries, design review, root-cause analysis, general freeform writing, replacing Direct Pi, or blindly trusting contract-free answers. |

Use a direct source read, search, language-service query, or test when that is smaller and clearer. Contract-free queries are best effort; use a reviewed typed contract when the answer needs source-fact and finalization guarantees.

An outer frontier model may answer open-ended conversational requests only by orchestrating direct tools and bounded Shepherd evidence: it clarifies material ambiguity, decomposes the request, validates receipt evidence, and synthesizes the result with uncertainty. It does not trust one contract-free primitive answer as a complete summary, design, or root-cause conclusion.

## Quickstart

Shepherd exposes one public command name and has no compatibility aliases or deprecated public commands.

### Install and activate in Pi

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

The native `/shepherd` commands are immediate low-level primitives and automation escape hatches. Shell `shepherd query` and `shepherd check`, plus the checkout commands below, are the same direct path; none require conversational skill routing. When a frontier model is answering a source question conversationally, automatic `query-large-source` routing is the primary path: it selects ordinary reads, search, language-service queries, focused tests, or bounded Shepherd evidence before synthesizing an answer from the resulting observations and receipts.

### Install and activate in OMP

Install Shepherd directly from GitHub as a user plugin:

```bash
omp plugin install github:reoring/shepherd
omp plugin doctor --json
```

Restart OMP after installation or update. The plugin manifest loads the native
`/shepherd` command and the bundled skills. Conversational source requests may
select `query-large-source` automatically; invoke it explicitly with:

```text
/skill:query-large-source <source question>
```

Re-run `omp plugin install github:reoring/shepherd` to update the installed Git
revision. Use `omp plugin list --json` to inspect the installed version and
enabled state.

### Contract ownership

Contracts belong in the target repository, recommended under `.rlm/contracts/`, and are reviewed and versioned with its source. A contract defines source selection and typed capture/reduction; it may additionally define a deterministic finalizer and answer pattern. Finalization and answer-pattern guarantees apply only when those fields are configured. The bundled [`examples/contracts/exact-source-value.v1.json`](examples/contracts/exact-source-value.v1.json) is a minimal parser/runtime example, not a universal contract.


### Repository checkout CLI for automation

From a checkout with Node.js 24 or newer:

```bash
git clone https://github.com/reoring/shepherd.git
cd shepherd
npm ci
```

```text
node src/shepherd-cli.ts query <file-or-directory> --question <text> [--contract <contract.json>] [--model provider/model] [--isolation subprocess|docker] [--json]
node src/shepherd-cli.ts check <directory> --contract <contract.json> [--isolation subprocess|docker] [--json]
```

For a contract-backed query, run `check` first and stop if it fails.

## Agent skills

Skill names describe the task; Shepherd is the public CLI and RLM is the recursive-runtime technique underneath. The same canonical skills are exposed to Pi, OMP, Claude, and Agents:

| Skill | Use |
|---|---|
| `query-large-source` | Conversationally orchestrate bounded source questions, direct inspection tools, Shepherd receipts, and evidence-backed synthesis. |
| `check-source-contract` | Validate a versioned source-fact contract with zero model calls. |
| `check-api-boundaries` | Check HTTP routes, middleware groups, and exceptions. |
| `check-cli-registrations` | Check command registration order, cardinality, and drift. |
| `check-config-mappings` | Check defaults, config fields, and constructor wiring. |
| `check-generated-code` | Extract bounded facts from large generated files. |
| `check-registration-inventory` | Check plugin, controller, route, provider, or handler inventories. |
| `check-sdk-wiring` | Check handwritten SDK services against generated request builders. |

## Current limits

Default limits are intentionally conservative: recursion depth is 2, root turns are 6, concurrent model calls are 4, subcall input is capped at 8,000 tokens, provider output at 512 tokens, total use at 20,000 tokens and USD 0.05, and the runtime timeout is 180 seconds. The staged patch flow is experimental and only has the limited scope above.

## Security boundaries

Choose the context path deliberately: the runtime reads indexed source context and does not grant write access through the query flow. Do not pass credentials on the command line; use configured Pi provider authentication. Subprocess and optional Docker isolation constrain the worker execution path, but they do not replace host policy, container policy, code review, or normal test coverage. A passing deterministic contract proves only its declared source facts.

## Attribution

Shepherd is independently implemented and is inspired by [alexzhang13/rlm](https://github.com/alexzhang13/rlm) and the paper [Recursive Language Models (arXiv:2512.24601)](https://arxiv.org/abs/2512.24601). It is not affiliated with that project or its authors.

There is no npm or PyPI release yet.

## License

Shepherd is licensed under [Apache-2.0](LICENSE).
