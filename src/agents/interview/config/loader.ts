import { readFile, readdir } from "node:fs/promises";
import { resolve, join, parse } from "node:path";
import type {
  CompanyConfig,
  JobConfig,
  InterviewConfig,
  TechnicalChallengeConfig,
  InterviewConfigBundle,
} from "../types.js";

// ── Loader Options ───────────────────────────────────────────────────────

export interface LoadInterviewConfigOptions {
  /** Base path for configs directory. Default: process.cwd() + "/configs" */
  configRoot?: string;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Resolve the path to the configs directory.
 */
function resolveConfigRoot(options?: LoadInterviewConfigOptions): string {
  return options?.configRoot ?? resolve(process.cwd(), "configs");
}

/**
 * Load and validate the full interview configuration bundle for a company + job.
 *
 * Reads company.json, job.json, interview.json, and optionally
 * technical-challenge.json from the standard directory layout:
 *
 *   <configRoot>/companies/<companyId>/company.json
 *   <configRoot>/companies/<companyId>/jobs/<jobId>/job.json
 *   <configRoot>/companies/<companyId>/jobs/<jobId>/interview.json
 *   <configRoot>/companies/<companyId>/jobs/<jobId>/technical-challenge.json (optional)
 *   <configRoot>/companies/<companyId>/jobs/<jobId>/technical-challenges/*.json (optional)
 */
export async function loadInterviewConfig(
  companyId: string,
  jobId: string,
  options?: LoadInterviewConfigOptions,
): Promise<InterviewConfigBundle> {
  const root = resolveConfigRoot(options);
  const companyDir = join(root, "companies", companyId);
  const jobDir = join(companyDir, "jobs", jobId);

  const [companyRaw, jobRaw, interviewRaw] = await Promise.all([
    readFile(join(companyDir, "company.json"), "utf-8"),
    readFile(join(jobDir, "job.json"), "utf-8"),
    readFile(join(jobDir, "interview.json"), "utf-8"),
  ]);

  const company = JSON.parse(companyRaw) as CompanyConfig;
  const job = JSON.parse(jobRaw) as JobConfig;
  const interview = JSON.parse(interviewRaw) as InterviewConfig;

  let technicalChallenge: TechnicalChallengeConfig | undefined;
  try {
    const tcRaw = await readFile(
      join(jobDir, "technical-challenge.json"),
      "utf-8",
    );
    technicalChallenge = JSON.parse(tcRaw) as TechnicalChallengeConfig;
  } catch {
    // technical-challenge.json is optional
  }

  // Load multiple technical challenges from technical-challenges/ directory
  let technicalChallenges: Record<string, TechnicalChallengeConfig> | undefined;
  try {
    const tcDir = join(jobDir, "technical-challenges");
    const entries = await readdir(tcDir, { withFileTypes: true });
    const challengeFiles = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith(".json"),
    );
    if (challengeFiles.length > 0) {
      technicalChallenges = {};
      for (const entry of challengeFiles) {
        const key = parse(entry.name).name;
        const raw = await readFile(join(tcDir, entry.name), "utf-8");
        technicalChallenges[key] = JSON.parse(raw) as TechnicalChallengeConfig;
      }
    }
  } catch {
    // technical-challenges/ directory is optional
  }

  // Backward compat: inject single technical-challenge.json into the map under key "default"
  if (technicalChallenge && technicalChallenges && !technicalChallenges["default"]) {
    technicalChallenges["default"] = technicalChallenge;
  } else if (technicalChallenge && !technicalChallenges) {
    technicalChallenges = { default: technicalChallenge };
  }

  const bundle: InterviewConfigBundle = {
    company,
    job,
    interview,
    technicalChallenge,
    technicalChallenges,
  };

  validateInterviewConfigBundle(bundle);

  return bundle;
}

// ── Validation ───────────────────────────────────────────────────────────

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validate an {@link InterviewConfigBundle} for internal consistency.
 *
 * Checks:
 * - company.id matches company_id on job and interview
 * - job.id matches job_id on interview
 * - all state transition targets reference existing state ids
 * - all submission refs have valid types
 * - score weights reference valid scoring categories
 * - bundle has at least one state
 * - first state is reachable (no incoming edges in a simple linear chain)
 *
 * @throws {AggregateError} if validation fails, with individual ValidationErrors
 */
export function validateInterviewConfigBundle(
  bundle: InterviewConfigBundle,
): void {
  const errors: ValidationError[] = [];

  const { company, job, interview } = bundle;

  // -- ID cross-checks
  if (job.company_id !== company.id) {
    errors.push({
      field: "job.company_id",
      message: `job.company_id "${job.company_id}" does not match company.id "${company.id}"`,
    });
  }

  if (interview.company_id !== company.id) {
    errors.push({
      field: "interview.company_id",
      message: `interview.company_id "${interview.company_id}" does not match company.id "${company.id}"`,
    });
  }

  if (interview.job_id !== job.id) {
    errors.push({
      field: "interview.job_id",
      message: `interview.job_id "${interview.job_id}" does not match job.id "${job.id}"`,
    });
  }

  // -- States
  if (interview.states.length === 0) {
    errors.push({
      field: "interview.states",
      message: "interview must define at least one state",
    });
  }

  const stateIds = new Set(interview.states.map((s) => s.id));
  const validSubmissionTypes = new Set(["text", "video", "code", "none"]);

  for (const state of interview.states) {
    // Transition targets must exist
    for (const target of state.transitions_to) {
      if (!stateIds.has(target)) {
        errors.push({
          field: `interview.states[${state.id}].transitions_to[${target}]`,
          message: `transition target "${target}" is not a defined state id`,
        });
      }
    }

    // Submission type must be valid
    if (!validSubmissionTypes.has(state.expected_submission.type)) {
      errors.push({
        field: `interview.states[${state.id}].expected_submission.type`,
        message: `invalid submission type "${state.expected_submission.type}"`,
      });
    }

    // Score weights must reference valid scoring categories
    for (const key of Object.keys(state.score_weights)) {
      if (!interview.scoring_categories[key]) {
        errors.push({
          field: `interview.states[${state.id}].score_weights[${key}]`,
          message: `score weight "${key}" is not a defined scoring category`,
        });
      }
    }
  }

  // -- First state should be reachable (the state with no incoming edges)
  // In a simple chain FSM, the first state has no incoming transitions.
  const reachedIds = new Set<string>();
  for (const state of interview.states) {
    for (const target of state.transitions_to) {
      reachedIds.add(target);
    }
  }
  const unreachable = interview.states.filter(
    (s) => !reachedIds.has(s.id) && s.id !== interview.states[0]?.id,
  );
  if (unreachable.length > 0) {
    for (const s of unreachable) {
      errors.push({
        field: `interview.states[${s.id}]`,
        message: `state "${s.id}" is not reachable from any other state transition`,
      });
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, "Interview config validation failed");
  }
}
