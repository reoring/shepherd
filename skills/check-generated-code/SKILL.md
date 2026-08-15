---
name: check-generated-code
description: Creates bounded source contracts for important facts inside large generated files. Use when verifying request shapes, route tables, bindings, operation names, or headers without loading the full generated artifact into model context.
---

# Check Generated Code

## Outcome

Extract a small, stable set of public-contract facts from a large generated file through one exact symbol slice, while avoiding broad model context and adjacent generated function contamination.

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

- Generated artifacts are large enough to exceed practical model input limits.
- A specific generated operation or binding has a stable symbol.
- Generated output is reviewed through its owning schema but exact emitted facts still matter.
- Source regeneration should fail CI when a public request/route/binding changes.

Do not use this skill to validate generated formatting, whitespace, comments, or implementation noise. Prefer generator drift checks for whole-file reproducibility.

## Workflow

1. Identify the owning schema/generator and the exact generated symbol.
2. Select the smallest source window containing all required facts.
3. Define one fact per public concern: method, path, header, operation ID, binding name, or field number.
4. Use selectors that describe syntax shape without embedding the expected output value.
5. Use exact cardinality to reject adjacent-function matches.
6. Run `shepherd check` immediately after regeneration.
7. If the generated output changes intentionally, update schema, generated file, and contract in one review.

## Good Facts

- HTTP method literal
- URL/path template
- idempotency or auth header name
- generated operation method name
- route name
- protobuf field/binding identity when represented as stable source literals

## Bad Facts

- generated timestamps
- formatting
- line numbers
- comments
- arbitrary helper implementation details
- values already protected by a canonical generator checksum

## Bounding Rules

- Prefer `source.kind: symbol` over repository-wide literal search.
- Keep `before` at zero unless preceding declarations are evidence.
- Set `after` to the target function length, not a large convenience window.
- If multiple identical request lines appear, shrink the source before changing cardinality.

## Failure Policy

- `SOURCE_NOT_FOUND`: generated operation was renamed or removed; inspect the owning schema.
- `CARDINALITY_MISMATCH`: source window may include adjacent generated operations.
- `CAPTURE_FAILED`: generator syntax changed; review before updating the extractor.
- Never edit generated source manually to restore a check.

## Acceptance

- Facts correspond to public/generated contract boundaries.
- No expected value is copied into a selector.
- The bounded source excludes neighboring operations.
- Regeneration is the only source writer.
- Local and CI checks run with zero model calls.
