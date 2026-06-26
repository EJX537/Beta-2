import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { InterviewPersistenceBridge } from "../src/agents/interview/persistence/bridge.js";
import type {
  FinalEvaluation,
  InterviewSession,
} from "../src/agents/interview/types.js";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "interview-persistence-"));
}

function createScreeningDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      candidate_name TEXT NOT NULL,
      resume_text TEXT NOT NULL,
      overall_score REAL NOT NULL,
      verdict TEXT NOT NULL,
      analysis TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO profiles
      (id, job_id, candidate_name, resume_text, overall_score, verdict, analysis, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "profile-1",
    "software-developer",
    "Ada Lovelace",
    "Built analytical engines.",
    92,
    "strong",
    JSON.stringify({ summary: "Excellent systems candidate" }),
    "2026-06-26T13:00:00Z",
  );
  db.close();
}

describe("InterviewPersistenceBridge", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hydrates candidate context from attached screening DB and stores interview snapshots separately", () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const screeningDBPath = join(dir, "agent1.db");
    const interviewDBPath = join(dir, "interview.db");
    createScreeningDb(screeningDBPath);

    const bridge = new InterviewPersistenceBridge({
      interviewDBPath,
      screeningDBPath,
    });

    expect(bridge.getScreeningProfileCount()).toBe(1);

    const context = bridge.hydrateFromScreening("profile-1");
    expect(context).toMatchObject({
      candidateId: "profile-1",
      profileId: "profile-1",
      source: "screening",
    });
    expect(bridge.hydrateFromScreening("Ada Lovelace")).toBeNull();
    expect(context?.profile?.["analysis"]).toEqual({
      summary: "Excellent systems candidate",
    });

    const evaluation: FinalEvaluation = {
      recommendation: "yes",
      scores: { technical: 10 },
      strengths: ["Correct code"],
      risks: [],
      summary: "Passed technical challenge.",
    };
    const session: InterviewSession = {
      threadId: "thread-1",
      companyId: "demo-company",
      jobId: "software-developer",
      currentStateId: "complete",
      submissions: [
        {
          stateId: "technical_challenge",
          data: { score: 10 },
          submittedAt: 1,
        },
      ],
      scores: { technical: 10 },
      candidateContext: context ?? undefined,
      finalEvaluation: evaluation,
      isComplete: true,
      createdAt: 1,
      updatedAt: 2,
    };

    bridge.saveSnapshot(session, undefined, evaluation);

    const row = bridge.loadSnapshot("thread-1");
    expect(row).toMatchObject({
      thread_id: "thread-1",
      profile_id: "profile-1",
      candidate_id: "profile-1",
      status: "complete",
      current_state: "complete",
    });

    const restored = bridge.rebuildSessionFromSnapshot(row!);
    expect(restored).toMatchObject({
      threadId: "thread-1",
      currentStateId: "complete",
      isComplete: true,
      scores: { technical: 10 },
    });

    const loadedSession = bridge.loadSession("thread-1");
    expect(loadedSession).toMatchObject({
      threadId: "thread-1",
      companyId: "demo-company",
      jobId: "software-developer",
      currentStateId: "complete",
      candidateContext: {
        candidateId: "profile-1",
        profileId: "profile-1",
      },
      finalEvaluation: {
        recommendation: "yes",
        summary: "Passed technical challenge.",
      },
    });

    bridge.dispose();

    const screening = new DatabaseSync(screeningDBPath);
    const screeningRows = screening
      .prepare("SELECT count(*) AS cnt FROM profiles")
      .get() as { cnt: number };
    expect(screeningRows.cnt).toBe(1);
    screening.close();
  });

  it("works when no screening DB is attached", () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const bridge = new InterviewPersistenceBridge({
      interviewDBPath: join(dir, "interview.db"),
      screeningDBPath: null,
    });

    expect(bridge.getScreeningProfileCount()).toBeNull();
    expect(bridge.hydrateFromScreening("missing-profile")).toBeNull();

    bridge.dispose();
  });
});
