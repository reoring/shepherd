# Benchmark evidence

This page contains the detailed, sanitized benchmark evidence summarized in the [README](../README.md). It records the tested harnesses, public commit bindings, results, caveats, and commands for re-evaluating the current harness.

## Current public-SHA evidence — [c9b0c94](https://github.com/reoring/shepherd/commit/c9b0c9461e63a588c37f1f48ab5040619352c169)

These sanitized aggregates were measured from a clean checkout of public commit [c9b0c94](https://github.com/reoring/shepherd/commit/c9b0c9461e63a588c37f1f48ab5040619352c169) with GPT-5.6 Luna on **2026-08-15**.

### Query stability — subprocess, two scenarios × 10

| Scenario | Correct | False `PASS` | Median | p95 | Model calls | Tokens | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| Plain file | 10/10 | 0 | 4.94 s | 5.99 s | 18 | 27,428 | $0.0085852 |
| Directory | 10/10 | 0 | 5.03 s | 6.26 s | 17 | 24,959 | $0.0077363 |
| **Aggregate** | **20/20** | **0** | — | — | **35** | **52,387** | **$0.0163215** |

### Matched patch tasks — Shepherd versus Direct Pi, thinking off, three tasks × 5 per harness

The Direct Pi baseline was benchmark-specific: it had only host-allowlisted `read`, `edit`, and `write` tools, with no shell, search, network, extensions, or skills. Both paths used the same source, task, model, limits, and verification profile; Direct Pi ran first for each case and repeat.

| Aggregate metric | Shepherd (15 runs) | Direct Pi (15 runs) | Result |
|---|---:|---:|---:|
| Accepted-correct | 15/15 | 9/15 | **+40 percentage points** |
| False successes | 0 | 6 | 6 fewer |
| Scope violations | 0 | 4 | 4 fewer |
| Model calls | 30 | 52 | **42.3% lower** |
| Total tokens | 15,899 | 28,278 | **43.8% lower** |
| Total cost | $0.0043738 | $0.0073866 | **40.8% lower** |
| Aggregate latency | 102,149.7 ms | 91,562.7 ms | **Shepherd 11.6% higher (latency regression)** |

The joint benchmark exits nonzero by design unless **both** harnesses meet acceptance. Direct Pi does not meet it; Shepherd's own per-harness result is **15/15** accepted-correct runs.

This supports a **limited GO** only for host-targeted replacement, insertion, exact multi-file wiring, and seeded one-file repair. It does not support general writing: the host owns target paths, operations, ranges, replacement constraints, and verification; the model supplies intent and replacement through the staged flow.

## Local-model evidence — matched patch tasks on Qwen3.8-27B — [f1189f8](https://github.com/reoring/shepherd/commit/f1189f8769a6bee06da2dc38960d3a078e0e25f6)

The same matched-patch benchmark (three tasks × 5 repeats per harness, thinking off, identical limits) was re-run on **2026-08-18** from public commit [f1189f8](https://github.com/reoring/shepherd/commit/f1189f8769a6bee06da2dc38960d3a078e0e25f6) on a local Qwen3.8-27B-GGUF (UD-Q4_K_XL, OpenAI-compatible endpoint, `reasoning_effort: none` for thinking off).

| Aggregate metric | Shepherd (15 runs) | Direct Pi (15 runs) | Result |
|---|---:|---:|---:|
| Accepted-correct | 15/15 | 14/15 | **+6.7 percentage points** |
| False successes | 0 | 1 | 1 fewer |
| Scope violations | 0 | 1 | 1 fewer |
| Model calls | 30 | 50 | **40.0% lower** |
| Total tokens (cache-read inclusive) | 24,147 | 46,762 | 48.4% lower |
| Fresh tokens (non-cached) | 14,763 | 12,086 | Direct Pi 18.1% lower |
| Total cost | $0 (local) | $0 (local) | no pricing configured |
| Aggregate latency | 84,044 ms | 146,830 ms | **Shepherd 42.8% lower** |

Token accounting: the local endpoint reports prompt-cache reads. The Direct Pi agent session accumulates history without compaction, so later calls resend the growing prefix and it is billed as cache reads (34,676 tokens, 74% of its total). `totalTokens` includes cache reads 1:1, so the headline token gap is inflated; on fresh (non-cached) tokens Direct Pi is actually lower. The Luna table above has zero cache reads on both harnesses, so its token delta is entirely fresh.

Model robustness: Shepherd's 15/15 accepted-correct, zero false successes, zero scope violations, and 30 model calls hold on both Luna and Qwen. Direct Pi's quality (9/15 on Luna, 14/15 on Qwen) and the latency winner (Direct Pi on Luna, Shepherd on Qwen) are model-dependent. `contextWindow` is not used in any Shepherd limit; `maxTokens` is a per-run reservation budget, not a context cap.

## Luna versus Qwen — same matched-patch benchmark, two models

The two tables above re-run the same matched-patch benchmark (three tasks × 5 repeats per harness, thinking off, identical limits) on two different models. They are bound to different harness commits (Luna at [c9b0c94](https://github.com/reoring/shepherd/commit/c9b0c9461e63a588c37f1f48ab5040619352c169), Qwen at [f1189f8](https://github.com/reoring/shepherd/commit/f1189f8769a6bee06da2dc38960d3a078e0e25f6)); the harness changed between them, so this is a cross-model comparison, not a controlled A/B.

| Metric | Luna (c9b0c94) | Qwen (f1189f8) |
|---|---:|---:|
| Shepherd accepted-correct | 15/15 | 15/15 |
| Direct Pi accepted-correct | 9/15 | 14/15 |
| Direct Pi false successes | 6 | 1 |
| Direct Pi scope violations | 4 | 1 |
| Shepherd model calls | 30 | 30 |
| Direct Pi model calls | 52 | 50 |
| Shepherd latency | 102.1 s | 84.0 s |
| Direct Pi latency | 91.6 s | 146.8 s |
| Latency winner | Direct Pi (Shepherd +11.6%) | Shepherd (−42.8%) |

What holds on both models (model-robust): Shepherd's 15/15 accepted-correct, zero false successes, zero scope violations, and 30 model calls.

What changes with the model (model-dependent): Direct Pi's quality (9/15 on Luna, 14/15 on Qwen) and which harness is faster (Direct Pi on Luna, Shepherd on Qwen).

Takeaway: on this local model, Qwen is a stronger freeform patcher than Luna (Direct Pi 14/15 vs 9/15) but slower and more wasteful (146.8 s, cache-inflated tokens). Running it through Shepherd recovers both correctness (15/15) and speed (84.0 s — the faster of the two harnesses on Qwen, whereas on Luna Direct Pi was faster). This is one 5-repeat run across two harness commits: directional, not stability evidence.

## Historical pre-release evidence — matched large-source extraction

With GPT-5.6 Luna, thinking off, the same model, questions, exact source, and limits, three cases were repeated three times per harness (9 runs per harness). The pre-release runtime then labelled Pi-RLM, now shipped as Shepherd, completed **9/9** correctly versus Direct Pi's **3/9**: **+66.7 percentage points**.

| Aggregate metric | Shepherd/Pi-RLM (9 runs) | Direct Pi (9 runs) | Shepherd/Pi-RLM result |
|---|---:|---:|---:|
| Correct | 9/9 | 3/9 | +66.7 percentage points |
| Total cost | $0.0044154 | $0.00552401 | 20.1% lower |
| Total tokens | 14,969 | 20,027 | 25.3% lower |
| Model calls | 9 | 14 | 5 fewer |

Direct Pi's six failures were fail-closed input-budget preflight rejections, not semantic wrong answers. The pre-release Shepherd/Pi-RLM run used task-specific typed contracts; Direct Pi did not have an equivalent contract.

## Historical pre-release evidence — evidence projection before/after

A runtime-owned evidence-projection improvement was measured on the same two scenarios, with 10 repeats each before and after (20 runs per condition). It improved extractive correctness from **16/20 to 20/20**, reduced false `PASS` from **2 to 0**, cut model calls from **70 to 36** (**48.6% lower**), and cut total cost from **$0.0264207 to $0.0167854** (**36.5% lower**).

This result applies to **single-line extractive answers**. It is neither a Direct Pi comparison nor evidence for freeform summaries, design review, or reasoning across multiple evidence items.

## Methodology and caveats

The current tables are public-SHA-bound sanitized aggregates. Raw outputs were deleted and are not published because they may include source or transcripts. Historical external-source captures remain unpublished. These measurements are not a universal performance guarantee.

The local-model Qwen run reports $0 cost (no pricing configured) and its token totals include prompt-cache reads; compare that run on fresh tokens, model calls, and latency rather than total tokens.

The [benchmark-v3 runner](../src/benchmark-v3.ts) and [matched-patch benchmark runner](../src/matched-patch-benchmark-cli.ts) can re-evaluate the current harness with configured provider authentication:

```bash
npm run benchmark:v3
npm run benchmark:matched-patch
```

Those commands incur provider cost. They exercise the current harness rather than byte-for-byte reproducing the historical tables, whose external source snapshots are not published.
