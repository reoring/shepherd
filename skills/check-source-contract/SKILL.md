---
name: check-source-contract
description: Validates a versioned source-fact contract deterministically with zero model calls. Use in local development or CI to detect extraction, grounding, finalization, answer-pattern, and source drift failures.
---

# Check Source Contract

## Outcome

Prove that a versioned RLM contract matches the current tracked source without invoking an LLM provider. Return grounded facts, failure codes, answer preview, source revision, and CI-compatible exit status.

## Use When

- Authoring or reviewing an RLM contract.
- Editing source covered by a contract.
- Preflighting a `query-large-source` call.
- Running local or CI source-drift checks.
- Separating source/contract failures from model/provider failures.

## First Action

The checker and skill locations are already resolved. Do not run `ls`, `find`, `which`, or `cat SKILL.md`. When `src/shepherd-cli.ts` exists from the current repository root, run the `node src/shepherd-cli.ts check` command immediately; otherwise use `shepherd check`.

## Command

Installed package:

```bash
shepherd check "$REPO" --contract "$CONTRACT" --json
```

This repository checkout, from the repository root:

```bash
node src/shepherd-cli.ts check \
  "$REPO" --contract "$CONTRACT" --json
```

Use `--isolation docker` only when worker-isolation parity is part of the check.

## Exit Contract

```text
0: contract/source check passed
1: deterministic contract/source mismatch
2: usage, file, JSON, or runtime error
```

Never convert exit `1` into a warning when the user asked for a gate. Never retry with a model.

## Result Review

On PASS verify:

- all required facts are grounded
- extractor failures are zero
- runtime finalizer state matches the contract
- answer pattern passes when configured
- `modelCalls` is zero

On FAIL report:

- failed fact ID
- failure code
- bounded source path
- selected/captured counts
- pending facts
- answer/finalizer state

Do not change cardinality, anchors, or selectors only to make the check green. Read the owning source and decide whether source or contract should change.

## Cross-Harness Use

The deterministic checker core remains the authority:

- OMP and Pi: native `/shepherd check` executes immediately without an outer-agent model turn.
- Claude: use the direct shell command for an explicit check; use `/check-source-contract` only when Claude must select the workflow.
- CI: use the headless command without provider credentials.

Automatic skill selection necessarily spends an outer-agent decision; explicit checks should use the native or shell fast path.

## Working Tree

Tracked-file content is read from the current working tree, so staged and unstaged edits are checked. Untracked files are absent until added to the Git index. Current source revision display is HEAD-based and may not identify dirty content uniquely.

## Acceptance

- Check performs zero model calls.
- PASS/FAIL is deterministic for the same source and contract.
- Contract drift exits `1`.
- Config/runtime errors exit `2`.
- Query execution is not attempted after a failed check.
