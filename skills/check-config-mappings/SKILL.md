---
name: check-config-mappings
description: Creates and verifies source contracts for configuration defaults and constructor wiring. Use when checking zero-value defaults, config field assignments, timeout/retry settings, environment option mapping, or production constructor fields.
---

# Check Config Mappings

## Outcome

Verify that stable configuration fields are defaulted and wired through the intended source boundaries, with each captured value grounded in a bounded assignment or range line.

## Existing Contract Fast Path

When the user supplies an existing contract, do not begin with broad repository search.

The commands below are authoritative. Do not search for the skill, checker, or source before running the preflight.

1. Run `shepherd check "$REPO" --contract "$CONTRACT" --json`.
2. If the installed bin is unavailable in this checkout, run `node src/shepherd-cli.ts check "$REPO" --contract "$CONTRACT" --json` from the repository root.
3. Do not invent flags such as `--context`.
4. On PASS, use returned grounded facts and inspect only source paths needed for the requested risk review.
5. On FAIL, inspect only failed facts and their bounded source paths before changing the contract.
6. Treat `check-source-contract` as the deterministic authority. If the user also requests an answer, hand the passing contract to `query-large-source`; do not reconstruct the answer in this skill.

## Use When

- Config/default logic is explicit in source.
- A production constructor wires named fields or lists.
- Timeout, retry, idempotency, or endpoint settings must remain aligned.
- Multiple files contribute to one configuration contract.

Do not use this skill to prove runtime precedence, environment parsing, or behavioral timeout semantics. Keep those in unit/integration tests.

## Workflow

1. Identify the defaulting function and production constructor separately.
2. List only stable fields whose wiring matters to the product contract.
3. Scope extraction after a stable assignment/group anchor and before its closing boundary.
4. Capture field identifiers or quoted literals from complete assignment lines.
5. Represent cross-file facts separately rather than deriving a combined value in model code.
6. Use a finalizer only for a declared output format.
7. Run the checker against the dirty working tree during development.
8. Review source and contract changes together.

## Extractor Patterns

Capture a Config field used in a bounded group:

```json
{
  "scope": {
    "afterLiteral": "middleware.Timeout(cfg.RequestTimeout)",
    "beforeLiteral": "})",
    "maxLines": 12
  },
  "select": {"kind": "contains-all", "literals": ["range cfg."]},
  "capture": {"kind": "identifier-after", "literal": "cfg."},
  "reduce": {"kind": "single", "exactCount": 1}
}
```

Capture a quoted default:

```json
{
  "select": {"kind": "contains-all", "literals": ["DefaultEndpoint"]},
  "capture": {"kind": "quoted-string", "index": 0},
  "reduce": {"kind": "single", "exactCount": 1}
}
```

Use identifier capture for named constants rather than copying the constant's resolved runtime value into the source contract.

## Precedence Boundary

`shepherd check` can prove source wiring such as:

```text
zero value assigns DefaultRequestTimeout
server constructor uses cfg.RequestTimeout
```

It cannot by itself prove environment/flag precedence or actual deadline behavior. Add normal tests for those paths.

## Failure Policy

- Missing default assignment: inspect whether ownership moved.
- Multiple matching assignments: narrow to the owning branch/scope.
- Changed field identifier: review all constructor and caller mappings.
- Do not broaden selectors until an arbitrary assignment passes.

## Acceptance

- Defaulting and production wiring facts have separate evidence.
- Scope anchors identify the owning branch/group.
- Source constants remain symbolic unless literal output is the contract.
- Runtime precedence remains covered by tests.
- Check mode is deterministic and model-free.
