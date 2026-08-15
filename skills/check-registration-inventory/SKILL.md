---
name: check-registration-inventory
description: Creates and verifies source contracts for plugin, controller, route, provider, or handler inventories. Use when an exact registration list, order, or cardinality is an architectural invariant checked locally or in CI.
---

# Check Registration Inventory

## Outcome

Turn a stable explicit registration block into an evidence-grounded inventory contract that detects additions, removals, duplicates, ordering changes, and source-boundary drift.

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

- Registrations are explicit source lines in one bounded block.
- Exact membership or order matters operationally.
- Missing one registration causes a feature to disappear silently.
- The inventory should be reviewable as a versioned artifact.

Examples:

- controller `SetupWithManager` calls
- plugin/provider registration
- route mounter lists
- command/subcommand registration
- serializer/handler registries

Do not use this skill for reflection, dependency injection containers resolved at runtime, map iteration with undefined order, or dynamically discovered plugins.

## Workflow

1. Find the single owning registration block.
2. Decide whether source order is meaningful. If not, do not pretend the current ordered `join` reducer provides set semantics.
3. Identify a selector literal shared only by registration lines inside the bounded source.
4. Choose a capture that returns the registration expression without wrapper syntax.
5. Set exact cardinality from observed complete lines.
6. Use one support per captured item.
7. Run the checker and inspect every captured value before committing the contract.
8. Add path filters in CI so unrelated changes do not run the inventory check.

## Contract Choice

Use `identifier-chain-line` when each registration is a standalone chain with a delimiter:

```text
streamHandler.Mount,
devWorkspaceHandler.MountProxy,
```

Use `identifier-after` when each value is wrapped:

```text
registry.Register(provider.NewProvider())
rootCmd.AddCommand(cluster.NewClusterCmd())
```

Use quoted capture only when the registered identity is a source string and the string itself is the contract.

## Order Policy

- Order meaningful: use ordered `join` and document why.
- Order not meaningful: prefer multiple single facts or a normal AST/unit test until the reducer supports declared set semantics.
- Never sort values in model-authored code to hide source changes.

## Failure Policy

- Count increase: review new registration and ordering.
- Count decrease: inspect feature removal or conditional wiring.
- Duplicate capture: reject; do not deduplicate silently.
- Capture failure: registration syntax changed; select a supported structural path.

## Acceptance

- Inventory ownership is clear.
- Every item has a distinct complete-line support.
- Exact cardinality is intentional and reviewed.
- The checker returns deterministic JSON and exit status.
- A one-item stale contract fails with no model calls.
