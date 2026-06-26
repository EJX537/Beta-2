import { describe, it, expect } from "vitest";
import {
  createInterviewJitContext,
  createInterviewResourceLoader,
} from "../src/agents/interview/resource-loader.js";
import type {
  InterviewConfigBundle,
  InterviewSession,
  InterviewStateConfig,
  SubmissionRequirement,
} from "../src/agents/interview/types.js";

// ── Shared Fixtures ─────────────────────────────────────────────────────

const sampleCurrentState: InterviewStateConfig = {
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
};

const technicalChallengeState: InterviewStateConfig = {
  id: "technical_challenge",
  label: "Technical Challenge",
  agent_instruction: "Present coding challenge.",
  expected_submission: {
    type: "code",
    fields: ["language", "files", "entrypoint"],
  },
  transitions_to: ["complete"],
  score_weights: { technical_depth: 0.7, problem_solving: 0.3 },
};

const sampleConfig: InterviewConfigBundle = {
  company: {
    id: "demo-company",
    name: "Demo Company",
    description: "A demo company",
    values: ["innovation"],
    hiring_style: "standard",
    agent_tone: "professional",
  },
  job: {
    id: "software-developer",
    title: "Software Developer",
    company_id: "demo-company",
    level: "mid",
    description: "Build cool stuff",
    responsibilities: ["code"],
    required_skills: ["TypeScript"],
    preferred_skills: ["Rust"],
    evaluation_priorities: ["technical_depth"],
  },
  interview: {
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
      sampleCurrentState,
      technicalChallengeState,
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
  },
};

function createSampleSession(overrides?: Partial<InterviewSession>): InterviewSession {
  return {
    threadId: "thread-1",
    companyId: "demo-company",
    jobId: "software-developer",
    currentStateId: "video_question_1",
    submissions: [],
    scores: {},
    isComplete: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

const videoSubmissionRequirement: SubmissionRequirement = {
  type: "video",
  fields: [],
  any_of_fields: ["audio_url", "transcript"],
  optional_fields: ["video_url"],
  max_seconds: 30,
};

const codeSubmissionRequirement: SubmissionRequirement = {
  type: "code",
  fields: ["language", "files", "entrypoint"],
};

// ── Tests for createInterviewJitContext ─────────────────────────────────

describe("createInterviewJitContext", () => {
  it("includes current state, next submission, and sequence", () => {
    const session = createSampleSession();
    const context = createInterviewJitContext({
      config: sampleConfig,
      session,
      currentState: sampleCurrentState,
      nextSubmission: videoSubmissionRequirement,
    });

    expect(context).toContain("Thread ID: thread-1");
    expect(context).toContain("Demo Company");
    expect(context).toContain("Software Developer");
    expect(context).toContain("Allowed FSM sequence");
    expect(context).toContain("Current state: video_question_1 (Video Question 1)");
    expect(context).toContain("Required next submission:");
    expect(context).toContain("audio_url");
    expect(context).toContain("transcript");
    expect(context).toContain("Hard rule: Do NOT invent states");
    expect(context).toContain("Hard rule: Ask only for");
  });

  it("includes technical challenge details when current state expects code", () => {
    const configWithTech: InterviewConfigBundle = {
      ...sampleConfig,
      technicalChallenge: {
        title: "FizzBuzz",
        prompt: "Write a FizzBuzz function",
        accepted_languages: ["typescript", "python"],
        scoring_rubric: [{ criterion: "correctness", weight: 1 }],
      },
    };

    const session = createSampleSession({ currentStateId: "technical_challenge" });
    const context = createInterviewJitContext({
      config: configWithTech,
      session,
      currentState: technicalChallengeState,
      nextSubmission: codeSubmissionRequirement,
    });

    expect(context).toContain("FizzBuzz");
    expect(context).toContain("Write a FizzBuzz function");
    expect(context).toContain("typescript");
    expect(context).toContain("python");
    expect(context).toContain("Scoring rubric");
  });

  it("includes candidate context when available", () => {
    const session = createSampleSession({
      candidateContext: {
        candidateId: "cand-42",
        profile: { name: "Alice" },
        source: "linkedin",
      },
    });
    const context = createInterviewJitContext({
      config: sampleConfig,
      session,
      currentState: sampleCurrentState,
      nextSubmission: videoSubmissionRequirement,
    });

    expect(context).toContain("Candidate ID: cand-42");
    expect(context).toContain("Alice");
    expect(context).toContain("linkedin");
  });

  it("includes completed states and scores when present", () => {
    const session = createSampleSession({
      submissions: [
        { stateId: "intro", data: { __auto: true }, submittedAt: Date.now() },
      ],
      scores: { communication: 4, role_fit: 3 },
    });
    const context = createInterviewJitContext({
      config: sampleConfig,
      session,
      currentState: sampleCurrentState,
      nextSubmission: videoSubmissionRequirement,
    });

    expect(context).toContain("Completed states: intro");
    expect(context).toContain('{"communication":4,"role_fit":3}');
  });

  it("says no submission required when nextSubmission is null", () => {
    const session = createSampleSession();
    const context = createInterviewJitContext({
      config: sampleConfig,
      session,
      currentState: sampleCurrentState,
      nextSubmission: null,
    });

    expect(context).toContain("No candidate submission is currently required.");
  });

  it("includes pending submission, artifact refs, and tool-advancement instruction", () => {
    const session = createSampleSession();
    const context = createInterviewJitContext({
      config: sampleConfig,
      session,
      currentState: sampleCurrentState,
      nextSubmission: videoSubmissionRequirement,
      turnId: "turn-123",
      pendingSubmission: { transcript: "I built a distributed queue." },
      artifactRefs: [
        {
          uri: "interview-artifact://demo-company/software-developer/thread-1/audio-1",
          media_type: "audio/webm",
          field_hint: "audio_url",
        },
      ],
    });

    expect(context).toContain("Current turn idempotency seed: turn-123");
    expect(context).toContain("Pending candidate submission");
    expect(context).toContain("distributed queue");
    expect(context).toContain("advance_interview_state");
    expect(context).toContain("Pending artifact references");
    expect(context).toContain("interview-artifact://demo-company/software-developer/thread-1/audio-1");
  });
});

// ── Tests for createInterviewResourceLoader ─────────────────────────────

describe("createInterviewResourceLoader", () => {
  it("returns the interview-fsm skill", () => {
    const loader = createInterviewResourceLoader({
      systemPrompt: "test prompt",
    });

    const { skills } = loader.getSkills();
    expect(skills.length).toBe(1);
    expect(skills[0]!.name).toBe("interview-fsm");
    expect(skills[0]!.description).toContain("interview finite state machine");
  });

  it("returns a stable input-hook extension and empty prompts, themes, and agentsFiles", () => {
    const loader = createInterviewResourceLoader({
      systemPrompt: "test prompt",
    });

    const extensions = loader.getExtensions().extensions;
    expect(extensions).toHaveLength(1);
    expect(extensions[0]!.path).toBe("interview-context-input-hook");
    expect(extensions[0]!.handlers.has("input")).toBe(true);
    expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getThemes().themes).toEqual([]);
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
  });

  it("returns the static system prompt", () => {
    const loader = createInterviewResourceLoader({
      systemPrompt: "custom system prompt",
    });

    expect(loader.getSystemPrompt()).toBe("custom system prompt");
  });

  it("always returns empty append prompt (no dynamic system prompt manipulation)", () => {
    const loader = createInterviewResourceLoader({
      systemPrompt: "test",
    });

    // Provider caching requires stable system prompt — append must always be empty
    expect(loader.getAppendSystemPrompt()).toEqual([]);

    // Verify multiple calls also return empty (no closure mutation)
    expect(loader.getAppendSystemPrompt()).toEqual([]);
  });

  it("injects per-turn context through the input hook", async () => {
    const loader = createInterviewResourceLoader({
      systemPrompt: "test",
      getTurnContext: () => "current FSM context",
    });
    const extension = loader.getExtensions().extensions[0]!;
    const handler = extension.handlers.get("input")![0] as (
      event: { text: string; images?: unknown },
    ) => Promise<{ action: string; text?: string }>;

    const result = await handler({ text: "Candidate message: hello" });

    expect(result.action).toBe("transform");
    expect(result.text).toContain("current FSM context");
    expect(result.text).toContain("Candidate message: hello");
    expect(result.text).toContain("Respond for the current FSM state only");
  });

  it("does not inject context when no per-turn context exists", async () => {
    const loader = createInterviewResourceLoader({
      systemPrompt: "test",
      getTurnContext: () => "",
    });
    const extension = loader.getExtensions().extensions[0]!;
    const handler = extension.handlers.get("input")![0] as (
      event: { text: string; images?: unknown },
    ) => Promise<{ action: string; text?: string }>;

    const result = await handler({ text: "Candidate message: hello" });

    expect(result).toEqual({ action: "continue" });
  });

  it("reload and extendResources are no-ops", async () => {
    const loader = createInterviewResourceLoader({
      systemPrompt: "test",
    });

    await expect(loader.reload()).resolves.toBeUndefined();
    expect(() => loader.extendResources({})).not.toThrow();
  });
});
