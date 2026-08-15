---
name: check-cli-registrations
description: Creates and verifies source contracts for CLI root and subcommand registrations. Use when preserving constructor wiring, source order, exact registration cardinality, or detecting command additions, removals, renames, and duplicates.
---

# Check CLI Registrations

## Outcome

Create a versioned contract that extracts CLI constructor expressions from one bounded registration function, grounds every item in a complete source line, and fails closed when the registration inventory drifts.

## Existing Contract Fast Path

When the user supplies an existing contract, do not begin with broad repository search.

The commands below are authoritative. Do not search for the skill, checker, or source before running the preflight.

1. Run `sheperd check "$REPO" --contract "$CONTRACT" --json`.
2. If the installed bin is unavailable in this checkout, run `node src/sheperd-cli.ts check "$REPO" --contract "$CONTRACT" --json` from the repository root.
3. Do not invent flags such as `--context`.
4. On PASS, use returned grounded facts and inspect only source paths needed for the requested risk review.
5. On FAIL, inspect only failed facts and their bounded source paths before changing the contract.
6. Treat `check-source-contract` as the deterministic authority. If the user also requests an answer, hand the passing contract to `query-large-source`; do not reconstruct the answer in this skill.

## Use When

- A stable root function registers commands or subcommands.
- Registration count or source order is architecturally meaningful.
- Constructor expressions are directly visible in source.
- The check must run locally and in CI without model calls.

Do not use this skill when commands are assembled dynamically from maps, reflection, runtime plugins, or generated data. Prefer a runtime/unit test or AST-aware checker in those cases.

## Workflow

1. Locate the owning registration function and confirm there is one unambiguous definition.
2. Read the complete bounded function. Do not search the whole repository for the registration literal and assume all hits belong to the root.
3. Count direct registration lines and preserve source order only if order matters.
4. Create `.rlm/contracts/<cli-name>.v1.json` with one `constructors` fact.
5. Use a symbol source selector, a literal line selector, `identifier-after` capture, exact-cardinality `join`, and a template finalizer.
6. Use `grounding: derived` when the captured constructor is embedded inside an `AddCommand(...)` line.
7. Run `sheperd check` before invoking `/sheperd query`.
8. If source intentionally changes, update source and contract in the same review.

## Contract Pattern

```json
{
  "version": 1,
  "factContract": {
    "requirements": [
      {
        "id": "constructors",
        "description": "Constructor expressions passed directly to the root command in source order.",
        "grounding": "derived",
        "minSupports": 14,
        "extractor": {
          "source": {
            "kind": "symbol",
            "name": "NewRootCmd",
            "before": 0,
            "after": 80
          },
          "select": {
            "kind": "contains-all",
            "literals": ["rootCmd.AddCommand("]
          },
          "capture": {
            "kind": "identifier-after",
            "literal": "rootCmd.AddCommand("
          },
          "reduce": {
            "kind": "join",
            "exactCount": 14,
            "separator": ","
          }
        }
      }
    ],
    "finalizer": {
      "kind": "template",
      "template": "{{constructors}}"
    }
  }
}
```

Replace symbol, literal, and cardinality with observed source facts. Never copy expected constructor values into the contract.

## Check

Installed package:

```bash
sheperd check "$REPO" --contract "$REPO/.rlm/contracts/cli-root.v1.json" --json
```

This checkout:

```bash
node src/sheperd-cli.ts check \
  "$REPO" --contract "$REPO/.rlm/contracts/cli-root.v1.json" --json
```

## Failure Policy

- `SOURCE_NOT_FOUND`: verify the owning function name; do not broaden to repository-wide text.
- `SOURCE_AMBIGUOUS`: select a unique production symbol before proceeding.
- `CARDINALITY_MISMATCH`: inspect additions, removals, and duplicates. Do not change `exactCount` just to make CI green.
- `CAPTURE_FAILED`: the registration syntax changed; use a supported structural contract or choose AST/runtime testing.

## Acceptance

- All direct registrations are captured exactly once.
- Supports are complete source lines.
- `modelCalls` is `0` in check mode.
- Intentional source changes and contract changes are reviewed together.
- An intentionally stale cardinality exits non-zero.
