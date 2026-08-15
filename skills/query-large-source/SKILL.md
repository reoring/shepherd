---
name: query-large-source
description: Answers bounded questions over large files or Git directories through indexed evidence. Use when normal read, grep, LSP, or direct model context is insufficient for the source size or cross-file question.
---

# Query Large Source

## Outcome

Answer a question over a file or tracked Git directory through the same PiRlmRunner regardless of the outer agent harness. Return the Shepherd query answer, usage, fact summary, source revision, and deterministic failure status.

## Use When

- The user explicitly asks for a bounded Shepherd query over source.
- A source tree is too large to place directly in model chat.
- The question needs bounded cross-file evidence.
- A versioned RLM contract exists for the task.
- Direct Pi/Claude/OMP context would exceed provider or cost limits.

Do not use Shepherd for a small source lookup that one normal read, grep, LSP, AST query, or unit test can answer more directly.

## Invocation Choice

- Explicit Pi or OMP request: use native `/shepherd query <file-or-directory> [--contract <contract.json>] -- <question>`. The extension runs immediately without an outer-agent model turn.
- Explicit Claude or shell request: execute the installed `shepherd query` command or the repository checkout's `node src/shepherd-cli.ts query` command directly. In Claude interactive mode, use its local shell mode rather than asking Claude to rediscover the command.
- Automatic agent routing: use this skill. One outer-agent decision remains inherent, but source inspection and the RLM answer stay inside the shared runner.

## First Action

The skill and command locations are already resolved. Do not run `ls`, `find`, `which`, `cat SKILL.md`, or inspect the target source before dispatch. When `src/shepherd-cli.ts` exists from the current repository root, the first external action must use the `node src/shepherd-cli.ts query` command; otherwise use `shepherd query`. With a contract, preflight through the matching checker command first.

## Contract-Driven Fast Path

When a contract exists:

1. Run `shepherd check "$CONTEXT" --contract "$CONTRACT" --json` first.
2. Stop on check failure. Do not spend a query model call on stale source.
3. Run the headless query only after every fact is grounded and the answer pattern passes.

## Headless Query

Installed package:

```bash
shepherd query "$CONTEXT" \
  --question "$QUESTION" \
  --contract "$CONTRACT" \
  --model openai/gpt-5.6-luna \
  --isolation subprocess \
  --json
```

This repository checkout, from the repository root:

```bash
node src/shepherd-cli.ts query \
  "$CONTEXT" \
  --question "$QUESTION" \
  --contract "$CONTRACT" \
  --model openai/gpt-5.6-luna \
  --isolation subprocess \
  --json
```

Use `--isolation docker` for an isolated worker parity check.

## Contract-Free Query

Contract-free mode is best effort:

```bash
shepherd query "$FILE_OR_DIRECTORY" \
  --question "$QUESTION" \
  --model openai/gpt-5.6-luna \
  --json
```

Report that contract-free results do not have typed fact/finalizer guarantees.

## Cross-Harness Use

- OMP: prefer native `/shepherd query`; it shares the Pi extension implementation and bypasses an outer model turn.
- Pi: prefer native `/shepherd query`; use the headless CLI for exact JSON/exit behavior.
- Claude: use the direct shell command for an explicit request; use `/query-large-source` only when Claude must select and orchestrate the capability.

Automatic skill selection is intentionally not the fast path. A model must choose a skill before it can invoke tools.

The outer harness must not re-read the full source tree after a successful Shepherd query response unless verification requires a specific cited source path.

## Output Contract

Success exits `0` and returns:

```text
status
contextPath
contractPath?
model
isolationMode
context metadata
answer
executionCount
answerRejections
usage
facts grounded/pending
extractor failures
runtime finalizations
```

Usage/config errors exit `2`. Runtime/provider/answer failures exit `1` with bounded JSON diagnostics when `--json` is set.

## Safety

- Never pass credentials on the command line.
- Use configured Pi provider auth.
- Keep default token/cost/depth/time limits unless the user explicitly owns a different bounded limit.
- Do not retry the same failed run blindly.
- Contract/source failures return to `shepherd check`; provider failures return to provider/auth diagnosis.

## Acceptance

- The answer comes from `shepherd query`, not the outer harness reconstructing it.
- Contract mode is preflighted with zero-model `shepherd check`.
- JSON reports exact usage and source revision.
- OMP, Claude, and Pi use the same CLI argv for parity.
- Explicit OMP/Pi invocation uses native `/shepherd query` without an outer-agent model turn.
- No raw directory bundle is pasted into outer model chat.
