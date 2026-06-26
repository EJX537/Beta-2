import { createSyntheticSourceInfo, createExtensionRuntime, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import type {
  InterviewConfigBundle,
  InterviewSession,
  CandidateArtifactReference,
  InterviewStateConfig,
  SubmissionRequirement,
} from "./types.js";

// ── Types ───────────────────────────────────────────────────────────────

/**
 * Input bundle for building the per-turn interview context string.
 */
export interface InterviewJitContextInput {
  config: InterviewConfigBundle;
  session: InterviewSession;
  currentState: InterviewStateConfig;
  nextSubmission: SubmissionRequirement | null;
  turnId?: string;
  pendingSubmission?: Record<string, unknown>;
  artifactRefs?: CandidateArtifactReference[];
  lastRunnerResult?: Record<string, unknown>;
}

// ── Per-turn Context Builder ────────────────────────────────────────────

/**
 * Build a compact JIT context string for the current user turn.
 *
 * Keep this out of the system prompt path so provider prompt-caching can
 * reuse the stable system prompt, skill list, and tool definitions.
 */
export function createInterviewJitContext(input: InterviewJitContextInput): string {
  const {
    config,
    session,
    currentState,
    nextSubmission,
    turnId,
    pendingSubmission,
    artifactRefs,
    lastRunnerResult,
  } = input;
  const { company, job, interview, technicalChallenge } = config;

  const lines: string[] = [];

  // Header
  lines.push("── Per-turn Interview Context ──");

  // Thread / company / job
  lines.push(`Thread ID: ${session.threadId}`);
  lines.push(`Company: ${company.name} (${company.id})`);
  lines.push(`Job: ${job.title} (${job.id})`);

  // Allowed FSM sequence
  const fsmSequence = interview.states
    .map((s) => `${s.id} (${s.label})`)
    .join(" → ");
  lines.push(`Allowed FSM sequence: ${fsmSequence}`);

  // Current state
  lines.push(`Current state: ${currentState.id} (${currentState.label})`);
  if (currentState.agent_instruction) {
    lines.push(`State instruction: ${currentState.agent_instruction}`);
  }

  // Next submission requirement
  if (nextSubmission) {
    lines.push(`Required next submission: ${JSON.stringify(nextSubmission)}`);
  } else {
    lines.push("No candidate submission is currently required.");
  }

  if (turnId) {
    lines.push(`Current turn idempotency seed: ${turnId}`);
  }

  if (pendingSubmission) {
    lines.push(`Pending candidate submission: ${JSON.stringify(pendingSubmission)}`);
    lines.push(
      "Agent action required: validate the pending submission, then call advance_interview_state with expected_state_id equal to the current state and idempotency_key based on the current turn idempotency seed.",
    );
  }

  if (artifactRefs && artifactRefs.length > 0) {
    lines.push(`Pending artifact references: ${JSON.stringify(artifactRefs)}`);
  }

  // Candidate context
  if (session.candidateContext) {
    const ctx = session.candidateContext;
    lines.push(`Candidate ID: ${ctx.candidateId}`);
    if (ctx.profile) {
      lines.push(`Candidate profile: ${JSON.stringify(ctx.profile)}`);
    }
    if (ctx.source) {
      lines.push(`Candidate source: ${ctx.source}`);
    }
  }

  // Recent submissions (state IDs only, for awareness)
  if (session.submissions.length > 0) {
    const recentIds = session.submissions.map((s) => s.stateId).join(", ");
    lines.push(`Completed states: ${recentIds}`);
  }

  // Scores
  if (Object.keys(session.scores).length > 0) {
    lines.push(`Scores so far: ${JSON.stringify(session.scores)}`);
  }

  // Technical challenge details (when current state expects code, or when the
  // current state transitions into a code state so the agent presents the
  // exact configured challenge instead of inventing one).
  const codeStateIds = new Set(
    interview.states
      .filter((s) => s.expected_submission.type === "code")
      .map((s) => s.id),
  );
  const leadsToCodeState =
    currentState.expected_submission.type === "code" ||
    currentState.transitions_to.some((tid) => codeStateIds.has(tid));
  if (leadsToCodeState && technicalChallenge) {
    lines.push(``);
    lines.push(`Technical Challenge: ${technicalChallenge.title}`);
    lines.push(`Challenge prompt: ${technicalChallenge.prompt}`);
    if (technicalChallenge.accepted_languages && technicalChallenge.accepted_languages.length > 0) {
      lines.push(`Accepted languages: ${technicalChallenge.accepted_languages.join(", ")}`);
    }
    if (technicalChallenge.acceptedLanguages && technicalChallenge.acceptedLanguages.length > 0) {
      lines.push(`Accepted languages: ${technicalChallenge.acceptedLanguages.join(", ")}`);
    }
    if (technicalChallenge.requiredFiles && technicalChallenge.requiredFiles.length > 0) {
      lines.push(`Required files: ${technicalChallenge.requiredFiles.join(", ")}`);
    }
    if (technicalChallenge.scoring_rubric) {
      lines.push(`Scoring rubric: ${JSON.stringify(technicalChallenge.scoring_rubric)}`);
    }
    if (lastRunnerResult) {
      lines.push(`Last runner result: ${JSON.stringify(lastRunnerResult)}`);
    }
  }

  // Hard rule enforcement
  lines.push(``);
  lines.push("Hard rule: Do NOT invent states or interview phases not in the allowed FSM sequence above.");
  lines.push("Hard rule: Ask only for the current state's required submission. Do not ask about future states.");
  lines.push("Hard rule: When presenting the technical challenge, use the exact title and prompt from the Technical Challenge context above. Do not invent or substitute a different challenge.");
  lines.push("Hard rule: The interview state machine advances only through interview tools. Never claim the state advanced unless advance_interview_state succeeded.");

  lines.push("── End Per-turn Interview Context ──");

  return lines.join("\n");
}

// ── Resource Loader Factory ─────────────────────────────────────────────

export interface CreateInterviewResourceLoaderOptions {
  systemPrompt: string;
  /** Dynamic per-turn context for the input hook. Not part of system prompt. */
  getTurnContext?: () => string | undefined;
}

/**
 * Create a ResourceLoader for the interview agent.
 *
 * Returns stable resources only:
 * - No extensions, prompts, themes, or agents files
 * - A synthetic `interview-fsm` skill from `configs/skills/interview-fsm/SKILL.md`
 * - Static system prompt only — no dynamic append-system-prompt, preserving
 *   provider prompt-cache reuse.
 * - A stable in-memory extension whose `input` hook injects dynamic per-turn
 *   FSM context into the user message before the agent loop.
 *
 * All per-turn dynamic state (current FSM state, submission requirements, etc.)
 * lives in the user turn message via the extension hook, not in
 * ResourceLoader.getAppendSystemPrompt().
 */
export function createInterviewResourceLoader(
  options: CreateInterviewResourceLoaderOptions,
): ResourceLoader {
  const { systemPrompt, getTurnContext } = options;

  const skillFilePath = process.cwd() + "/configs/skills/interview-fsm/SKILL.md";
  const extensionPath = "interview-context-input-hook";
  const runtime = createExtensionRuntime();

  const inputHandler = async (...args: unknown[]) => {
    const event = args[0] as { text?: string; images?: unknown };
    const text = event.text ?? "";
    const turnContext = getTurnContext?.()?.trim();

    if (!turnContext || text.includes("── Per-turn Interview Context ──")) {
      return { action: "continue" as const };
    }

    return {
      action: "transform" as const,
      text: [
        turnContext,
        "",
        text,
        "",
        "Use the per-turn interview context above and the interview tools if exact state/config is needed. Respond for the current FSM state only.",
      ].join("\n"),
      images: event.images,
    };
  };

  const extensionSourceInfo = createSyntheticSourceInfo(extensionPath, {
    source: "interview-agent",
    scope: "project" as const,
    origin: "top-level" as const,
  });
  const extension = {
    path: extensionPath,
    resolvedPath: extensionPath,
    sourceInfo: extensionSourceInfo,
    handlers: new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      ["input", [inputHandler]],
    ]),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };

  const skill = {
    name: "interview-fsm",
    description:
      "Use for running the configured employer interview finite state machine, asking only for the current state's required submission, handling audio/transcript recorded responses, and never inventing interview phases.",
    filePath: skillFilePath,
    baseDir: process.cwd() + "/configs/skills",
    sourceInfo: createSyntheticSourceInfo(skillFilePath, {
      source: "interview-agent",
      scope: "project" as const,
      origin: "top-level" as const,
      baseDir: process.cwd() + "/configs/skills",
    }),
    disableModelInvocation: false,
  };

  return {
    getExtensions: () => ({
      extensions: [extension],
      errors: [],
      runtime,
    }),
    getSkills: () => ({ skills: [skill], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}
