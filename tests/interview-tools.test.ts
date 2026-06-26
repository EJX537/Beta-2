import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InterviewPersistenceBridge } from "../src/agents/interview/persistence/bridge.js";
import { InterviewSessionStore } from "../src/agents/interview/state/session-store.js";
import { initializeInterviewSession } from "../src/agents/interview/state/fsm.js";
import { createInterviewTools } from "../src/agents/interview/tools/index.js";
import type {
  InterviewConfig,
  TechnicalChallengeConfig,
} from "../src/agents/interview/types.js";

interface ToolCallResult {
  ok: boolean;
  code?: string;
  message: string;
  idempotent?: boolean;
  technical_result?: {
    passed: boolean;
    score: number;
    maxScore: number;
    summary: string;
  };
  state?: {
    currentStateId: string;
    isComplete: boolean;
    scores: Record<string, number>;
  };
}

interface CallableTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: () => void,
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

const interviewConfig: InterviewConfig = {
  company_id: "demo-company",
  job_id: "tool-owned-fsm",
  version: "1.0.0-test",
  states: [
    {
      id: "intro",
      label: "Intro",
      agent_instruction: "Ask whether the candidate is ready.",
      expected_submission: { type: "text", fields: ["answer"] },
      transitions_to: ["technical_challenge"],
      score_weights: {},
    },
    {
      id: "technical_challenge",
      label: "Technical Challenge",
      agent_instruction: "Ask the candidate to implement double(n).",
      expected_submission: { type: "code", fields: ["language", "files", "entrypoint"] },
      transitions_to: ["final_evaluation"],
      score_weights: { technical_depth: 0.7, problem_solving: 0.3 },
    },
    {
      id: "final_evaluation",
      label: "Final Evaluation",
      agent_instruction: "Produce the scorecard.",
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
    technical_depth: { label: "Technical Depth", max_score: 10 },
    problem_solving: { label: "Problem Solving", max_score: 10 },
  },
  recommendation_levels: ["strong_yes", "yes", "mixed", "no"],
};

const technicalChallenge: TechnicalChallengeConfig = {
  title: "Double",
  prompt: "Implement double(n).",
  acceptedLanguages: ["javascript"],
  requiredFiles: ["solution.js"],
  scoring_rubric: [{ criterion: "correctness", weight: 1 }],
  maxScore: 10,
  runner: {
    parser: "stdout-json-last-line",
    scorePath: "score",
    passedPath: "passed",
    summaryPath: "summary",
    fallback: {
      score: 0,
      passed: false,
      summary: "Verifier failed.",
    },
    config: {
      command: "node verifier.js",
      cwd: ".",
      timeoutMs: 1_000,
      allowInstall: false,
      supportFiles: {
        "verifier.js": `
const solution = require('./solution.js');
const double = solution.double;
const cases = [[2, 4], [0, 0], [-3, -6]];
let passedCount = 0;
for (const [input, expected] of cases) {
  if (double(input) === expected) passedCount += 1;
}
const passed = passedCount === cases.length;
console.log(JSON.stringify({
  passed,
  score: passed ? 10 : 0,
  summary: passedCount + '/' + cases.length + ' cases passed'
}));
process.exit(passed ? 0 : 1);
`,
      },
    },
  },
};

function getTool(tools: unknown[], name: string): CallableTool {
  const tool = tools.find(
    (candidate): candidate is CallableTool =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { name?: unknown }).name === name,
  );
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }
  return tool;
}

async function callTool(
  tool: CallableTool,
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const result = await tool.execute(
    "tool-call-id",
    params,
    new AbortController().signal,
    () => {},
  );
  return JSON.parse(result.content[0]!.text) as ToolCallResult;
}

describe("interview tools own FSM advancement", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("advances exactly one transition with idempotency and persists snapshots", async () => {
    const dir = mkdtempSync(join(tmpdir(), "interview-tools-"));
    tempDirs.push(dir);
    const persistence = new InterviewPersistenceBridge({
      interviewDBPath: join(dir, "interview.db"),
      screeningDBPath: null,
    });
    const store = new InterviewSessionStore();
    const session = initializeInterviewSession({
      threadId: "tool-thread-1",
      companyId: interviewConfig.company_id,
      jobId: interviewConfig.job_id,
      interviewConfig,
      candidateContext: { candidateId: "candidate-1" },
    });
    store.set(session.threadId, session);

    const tools = createInterviewTools(store, interviewConfig, {
      technicalChallenge,
      persistence,
    });
    const advance = getTool(tools, "advance_interview_state");

    const first = await callTool(advance, {
      thread_id: session.threadId,
      expected_state_id: "intro",
      idempotency_key: "turn-1:intro",
      submission: { answer: "Ready." },
    });

    expect(first).toMatchObject({
      ok: true,
      state: { currentStateId: "technical_challenge", isComplete: false },
    });
    expect(store.get(session.threadId)?.submissions).toHaveLength(1);

    const duplicate = await callTool(advance, {
      thread_id: session.threadId,
      expected_state_id: "intro",
      idempotency_key: "turn-1:intro",
      submission: { answer: "Ready." },
    });

    expect(duplicate).toMatchObject({ ok: true, idempotent: true });
    expect(store.get(session.threadId)?.submissions).toHaveLength(1);
    expect(store.get(session.threadId)?.currentStateId).toBe("technical_challenge");

    const wrongState = await callTool(advance, {
      thread_id: session.threadId,
      expected_state_id: "intro",
      idempotency_key: "turn-2:intro",
      submission: { answer: "Should not apply." },
    });

    expect(wrongState).toMatchObject({ ok: false, code: "WRONG_STATE" });
    expect(store.get(session.threadId)?.submissions).toHaveLength(1);

    const restored = persistence.loadSession(session.threadId);
    expect(restored).toMatchObject({
      threadId: session.threadId,
      currentStateId: "technical_challenge",
      submissions: [{ stateId: "intro", idempotencyKey: "turn-1:intro" }],
    });

    store.dispose();
    persistence.dispose();
  });

  it("runs technical verification inside advance_interview_state", async () => {
    const store = new InterviewSessionStore();
    const session = initializeInterviewSession({
      threadId: "tool-thread-technical",
      companyId: interviewConfig.company_id,
      jobId: interviewConfig.job_id,
      interviewConfig,
    });
    session.currentStateId = "technical_challenge";
    store.set(session.threadId, session);

    const tools = createInterviewTools(store, interviewConfig, { technicalChallenge });
    const advance = getTool(tools, "advance_interview_state");

    const result = await callTool(advance, {
      thread_id: session.threadId,
      expected_state_id: "technical_challenge",
      idempotency_key: "turn-technical",
      submission: {
        language: "javascript",
        entrypoint: "solution.js",
        files: {
          "solution.js": "module.exports.double = function double(n) { return n * 2; };",
        },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      technical_result: {
        passed: true,
        score: 10,
        maxScore: 10,
        summary: "3/3 cases passed",
      },
      state: {
        currentStateId: "final_evaluation",
        scores: {
          technical_depth: 7,
          problem_solving: 3,
        },
      },
    });

    const updated = store.get(session.threadId)!;
    expect(updated.submissions[0]).toMatchObject({
      stateId: "technical_challenge",
      idempotencyKey: "turn-technical",
      data: {
        technical_result: {
          passed: true,
          score: 10,
        },
      },
    });

    const auto = await callTool(advance, {
      thread_id: session.threadId,
      expected_state_id: "final_evaluation",
      idempotency_key: "turn-final:auto",
    });

    expect(auto).toMatchObject({
      ok: true,
      state: { currentStateId: "complete", isComplete: true },
    });

    store.dispose();
  });
});
