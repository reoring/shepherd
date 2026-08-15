import type {
  FileIndexedContext,
  FileIndexedEvidenceSession,
} from "./file-context.ts";
import {
  redactPatchPocFailure,
  sanitizePiRlmFailureTrace,
  type SanitizedPiRlmFailureTrace,
} from "./patch-poc-artifacts.ts";
import {
  type PatchExecutionResult,
  type PatchExecutor,
  type PatchReceipt,
  type PatchRuntimeState,
} from "./patch-executor.ts";
import type { MutationLimits, PatchPlan } from "./patch-plan.ts";
import { ReplDockerCleanupError } from "./repl-client.ts";
import {
  PiRlmRunError,
  type NativePatchEditTarget,
  type NativePatchReplacementTarget,
  type PatchPlanningMode,
  type PiRlmFailureTrace,
  type PiRlmPatchPlanResult,
  type PiRlmRunner,
} from "./runner.ts";
import type { PiRlmUsage } from "./shared-limits.ts";

export interface PatchPlanningExecutionRequest {
  runner: PiRlmRunner;
  executor: PatchExecutor;
  context: FileIndexedContext;
  question: string;
  verificationProfile: string;
  limits?: MutationLimits;
  signal?: AbortSignal;
  patchPlanningMode?: PatchPlanningMode;
  nativeEdits?: readonly NativePatchEditTarget[];
  nativeReplacementTarget?: NativePatchReplacementTarget;
}

export interface PatchPlanningTrace {
  states: readonly PatchRuntimeState[];
  plannerTrace?: SanitizedPiRlmFailureTrace;
  failureClass?: string;
  failureDigest?: string;
}

/** The planning result deliberately excludes raw model messages, prompts, and traces. */
export interface PatchPlanningSummary {
  evidenceSession: FileIndexedEvidenceSession;
  executionCount: number;
  usage: PiRlmUsage;
  trace: SanitizedPiRlmFailureTrace;
}

export interface PatchPlanningExecutionResult {
  state: PatchRuntimeState;
  accepted: boolean;
  plan?: PatchPlan;
  usage?: PiRlmUsage;
  receipt?: PatchReceipt;
  execution?: PatchExecutionResult;
  planning?: PatchPlanningSummary;
  trace: PatchPlanningTrace;
}

function summarizePlanning(planning: PiRlmPatchPlanResult): PatchPlanningSummary {
  return {
    evidenceSession: planning.evidenceSession,
    executionCount: planning.executionCount,
    usage: { ...planning.usage },
    trace: sanitizePiRlmFailureTrace(planning.trace),
  };
}

function abortedTrace(
  plannerTrace: PiRlmFailureTrace | undefined,
  error: unknown,
): PatchPlanningTrace {
  return {
    states: ["READ_ONLY", "ABORTED"],
    ...(plannerTrace ? { plannerTrace: sanitizePiRlmFailureTrace(plannerTrace) } : {}),
    ...redactPatchPocFailure("ABORTED", undefined, error),
  };
}

function planningFailureTrace(
  plannerTrace: PiRlmFailureTrace | undefined,
  error: unknown,
): PatchPlanningTrace {
  return {
    states: ["READ_ONLY", "PLANNING_FAILED"],
    ...(plannerTrace ? { plannerTrace: sanitizePiRlmFailureTrace(plannerTrace) } : {}),
    ...redactPatchPocFailure("PLANNING_FAILED", undefined, error),
  };
}

function cleanupFailureTrace(
  plannerTrace: PiRlmFailureTrace | undefined,
  error: unknown,
): PatchPlanningTrace {
  return {
    states: ["READ_ONLY", "CLEANUP_FAILED"],
    ...(plannerTrace ? { plannerTrace: sanitizePiRlmFailureTrace(plannerTrace) } : {}),
    ...redactPatchPocFailure("CLEANUP_FAILED", "CLEANUP_FAILED", error),
  };
}
function hasDockerCleanupFailure(error: unknown): boolean {
  return (
    error instanceof ReplDockerCleanupError ||
    (error instanceof PiRlmRunError && error.cause instanceof ReplDockerCleanupError)
  );
}


/**
 * Keeps the planning model on the read-only side of the boundary. The host
 * owns the executor, source session, verification profile, and every mutation.
 */
export async function executePatchPlanning(
  request: PatchPlanningExecutionRequest,
): Promise<PatchPlanningExecutionResult> {
  if (request.signal?.aborted) {
    return {
      state: "ABORTED",
      accepted: false,
      trace: abortedTrace(undefined, request.signal.reason),
    };
  }

  let planning: PiRlmPatchPlanResult;
  try {
    planning = await request.runner.planPatch(request.context, request.question, {
      signal: request.signal,
      mode: request.patchPlanningMode,
      nativeEdits: request.nativeEdits,
      nativeReplacementTarget: request.nativeReplacementTarget,
    });
  } catch (error) {
    const plannerError = error instanceof PiRlmRunError ? error : undefined;
    if (hasDockerCleanupFailure(error)) {
      return {
        state: "CLEANUP_FAILED",
        accepted: false,
        ...(plannerError ? { usage: plannerError.usage } : {}),
        trace: cleanupFailureTrace(plannerError?.trace, error),
      };
    }
    if (request.signal?.aborted) {
      return {
        state: "ABORTED",
        accepted: false,
        ...(plannerError ? { usage: plannerError.usage } : {}),
        trace: abortedTrace(plannerError?.trace, error),
      };
    }
    return {
      state: "PLANNING_FAILED",
      accepted: false,
      ...(plannerError ? { usage: plannerError.usage } : {}),
      trace: planningFailureTrace(plannerError?.trace, error),
    };
  }

  let execution: PatchExecutionResult;
  try {
    request.signal?.throwIfAborted();
    execution = await request.executor.execute({
      plan: planning.plan,
      verificationProfile: request.verificationProfile,
      context: request.context,
      evidenceSession: planning.evidenceSession,
      limits: request.limits,
      signal: request.signal,
    });
  } catch (error) {
    const planningSummary = summarizePlanning(planning);
    if (hasDockerCleanupFailure(error)) {
      return {
        state: "CLEANUP_FAILED",
        accepted: false,
        plan: planning.plan,
        usage: planning.usage,
        planning: planningSummary,
        trace: cleanupFailureTrace(planning.trace, error),
      };
    }
    if (request.signal?.aborted) {
      return {
        state: "ABORTED",
        accepted: false,
        plan: planning.plan,
        usage: planning.usage,
        planning: planningSummary,
        trace: abortedTrace(planning.trace, error),
      };
    }
    return {
      state: "APPLY_FAILED",
      accepted: false,
      plan: planning.plan,
      usage: planning.usage,
      planning: planningSummary,
      trace: {
        states: ["READ_ONLY", "PLAN_SUBMITTED", "PLAN_VALIDATED", "APPLY_FAILED"],
        plannerTrace: sanitizePiRlmFailureTrace(planning.trace),
        ...redactPatchPocFailure("APPLY_FAILED", undefined, error),
      },
    };
  }

  return {
    state: execution.state,
    accepted: execution.state === "ACCEPTED",
    plan: planning.plan,
    usage: planning.usage,
    receipt: execution.receipt,
    execution,
    planning: summarizePlanning(planning),
    trace: {
      states: execution.receipt.transitions,
      plannerTrace: sanitizePiRlmFailureTrace(planning.trace),
      ...(execution.state === "ACCEPTED"
        ? {}
        : redactPatchPocFailure(
            execution.state,
            execution.receipt.failureCode,
            execution.receipt.failureCode ?? execution.state,
          )),
    },
  };
}
