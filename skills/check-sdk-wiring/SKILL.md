---
name: check-sdk-wiring
description: Creates and verifies cross-file source contracts from handwritten SDK services to generated request builders. Use when preserving validation labels, client method wiring, HTTP methods, URL templates, headers, or idempotency behavior.
---

# Check SDK Wiring

## Outcome

Verify that a handwritten SDK method remains connected to the intended generated request builder and that the generated request shape preserves the declared HTTP method, path template, and critical headers.

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

- A handwritten service delegates to a generated client.
- The generated file is too large to send directly to a model.
- A small set of cross-file request facts must remain aligned.
- Generated code changes frequently but the public SDK contract is stable.

Do not edit generated code to satisfy the contract. Change the owning schema/generator or intentionally update the contract after regeneration.

## Workflow

1. Locate the handwritten service method and its exact generated raw method call.
2. Locate the generated request-builder symbol, not a broad path literal hit.
3. Keep each semantic output as a separate fact.
4. Use one bounded service slice for validation label and raw method.
5. Use one bounded generated-builder slice for HTTP method, URL template, and headers.
6. Keep the slice short enough not to include the next generated function.
7. Use quoted captures for strings and `identifier-after` for generated method names.
8. Finalize only after every cross-file fact is grounded.

## Recommended Facts

```text
validation-label
raw-method
http-method
url-template
idempotency-header
```

## Extractor Patterns

Validation label:

```json
{
  "select": {"kind": "contains-all", "literals": ["requireNonEmpty(", "id)"]},
  "capture": {"kind": "quoted-string", "index": 0},
  "reduce": {"kind": "single", "exactCount": 1}
}
```

Generated raw method:

```json
{
  "select": {"kind": "contains-all", "literals": ["client.raw.", "WithBodyWithResponse("]},
  "capture": {"kind": "identifier-after", "literal": "client.raw."},
  "reduce": {"kind": "single", "exactCount": 1}
}
```

Generated request facts:

```json
{
  "select": {"kind": "contains-all", "literals": ["http.NewRequest("]},
  "capture": {"kind": "quoted-string", "index": 0},
  "reduce": {"kind": "single", "exactCount": 1}
}
```

Use separate selectors for `operationPath := fmt.Sprintf(` and critical `Header.Set(` lines.

## Bounded Generated Source

Generated files often contain adjacent functions with identical request construction lines. If `exactCount` is unexpectedly greater than one:

1. Reduce `after` to the target function body.
2. Add a stable scope end if available.
3. Do not select the first request line from a large generated window.

## Failure Policy

- `CARDINALITY_MISMATCH` in generated source often means the slice includes the next function.
- `SOURCE_NOT_FOUND` after regeneration requires checking the owning API operation name.
- A changed HTTP method/path/header is a public contract review, not automatic repair.
- Never encode the expected generated method/path/header value into selector literals merely to force a pass.

## Acceptance

- Handwritten and generated facts are grounded separately.
- The contract contains structure but no oracle output values.
- Regeneration with an intentional API change fails until reviewed.
- Check mode performs zero model calls.
