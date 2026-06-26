/**
 * Conflict-free SQLite bridge for interview persistence.
 *
 * Owns a separate interview DB (`INTERVIEW_DB`) and optionally attaches
 * the Python screening DB (`AGENT_DB`) as a read-only schema named `screening`.
 *
 * Uses Node 24 built-in `node:sqlite` (DatabaseSync) — zero native deps.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type {
  CandidateContext,
  FinalEvaluation,
  InterviewResponse,
  InterviewSession,
  SubmissionRecord,
} from "../types.js";

const INTERVIEW_SNAPSHOTS_TABLE = "interview_snapshots";
const SCREENING_ATTACH_SCHEMA = "screening";
const SCREENING_PROFILES_TABLE = `${SCREENING_ATTACH_SCHEMA}.profiles`;

export interface InterviewPersistenceBridgeOptions {
  interviewDBPath?: string;
  /** Pass null/empty string to disable screening DB attach. */
  screeningDBPath?: string | null;
}

export interface InterviewSnapshotRow {
  thread_id: string;
  profile_id: string | null;
  candidate_id: string;
  company_id: string;
  job_id: string;
  status: string;
  current_state: string;
  candidate_context_json: string | null;
  submissions_json: string | null;
  scores_json: string | null;
  final_evaluation_json: string | null;
  created_at: string;
  updated_at: string;
}

function envPath(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function normalizeScreeningProfile(row: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...row };
  const analysis = normalized["analysis"];
  if (typeof analysis === "string") {
    try {
      normalized["analysis"] = JSON.parse(analysis) as unknown;
    } catch {
      // Keep raw analysis string if partner data is not valid JSON.
    }
  }
  return normalized;
}

export class InterviewPersistenceBridge {
  private readonly db: DatabaseSync;
  private readonly interviewDBPath: string;
  private readonly screeningDBPath: string | null;
  private disposed = false;

  constructor(options?: InterviewPersistenceBridgeOptions);
  constructor(interviewDBPath?: string, screeningDBPath?: string | null);
  constructor(
    optionsOrPath?: InterviewPersistenceBridgeOptions | string,
    screeningPath?: string | null,
  ) {
    const options: InterviewPersistenceBridgeOptions =
      typeof optionsOrPath === "object" && optionsOrPath !== null
        ? optionsOrPath
        : { interviewDBPath: optionsOrPath, screeningDBPath: screeningPath };

    this.interviewDBPath =
      options.interviewDBPath ?? envPath("INTERVIEW_DB", "/data/interview.db");
    this.screeningDBPath =
      options.screeningDBPath === undefined
        ? envPath("AGENT_DB", "/data/agent1.db")
        : options.screeningDBPath;

    mkdirSync(dirname(this.interviewDBPath), { recursive: true });

    this.db = new DatabaseSync(this.interviewDBPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");

    this.ensureInterviewSchema();
    this.attachScreeningDB();
  }

  private ensureInterviewSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${INTERVIEW_SNAPSHOTS_TABLE} (
        thread_id              TEXT PRIMARY KEY,
        profile_id             TEXT,
        candidate_id           TEXT NOT NULL,
        company_id             TEXT NOT NULL,
        job_id                 TEXT NOT NULL,
        status                 TEXT NOT NULL DEFAULT 'in_progress',
        current_state          TEXT NOT NULL DEFAULT '',
        candidate_context_json TEXT,
        submissions_json       TEXT,
        scores_json            TEXT,
        final_evaluation_json  TEXT,
        created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_interview_snapshots_profile
        ON ${INTERVIEW_SNAPSHOTS_TABLE}(profile_id);

      CREATE INDEX IF NOT EXISTS idx_interview_snapshots_job
        ON ${INTERVIEW_SNAPSHOTS_TABLE}(company_id, job_id, status);
    `);
  }

  private attachScreeningDB(): void {
    if (!this.screeningDBPath) {
      return;
    }

    if (!existsSync(this.screeningDBPath)) {
      console.warn(
        "[persistence] Screening DB not found at %s — continuing without attach",
        this.screeningDBPath,
      );
      return;
    }

    try {
      const readonlyUri = `${pathToFileURL(this.screeningDBPath).href}?mode=ro`;
      this.db
        .prepare(`ATTACH DATABASE ? AS ${SCREENING_ATTACH_SCHEMA}`)
        .run(readonlyUri);
      console.info(
        "[persistence] Attached screening DB read-only: %s as schema '%s'",
        this.screeningDBPath,
        SCREENING_ATTACH_SCHEMA,
      );
    } catch (error) {
      console.warn(
        "[persistence] Failed to attach screening DB at %s: %s",
        this.screeningDBPath,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private isScreeningAttached(): boolean {
    if (this.disposed) {
      return false;
    }

    try {
      const row = this.db
        .prepare("SELECT count(*) AS cnt FROM pragma_database_list WHERE name = ?")
        .get(SCREENING_ATTACH_SCHEMA) as { cnt: number } | undefined;
      return (row?.cnt ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /**
   * Hydrate a CandidateContext from the attached screening.profiles table.
   *
   * The Python screening DB is read-only here. We lookup by `profiles.id`
   * first; `candidate_name` fallback exists only to make demos forgiving.
   */
  hydrateFromScreening(
    profileId: string,
    candidateIdOverride?: string,
  ): CandidateContext | null {
    if (!this.isScreeningAttached()) {
      return null;
    }

    const lookup = profileId.trim();
    if (!lookup) {
      return null;
    }

    try {
      const row = this.db
        .prepare(`
          SELECT id, job_id, candidate_name, resume_text, overall_score,
                 verdict, analysis, created_at
          FROM ${SCREENING_PROFILES_TABLE}
          WHERE id = ? OR candidate_name = ?
          LIMIT 1
        `)
        .get(lookup, lookup) as Record<string, unknown> | undefined;

      if (!row) {
        return null;
      }

      const resolvedProfileId = String(row["id"] ?? lookup);
      return {
        candidateId: candidateIdOverride ?? resolvedProfileId,
        profileId: resolvedProfileId,
        profile: normalizeScreeningProfile(row),
        source: "screening",
      };
    } catch (error) {
      console.warn(
        "[persistence] Screening profile lookup failed: %s",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  getScreeningProfileCount(): number | null {
    if (!this.isScreeningAttached()) {
      return null;
    }

    try {
      const row = this.db
        .prepare(`SELECT count(*) AS cnt FROM ${SCREENING_PROFILES_TABLE}`)
        .get() as { cnt: number } | undefined;
      return row?.cnt ?? null;
    } catch {
      return null;
    }
  }

  saveSnapshot(
    session: InterviewSession,
    response?: InterviewResponse,
    finalEvaluation?: FinalEvaluation,
  ): void {
    if (this.disposed) {
      return;
    }

    const profileId =
      session.candidateContext?.profileId ??
      (session.candidateContext?.profile?.["id"] != null
        ? String(session.candidateContext.profile["id"])
        : null);
    const candidateId = session.candidateContext?.candidateId ?? "unknown";
    const status = session.isComplete ? "complete" : "in_progress";
    const evaluation = finalEvaluation ?? response?.evaluation;

    this.db
      .prepare(`
        INSERT INTO ${INTERVIEW_SNAPSHOTS_TABLE}
          (thread_id, profile_id, candidate_id, company_id, job_id,
           status, current_state, candidate_context_json, submissions_json,
           scores_json, final_evaluation_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        ON CONFLICT(thread_id) DO UPDATE SET
          profile_id = excluded.profile_id,
          candidate_id = excluded.candidate_id,
          company_id = excluded.company_id,
          job_id = excluded.job_id,
          status = excluded.status,
          current_state = excluded.current_state,
          candidate_context_json = excluded.candidate_context_json,
          submissions_json = excluded.submissions_json,
          scores_json = excluded.scores_json,
          final_evaluation_json = excluded.final_evaluation_json,
          updated_at = excluded.updated_at
      `)
      .run(
        session.threadId,
        profileId,
        candidateId,
        session.companyId,
        session.jobId,
        status,
        session.currentStateId,
        this.safeStringify(session.candidateContext),
        this.safeStringify(session.submissions),
        this.safeStringify(session.scores),
        this.safeStringify(evaluation),
      );
  }

  loadSnapshot(threadId: string): InterviewSnapshotRow | null {
    if (this.disposed) {
      return null;
    }

    const row = this.db
      .prepare(`SELECT * FROM ${INTERVIEW_SNAPSHOTS_TABLE} WHERE thread_id = ?`)
      .get(threadId) as InterviewSnapshotRow | undefined;
    return row ?? null;
  }

  rebuildSessionFromSnapshot(row: InterviewSnapshotRow): InterviewSession {
    const candidateContext = this.safeParse<CandidateContext>(
      row.candidate_context_json,
    ) ?? {
      candidateId: row.candidate_id,
      profileId: row.profile_id ?? undefined,
    };

    return {
      threadId: row.thread_id,
      companyId: row.company_id,
      jobId: row.job_id,
      currentStateId: row.current_state,
      submissions: this.safeParse<SubmissionRecord[]>(row.submissions_json) ?? [],
      scores: this.safeParse<Record<string, number>>(row.scores_json) ?? {},
      candidateContext,
      isComplete: row.status === "complete",
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
    };
  }

  loadSession(threadId: string): InterviewSession | null {
    const row = this.loadSnapshot(threadId);
    return row ? this.rebuildSessionFromSnapshot(row) : null;
  }

  private safeStringify(value: unknown): string | null {
    if (value === undefined) {
      return null;
    }

    try {
      return JSON.stringify(value) ?? null;
    } catch {
      return null;
    }
  }

  private safeParse<T>(json: string | null): T | null {
    if (!json) {
      return null;
    }

    try {
      return JSON.parse(json) as T;
    } catch {
      return null;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.db.close();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get paths(): { interviewDBPath: string; screeningDBPath: string | null } {
    return {
      interviewDBPath: this.interviewDBPath,
      screeningDBPath: this.screeningDBPath,
    };
  }
}
