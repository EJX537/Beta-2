import { describe, it, expect } from "vitest";
import {
  initializeInterviewSession,
  getInterviewStateView,
  getNextSubmissionRequirement,
  validateSubmissionForCurrentState,
  applySubmissionAndAdvance,
  advanceUntilAwaitingCandidate,
} from "../src/agents/interview/state/fsm.js";
import type {
  InterviewConfig,
  InterviewStateConfig,
  InterviewSession,
} from "../src/agents/interview/types.js";

// ── Shared Fixture ───────────────────────────────────────────────────────

const sampleConfig: InterviewConfig = {
  company_id: "demo-company",
  job_id: "software-developer",
  version: "1.0.0",
  states: [
    {
      id: "intro",
      label: "Introduction",
      agent_instruction: "Greet the candidate.",
      expected_submission: { type: "none", fields: [] },
      transitions_to: ["video_question_1"],
      score_weights: {},
    },
    {
      id: "video_question_1",
      label: "Video Question 1",
      agent_instruction: "Ask about background.",
      expected_submission: {
        type: "video",
        fields: [],
        any_of_fields: ["audio_url", "transcript"],
        optional_fields: ["video_url"],
        max_seconds: 30,
      },
      transitions_to: ["technical_challenge"],
      score_weights: { communication: 0.5, role_fit: 0.5 },
    },
    {
      id: "technical_challenge",
      label: "Technical Challenge",
      agent_instruction: "Present coding challenge.",
      expected_submission: {
        type: "code",
        fields: ["language", "files", "entrypoint"],
      },
      transitions_to: ["complete"],
      score_weights: { technical_depth: 0.7, problem_solving: 0.3 },
    },
    {
      id: "complete",
      label: "Complete",
      agent_instruction: "Wrap up.",
      expected_submission: { type: "none", fields: [] },
      transitions_to: [],
      score_weights: {},
    },
  ],
  scoring_categories: {
    communication: { label: "Communication", max_score: 10 },
    technical_depth: { label: "Technical Depth", max_score: 10 },
    problem_solving: { label: "Problem Solving", max_score: 10 },
    role_fit: { label: "Role Fit", max_score: 10 },
  },
  recommendation_levels: ["strong_yes", "yes", "mixed", "no"],
};

// ── Tests ────────────────────────────────────────────────────────────────

describe("initializeInterviewSession", () => {
  it("creates a session at the first state", () => {
    const session = initializeInterviewSession({
      threadId: "thread-1",
      companyId: "demo-company",
      jobId: "software-developer",
      interviewConfig: sampleConfig,
    });

    expect(session.threadId).toBe("thread-1");
    expect(session.currentStateId).toBe("intro");
    expect(session.isComplete).toBe(false);
    expect(session.submissions).toEqual([]);
    expect(session.createdAt).toBeGreaterThan(0);
  });

  it("throws if config has no states", () => {
    const emptyConfig: InterviewConfig = {
      ...sampleConfig,
      states: [],
    };
    expect(() =>
      initializeInterviewSession({
        threadId: "t",
        companyId: "c",
        jobId: "j",
        interviewConfig: emptyConfig,
      }),
    ).toThrow("has no states");
  });

  it("accepts an optional candidate context", () => {
    const session = initializeInterviewSession({
      threadId: "t",
      companyId: "c",
      jobId: "j",
      interviewConfig: sampleConfig,
      candidateContext: {
        candidateId: "candidate-1",
        profile: { name: "Alice" },
        source: "screening",
      },
    });
    expect(session.candidateContext?.candidateId).toBe("candidate-1");
  });
});

describe("getInterviewStateView", () => {
  it("returns a read-only projection of the session", () => {
    const session = initializeInterviewSession({
      threadId: "t-1",
      companyId: "demo-company",
      jobId: "software-developer",
      interviewConfig: sampleConfig,
    });

    const view = getInterviewStateView(session, sampleConfig);
    expect(view.threadId).toBe("t-1");
    expect(view.currentStateId).toBe("intro");
    expect(view.isComplete).toBe(false);
    // intro state has submission type "none", so nextSubmission is null
    expect(view.nextSubmission).toBeNull();
  });
});

describe("getNextSubmissionRequirement", () => {
  it("returns null for non-submission states", () => {
    const session = initializeInterviewSession({
      threadId: "t",
      companyId: "c",
      jobId: "j",
      interviewConfig: sampleConfig,
    });
    // intro has type "none"
    expect(getNextSubmissionRequirement(session, sampleConfig)).toBeNull();
  });

  it("returns the submission requirement for states that expect input", () => {
    // Start at video_question_1
    const session: InterviewSession = {
      threadId: "t",
      companyId: "c",
      jobId: "j",
      currentStateId: "video_question_1",
      submissions: [],
      scores: {},
      isComplete: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const req = getNextSubmissionRequirement(session, sampleConfig);
    expect(req).not.toBeNull();
    expect(req!.type).toBe("video");
    expect(req!.fields).toEqual([]);
    expect(req!.any_of_fields).toEqual(["audio_url", "transcript"]);
    expect(req!.optional_fields).toEqual(["video_url"]);
    expect(req!.max_seconds).toBe(30);
  });

  it("returns null when already submitted for the current state", () => {
    const session: InterviewSession = {
      threadId: "t",
      companyId: "c",
      jobId: "j",
      currentStateId: "video_question_1",
      submissions: [
        {
          stateId: "video_question_1",
          data: { transcript: "..." },
          submittedAt: Date.now(),
        },
      ],
      scores: {},
      isComplete: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    expect(getNextSubmissionRequirement(session, sampleConfig)).toBeNull();
  });

  it("returns null when interview is complete", () => {
    const session: InterviewSession = {
      threadId: "t",
      companyId: "c",
      jobId: "j",
      currentStateId: "complete",
      submissions: [],
      scores: {},
      isComplete: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    expect(getNextSubmissionRequirement(session, sampleConfig)).toBeNull();
  });
});

describe("validateSubmissionForCurrentState", () => {
  it("returns errors when video submission has neither audio nor transcript", () => {
    const session: InterviewSession = {
      threadId: "t",
      companyId: "c",
      jobId: "j",
      currentStateId: "video_question_1",
      submissions: [],
      scores: {},
      isComplete: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const errors = validateSubmissionForCurrentState(session, sampleConfig, {
      video_url: "https://example.com/video",
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("audio_url");
    expect(errors[0]).toContain("transcript");
  });

  it("returns no errors for valid submission", () => {
    const session: InterviewSession = {
      threadId: "t",
      companyId: "c",
      jobId: "j",
      currentStateId: "video_question_1",
      submissions: [],
      scores: {},
      isComplete: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const errors = validateSubmissionForCurrentState(session, sampleConfig, {
      transcript: "Hello, I am a candidate...",
    });
    expect(errors).toEqual([]);
  });

  it("returns error if already submitted for this state", () => {
    const session: InterviewSession = {
      threadId: "t",
      companyId: "c",
      jobId: "j",
      currentStateId: "video_question_1",
      submissions: [
        {
          stateId: "video_question_1",
          data: { audio_url: "https://example.com/audio.wav" },
          submittedAt: Date.now(),
        },
      ],
      scores: {},
      isComplete: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const errors = validateSubmissionForCurrentState(session, sampleConfig, {
      transcript: "new",
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("Already submitted");
  });
});

describe("applySubmissionAndAdvance", () => {
  it("records the submission and advances to the next state", () => {
    const session = initializeInterviewSession({
      threadId: "t",
      companyId: "c",
      jobId: "j",
      interviewConfig: sampleConfig,
    });

    // Must advance past intro (non-submission state) first
    advanceUntilAwaitingCandidate(session, sampleConfig);
    expect(session.currentStateId).toBe("video_question_1");

    applySubmissionAndAdvance(session, sampleConfig, {
      audio_url: "https://example.com/audio.wav",
    });

    // Intro auto-submission + video_question_1 submission
    expect(session.submissions.length).toBe(2);
    expect(session.submissions.some((s) => s.stateId === "video_question_1")).toBe(
      true,
    );
    // After video_question_1, it should go to technical_challenge
    expect(session.currentStateId).toBe("technical_challenge");
  });

  it("marks interview complete when transitioning from final state", () => {
    const session: InterviewSession = {
      threadId: "t",
      companyId: "c",
      jobId: "j",
      currentStateId: "technical_challenge",
      submissions: [],
      scores: {},
      isComplete: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    applySubmissionAndAdvance(session, sampleConfig, {
      language: "typescript",
      files: { "solution.ts": "console.log('hello')" },
      entrypoint: "solution.ts",
    });

    // technical_challenge -> complete
    expect(session.currentStateId).toBe("complete");
    expect(session.isComplete).toBe(false); // not yet, need advanceUntilAwaitingCandidate

    advanceUntilAwaitingCandidate(session, sampleConfig);
    expect(session.isComplete).toBe(true);
  });

  it("throws when submission is invalid", () => {
    const session: InterviewSession = {
      threadId: "t",
      companyId: "c",
      jobId: "j",
      currentStateId: "video_question_1",
      submissions: [],
      scores: {},
      isComplete: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    expect(() =>
      applySubmissionAndAdvance(session, sampleConfig, {}),
    ).toThrow("Submission validation failed");
  });
});

describe("advanceUntilAwaitingCandidate", () => {
  it("skips non-submission states", () => {
    const session = initializeInterviewSession({
      threadId: "t",
      companyId: "c",
      jobId: "j",
      interviewConfig: sampleConfig,
    });

    // Starts at "intro" (type: none) — should skip to video_question_1
    advanceUntilAwaitingCandidate(session, sampleConfig);
    expect(session.currentStateId).toBe("video_question_1");
    expect(session.submissions.length).toBeGreaterThanOrEqual(1);
  });
});
