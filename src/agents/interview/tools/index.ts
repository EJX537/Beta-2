import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { InterviewSessionStore } from "../state/session-store.js";
import type { InterviewConfig, InterviewSession } from "../types.js";
import {
  getInterviewStateView,
  getNextSubmissionRequirement,
  validateSubmissionForCurrentState,
  applySubmissionAndAdvance,
  advanceUntilAwaitingCandidate,
} from "../state/fsm.js";

// ── Tool Factory ─────────────────────────────────────────────────────────

/**
 * Create the set of custom interview tools, wired to a session store and
 * interview config via closures.
 */
export function createInterviewTools(
  store: InterviewSessionStore,
  config: InterviewConfig,
) {
  // Helper to find a session or throw
  function getSession(threadId: string): InterviewSession {
    const session = store.get(threadId);
    if (!session) {
      throw new Error(`No interview session found for thread: ${threadId}`);
    }
    return session;
  }

  // ── load_config ────────────────────────────────────────────────────────

  const loadConfigTool = defineTool({
    name: "load_interview_config",
    label: "Load Interview Config",
    description:
      "Load the company and job configuration for the current interview.",
    parameters: Type.Object({
      thread_id: Type.String({ description: "Interview thread ID" }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      // Session must exist (validates thread_id)
      getSession(params.thread_id);
      return {
        content: [
          {
            type: "text" as const,
            text: `Loaded interview config for company "${config.company_id}", job "${config.job_id}" with ${config.states.length} states.`,
          },
        ],
        details: undefined,
      };
    },
  });

  // ── get_state ──────────────────────────────────────────────────────────

  const getStateTool = defineTool({
    name: "get_current_interview_state",
    label: "Get Current Interview State",
    description:
      "Get the current interview state, including submission requirements.",
    parameters: Type.Object({
      thread_id: Type.String({ description: "Interview thread ID" }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      const session = getSession(params.thread_id);
      const view = getInterviewStateView(session, config);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(view, null, 2),
          },
        ],
        details: undefined,
      };
    },
  });

  // ── validate_submission ────────────────────────────────────────────────

  const validateTool = defineTool({
    name: "validate_submission",
    label: "Validate Submission",
    description:
      "Validate a candidate submission against current state requirements. Does not advance state.",
    parameters: Type.Object({
      thread_id: Type.String({ description: "Interview thread ID" }),
      submission: Type.Record(Type.String(), Type.Unknown(), {
        description: "The candidate's submission data",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      const session = getSession(params.thread_id);
      const errors = validateSubmissionForCurrentState(
        session,
        config,
        params.submission as Record<string, unknown>,
      );
      const valid = errors.length === 0;
      return {
        content: [
          {
            type: "text" as const,
            text: valid
              ? "Submission is valid."
              : `Submission has errors:\n${errors.map((e) => `- ${e}`).join("\n")}`,
          },
        ],
        details: undefined,
      };
    },
  });

  // ── advance_state ──────────────────────────────────────────────────────

  const advanceTool = defineTool({
    name: "advance_interview_state",
    label: "Advance Interview State",
    description:
      "Record the candidate's submission for the current state and advance to the next interview state. Use this after the candidate has provided their response.",
    parameters: Type.Object({
      thread_id: Type.String({ description: "Interview thread ID" }),
      submission: Type.Record(Type.String(), Type.Unknown(), {
        description: "The candidate's submission data to record",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      const session = getSession(params.thread_id);
      const submissionData = params.submission as Record<string, unknown>;

      applySubmissionAndAdvance(session, config, submissionData);
      advanceUntilAwaitingCandidate(session, config);

      store.set(params.thread_id, session);

      const view = getInterviewStateView(session, config);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "State advanced successfully.",
                state: view,
              },
              null,
              2,
            ),
          },
        ],
        details: undefined,
      };
    },
  });

  // ── record_submission ──────────────────────────────────────────────────

  const recordTool = defineTool({
    name: "record_submission",
    label: "Record Submission",
    description:
      "Record a candidate submission without advancing state. Use this for follow-up questions within the same state.",
    parameters: Type.Object({
      thread_id: Type.String({ description: "Interview thread ID" }),
      data: Type.Record(Type.String(), Type.Unknown(), {
        description: "Submission data to record",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      const session = getSession(params.thread_id);
      session.submissions.push({
        stateId: session.currentStateId,
        data: params.data as Record<string, unknown>,
        submittedAt: Date.now(),
      });
      store.set(params.thread_id, session);
      return {
        content: [
          {
            type: "text" as const,
            text: "Submission recorded.",
          },
        ],
        details: undefined,
      };
    },
  });

  // ── check_next_requirement ─────────────────────────────────────────────

  const checkNextTool = defineTool({
    name: "check_next_submission_requirement",
    label: "Check Next Submission Requirement",
    description:
      "Check what the candidate needs to submit next. Returns null if no submission is required.",
    parameters: Type.Object({
      thread_id: Type.String({ description: "Interview thread ID" }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      const session = getSession(params.thread_id);
      const requirement = getNextSubmissionRequirement(session, config);
      return {
        content: [
          {
            type: "text" as const,
            text: requirement
              ? JSON.stringify(requirement, null, 2)
              : "No submission required at this time.",
          },
        ],
        details: undefined,
      };
    },
  });

  return [
    loadConfigTool,
    getStateTool,
    validateTool,
    advanceTool,
    recordTool,
    checkNextTool,
  ];
}
