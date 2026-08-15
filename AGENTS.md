# Sheperd contributor guidance

Sheperd exposes one public contract: Pi `/sheperd query <file-or-directory> [--contract <contract.json>] -- <question>` and `/sheperd check <directory> --contract <contract.json>`, plus shell `sheperd query <file-or-directory> --question <text> [--contract <contract.json>] [--model provider/model] [--isolation subprocess|docker] [--json]` and `sheperd check <directory> --contract <contract.json> [--isolation subprocess|docker] [--json]`. RLM is the internal recursive runtime technique underneath, not a public command name. Do not add compatibility aliases or deprecated commands.

## Working rules

- Start with the owning module in `src/` and its focused test in `test/`.
- Reuse the file-indexed context, shared-limit, worker-protocol, and contract-parser abstractions instead of adding parallel paths.
- Keep source inspection read-only in query and contract-check flows. Treat subprocess and Docker modes as explicit isolation choices.
- Contract checks must remain deterministic and use zero model calls. Facts need bounded source evidence; finalizers must only consume grounded facts.
- The staged patch runtime is experimental. Do not present it as a replacement for review, authorization, or tests.
- Skills in `skills/`, `.pi/skills/`, `.claude/skills/`, and `.agents/skills/` are mirrored integration material. Keep their root-relative checkout commands aligned. `.pi/extensions/sheperd.ts` and `.omp/extensions/sheperd.ts` re-export `src/native-extension.ts`.
- Do not add credentials, node_modules, captured source trees, raw run logs, generated benchmark outputs, or other workload artifacts.

## Verification

For behavior changes, run the narrow affected test first, then `npm run typecheck` and `npm test` when the change crosses shared runtime contracts. Exercise the changed CLI or native command path when a surface changes.
