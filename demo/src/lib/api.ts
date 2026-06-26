/**
 * Shared API types and thin fetch wrappers for the Beta demo.
 * The website is served from the same origin as the agents, so all paths are relative.
 */

export interface MatchResult {
  job_id: string;
  title: string;
  description: string;
  score: number;
  verdict: "strong" | "consider" | "weak" | string;
  analysis?: {
    summary?: string;
    skill_breakdown?: { name: string; score: number; evidence?: string }[];
    missing_must_haves?: string[];
    red_flags?: string[];
    sources_checked?: string[];
  };
  error?: string;
}

export interface MatchResponse {
  matches: MatchResult[];
  count: number;
  candidate_name?: string | null;
}

export interface SubmissionRequirement {
  type: "none" | "text" | "video" | "code";
  fields: string[];
  any_of_fields?: string[];
  optional_fields?: string[];
  max_seconds?: number;
}

export interface InterviewStateView {
  threadId: string;
  companyId: string;
  jobId: string;
  currentStateId: string;
  currentStateLabel: string;
  isComplete: boolean;
  nextSubmission?: SubmissionRequirement | null;
  scores: Record<string, number>;
  evaluation?: FinalEvaluation | null;
}

export interface FinalEvaluation {
  recommendation: "strong_yes" | "yes" | "consider" | "no" | string;
  summary: string;
  scores: Record<string, number>;
  strengths: string[];
  risks: string[];
}

export interface InterviewResponse {
  thread_id: string;
  company_id: string;
  job_id: string;
  state: InterviewStateView;
  message: string;
  next_submission: SubmissionRequirement | null;
  complete: boolean;
  final_evaluation: FinalEvaluation | null;
}

export async function matchResume(form: FormData | { resume: string; candidate_name?: string }): Promise<MatchResponse> {
  const init: RequestInit = form instanceof FormData
    ? { method: "POST", body: form }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) };
  const res = await fetch("/match", init);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Matching failed");
  return data as MatchResponse;
}

export async function applyToJob(
  jobId: string,
  body: { candidate_name?: string | null; resume_text?: string | null; analysis?: unknown },
): Promise<void> {
  await fetch(`/jobs/${jobId}/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function interviewTurn(
  companyId: string,
  jobId: string,
  body: {
    message?: string;
    thread_id?: string;
    turn_id?: string;
    submission?: Record<string, unknown>;
    artifact_refs?: { uri?: string; ref?: string; path?: string; mediaType?: string; fieldHint?: string }[];
    candidate_context?: Record<string, unknown>;
    candidate_profile?: Record<string, unknown>;
    candidate_id?: string;
    profile_id?: string;
  },
): Promise<InterviewResponse> {
  const res = await fetch(`/interview/${companyId}/${jobId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Interview request failed");
  return data as InterviewResponse;
}

export async function uploadArtifact(
  companyId: string,
  jobId: string,
  threadId: string,
  payload: {
    state_id: string;
    kind?: "audio" | "transcript" | "video" | "code" | "file";
    field_hint?: string;
    file?: File;
    content?: string;
    files?: Record<string, string>;
  },
): Promise<{ artifact: { ref: string; uri: string }; submission_patch: Record<string, unknown> }> {
  let body: BodyInit;
  let headers: Record<string, string> = {};

  if (payload.file) {
    const fd = new FormData();
    fd.append("state_id", payload.state_id);
    fd.append("file", payload.file);
    if (payload.kind) fd.append("kind", payload.kind);
    if (payload.field_hint) fd.append("field_hint", payload.field_hint);
    body = fd;
  } else if (payload.files) {
    headers["content-type"] = "application/json";
    body = JSON.stringify({ state_id: payload.state_id, files: payload.files });
  } else {
    headers["content-type"] = "application/json";
    body = JSON.stringify({
      state_id: payload.state_id,
      kind: payload.kind,
      field_hint: payload.field_hint,
      content: payload.content,
    });
  }

  const res = await fetch(`/interview/${companyId}/${jobId}/${threadId}/uploads`, {
    method: "POST",
    headers,
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Upload failed");
  return data;
}
