import { describe, it, expect } from "vitest";
import { computeFinalEvaluation } from "../src/agents/interview/skills/final-evaluator.js";
import type {
  FinalEvaluation,
  InterviewConfig,
  InterviewSession,
} from "../src/agents/interview/types.js";

// ── Shared Fixtures ──────────────────────────────────────────────────────

const baseConfig: InterviewConfig = {
  company_id: "demo-company",
  job_id: "software-developer",
  version: "1.0.0",
  states: [
    {
      id: "video_question_1",
      label: "Video Question 1",
      agent_instruction: "Ask about background.",
      expected_submission: {
        type: "video",
        fields: [],
        any_of_fields: ["audio_url", "transcript"],
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
  recommendation_levels: ["strong_yes", "yes", "consider", "no"],
  final_evaluation: {
    strong_threshold: 0.8,
    consider_threshold: 0.6,
    weak_threshold: 0.4,
  },
};

function makeSession(
  overrides: Partial<InterviewSession> = {},
): InterviewSession {
  return {
    threadId: "test-thread",
    companyId: "demo-company",
    jobId: "software-developer",
    currentStateId: "complete",
    submissions: [],
    scores: {},
    isComplete: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function evaluate(
  scores: Record<string, number>,
  configOverrides: Partial<InterviewConfig> = {},
): FinalEvaluation {
  const config = { ...baseConfig, ...configOverrides };
  const session = makeSession({ scores });
  return computeFinalEvaluation(session, config);
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("computeFinalEvaluation", () => {
  describe("Perfect scores — strong recommendation", () => {
    it("returns strong_yes for all max scores", () => {
      const result = evaluate({
        communication: 10,
        technical_depth: 10,
        problem_solving: 10,
        role_fit: 10,
      });

      expect(result.recommendation).toBe("strong_yes");
      expect(result.scores.communication).toBe(10);
      expect(result.scores.technical_depth).toBe(10);
      expect(result.scores.problem_solving).toBe(10);
      expect(result.scores.role_fit).toBe(10);
      expect(result.strengths.length).toBeGreaterThanOrEqual(4);
      expect(result.summary).toContain("strong_yes");
    });
  });

  describe("Mixed scores — yes/consider", () => {
    it("returns yes for decent scores near 70%", () => {
      const result = evaluate({
        communication: 7,
        technical_depth: 8,
        problem_solving: 6,
        role_fit: 7,
      });

      // Overall: (7+8+6+7) / 40 = 0.7 → >= 0.6 but < 0.8 → "yes"
      expect(result.recommendation).toBe("yes");
      expect(result.strengths.length).toBeGreaterThan(0);
    });

    it("returns consider for moderate scores near 50%", () => {
      const result = evaluate({
        communication: 5,
        technical_depth: 6,
        problem_solving: 4,
        role_fit: 5,
      });

      // Overall: (5+6+4+5) / 40 = 0.5 → >= 0.4 but < 0.6 → "consider"
      expect(result.recommendation).toBe("consider");
    });
  });

  describe("Low scores — no recommendation", () => {
    it("returns the last level for very low scores", () => {
      const result = evaluate({
        communication: 1,
        technical_depth: 2,
        problem_solving: 0,
        role_fit: 1,
      });

      // Overall: (1+2+0+1) / 40 = 0.1 → < 0.4 → "no"
      expect(result.recommendation).toBe("no");
    });
  });

  describe("Edge cases", () => {
    it("handles empty scores gracefully", () => {
      const result = evaluate({});

      expect(result.recommendation).toBe("no");
      expect(result.summary).toBeTruthy();
      // All categories should be at 0
      expect(result.scores.communication).toBe(0);
      expect(result.scores.technical_depth).toBe(0);
      expect(result.scores.problem_solving).toBe(0);
      expect(result.scores.role_fit).toBe(0);
    });

    it("handles missing category keys gracefully", () => {
      const result = evaluate({ communication: 10 });

      expect(result.scores.communication).toBe(10);
      // Other categories default to 0
      expect(result.scores.technical_depth).toBe(0);
      expect(result.scores.problem_solving).toBe(0);
      expect(result.scores.role_fit).toBe(0);
    });

    it("handles empty states array", () => {
      const config: InterviewConfig = {
        ...baseConfig,
        states: [],
      };
      const session = makeSession({
        scores: { communication: 10 },
      });
      const result = computeFinalEvaluation(session, config);

      expect(result.recommendation).toBe("no");
      expect(result.summary).toContain("0%");
    });

    it("handles empty scoring_categories", () => {
      const config: InterviewConfig = {
        ...baseConfig,
        scoring_categories: {},
      };
      const session = makeSession({
        scores: { communication: 10 },
      });
      const result = computeFinalEvaluation(session, config);

      expect(result.recommendation).toBe("no");
      expect(Object.keys(result.scores)).toEqual([]);
    });

    it("handles empty recommendation_levels", () => {
      const config: InterviewConfig = {
        ...baseConfig,
        recommendation_levels: [],
      };
      const result = evaluate(
        { communication: 10, technical_depth: 10, problem_solving: 10, role_fit: 10 },
        config,
      );

      expect(result.recommendation).toBe("no_recommendation");
    });
  });

  describe("Category aggregation correctness", () => {
    it("correctly computes weighted category scores", () => {
      // Set up a config with specific state weights
      const config: InterviewConfig = {
        ...baseConfig,
        states: [
          {
            id: "state_a",
            label: "State A",
            agent_instruction: "Do A.",
            expected_submission: { type: "none", fields: [] },
            transitions_to: ["state_b"],
            score_weights: { communication: 0.5, role_fit: 0.5 },
          },
          {
            id: "state_b",
            label: "State B",
            agent_instruction: "Do B.",
            expected_submission: { type: "none", fields: [] },
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
      };

      const result = computeFinalEvaluation(
        makeSession({
          scores: {
            communication: 8,
            role_fit: 6,
            technical_depth: 9,
            problem_solving: 7,
          },
        }),
        config,
      );

      // Each category's max is 10.
      // Communication: 8/10 = 0.8 → weightedScore = 8
      // Role Fit: 6/10 = 0.6 → weightedScore = 6
      // Technical Depth: 9/10 = 0.9 → weightedScore = 9
      // Problem Solving: 7/10 = 0.7 → weightedScore = 7
      expect(result.scores.communication).toBeCloseTo(8, 1);
      expect(result.scores.role_fit).toBeCloseTo(6, 1);
      expect(result.scores.technical_depth).toBeCloseTo(9, 1);
      expect(result.scores.problem_solving).toBeCloseTo(7, 1);

      // Overall: (8+6+9+7) / 40 = 0.75 → "yes"
      expect(result.recommendation).toBe("yes");
    });

    it("uses custom thresholds correctly", () => {
      // Lower the strong_threshold to 0.7 so 75% qualifies
      const config: InterviewConfig = {
        ...baseConfig,
        final_evaluation: {
          strong_threshold: 0.7,
          consider_threshold: 0.5,
          weak_threshold: 0.3,
        },
      };

      const result = evaluate(
        {
          communication: 7,
          technical_depth: 8,
          problem_solving: 7,
          role_fit: 8,
        },
        config,
      );

      // Overall: (7+8+7+8) / 40 = 0.75 → >= 0.7 → "strong_yes"
      expect(result.recommendation).toBe("strong_yes");
    });

    it("includes strengths and risks in summary", () => {
      const result = evaluate({
        communication: 9,
        technical_depth: 8,
        problem_solving: 2,
        role_fit: 3,
      });

      // Strengths should include communication and technical_depth (>= 70%)
      expect(result.strengths.some((s) => s.includes("Communication"))).toBe(true);
      expect(result.strengths.some((s) => s.includes("Technical Depth"))).toBe(true);

      // Risks should include problem_solving and role_fit (< 50%)
      expect(result.risks.some((s) => s.includes("Problem Solving"))).toBe(true);
      expect(result.risks.some((s) => s.includes("Role Fit"))).toBe(true);

      expect(result.summary).toContain("Strengths:");
      expect(result.summary).toContain("Risks:");
    });

    it("generates deterministic output (same input → same output)", () => {
      const scores = {
        communication: 7,
        technical_depth: 6,
        problem_solving: 5,
        role_fit: 8,
      };

      const result1 = evaluate(scores);
      const result2 = evaluate(scores);

      expect(result1).toEqual(result2);
    });

    it("handles negative scores gracefully (clamped to 0)", () => {
      // This shouldn't happen in practice, but be defensive
      const result = evaluate({
        communication: -5,
        technical_depth: 10,
        problem_solving: 10,
        role_fit: 10,
      });

      // Overall: (0+10+10+10) / 40 = 0.75 → "yes"
      expect(result.recommendation).toBe("yes");
      expect(result.scores.communication).toBe(0);
    });

    it("handles scores exceeding max_score (clamped)", () => {
      const result = evaluate({
        communication: 999,
        technical_depth: 10,
        problem_solving: 10,
        role_fit: 10,
      });

      // Clamped to max: (10+10+10+10) / 40 = 1.0 → "strong_yes"
      expect(result.recommendation).toBe("strong_yes");
      expect(result.scores.communication).toBe(10);
    });
  });
});
