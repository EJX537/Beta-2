import { describe, expect, it } from "vitest";
import {
  advanceUntilAwaitingCandidate,
  applySubmissionAndAdvance,
  getNextSubmissionRequirement,
  initializeInterviewSession,
  validateSubmissionForCurrentState,
} from "../src/agents/interview/state/fsm.js";
import { runLocalCodeSubmission } from "../src/agents/interview/skills/local-runner.js";
import type {
  CodeSubmission,
  InterviewConfig,
  InterviewSession,
  TechnicalChallengeConfig,
} from "../src/agents/interview/types.js";

const technicalInterviewConfig: InterviewConfig = {
  company_id: "demo-company",
  job_id: "three-round-technical",
  version: "1.0.0-test",
  states: [
    {
      id: "intro",
      label: "Intro",
      agent_instruction: "Explain the three technical rounds.",
      expected_submission: { type: "none", fields: [] },
      transitions_to: ["technical_reverse_string"],
      score_weights: {},
    },
    {
      id: "technical_reverse_string",
      label: "Technical Round 1: Reverse String",
      agent_instruction: "Ask the candidate to implement reverseString(input).",
      expected_submission: {
        type: "code",
        fields: ["language", "files", "entrypoint"],
      },
      transitions_to: ["technical_review_1"],
      score_weights: { technical_depth: 0.6, problem_solving: 0.4 },
    },
    {
      id: "technical_review_1",
      label: "Technical Review 1",
      agent_instruction: "Record the first technical result.",
      expected_submission: { type: "none", fields: [] },
      transitions_to: ["technical_sum_array"],
      score_weights: {},
    },
    {
      id: "technical_sum_array",
      label: "Technical Round 2: Sum Array",
      agent_instruction: "Ask the candidate to implement sumArray(numbers).",
      expected_submission: {
        type: "code",
        fields: ["language", "files", "entrypoint"],
      },
      transitions_to: ["technical_review_2"],
      score_weights: { technical_depth: 0.5, problem_solving: 0.5 },
    },
    {
      id: "technical_review_2",
      label: "Technical Review 2",
      agent_instruction: "Record the second technical result.",
      expected_submission: { type: "none", fields: [] },
      transitions_to: ["technical_is_palindrome"],
      score_weights: {},
    },
    {
      id: "technical_is_palindrome",
      label: "Technical Round 3: Palindrome",
      agent_instruction: "Ask the candidate to implement isPalindrome(input).",
      expected_submission: {
        type: "code",
        fields: ["language", "files", "entrypoint"],
      },
      transitions_to: ["technical_review_3"],
      score_weights: { technical_depth: 0.4, problem_solving: 0.6 },
    },
    {
      id: "technical_review_3",
      label: "Technical Review 3",
      agent_instruction: "Record the third technical result.",
      expected_submission: { type: "none", fields: [] },
      transitions_to: ["final_evaluation"],
      score_weights: {},
    },
    {
      id: "final_evaluation",
      label: "Final Evaluation",
      agent_instruction: "Produce the technical scorecard.",
      expected_submission: { type: "none", fields: [] },
      transitions_to: ["complete"],
      score_weights: {},
    },
    {
      id: "complete",
      label: "Complete",
      agent_instruction: "Interview complete.",
      expected_submission: { type: "none", fields: [] },
      transitions_to: [],
      score_weights: {},
    },
  ],
  scoring_categories: {
    technical_depth: { label: "Technical Depth", max_score: 15 },
    problem_solving: { label: "Problem Solving", max_score: 15 },
  },
  recommendation_levels: ["strong_yes", "yes", "mixed", "no"],
};

const challengesByState: Record<string, TechnicalChallengeConfig> = {
  technical_reverse_string: createAlgorithmChallenge({
    title: "Reverse String",
    functionName: "reverseString",
    cases: [
      { input: ["beta"], expected: "ateb" },
      { input: ["AgentBox"], expected: "xoBtnegA" },
      { input: [""], expected: "" },
    ],
  }),
  technical_sum_array: createAlgorithmChallenge({
    title: "Sum Array",
    functionName: "sumArray",
    cases: [
      { input: [[1, 2, 3, 4]], expected: 10 },
      { input: [[-2, 5, 7]], expected: 10 },
      { input: [[]], expected: 0 },
    ],
  }),
  technical_is_palindrome: createAlgorithmChallenge({
    title: "Palindrome",
    functionName: "isPalindrome",
    cases: [
      { input: ["racecar"], expected: true },
      { input: ["A man, a plan, a canal: Panama"], expected: true },
      { input: ["not a palindrome"], expected: false },
    ],
  }),
};

describe("three-round technical interview E2E", () => {
  it("runs the full FSM through three deterministic algorithm submissions", async () => {
    const session = initializeInterviewSession({
      threadId: "technical-e2e-thread",
      companyId: technicalInterviewConfig.company_id,
      jobId: technicalInterviewConfig.job_id,
      interviewConfig: technicalInterviewConfig,
      candidateContext: {
        candidateId: "candidate-technical-e2e",
        profile: { role: "Software Developer" },
        source: "test",
      },
    });

    advanceUntilAwaitingCandidate(session, technicalInterviewConfig);

    expect(session.currentStateId).toBe("technical_reverse_string");
    expect(getNextSubmissionRequirement(session, technicalInterviewConfig)).toEqual({
      type: "code",
      fields: ["language", "files", "entrypoint"],
    });

    await submitTechnicalRound(session, "technical_reverse_string", {
      language: "javascript",
      entrypoint: "solution.js",
      files: [
        {
          path: "solution.js",
          content:
            "module.exports.reverseString = function reverseString(input) { return input.split('').reverse().join(''); };",
        },
      ],
    });

    expect(session.currentStateId).toBe("technical_sum_array");

    await submitTechnicalRound(session, "technical_sum_array", {
      language: "javascript",
      entrypoint: "solution.js",
      files: [
        {
          path: "solution.js",
          content:
            "module.exports.sumArray = function sumArray(numbers) { return numbers.reduce((total, n) => total + n, 0); };",
        },
      ],
    });

    expect(session.currentStateId).toBe("technical_is_palindrome");

    await submitTechnicalRound(session, "technical_is_palindrome", {
      language: "javascript",
      entrypoint: "solution.js",
      files: [
        {
          path: "solution.js",
          content: `
module.exports.isPalindrome = function isPalindrome(input) {
  const normalized = input.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized === normalized.split('').reverse().join('');
};
`,
        },
      ],
    });

    expect(session.currentStateId).toBe("complete");
    expect(session.isComplete).toBe(true);
    expect(getNextSubmissionRequirement(session, technicalInterviewConfig)).toBeNull();

    const technicalSubmissions = session.submissions.filter((submission) =>
      submission.stateId.startsWith("technical_") &&
      submission.stateId !== "technical_review_1" &&
      submission.stateId !== "technical_review_2" &&
      submission.stateId !== "technical_review_3",
    );

    expect(technicalSubmissions).toHaveLength(3);
    expect(
      technicalSubmissions.map((submission) => submission.stateId),
    ).toEqual([
      "technical_reverse_string",
      "technical_sum_array",
      "technical_is_palindrome",
    ]);

    for (const submission of technicalSubmissions) {
      expect(submission.data.technical_result).toMatchObject({
        passed: true,
        score: 10,
        maxScore: 10,
        summary: "3/3 cases passed",
      });
    }

    expect(session.submissions.map((submission) => submission.stateId)).toEqual([
      "intro",
      "technical_reverse_string",
      "technical_review_1",
      "technical_sum_array",
      "technical_review_2",
      "technical_is_palindrome",
      "technical_review_3",
      "final_evaluation",
    ]);

    expect(session.scores).toEqual({
      technical_depth: 15,
      problem_solving: 15,
    });
  });
});

async function submitTechnicalRound(
  session: InterviewSession,
  expectedStateId: string,
  submission: CodeSubmission,
): Promise<void> {
  expect(session.currentStateId).toBe(expectedStateId);
  expect(
    validateSubmissionForCurrentState(
      session,
      technicalInterviewConfig,
      submission as unknown as Record<string, unknown>,
    ),
  ).toEqual([]);

  const challenge = challengesByState[expectedStateId];
  expect(challenge).toBeDefined();

  const technicalResult = await runLocalCodeSubmission(submission, challenge!);
  expect(technicalResult.passed).toBe(true);

  const submissionWithResult = {
    ...(submission as unknown as Record<string, unknown>),
    technical_result: technicalResult,
  };

  addWeightedScores(session, expectedStateId, technicalResult.score);
  applySubmissionAndAdvance(
    session,
    technicalInterviewConfig,
    submissionWithResult,
  );
  advanceUntilAwaitingCandidate(session, technicalInterviewConfig);
}

function addWeightedScores(
  session: InterviewSession,
  stateId: string,
  score: number,
): void {
  const state = technicalInterviewConfig.states.find(
    (candidateState) => candidateState.id === stateId,
  );
  expect(state).toBeDefined();

  for (const [category, weight] of Object.entries(state!.score_weights)) {
    session.scores[category] = (session.scores[category] ?? 0) + score * weight;
  }
}

function createAlgorithmChallenge(params: {
  title: string;
  functionName: string;
  cases: Array<{ input: unknown[]; expected: unknown }>;
}): TechnicalChallengeConfig {
  return {
    title: params.title,
    prompt: `Implement ${params.functionName}.`,
    acceptedLanguages: ["javascript"],
    accepted_languages: ["javascript"],
    requiredFiles: ["solution.js"],
    required_files: ["solution.js"],
    scoring_rubric: [{ criterion: "correctness", weight: 1 }],
    maxScore: 10,
    max_score: 10,
    runner: {
      parser: "stdout-json-last-line",
      scorePath: "score",
      passedPath: "passed",
      summaryPath: "summary",
      fallback: {
        score: 0,
        passed: false,
        summary: "Verifier did not emit valid JSON.",
      },
      config: {
        command: "node verifier.js",
        cwd: ".",
        timeoutMs: 1_000,
        allowInstall: false,
        supportFiles: {
          "verifier.js": createVerifier(params.functionName, params.cases),
        },
      },
    },
  };
}

function createVerifier(
  functionName: string,
  cases: Array<{ input: unknown[]; expected: unknown }>,
): string {
  return `
const solution = require('./solution.js');
const candidate = typeof solution === 'function' ? solution : solution.${functionName};
const cases = ${JSON.stringify(cases)};

if (typeof candidate !== 'function') {
  console.log(JSON.stringify({
    passed: false,
    score: 0,
    summary: 'Missing exported function ${functionName}',
    details: { expectedExport: '${functionName}' }
  }));
  process.exit(1);
}

let passedCount = 0;
const details = [];

for (const testCase of cases) {
  let actual;
  try {
    actual = candidate(...testCase.input);
  } catch (error) {
    details.push({ input: testCase.input, error: String(error && error.message ? error.message : error) });
    continue;
  }

  const passed = JSON.stringify(actual) === JSON.stringify(testCase.expected);
  if (passed) passedCount += 1;
  details.push({ input: testCase.input, expected: testCase.expected, actual, passed });
}

const passed = passedCount === cases.length;
const score = Math.round((passedCount / cases.length) * 10);
console.log(JSON.stringify({
  passed,
  score,
  summary: passedCount + '/' + cases.length + ' cases passed',
  details
}));
process.exit(passed ? 0 : 1);
`;
}
