---
type: Decision
title: Bounded log evidence projection
description: Defines what Shepherd's indexed log evidence proves and the semantic contract required before a projected answer may pass.
status: stable
tags: [shepherd, evidence, logs, indexing]
generated: { by: "openai/gpt-5.6-sol", at: "2026-08-17T09:59:09+09:00" }
sources:
  - id: file-context
    resource: https://github.com/reoring/shepherd/blob/5b54906bd71a0e0e45217b6b052b6311b8d79c58/src/file-context.ts
    title: File-indexed context and evidence bounds
  - id: repl-worker
    resource: https://github.com/reoring/shepherd/blob/5b54906bd71a0e0e45217b6b052b6311b8d79c58/src/repl-worker.ts
    title: REPL worker evidence projection
  - id: fact-extractor
    resource: https://github.com/reoring/shepherd/blob/5b54906bd71a0e0e45217b6b052b6311b8d79c58/src/fact-extractor.ts
    title: Typed fact extraction and quoted-string capture
  - id: runner
    resource: https://github.com/reoring/shepherd/blob/5b54906bd71a0e0e45217b6b052b6311b8d79c58/src/runner.ts
    title: Runner answer validation
  - id: query-command
    resource: https://github.com/reoring/shepherd/blob/5b54906bd71a0e0e45217b6b052b6311b8d79c58/src/query-command.ts
    title: Shepherd query command
  - id: indexed-context-tests
    resource: https://github.com/reoring/shepherd/blob/5b54906bd71a0e0e45217b6b052b6311b8d79c58/test/indexed-context.test.ts
    title: Indexed context deterministic tests
---

# Scope and authority

This decision applies to Shepherd's file-indexed, contract-free query path at source commit `5b54906bd71a0e0e45217b6b052b6311b8d79c58`. The pinned runtime source and tests remain authoritative; this concept curates the boundary and does not replace them.[^file-context][^repl-worker][^indexed-context-tests]

The [large-log projection PoC](./large-log-projection-poc.md) is bounded historical evidence for this decision. It does not establish general log-analysis quality.

# Decision

**Evidence provenance is not semantic correctness.** A projected value may pass only when the runtime can verify that its selection and output shape satisfy the user's requested answer contract.

Current evidence IDs, source revisions, exact support text, line positions, and bounded extraction prove that a value came from observed source. They do not prove that the value answers the question, represents the intended JSON role, contains every requested event, is chronologically ordered, or is a valid root-cause conclusion.[^repl-worker][^fact-extractor]

A contract-free answer that lacks a question-bound runtime validator must fail closed rather than report semantic success.

# Current implemented boundary

At the pinned source revision:

- A single regular file is loaded as UTF-8 regardless of extension. A Git directory includes only tracked paths on the text allowlist; `.log` is not included.[^file-context][^query-command]
- Default file-context ceilings are 20,000 files, 16 MiB per file, and 256 MiB total. A source slice is bounded to 200 lines and 16 KiB.[^file-context]
- Observation is bounded to 4 KiB per turn and 12 KiB per run. Literal search returns 100 results by default and at most 1,000; `search_open` returns at most two matches.[^file-context]
- Search is literal rather than regular-expression or timestamp-aware. The runtime has no native whole-corpus count, timestamp parser, time-window scan, or cross-file timeline merge.[^file-context]
- `project_answer` projects one scalar using number-after, identifier-after, or quoted-string capture. Quoted-string capture tokenizes quoted text lexically; for JSONL, quoted index zero commonly selects the key `timestamp`, not the complete record or its first value.[^repl-worker][^fact-extractor]
- Evidence-projection enforcement checks that the submitted answer equals the runtime-projected scalar. Without an explicit validator, the runner accepts any non-empty projected scalar.[^repl-worker][^runner][^query-command]

# Required semantic binding

The runtime needs explicit projection kinds whose outputs are mechanically checkable against the requested shape:

- `exact-line`: answer equals one observed source line selected by declared literal and cardinality.
- `json-field`: answer comes from a named JSON property, with key and value roles parsed structurally.
- `timeline`: answer contains the declared number of matching events, preserves the correlation key, and is sorted by the declared timestamp field.
- `count`: answer is computed over a complete, non-truncated scan rather than model-visible search previews.

If the requested answer shape cannot be represented and validated by an available projection kind, Shepherd must reject the answer. A scalar projection cannot satisfy an exact-line or multi-event timeline request.

This semantic binding is design intent; the pinned source does not yet implement these projection kinds.

# Operational boundary

Current Shepherd is suitable for bounded literal discovery and evidence navigation in a single log below the file ceiling. It is not a trusted general log analyzer for exact JSONL records, whole-log counts, multi-file correlation, timelines, summaries, or root-cause claims until the corresponding runtime-owned semantic contracts exist.

[^file-context]: File-indexed context and evidence bounds
[^repl-worker]: REPL worker evidence projection
[^fact-extractor]: Typed fact extraction and quoted-string capture
[^runner]: Runner answer validation
[^query-command]: Shepherd query command
[^indexed-context-tests]: Indexed context deterministic tests
