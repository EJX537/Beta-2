import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { InterviewPersistenceBridge } from "../persistence/bridge.js";
import type { LocalArtifactStore } from "../artifacts/store.js";
import type { InterviewSessionStore } from "../state/session-store.js";
import type OpenAI from "openai";
import type {
  AudioGradeResult,
  CodeSubmission,
  FinalEvaluation,
  InterviewConfig,
  InterviewSession,
  InterviewStateConfig,
  LocalRunnerOutput,
  ScoringCategory,
  TechnicalChallengeConfig,
} from "../types.js";
import {
  getInterviewStateView,
  getNextSubmissionRequirement,
  validateSubmissionForCurrentState,
} from "../state/fsm.js";
import { runLocalCodeSubmission } from "../skills/local-runner.js";
import { gradeAudioArtifact } from "../skills/audio-grader.js";
import { computeFinalEvaluation } from "../skills/final-evaluator.js";
import {
  wrongState,
  invalidSubmission,
  threadNotFound,
} from "../errors.js";
import { InterviewError } from "../errors.js";

// ── Types ───────────────────────────────────────────────────────────────

export interface CreateInterviewToolsOptions {
  technicalChallenge?:
    | TechnicalChallengeConfig
    | ((stateId: string) => TechnicalChallengeConfig | undefined);
  persistence?: InterviewPersistenceBridge;
  artifactStore?: LocalArtifactStore;
  /** OpenAI-compatible client for audio grading. If omitted, audio grading is skipped. */
  audioGradingClient?: OpenAI;
  /** Grading model identifier. Defaults to "google/gemini-3.5-flash". */
  audioGradingModel?: string;
}

interface ToolJsonResult {
  ok: boolean;
  code?: string;
  message: string;
  state?: ReturnType<typeof getInterviewStateView>;
  errors?: string[];
  details?: Record<string, unknown>;
  idempotent?: boolean;
  technical_result?: LocalRunnerOutput;
  audio_grade_result?: AudioGradeResult;
  audio_grade_error?: string;
}

/**
 * Clamp an accumulated category score to its configured max_score so that
 * mid-interview (per-turn) score displays never exceed the category ceiling.
 * The final evaluation already normalizes to [0,1], but the raw session.scores
 * map is shown to the candidate/agent between rounds and should stay in range.
 */
function clampScore(
  categories: Record<string, ScoringCategory> | undefined,
  category: string,
  value: number,
): number {
  const max = categories?.[category]?.max_score;
  if (typeof max === "number" && max > 0) {
    return Math.min(value, max);
  }
  return value;
}

// ── Tool Factory ─────────────────────────────────────────────────────────

/**
 * Create the custom interview tools. These tools are the sole runtime
 * mutation boundary for the interview FSM: HTTP routes and handleInteraction
 * transport candidate turns, while the pi agent advances state by calling
 * advance_interview_state with an expected state and idempotency key.
 */
export function createInterviewTools(
  store: InterviewSessionStore,
  config: InterviewConfig,
  options: CreateInterviewToolsOptions = {},
) {
  function getSession(threadId: string): InterviewSession {
    const session = store.get(threadId);
    if (!session) {
      throw threadNotFound(threadId);
    }
    return session;
  }

  function findState(stateId: string): InterviewStateConfig | undefined {
    return config.states.find((state) => state.id === stateId);
  }

  function hasIdempotencyKey(
    session: InterviewSession,
    idempotencyKey: string,
  ): boolean {
    return session.submissions.some(
      (submission) => submission.idempotencyKey === idempotencyKey,
    );
  }

  function getTechnicalChallenge(
    stateId: string,
  ): TechnicalChallengeConfig | undefined {
    if (typeof options.technicalChallenge === "function") {
      return options.technicalChallenge(stateId);
    }
    return options.technicalChallenge;
  }

  function persist(session: InterviewSession): void {
    store.set(session.threadId, session);
    options.persistence?.saveSnapshot(session, undefined, session.finalEvaluation);
  }

  function artifactRefsFromSubmission(
    submission: Record<string, unknown>,
  ): string[] {
    return Object.entries(submission)
      .filter(([key, value]) =>
        (key === "artifact_ref" || key.endsWith("_artifact_ref")) &&
        typeof value === "string" &&
        value.length > 0,
      )
      .map(([, value]) => value as string);
  }

  function validateArtifactRefsForState(
    session: InterviewSession,
    state: InterviewStateConfig,
    submission: Record<string, unknown>,
  ): string[] {
    if (!options.artifactStore) {
      return [];
    }

    const errors: string[] = [];
    for (const ref of artifactRefsFromSubmission(submission)) {
      try {
        options.artifactStore.validateOwnership(ref, {
          companyId: session.companyId,
          jobId: session.jobId,
          threadId: session.threadId,
          stateId: state.id,
        });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return errors;
  }

  function jsonText(result: ToolJsonResult) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
      details: undefined,
    };
  }

  function assertExpectedState(
    session: InterviewSession,
    expectedStateId: string,
    idempotencyKey?: string,
  ): ToolJsonResult | null {
    if (session.currentStateId === expectedStateId) {
      return null;
    }

    if (idempotencyKey && hasIdempotencyKey(session, idempotencyKey)) {
      return {
        ok: true,
        idempotent: true,
        message: "State was already advanced for this idempotency key.",
        state: getInterviewStateView(session, config, session.finalEvaluation),
      };
    }

    // WRONG_STATE — throw structured InterviewError
    throw wrongState(expectedStateId, session.currentStateId);
  }

  function advanceOneTransition(
    session: InterviewSession,
    state: InterviewStateConfig,
  ): void {
    if (state.transitions_to.length === 0) {
      session.currentStateId = "complete";
      session.isComplete = true;
      session.updatedAt = Date.now();
      return;
    }

    const nextStateId = state.transitions_to[0]!;
    session.currentStateId = nextStateId;
    session.isComplete = nextStateId === "complete";
    session.updatedAt = Date.now();
  }

  async function prepareSubmissionForAdvance(
    session: InterviewSession,
    state: InterviewStateConfig,
    submission: Record<string, unknown> | undefined,
  ): Promise<{
    ok: true;
    data: Record<string, unknown>;
    technicalResult?: LocalRunnerOutput;
  } | {
    ok: false;
    result: ToolJsonResult;
  }> {
    if (state.expected_submission.type === "none") {
      return {
        ok: true,
        data: submission ?? { __auto: true },
      };
    }

    const submissionData = submission ?? {};
    const errors = validateSubmissionForCurrentState(session, config, submissionData);
    const artifactErrors = validateArtifactRefsForState(
      session,
      state,
      submissionData,
    );
    const allErrors = [...errors, ...artifactErrors];
    if (allErrors.length > 0) {
      // Throw structured InterviewError instead of returning a ToolJsonResult
      const missingFields: string[] = [];
      const failedAnyOfFields: string[] = [];
      const requirement = state.expected_submission;

      if (requirement) {
        for (const field of requirement.fields) {
          const value = submissionData[field];
          if (value === undefined || value === null || value === "") {
            missingFields.push(field);
          }
        }
        if (requirement.any_of_fields) {
          const hasAnyField = requirement.any_of_fields.some((f) => {
            const val = submissionData[f];
            return val !== undefined && val !== null && val !== "";
          });
          if (!hasAnyField) {
            failedAnyOfFields.push(...requirement.any_of_fields);
          }
        }
      }

      throw invalidSubmission("Submission validation failed.", {
        errors: allErrors,
        ...(missingFields.length > 0 ? { missingFields } : {}),
        ...(failedAnyOfFields.length > 0 ? { anyOfFields: failedAnyOfFields } : {}),
        stateId: state.id,
      });
    }

    if (state.expected_submission.type !== "code") {
      return { ok: true, data: submissionData };
    }

    const challenge = getTechnicalChallenge(state.id);
    if (!challenge) {
      return { ok: true, data: submissionData };
    }

    try {
      let files = submissionData["files"] as CodeSubmission["files"] | undefined;
      const codeArtifactRef =
        typeof submissionData["code_artifact_ref"] === "string"
          ? submissionData["code_artifact_ref"]
          : undefined;

      if (!files && codeArtifactRef) {
        if (!options.artifactStore) {
          throw new Error("code_artifact_ref requires a configured artifact store");
        }
        files = options.artifactStore.readCodeFiles(codeArtifactRef);
      }

      if (!files) {
        throw new Error("Code submission must include files or code_artifact_ref");
      }

      const codeSubmission: CodeSubmission = {
        language: String(submissionData["language"]),
        files,
        entrypoint:
          typeof submissionData["entrypoint"] === "string"
            ? submissionData["entrypoint"]
            : undefined,
      };
      const technicalResult = await runLocalCodeSubmission(codeSubmission, challenge);
      const data: Record<string, unknown> = {
        ...submissionData,
        technical_result: technicalResult,
      };

      for (const [category, weight] of Object.entries(state.score_weights)) {
        session.scores[category] = clampScore(
          config.scoring_categories,
          category,
          (session.scores[category] ?? 0) + technicalResult.score * weight,
        );
      }

      if (!technicalResult.passed && technicalResult.exitCode !== 0) {
        data["__runner_failed"] = true;
      }

      return { ok: true, data, technicalResult };
    } catch (error) {
      return {
        ok: false,
        result: {
          ok: false,
          code: "RUNNER_FAILED",
          message: error instanceof Error ? error.message : String(error),
          state: getInterviewStateView(session, config, session.finalEvaluation),
        },
      };
    }
  }

  async function gradeAudioIfNeeded(
    session: InterviewSession,
    state: InterviewStateConfig,
    data: Record<string, unknown>,
  ): Promise<{ error?: string; result?: AudioGradeResult }> {
    if (!options.audioGradingClient) {
      return {};
    }

    const isVideoState =
      state.expected_submission.type === "video";
    if (!isVideoState) {
      return {};
    }

    const audioArtifactRef =
      typeof data["audio_artifact_ref"] === "string"
        ? (data["audio_artifact_ref"] as string)
        : undefined;

    if (!audioArtifactRef) {
      return {};
    }

    const rubric = state.audioRubric;
    if (!rubric || rubric.categories.length === 0) {
      return {};
    }

    if (!options.artifactStore) {
      return {
        error:
          "Audio grading requires an artifact store but none is configured.",
      };
    }

    try {
      const gradeResult = await gradeAudioArtifact({
        artifactRef: audioArtifactRef,
        questionText: state.agent_instruction,
        rubric,
        artifactStore: options.artifactStore,
        client: options.audioGradingClient,
        model: options.audioGradingModel ??
          process.env["GMI_GRADING_MODEL"] ??
          "google/gemini-3.5-flash",
      });

      // Map grade result onto session scores using score_weights
      for (const [category, weight] of Object.entries(state.score_weights)) {
        const catDetail = gradeResult.details?.[category];
        if (catDetail && typeof catDetail === "object") {
          const detail = catDetail as Record<string, unknown>;
          const catScore = Number(detail["score"]) ?? 0;
          session.scores[category] = clampScore(
            config.scoring_categories,
            category,
            (session.scores[category] ?? 0) + catScore * weight,
          );
        } else {
          // Fall back to distributing the overall score proportionally
          const catMax =
            rubric.categories.find((c) => c.label === category)?.maxScore ??
            gradeResult.maxScore;
          const proportion =
            gradeResult.maxScore > 0
              ? gradeResult.score / gradeResult.maxScore
              : 0;
          session.scores[category] = clampScore(
            config.scoring_categories,
            category,
            (session.scores[category] ?? 0) + catMax * proportion * weight,
          );
        }
      }

      return { result: gradeResult };
    } catch (error) {
      return {
        error: `Audio grading failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
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
      getSession(params.thread_id);
      return jsonText({
        ok: true,
        message: `Loaded interview config for company "${config.company_id}", job "${config.job_id}" with ${config.states.length} states.`,
      });
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
      return jsonText({
        ok: true,
        message: "Current interview state loaded.",
        state: getInterviewStateView(session, config, session.finalEvaluation),
      });
    },
  });

  // ── validate_submission ────────────────────────────────────────────────

  const validateTool = defineTool({
    name: "validate_submission",
    label: "Validate Submission",
    description:
      "Validate a candidate submission against the expected current state. Does not advance state.",
    parameters: Type.Object({
      thread_id: Type.String({ description: "Interview thread ID" }),
      expected_state_id: Type.String({
        description: "State id the agent believes is current",
      }),
      submission: Type.Record(Type.String(), Type.Unknown(), {
        description: "The candidate's submission data",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      const session = getSession(params.thread_id);

      try {
        assertExpectedState(
          session,
          params.expected_state_id,
        );
      } catch (error) {
        if (error instanceof InterviewError) {
          return jsonText({
            ok: false,
            code: error.code,
            message: error.message,
            state: getInterviewStateView(session, config, session.finalEvaluation),
          });
        }
        throw error;
      }

      const submission = params.submission as Record<string, unknown>;
      const state = findState(session.currentStateId);
      const errors = validateSubmissionForCurrentState(
        session,
        config,
        submission,
      );
      const artifactErrors = state
        ? validateArtifactRefsForState(session, state, submission)
        : [`Unknown state: ${session.currentStateId}`];
      const allErrors = [...errors, ...artifactErrors];
      return jsonText({
        ok: allErrors.length === 0,
        code: allErrors.length === 0 ? undefined : "INVALID_SUBMISSION",
        message: allErrors.length === 0
          ? "Submission is valid."
          : "Submission validation failed.",
        errors: allErrors.length === 0 ? undefined : allErrors,
        state: getInterviewStateView(session, config, session.finalEvaluation),
      });
    },
  });

  // ── advance_state ──────────────────────────────────────────────────────

  const advanceTool = defineTool({
    name: "advance_interview_state",
    label: "Advance Interview State",
    description:
      "Atomically record the current state's submission and advance exactly one FSM transition. This is the only tool that advances interview state.",
    parameters: Type.Object({
      thread_id: Type.String({ description: "Interview thread ID" }),
      expected_state_id: Type.String({
        description: "State id the agent believes is current",
      }),
      idempotency_key: Type.String({
        description: "Stable key for this turn/state advancement",
      }),
      submission: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description:
            "Candidate submission data. Omit for internal states whose expected_submission.type is none.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      let session = getSession(params.thread_id);
      const idempotencyKey = params.idempotency_key;

      try {
        assertExpectedState(
          session,
          params.expected_state_id,
          idempotencyKey,
        );
      } catch (error) {
        // If it's an InterviewError (e.g. WRONG_STATE), return as json result
        if (error instanceof InterviewError) {
          return jsonText({
            ok: false,
            code: error.code,
            message: error.message,
            state: getInterviewStateView(session, config, session.finalEvaluation),
          });
        }
        throw error;
      }

      if (hasIdempotencyKey(session, idempotencyKey)) {
        return jsonText({
          ok: true,
          idempotent: true,
          message: "State was already advanced for this idempotency key.",
          state: getInterviewStateView(session, config, session.finalEvaluation),
        });
      }

      const state = findState(session.currentStateId);
      if (!state) {
        return jsonText({
          ok: false,
          code: "UNKNOWN_STATE",
          message: `Unknown state: ${session.currentStateId}`,
        });
      }

      let prepared;
      try {
        prepared = await prepareSubmissionForAdvance(
          session,
          state,
          params.submission as Record<string, unknown> | undefined,
        );
      } catch (error) {
        // INVALID_SUBMISSION thrown by prepareSubmissionForAdvance as InterviewError
        if (error instanceof InterviewError) {
          return jsonText({
            ok: false,
            code: error.code,
            message: error.message,
            details: error.details,
            state: getInterviewStateView(session, config, session.finalEvaluation),
          });
        }
        throw error;
      }
      if (!prepared.ok) {
        return jsonText(prepared.result);
      }

      session.submissions.push({
        stateId: state.id,
        data: prepared.data,
        submittedAt: Date.now(),
        idempotencyKey,
      });

      // Run audio grading if this is a video state with a rubric
      const audioGrade = await gradeAudioIfNeeded(session, state, prepared.data);

      advanceOneTransition(session, state);

      // Auto-compute final evaluation when entering a terminal state
      if (session.currentStateId === "complete" || session.isComplete) {
        if (!session.finalEvaluation) {
          session.finalEvaluation = computeFinalEvaluation(session, config);
        }
      }

      persist(session);

      return jsonText({
        ok: true,
        message: audioGrade.error
          ? `State advanced with audio grading issue: ${audioGrade.error}`
          : "State advanced successfully.",
        state: getInterviewStateView(session, config, session.finalEvaluation),
        technical_result: prepared.technicalResult,
        audio_grade_result: audioGrade.result,
        audio_grade_error: audioGrade.error,
      });
    },
  });

  // ── record_final_evaluation ────────────────────────────────────────────

  const recordFinalEvaluationTool = defineTool({
    name: "record_final_evaluation",
    label: "Record Final Evaluation",
    description:
      "Compute or record the final scorecard. If no evaluation data is provided, computes one deterministically.",
    parameters: Type.Object({
      thread_id: Type.String({ description: "Interview thread ID" }),
      expected_state_id: Type.String({
        description: "Must be the current final evaluation state id",
      }),
      idempotency_key: Type.String({
        description: "Stable key for recording this evaluation",
      }),
      evaluation: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description:
            "Optional final evaluation scorecard JSON. If omitted, computes deterministically from scores.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      const session = getSession(params.thread_id);

      try {
        assertExpectedState(
          session,
          params.expected_state_id,
        );
      } catch (error) {
        if (error instanceof InterviewError) {
          return jsonText({
            ok: false,
            code: error.code,
            message: error.message,
            state: getInterviewStateView(session, config, session.finalEvaluation),
          });
        }
        throw error;
      }

      if (!session.finalEvaluation) {
        if (params.evaluation) {
          session.finalEvaluation =
            params.evaluation as unknown as FinalEvaluation;
        } else {
          session.finalEvaluation = computeFinalEvaluation(session, config);
        }
      }

      persist(session);
      return jsonText({
        ok: true,
        message: "Final evaluation recorded.",
        state: getInterviewStateView(session, config, session.finalEvaluation),
      });
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
      return jsonText({
        ok: true,
        message: requirement
          ? "Next submission requirement loaded."
          : "No submission required at this time.",
        state: getInterviewStateView(session, config, session.finalEvaluation),
      });
    },
  });

  return [
    loadConfigTool,
    getStateTool,
    validateTool,
    advanceTool,
    recordFinalEvaluationTool,
    checkNextTool,
  ];
}
