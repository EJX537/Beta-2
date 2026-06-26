// ── Domain types for Interviewing Agent ───────────────────────────────────

// ── Company / Job / Interview Configuration ──────────────────────────────

export interface CompanyConfig {
  id: string;
  name: string;
  description: string;
  values: string[];
  hiring_style: string;
  agent_tone: string;
}

export interface JobConfig {
  id: string;
  title: string;
  company_id: string;
  level: string;
  description: string;
  responsibilities: string[];
  required_skills: string[];
  preferred_skills: string[];
  evaluation_priorities: string[];
}

export type SubmissionType = "text" | "video" | "code" | "none";

export interface SubmissionRequirement {
  type: SubmissionType;
  max_seconds?: number;
  /** Fields that are always required. */
  fields: string[];
  /** At least one of these fields must be present when provided. */
  any_of_fields?: string[];
  /** Optional fields accepted for storage/grading context. */
  optional_fields?: string[];
}

export interface InterviewStateConfig {
  id: string;
  label: string;
  agent_instruction: string;
  expected_submission: SubmissionRequirement;
  transitions_to: string[];
  score_weights: Record<string, number>;
  /** Optional rubric for grading audio/video submissions in this state. */
  audioRubric?: AudioGradingRubric;
}

export interface AudioGradingRubricCategory {
  label: string;
  description: string;
  weight: number;
  maxScore: number;
}

export interface AudioGradingRubric {
  categories: AudioGradingRubricCategory[];
}

export interface AudioGradeResult {
  score: number;
  maxScore: number;
  summary: string;
  strengths: string[];
  risks: string[];
  details?: Record<string, unknown>;
}

export interface ScoringCategory {
  label: string;
  max_score: number;
}

export interface FinalEvaluationConfig {
  strong_threshold?: number;
  consider_threshold?: number;
  weak_threshold?: number;
}

export interface InterviewConfig {
  company_id: string;
  job_id: string;
  version: string;
  states: InterviewStateConfig[];
  scoring_categories: Record<string, ScoringCategory>;
  recommendation_levels: string[];
  final_evaluation?: FinalEvaluationConfig;
}

export interface RunnerFile {
  path: string;
  content: string;
}

export interface RunnerConfig {
  /** Shell command to run the candidate's code */
  command: string;
  /** Working directory relative to workspace root where the command runs */
  cwd?: string;
  /** Timeout in milliseconds */
  timeoutMs: number;
  /** Whether `installCommand` is allowed to run */
  allowInstall?: boolean;
  /** Command to install dependencies before running (e.g. npm install) */
  installCommand?: string;
  /** Additional files to write into the workspace before the candidate's code */
  supportFiles?: Record<string, string> | RunnerFile[];
}

export interface TechnicalChallengeRunner {
  /** Runner config */
  config: RunnerConfig;
  /** How to parse the runner output into a score */
  parser: "stdout-json-last-line" | "exit-code-fallback";
  /** JSON pointer or key path for the score in parsed output */
  scorePath?: string;
  /** JSON pointer or key path for passed boolean */
  passedPath?: string;
  /** JSON pointer or key path for summary text */
  summaryPath?: string;
  /** Fallback score if parsing fails */
  fallback: {
    score: number;
    passed: boolean;
    summary: string;
  };
}

export interface TechnicalChallengeConfig {
  title: string;
  prompt: string;
  accepted_languages?: string[];
  acceptedLanguages?: string[];
  scoring_rubric: { criterion: string; weight: number }[];
  test_command?: string;
  timeout_seconds?: number;
  /** New runner contract */
  runner?: TechnicalChallengeRunner;
  /** Required files that must be present in the submission */
  requiredFiles?: string[];
  required_files?: string[];
  /** Maximum score for the technical challenge */
  maxScore?: number;
  max_score?: number;
}

// ── Runner Types ─────────────────────────────────────────────────────────

export interface CodeSubmission {
  type?: "code";
  language: string;
  files: Record<string, string> | RunnerFile[];
  entrypoint?: string;
}

export interface LocalRunnerOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  passed: boolean;
  score: number;
  maxScore: number;
  summary: string;
  details?: Record<string, unknown>;
}

// ── Interview Configuration Bundle (validated aggregate) ─────────────────

export interface InterviewConfigBundle {
  company: CompanyConfig;
  job: JobConfig;
  interview: InterviewConfig;
  technicalChallenge?: TechnicalChallengeConfig;
}

// ── FSM Types ────────────────────────────────────────────────────────────

export type InterviewStateId = string;

export interface InterviewSession {
  threadId: string;
  companyId: string;
  jobId: string;
  currentStateId: InterviewStateId;
  submissions: SubmissionRecord[];
  scores: Record<string, number>;
  candidateContext?: CandidateContext;
  finalEvaluation?: FinalEvaluation;
  isComplete: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CandidateContext {
  candidateId: string;
  /** Screening profile UUID from agent1.py, when available. */
  profileId?: string;
  profile?: Record<string, unknown>;
  source?: string;
  thread_id?: string;
}

export interface SubmissionRecord {
  stateId: InterviewStateId;
  data: Record<string, unknown>;
  submittedAt: number;
  idempotencyKey?: string;
}

export interface InterviewStateView {
  threadId: string;
  companyId: string;
  jobId: string;
  currentStateId: InterviewStateId;
  currentStateLabel: string;
  isComplete: boolean;
  nextSubmission: SubmissionRequirement | null;
  submissions: SubmissionRecord[];
  scores: Record<string, number>;
  evaluation?: FinalEvaluation;
}

export interface FinalEvaluation {
  recommendation: string;
  scores: Record<string, number>;
  strengths: string[];
  risks: string[];
  summary: string;
}

// ── Error Types ────────────────────────────────────────────────────────────

/**
 * Standardized error codes for interview API responses.
 */
export type InterviewErrorCode =
  | "INVALID_JSON"
  | "INVALID_PARAMS"
  | "MISSING_CANDIDATE_CONTEXT"
  | "CONFIG_NOT_FOUND"
  | "THREAD_NOT_FOUND"
  | "THREAD_ROUTE_MISMATCH"
  | "INVALID_SUBMISSION"
  | "WRONG_STATE"
  | "INTERVIEW_AGENT_FAILED";

/**
 * Standardized error payload for interview API responses.
 */
export interface InterviewErrorPayload {
  code: InterviewErrorCode;
  message: string;
  stateId?: string;
  threadId?: string;
  details?: Record<string, unknown>;
}

// ── GMI / Pi Agent Options ───────────────────────────────────────────────

export interface GmiProviderOptions {
  baseURL: string;
  apiKey: string;
  modelId: string;
}

export interface InterviewAgentOptions {
  gmi: GmiProviderOptions;
  companyId?: string;
  jobId?: string;
  systemPrompt?: string;
  customTools?: string[];
  /** Optional persistence bridge for DB-backed snapshot storage */
  persistence?: import("./persistence/bridge.js").InterviewPersistenceBridge;
  /** Optional local artifact store for upload refs */
  artifactStore?: import("./artifacts/store.js").LocalArtifactStore;
}

// ── Interview Agent Request / Response ───────────────────────────────────

export interface CandidateArtifactReference {
  ref?: string;
  uri: string;
  path?: string;
  mediaType?: string;
  media_type?: string;
  fieldHint?: string;
  field_hint?: string;
  size?: number;
  sha256?: string;
}

export interface InterviewRequest {
  message: string;
  threadId?: string;
  /** Stable per-turn id used by the agent tools as an idempotency key seed. */
  turnId?: string;
  submission?: Record<string, unknown>;
  artifactRefs?: CandidateArtifactReference[];
  candidateContext?: CandidateContext;
}

export interface InterviewResponse {
  threadId: string;
  state: InterviewStateView;
  message: string;
  requiresSubmission: boolean;
  nextSubmission?: SubmissionRequirement;
  isComplete: boolean;
  evaluation?: FinalEvaluation;
}
