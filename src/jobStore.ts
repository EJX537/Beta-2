import type { JobRecord, JobStatus, RunResult } from "./types.js";

const RETENTION_MS = 60 * 60 * 1000; // 1 hour
const SWEEP_INTERVAL_MS = 60_000; // 60 seconds

/**
 * Simple in-memory job store.
 *
 * Thread-safe for single-process Node.js.
 * Jobs are evicted 1 hour after reaching a terminal state.
 */
export class JobStore {
  private readonly jobs = new Map<string, JobRecord>();

  constructor() {
    // Periodic sweep to evict terminal jobs
    setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  insert(record: JobRecord): void {
    this.jobs.set(record.id, record);
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  updateStatus(
    id: string,
    status: JobStatus,
    extra?: { result?: RunResult; error?: string },
  ): void {
    const record = this.jobs.get(id);
    if (!record) return;
    record.status = status;
    if (extra?.result) record.result = extra.result;
    if (extra?.error !== undefined) record.error = extra.error;
    if (status === "completed" || status === "failed") {
      record.terminal_at = Date.now();
    }
  }

  /** Remove terminal jobs older than RETENTION_MS */
  sweep(): void {
    const cutoff = Date.now() - RETENTION_MS;
    for (const [id, record] of this.jobs) {
      if (record.terminal_at && record.terminal_at < cutoff) {
        this.jobs.delete(id);
      }
    }
  }
}
