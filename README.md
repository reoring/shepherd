# Shepherd

Shepherd is an independent, evidence-bound recursive runtime for [Pi](https://github.com/badlogic/pi-mono): it indexes selected source, keeps inspection read-only, and returns bounded answers or deterministic source checks without loading an entire repository into an outer model context. Shepherd is the public CLI; RLM is the recursive-runtime technique underneath, not a public command name.

## One concrete before/after

The matched benchmark task was to trace one handwritten SDK method into generated client code and return five exact wiring facts: the validation label, raw method, HTTP method, URL template, and idempotency header. Under the matched model, question, exact source, and 20,000-token limits, Direct Pi completed **0/3** because input-budget preflight rejected dispatch. The pre-release runtime now shipped as Shepherd completed **3/3**, with one model call per run, median **1,678 tokens**, and median cost **$0.0004716**.

What becomes easier is concrete: a reviewed contract selects and grounds those five facts instead of requiring the user or model to load the monorepo blindly. The following are illustrative current commands; `.rlm/contracts/sdk-wiring.json` is an example contract owned by the target repository and does **not** ship in Shepherd:

```bash
shepherd check ./monorepo --contract .rlm/contracts/sdk-wiring.json --json
shepherd query ./monorepo \
  --contract .rlm/contracts/sdk-wiring.json \
  --question "Trace one handwritten SDK method into generated client code and return the five exact wiring facts." \
  --json
```

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

The following measurements were made against the pre-release runtime then labelled **Pi-RLM**, now shipped as Shepherd. They are deliberately separated by comparison type and workload.

### Matched large-source extraction — Shepherd/Pi-RLM versus Direct Pi

With GPT-5.6 Luna, thinking off, the same model, questions, exact source, and limits, three cases were repeated three times per harness (9 runs per harness). Shepherd/Pi-RLM completed **9/9** correctly versus Direct Pi's **3/9**: **+66.7 percentage points**.

| Aggregate metric | Shepherd/Pi-RLM (9 runs) | Direct Pi (9 runs) | Shepherd/Pi-RLM result |
|---|---:|---:|---:|
| Correct | 9/9 | 3/9 | +66.7 percentage points |
| Total cost | $0.0044154 | $0.00552401 | 20.1% lower |
| Total tokens | 14,969 | 20,027 | 25.3% lower |
| Model calls | 9 | 14 | 5 fewer |

Direct Pi's six failures were fail-closed input-budget preflight rejections, not semantic wrong answers. The pre-release Shepherd/Pi-RLM run used task-specific typed contracts; Direct Pi did not have an equivalent contract.

### Matched staged patch tasks — Shepherd/Pi-RLM versus Direct Pi

Using the same exact source, task, model, limits, and verification profile, each harness ran 15 times. Shepherd/Pi-RLM completed **15/15** accepted-correct runs versus Direct Pi's **9/15**: **+40 percentage points**. Direct Pi recorded **6 false successes** and **4 scope violations**.

| Aggregate metric | Shepherd/Pi-RLM (15 runs) | Direct Pi (15 runs) | Shepherd/Pi-RLM result |
|---|---:|---:|---:|
| Accepted-correct | 15/15 | 9/15 | +40 percentage points |
| Total cost | $0.0043694 | $0.0078394 | 44.3% lower |
| Total tokens | 15,887 | 30,317 | 47.6% lower |
| Model calls | 30 | 55 | 45.5% lower |
| Aggregate latency | 90,320.9 ms | 102,326.7 ms | 11.7% lower |

This supports a **limited GO** only for host-targeted replacement, insertion, exact multi-file wiring, and seeded one-file repair. It does not support general writing: the host owns target paths, operations, ranges, replacement constraints, and verification; the model supplies intent and replacement through the staged flow.

### Runtime evidence projection — before and after, not a Direct Pi comparison

A runtime-owned evidence-projection improvement was measured on the same two scenarios, with 10 repeats each before and after (20 runs per condition). It improved extractive correctness from **16/20 to 20/20**, reduced false `PASS` from **2 to 0**, cut model calls from **70 to 36** (**48.6% lower**), and cut total cost from **$0.0264207 to $0.0167854** (**36.5% lower**).

This result applies to **single-line extractive answers**. It is neither a Direct Pi comparison nor evidence for freeform summaries, design review, or reasoning across multiple evidence items.

### Methodology and caveats

These are dated pre-release measurements from **2026-08-13/14**, with denominators shown above. They are not a universal performance guarantee and were not rerun on current main. Raw captures are excluded because they can contain workload source and transcripts. The current [benchmark-v3 runner](src/benchmark-v3.ts), [matched-patch benchmark runner](src/matched-patch-benchmark-cli.ts), and [patch PoC runner](src/patch-poc.ts) are available for current local re-evaluation; their outputs are gitignored and must be reviewed before sharing.

Exercise the current public runners with configured provider authentication:

```bash
npm run benchmark:v3
npm run benchmark:matched-patch
```

These exercise the current harness; they are not byte-for-byte reproductions of the dated tables because the measured external source snapshots are not published. Model-backed runs incur provider cost.

## Scope

| Status | Current scope |
|---|---|
| **GO** | Registration inventories; API boundaries; config mappings; SDK/generated wiring; exact extractive facts; and source-drift checks. |
| **Conditional** | Staged patches only for host-targeted replacement, insertion, exact multi-file wiring, and seeded one-file repair with observed evidence and a host-owned verification profile. |
| **Not GO** | Open-ended summaries, design review, root-cause analysis, general freeform writing, replacing Direct Pi, or blindly trusting contract-free answers. |

Use a direct source read, search, language-service query, or test when that is smaller and clearer. Contract-free queries are best effort; use a reviewed typed contract when the answer needs source-fact and finalization guarantees.

## Quickstart

Shepherd exposes one public command name and has no compatibility aliases or deprecated public commands.

### Pi native commands

```text
/shepherd query <file-or-directory> [--contract <contract.json>] -- <question>
/shepherd check <directory> --contract <contract.json>
```

### Installed executable syntax

If the `shepherd` executable is available in the environment, use:

```text
shepherd query <file-or-directory> --question <text> [--contract <contract.json>] [--model provider/model] [--isolation subprocess|docker] [--json]
shepherd check <directory> --contract <contract.json> [--isolation subprocess|docker] [--json]
```

### Repository checkout syntax

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

For a contract-backed query, run `check` first and stop if it fails. The bundled contract is a small repository-neutral parser example; contracts for another repository belong with that repository's reviewed source.

## Agent skills

Skill names describe the task; Shepherd is the public CLI and RLM is the recursive-runtime technique underneath. The same canonical skills are exposed to Pi, OMP, Claude, and Agents:

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

## Current limits

Default limits are intentionally conservative: recursion depth is 2, root turns are 6, concurrent model calls are 4, subcall input is capped at 8,000 tokens, provider output at 512 tokens, total use at 20,000 tokens and USD 0.05, and the runtime timeout is 180 seconds. The staged patch flow is experimental and only has the limited scope above.

## Security boundaries

Choose the context path deliberately: the runtime reads indexed source context and does not grant write access through the query flow. Do not pass credentials on the command line; use configured Pi provider authentication. Subprocess and optional Docker isolation constrain the worker execution path, but they do not replace host policy, container policy, code review, or normal test coverage. A passing deterministic contract proves only its declared source facts.

## Attribution

Shepherd is independently implemented and is inspired by [alexzhang13/rlm](https://github.com/alexzhang13/rlm) and the paper [Recursive Language Models (arXiv:2512.24601)](https://arxiv.org/abs/2512.24601). It is not affiliated with that project or its authors.

There is no npm or PyPI release yet.

## License

Shepherd is licensed under [Apache-2.0](LICENSE).
