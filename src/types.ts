/** Shape of the incoming POST /run request body */
export interface RunRequest {
  payload: RunPayload;
}

export interface RunPayload {
  message: string;
  thread_id?: string;
}

/** Response returned immediately by POST /run */
export interface RunResponse {
  job_id: string;
}

export type JobStatus = "pending" | "running" | "completed" | "failed";

/** Result produced when a job reaches "completed" */
export interface RunResult {
  message: string;
  thread_id: string;
}

/** Projection returned by GET /jobs/{job_id} — matches AgentBox contract */
export interface JobView {
  status: JobStatus;
  result?: RunResult;
  error?: string;
}

/** Internal bookkeeping per job */
export interface JobRecord {
  id: string;
  status: JobStatus;
  payload: RunPayload;
  result?: RunResult;
  error?: string;
  created_at: number; // Date.now()
  terminal_at?: number; // set when status → completed | failed
}
