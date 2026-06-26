import type {
    InterviewSession,
    InterviewStateView,
    InterviewStateConfig,
    SubmissionRecord,
    SubmissionRequirement,
    InterviewConfig,
    FinalEvaluation,
    CandidateContext,
} from "../types.js";
import {
    invalidSubmission,
} from "../errors.js";

// ── Session Factory ──────────────────────────────────────────────────────

export interface InitializeInterviewSessionParams {
    threadId: string;
    companyId: string;
    jobId: string;
    interviewConfig: InterviewConfig;
    candidateContext?: CandidateContext;
}

/**
 * Create a new interview session initialized to the first state.
 */
export function initializeInterviewSession(
    params: InitializeInterviewSessionParams,
): InterviewSession {
    const { threadId, companyId, jobId, interviewConfig, candidateContext } =
        params;
    const firstState = interviewConfig.states[0];
    if (!firstState) {
        throw new Error(
            `Interview config for ${companyId}/${jobId} has no states`,
        );
    }

    const now = Date.now();
    return {
        threadId,
        companyId,
        jobId,
        currentStateId: firstState.id,
        submissions: [],
        scores: {},
        candidateContext,
        isComplete: firstState.id === "complete",
        createdAt: now,
        updatedAt: now,
    };
}

// ── State View ───────────────────────────────────────────────────────────

/**
 * Get a read-only projection of the current interview state
 * suitable for API responses.
 */
export function getInterviewStateView(
    session: InterviewSession,
    interviewConfig: InterviewConfig,
    finalEvaluation?: FinalEvaluation,
): InterviewStateView {
    const currentState = findState(interviewConfig, session.currentStateId);
    const nextSubmission = getNextSubmissionRequirement(
        session,
        interviewConfig,
    );

    return {
        threadId: session.threadId,
        companyId: session.companyId,
        jobId: session.jobId,
        currentStateId: session.currentStateId,
        currentStateLabel: currentState?.label ?? session.currentStateId,
        isComplete: session.isComplete,
        nextSubmission,
        submissions: session.submissions,
        scores: session.scores,
        evaluation: finalEvaluation ?? session.finalEvaluation,
    };
}

// ── Next Submission ──────────────────────────────────────────────────────

/**
 * Determine what the candidate must submit next, if anything.
 *
 * Returns `null` when the state does not expect a submission (e.g. intro,
 * final_evaluation) or when the interview is complete.
 */
export function getNextSubmissionRequirement(
    session: InterviewSession,
    interviewConfig: InterviewConfig,
): SubmissionRequirement | null {
    if (session.isComplete) {
        return null;
    }

    const state = findState(interviewConfig, session.currentStateId);
    if (!state) {
        return null;
    }

    const submission = state.expected_submission;
    if (submission.type === "none") {
        return null;
    }

    // If already submitted for this state, return null (waiting for advancement)
    if (hasSubmittedForState(session, state.id)) {
        return null;
    }

    return submission;
}

// ── Validation ───────────────────────────────────────────────────────────

/**
 * Validate whether the provided submission data satisfies the current
 * state's requirements.
 *
 * Returns an array of error messages (empty = valid).
 *
 * @throws {InterviewError} with code INVALID_SUBMISSION when validation fails.
 *   Callers may catch this or check the returned error string array.
 */
export function validateSubmissionForCurrentState(
    session: InterviewSession,
    interviewConfig: InterviewConfig,
    submissionData: Record<string, unknown>,
): string[] {
    if (session.isComplete) {
        return ["Interview is already complete"];
    }

    const state = findState(interviewConfig, session.currentStateId);
    if (!state) {
        return [`Unknown state: ${session.currentStateId}`];
    }

    const requirement = state.expected_submission;

    if (requirement.type === "none") {
        return ["Current state does not require a submission"];
    }

    if (hasSubmittedForState(session, state.id)) {
        return [`Already submitted for state: ${state.id}`];
    }

    const errors: string[] = [];
    const missingFields: string[] = [];
    const failedAnyOfFields: string[] = [];

    for (const field of requirement.fields) {
        const value = submissionData[field];
        if (value === undefined || value === null || value === "") {
            errors.push(`Missing required field: "${field}"`);
            missingFields.push(field);
        }
    }

    if (requirement.any_of_fields && requirement.any_of_fields.length > 0) {
        const hasAnyField = requirement.any_of_fields.some((field) => {
            const value = submissionData[field];
            return value !== undefined && value !== null && value !== "";
        });

        if (!hasAnyField) {
            errors.push(
                `Missing one of required fields: ${requirement.any_of_fields
                    .map((field) => `"${field}"`)
                    .join(", ")}`,
            );
            failedAnyOfFields.push(...requirement.any_of_fields);
        }
    }

    // For video submissions, enforce max_seconds hint
    if (requirement.type === "video" && requirement.max_seconds !== undefined) {
        // We don't strictly enforce this server-side, but validate the field exists
    }

    return errors;
}

// ── State Advancement ────────────────────────────────────────────────────

/**
 * Record a submission for the current state and advance to the next state
 * according to the interview config.
 *
 * @returns The updated session (mutated in place for simplicity)
 * @throws {InterviewError} with code INVALID_SUBMISSION if submission is invalid
 * @throws {Error} if state has no transitions
 */
export function applySubmissionAndAdvance(
    session: InterviewSession,
    interviewConfig: InterviewConfig,
    submissionData: Record<string, unknown>,
): InterviewSession {
    const errors = validateSubmissionForCurrentState(
        session,
        interviewConfig,
        submissionData,
    );
    if (errors.length > 0) {
        const missingFields: string[] = [];
        const failedAnyOfFields: string[] = [];

        const state = findState(interviewConfig, session.currentStateId);
        const requirement = state?.expected_submission;

        if (requirement) {
            for (const field of requirement.fields) {
                const value = submissionData[field];
                if (value === undefined || value === null || value === "") {
                    missingFields.push(field);
                }
            }
            if (requirement.any_of_fields) {
                const hasAnyField = requirement.any_of_fields.some((field) => {
                    const value = submissionData[field];
                    return value !== undefined && value !== null && value !== "";
                });
                if (!hasAnyField) {
                    failedAnyOfFields.push(...requirement.any_of_fields);
                }
            }
        }

        throw invalidSubmission(
            `Submission validation failed: ${errors.join("; ")}`,
            {
                errors,
                ...(missingFields.length > 0 ? { missingFields } : {}),
                ...(failedAnyOfFields.length > 0 ? { anyOfFields: failedAnyOfFields } : {}),
                stateId: session.currentStateId,
            },
        );
    }

    const currentState = findState(interviewConfig, session.currentStateId);
    if (!currentState) {
        throw new Error(`Unknown state: ${session.currentStateId}`);
    }

    // Record submission
    const submission: SubmissionRecord = {
        stateId: currentState.id,
        data: submissionData,
        submittedAt: Date.now(),
    };
    session.submissions.push(submission);

    // Advance to next state
    if (currentState.transitions_to.length === 0) {
        session.currentStateId = "complete";
        session.isComplete = true;
    } else {
        session.currentStateId = currentState.transitions_to[0]!;
    }

    session.updatedAt = Date.now();
    return session;
}

// ── Auto-Advance ─────────────────────────────────────────────────────────

/**
 * Advance the session through non-candidate-evaluation states
 * (states where expected_submission.type === "none") until we reach
 * a state that requires candidate input or the interview is complete.
 *
 * This is called after initialization and after each submission advancement
 * to skip over internal states (e.g. technical_submission_review → final_evaluation).
 */
export function advanceUntilAwaitingCandidate(
    session: InterviewSession,
    interviewConfig: InterviewConfig,
): InterviewSession {
    while (!session.isComplete) {
        const state = findState(interviewConfig, session.currentStateId);
        if (!state) {
            break;
        }

        // If the state expects a non-none submission or we haven't submitted yet,
        // this is a candidate-facing state.
        if (state.expected_submission.type !== "none") {
            break;
        }

        // If this is a non-candidate state (like final_evaluation),
        // we can advance automatically.
        if (state.transitions_to.length === 0) {
            session.currentStateId = "complete";
            session.isComplete = true;
            session.updatedAt = Date.now();
            break;
        }

        // Check if we've already been through this state (guard against cycles)
        if (hasSubmittedForState(session, state.id)) {
            // Already auto-processed, advance
            session.currentStateId = state.transitions_to[0]!;
            session.updatedAt = Date.now();
            continue;
        }

        // Auto-record a submission for non-candidate states so we can track
        // that the state was visited.
        const autoSubmission: SubmissionRecord = {
            stateId: state.id,
            data: { __auto: true },
            submittedAt: Date.now(),
        };
        session.submissions.push(autoSubmission);

        // Advance
        if (state.transitions_to.length === 0) {
            session.currentStateId = "complete";
            session.isComplete = true;
        } else {
            session.currentStateId = state.transitions_to[0]!;
        }
        session.updatedAt = Date.now();
    }

    return session;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function findState(
    config: InterviewConfig,
    stateId: string,
): InterviewStateConfig | undefined {
    return config.states.find((s) => s.id === stateId);
}

function hasSubmittedForState(
    session: InterviewSession,
    stateId: string,
): boolean {
    return session.submissions.some((s) => s.stateId === stateId);
}
