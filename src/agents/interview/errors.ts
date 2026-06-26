// ── Interview Error System ───────────────────────────────────────────────

import type { InterviewErrorCode, InterviewErrorPayload } from "./types.js";

/**
 * Structured error for interview agent failures.
 * Carries a machine-readable error code and optional context details
 * for structured API responses.
 */
export class InterviewError extends Error {
  public readonly code: InterviewErrorCode;
  public readonly stateId?: string;
  public readonly threadId?: string;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: InterviewErrorCode,
    message: string,
    options?: {
      stateId?: string;
      threadId?: string;
      details?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = "InterviewError";
    this.code = code;
    this.stateId = options?.stateId;
    this.threadId = options?.threadId;
    this.details = options?.details;
  }

  /**
   * Convert this error to a serializable API response payload.
   */
  toResponsePayload(): InterviewErrorPayload {
    return {
      code: this.code,
      message: this.message,
      stateId: this.stateId,
      threadId: this.threadId,
      details: this.details,
    };
  }
}

// ── Helper Factory Functions ─────────────────────────────────────────────

/**
 * Create an INVALID_SUBMISSION error indicating the submission data does not
 * satisfy the current state's requirements.
 *
 * @param message - Human-readable description of what's wrong.
 * @param details - Optional context (e.g. `{ missingFields: ["answer"], anyOfFields: ["audio_url", "transcript"] }`)
 */
export function invalidSubmission(
  message: string,
  details?: Record<string, unknown>,
): InterviewError {
  return new InterviewError("INVALID_SUBMISSION", message, { details });
}

/**
 * Create a WRONG_STATE error indicating the agent's expected state does not
 * match the session's current state.
 *
 * @param expectedStateId - The state the agent expected to be in.
 * @param actualStateId   - The actual current state of the session.
 */
export function wrongState(
  expectedStateId: string,
  actualStateId: string,
): InterviewError {
  return new InterviewError("WRONG_STATE", `Expected state "${expectedStateId}" but current state is "${actualStateId}".`, {
    stateId: actualStateId,
    details: { expectedStateId, actualStateId },
  });
}

/**
 * Create a THREAD_NOT_FOUND error when no interview session exists for the
 * given thread ID.
 *
 * @param threadId - The requested thread ID that was not found.
 */
export function threadNotFound(threadId: string): InterviewError {
  return new InterviewError("THREAD_NOT_FOUND", `No interview session found for thread: "${threadId}".`, {
    threadId,
  });
}

/**
 * Create a CONFIG_NOT_FOUND error when no interview configuration exists for
 * the given company/job pair.
 *
 * @param companyId - The requested company ID.
 * @param jobId     - The requested job ID.
 */
export function configNotFound(
  companyId: string,
  jobId: string,
): InterviewError {
  return new InterviewError("CONFIG_NOT_FOUND", `Interview configuration not found for company "${companyId}" / job "${jobId}".`, {
    details: { companyId, jobId },
  });
}

/**
 * Create a MISSING_CANDIDATE_CONTEXT error when no candidate context is
 * provided when one is required.
 */
export function missingCandidateContext(): InterviewError {
  return new InterviewError(
    "MISSING_CANDIDATE_CONTEXT",
    "Candidate context is required but was not provided.",
  );
}

/**
 * Create a WRONG_STATE error specifically for when a state does not accept
 * submissions.
 *
 * @param stateId - The current state ID that rejects submissions.
 */
export function stateDoesNotAcceptSubmissions(stateId: string): InterviewError {
  return new InterviewError("WRONG_STATE", `Current state "${stateId}" does not accept submissions.`, {
    stateId,
  });
}

/**
 * Create an INTERVIEW_AGENT_FAILED error for unexpected agent errors.
 *
 * @param message - Description of the agent failure.
 * @param details - Optional error context.
 */
export function interviewAgentFailed(
  message: string,
  details?: Record<string, unknown>,
): InterviewError {
  return new InterviewError("INTERVIEW_AGENT_FAILED", message, { details });
}

/**
 * Convert any error to a serializable API response payload.
 * If the error is an InterviewError, it preserves the structured code/details.
 * Otherwise, it wraps as INTERVIEW_AGENT_FAILED.
 */
export function toResponsePayload(
  error: unknown,
): InterviewErrorPayload {
  if (error instanceof InterviewError) {
    return error.toResponsePayload();
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "INTERVIEW_AGENT_FAILED",
    message,
  };
}
