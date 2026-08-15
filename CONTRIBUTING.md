# Contributing to Shepherd

## Local setup

Use Node.js 24 or newer and the committed lockfile:

```bash
npm ci
npm run typecheck
npm test
```

## Change discipline

- Read the owning runtime module and its focused tests before changing behavior.
- Keep the Shepherd public contract stable: Pi `/shepherd query <file-or-directory> [--contract <contract.json>] -- <question>` and `/shepherd check <directory> --contract <contract.json>`; shell `shepherd query <file-or-directory> --question <text> [--contract <contract.json>] [--model provider/model] [--isolation subprocess|docker] [--json]` and `shepherd check <directory> --contract <contract.json> [--isolation subprocess|docker] [--json]`.
- Treat RLM as the recursive runtime technique underneath Shepherd, not as a command or compatibility surface.
- Keep file context read-only, shared limits bounded, and deterministic contract checking model-free.
- Add a focused test for a new observable runtime or contract behavior.
- Keep contracts source-grounded. Do not encode expected output values into selectors merely to force a pass.
- Do not commit credentials, source snapshots, raw run logs, generated benchmark reports, or other captured workload artifacts.

Run type checking and tests before opening a pull request. Keep changes small enough that their evidence and isolation behavior can be reviewed directly.
