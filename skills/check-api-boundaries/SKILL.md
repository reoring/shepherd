---
name: check-api-boundaries
description: Creates and verifies source contracts for HTTP route and middleware boundaries. Use when checking root probes, timeout/auth/CORS groups, streaming exceptions, route mounters, or production wiring split across router and server bootstrap files.
---

# Check API Boundaries

## Outcome

Encode a route/middleware architecture boundary as grounded facts: which routes are at the root, which registrations bypass middleware, which registrations remain inside it, and how production bootstrap supplies those groups.

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

- Route placement relative to middleware is part of the architecture.
- Streaming/SSE routes must bypass a request timeout.
- Health probes must remain outside normal route groups.
- Production wiring lives in a separate bootstrap file.

Do not use source shape as a substitute for runtime behavior tests. Keep timeout cancellation, auth behavior, CORS behavior, and streaming behavior covered by normal tests.

## Workflow

1. Identify the config-aware router constructor, not a test-only wrapper.
2. Read the bounded router function and mark exact middleware boundaries.
3. Identify root routes, bypass groups, and protected groups as separate facts.
4. Read the production config wiring for list-valued route mounters.
5. Use explicit `afterLiteral` and `beforeLiteral` scope anchors around middleware groups.
6. Set exact cardinality from current source, without embedding expected captured values.
7. Render a compact boundary answer from grounded facts.
8. Run `shepherd check` locally before `/shepherd query` and in CI on relevant route/config changes.

## Contract Patterns

Root quoted paths:

```json
{
  "source": {"kind": "symbol", "name": "NewRouterWithConfig", "before": 0, "after": 80},
  "select": {"kind": "contains-all", "literals": ["r.Get(", "health.Handler()"]},
  "capture": {"kind": "quoted-string", "index": 0},
  "reduce": {"kind": "join", "exactCount": 2, "separator": ","}
}
```

Middleware-scoped config field:

```json
{
  "source": {"kind": "symbol", "name": "NewRouterWithConfig", "before": 0, "after": 80},
  "scope": {
    "afterLiteral": "api.Use(middleware.Timeout(cfg.RequestTimeout))",
    "beforeLiteral": "\t})",
    "maxLines": 12
  },
  "select": {"kind": "contains-all", "literals": ["range cfg."]},
  "capture": {"kind": "identifier-after", "literal": "cfg."},
  "reduce": {"kind": "single", "exactCount": 1}
}
```

Production list wiring:

```json
{
  "source": {
    "kind": "search-open",
    "literal": "SSEMounts:",
    "path": "cmd/server/main.go",
    "before": 5,
    "after": 12
  },
  "scope": {"afterLiteral": "SSEMounts:", "beforeLiteral": "},", "maxLines": 8},
  "select": {"kind": "identifier-chain-line", "trailingDelimiter": ","},
  "capture": {"kind": "identifier-chain", "stripTrailingDelimiter": true},
  "reduce": {"kind": "join", "exactCount": 2, "separator": ","}
}
```

## Failure Policy

- A missing middleware anchor is an architecture change, not a reason to drop scope.
- A changed route count requires inspection of root/group placement.
- If multiple groups use the same literal, narrow the source/scope rather than selecting the first match.
- Never infer that a route bypasses middleware from its name; require source placement evidence.

## Acceptance

- Every boundary fact is grounded in the owning router/bootstrap source.
- Root, bypass, and protected groups are represented separately.
- Source drift fails before any model call.
- Runtime API/E2E tests remain the authority for actual request behavior.
