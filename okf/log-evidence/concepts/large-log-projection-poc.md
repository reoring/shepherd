---
type: Reference
title: Large-log projection PoC
description: Records the bounded synthetic-log experiment that separated Shepherd indexing success from semantic answer failure.
status: stable
tags: [shepherd, logs, poc, historical-evidence]
generated: { by: "openai/gpt-5.6-sol", at: "2026-08-17T09:59:09+09:00" }
sources:
  - id: poc-summary
    resource: /references/log-analysis-poc-summary.json
    title: Sanitized large-log PoC summary
  - id: file-context
    resource: https://github.com/reoring/shepherd/blob/5b54906bd71a0e0e45217b6b052b6311b8d79c58/src/file-context.ts
    title: File-indexed context and evidence bounds
  - id: projection-source
    resource: https://github.com/reoring/shepherd/blob/5b54906bd71a0e0e45217b6b052b6311b8d79c58/src/repl-worker.ts
    title: REPL worker evidence projection
  - id: extractor-source
    resource: https://github.com/reoring/shepherd/blob/5b54906bd71a0e0e45217b6b052b6311b8d79c58/src/fact-extractor.ts
    title: Quoted-string extraction
  - id: validation-source
    resource: https://github.com/reoring/shepherd/blob/5b54906bd71a0e0e45217b6b052b6311b8d79c58/src/runner.ts
    title: Runner answer validation
---

# Scope

This is immutable historical evidence from one synthetic PoC against Shepherd source commit `5b54906bd71a0e0e45217b6b052b6311b8d79c58` using `openai/gpt-5.6-luna` with subprocess isolation. It is not a benchmark of population-level reliability and does not establish production readiness.[^poc-summary]

The durable design conclusion is maintained separately in [Bounded log evidence projection](./bounded-log-evidence-projection.md).

# Fixture

The deterministic fixture contained one 11,534,568-byte UTF-8 JSONL file with 40,992 monotonically timestamped records. It embedded:

- one `ROOT_CAUSE_POOL_EXHAUSTED` marker at line 1,000;
- five `trace-7f3a` events at lines 2,000 through 2,004;
- 1,500 `RATE_LIMIT_BURST` records at lines 5,000 through 6,499;
- two tracked `.log` files in a disposable Git repository for directory-selection probing.[^poc-summary]

# Deterministic indexing result

| Probe | Observed result |
|---|---|
| Single-file load | 1 file and 11,534,568 bytes indexed |
| Root-cause literal | 1 exact hit at line 1,000 |
| Correlated trace literal | 5 exact hits at lines 2,000–2,004 |
| Rate-limit literal | 1,500 actual matches; 1,000 returned at the hard result ceiling |
| Tracked `.log` directory | 0 files indexed because `.log` was outside the tracked-text allowlist |

These observations show that the index can locate bounded literals in a file below the 16 MiB ceiling, while result caps and path filtering are explicit constraints.[^poc-summary][^file-context]

# Model-query result

Two contract-free queries requested different answer shapes:

| Request | Actual answer | Process status | Correct | Calls | Tokens | Cost |
|---|---|---:|---:|---:|---:|---:|
| Return the complete unique root-cause JSONL line | `timestamp` | `passed` | no | 2 | 3,166 | $0.0010097 |
| Return five correlated events as an ordered timeline | `timestamp` | `passed` | no | 2 | 3,586 | $0.00110425 |

Both were semantic false passes. `project_answer` selected quoted index zero from observed JSONL, which produced the first key `timestamp`. Evidence-projection enforcement accepted the runtime-produced scalar, and the absent answer validator allowed any non-empty candidate.[^poc-summary][^projection-source][^extractor-source][^validation-source]

The run had zero grounded facts, zero runtime finalizations, and zero answer rejections. Process success therefore did not imply semantic success.[^poc-summary]

# What this evidence proves

- The current single-file index can navigate an 11.5 MB synthetic log without placing the whole file in model chat context.
- Literal location and bounded source retrieval worked for the exact fixture.
- Current result caps prevent complete counts above 1,000 returned matches.
- Current Git-directory selection omits tracked `.log` files.
- Evidence provenance alone permitted a semantically unrelated projected scalar to pass for exact-line and timeline requests.

# What this evidence does not prove

- Reliability across other logs, formats, models, seeds, or repeats.
- Correct root-cause reasoning, chronology, aggregation, or cross-file correlation.
- Safety of contract-free answers outside this exact fixture.
- Performance on files above 16 MiB or corpora above 256 MiB.

[^poc-summary]: Sanitized large-log PoC summary
[^file-context]: File-indexed context and evidence bounds
[^projection-source]: REPL worker evidence projection
[^extractor-source]: Quoted-string extraction
[^validation-source]: Runner answer validation
