import { Hono, type Context } from "hono";
import type OpenAI from "openai";
import type { JobStore } from "../jobStore.js";
import type { GmiConfig } from "../gmi.js";
import { DEFAULT_GMI_MODEL, readGmiGradingConfig, createGmiGradingClient } from "../gmi.js";
import { createInterviewAgent } from "../agents/interview/agent.js";
import type { CreateInterviewAgentResult } from "../agents/interview/agent.js";
import { LocalArtifactStore } from "../agents/interview/artifacts/store.js";
import type { ArtifactKind } from "../agents/interview/artifacts/store.js";
import type { InterviewPersistenceBridge } from "../agents/interview/persistence/bridge.js";
import type {
  CandidateArtifactReference,
  CandidateContext,
  InterviewErrorCode,
  InterviewRequest,
  InterviewResponse,
} from "../agents/interview/types.js";
import { InterviewError } from "../agents/interview/errors.js";

// ── Interview Error Status Code Mapping ─────────────────────────────────

/**
 * Map an InterviewErrorCode to the appropriate HTTP status code.
 */
function interviewErrorStatusCode(code: InterviewErrorCode): number {
  switch (code) {
    case "INVALID_JSON":
    case "INVALID_PARAMS":
    case "MISSING_CANDIDATE_CONTEXT":
      return 400;
    case "CONFIG_NOT_FOUND":
    case "THREAD_NOT_FOUND":
      return 404;
    case "THREAD_ROUTE_MISMATCH":
    case "WRONG_STATE":
      return 409;
    case "INVALID_SUBMISSION":
      return 422;
    case "INTERVIEW_AGENT_FAILED":
      return 500;
    default:
      return 500;
  }
}

// ── Types ────────────────────────────────────────────────────────────────

interface Env {
  Variables: {
    store: JobStore;
    gmiClient: OpenAI | null;
    gmiModel: string | null;
    gmiConfig: GmiConfig | null;
    interviewAgentCache: InterviewAgentCache;
    persistence: InterviewPersistenceBridge | null;
  };
}

interface InterviewAgentCache {
  get(key: string): Promise<CreateInterviewAgentResult> | CreateInterviewAgentResult | undefined;
  set(key: string, agent: Promise<CreateInterviewAgentResult> | CreateInterviewAgentResult): void;
}

function createAgentCache(): InterviewAgentCache {
  const agents = new Map<string, Promise<CreateInterviewAgentResult> | CreateInterviewAgentResult>();
  return {
    get(key: string) {
      return agents.get(key);
    },
    set(key: string, agent: Promise<CreateInterviewAgentResult> | CreateInterviewAgentResult) {
      agents.set(key, agent);
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function candidateContextFromRecord(
  record: Record<string, unknown> | undefined,
  threadId?: string,
): CandidateContext | undefined {
  if (!record) {
    return undefined;
  }

  const profileId = stringField(record, "profile_id", "profileId", "id");
  const candidateId =
    stringField(record, "candidate_id", "candidateId") ?? profileId;

  if (!candidateId) {
    return undefined;
  }

  return {
    candidateId,
    profileId,
    profile: record,
    source: stringField(record, "source"),
    thread_id: threadId ?? stringField(record, "thread_id", "threadId"),
  };
}

function candidateContextFromIds(params: {
  candidateId?: string;
  profileId?: string;
  threadId?: string;
}): CandidateContext | undefined {
  const candidateId = params.candidateId ?? params.profileId;
  if (!candidateId) {
    return undefined;
  }

  return {
    candidateId,
    profileId: params.profileId,
    thread_id: params.threadId,
  };
}

function hydrateCandidateContext(
  persistence: InterviewPersistenceBridge | null,
  context: CandidateContext | undefined,
): CandidateContext | undefined {
  if (!persistence || !context || context.profile) {
    return context;
  }

  const lookupId = context.profileId ?? context.candidateId;
  const candidateIdOverride =
    context.candidateId === "unknown" ? undefined : context.candidateId;
  const hydrated = persistence.hydrateFromScreening(
    lookupId,
    candidateIdOverride,
  );

  return hydrated
    ? {
        ...hydrated,
        thread_id: context.thread_id ?? hydrated.thread_id,
      }
    : context;
}

interface UploadedFileLike {
  name?: string;
  type?: string;
  size?: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

function isUploadedFileLike(value: unknown): value is UploadedFileLike {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as UploadedFileLike).arrayBuffer === "function",
  );
}

function normalizeArtifactKind(value: unknown): ArtifactKind | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  if (["audio", "transcript", "video", "code", "file"].includes(value)) {
    return value as ArtifactKind;
  }
  return undefined;
}

function inferArtifactKind(record: Record<string, unknown>): ArtifactKind {
  const explicit = normalizeArtifactKind(record["kind"]);
  if (explicit) {
    return explicit;
  }
  if (record["files"] !== undefined) {
    return "code";
  }
  const fieldHint = stringField(record, "field_hint", "fieldHint");
  if (fieldHint?.includes("audio")) {
    return "audio";
  }
  if (fieldHint?.includes("transcript")) {
    return "transcript";
  }
  if (fieldHint?.includes("video")) {
    return "video";
  }
  if (fieldHint?.includes("code")) {
    return "code";
  }
  return "file";
}

async function parseArtifactUploadBody(c: Context<Env>): Promise<{
  stateId: string;
  kind: ArtifactKind;
  fieldHint?: string;
  contentType?: string;
  fileName?: string;
  data: Buffer | string;
}> {
  const contentTypeHeader = c.req.header("content-type") ?? "";

  if (contentTypeHeader.includes("multipart/form-data")) {
    const body = await c.req.parseBody();
    const record = body as Record<string, unknown>;
    const stateId = stringField(record, "state_id", "stateId");
    if (!stateId) {
      throw new Error("Upload requires state_id.");
    }

    const file = record["file"];
    const kind = inferArtifactKind(record);
    const fieldHint = stringField(record, "field_hint", "fieldHint");

    if (isUploadedFileLike(file)) {
      return {
        stateId,
        kind,
        fieldHint,
        contentType: file.type || stringField(record, "content_type", "contentType"),
        fileName: file.name || stringField(record, "filename", "fileName"),
        data: Buffer.from(await file.arrayBuffer()),
      };
    }

    const textContent =
      stringField(record, "content", "text", "transcript") ??
      (typeof file === "string" ? file : undefined);
    if (!textContent) {
      throw new Error("Multipart upload requires a file or text content.");
    }
    return {
      stateId,
      kind,
      fieldHint,
      contentType: stringField(record, "content_type", "contentType"),
      fileName: stringField(record, "filename", "fileName"),
      data: textContent,
    };
  }

  const body = asRecord(await c.req.json<Record<string, unknown>>()) ?? {};
  const stateId = stringField(body, "state_id", "stateId");
  if (!stateId) {
    throw new Error("Upload requires state_id.");
  }

  const kind = inferArtifactKind(body);
  const contentType =
    stringField(body, "content_type", "contentType") ??
    (body["files"] !== undefined ? "application/json" : undefined);
  const fileName = stringField(body, "filename", "fileName");
  const fieldHint = stringField(body, "field_hint", "fieldHint");

  if (body["files"] !== undefined) {
    return {
      stateId,
      kind: "code",
      fieldHint: fieldHint ?? "code_artifact_ref",
      contentType: contentType ?? "application/json",
      fileName: fileName ?? "code.json",
      data: JSON.stringify({ files: body["files"] }, null, 2),
    };
  }

  const base64Content = stringField(body, "content_base64", "base64");
  if (base64Content) {
    return {
      stateId,
      kind,
      fieldHint,
      contentType,
      fileName,
      data: Buffer.from(base64Content, "base64"),
    };
  }

  const textContent = stringField(body, "content", "text", "transcript");
  if (!textContent) {
    throw new Error("JSON upload requires files, content_base64, content, text, or transcript.");
  }

  return {
    stateId,
    kind,
    fieldHint,
    contentType,
    fileName,
    data: textContent,
  };
}

function artifactResponse(input: ReturnType<LocalArtifactStore["store"]>) {
  const { artifact, submissionPatch } = input;
  return {
    artifact: {
      ref: artifact.ref,
      uri: artifact.uri,
      kind: artifact.kind,
      field_hint: artifact.fieldHint ?? null,
      content_type: artifact.contentType,
      file_name: artifact.fileName,
      size_bytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      path: artifact.path,
      created_at: artifact.createdAt,
    },
    submission_patch: submissionPatch,
  };
}

function artifactRefsFromSubmission(
  submission: Record<string, unknown> | undefined,
): string[] {
  if (!submission) {
    return [];
  }

  return Object.entries(submission)
    .filter(([key, value]) =>
      (key === "artifact_ref" || key.endsWith("_artifact_ref")) &&
      typeof value === "string" &&
      value.length > 0,
    )
    .map(([, value]) => value as string);
}

function resolveArtifactReferences(
  store: LocalArtifactStore,
  refs: string[],
): CandidateArtifactReference[] {
  return refs.map((ref) => {
    try {
      return store.toCandidateReference(ref);
    } catch {
      return { uri: ref };
    }
  });
}

// ── Router ───────────────────────────────────────────────────────────────

const router = new Hono<Env>();

router.post("/interview/:companyId/:jobId/:threadId/uploads", async (c) => {
  const { companyId, jobId, threadId } = c.req.param();

  let upload;
  try {
    upload = await parseArtifactUploadBody(c);
  } catch (error) {
    return c.json(
      {
        error: {
          code: "INVALID_UPLOAD",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      400,
    );
  }

  try {
    const artifactStore = new LocalArtifactStore();
    const stored = artifactStore.store({
      companyId,
      jobId,
      threadId,
      stateId: upload.stateId,
      kind: upload.kind,
      fieldHint: upload.fieldHint,
      contentType: upload.contentType,
      fileName: upload.fileName,
      data: upload.data,
    });

    return c.json(artifactResponse(stored), 201);
  } catch (error) {
    return c.json(
      {
        error: {
          code: "UPLOAD_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      500,
    );
  }
});

router.post("/interview/:companyId/:jobId", async (c) => {
  const { companyId, jobId } = c.req.param();
  const gmiConfig = c.var.gmiConfig;

  if (!gmiConfig) {
    return c.json(
      {
        error: {
          code: "GMI_NOT_CONFIGURED",
          message:
            "GMI MaaS is not configured. Set GMI_MAAS_BASE_URL and GMI_MAAS_API_KEY environment variables.",
        },
      },
      503,
    );
  }

  const queryThreadId = c.req.query("thread_id");
  const queryCandidateContext = candidateContextFromIds({
    candidateId: c.req.query("candidate_id"),
    profileId: c.req.query("profile_id"),
    threadId: queryThreadId,
  });

  const paramsRaw = c.req.query("params");
  let paramsCandidateContext: CandidateContext | undefined;
  if (paramsRaw) {
    try {
      const decoded = asRecord(
        JSON.parse(Buffer.from(paramsRaw, "base64").toString("utf-8")),
      );
      paramsCandidateContext =
        candidateContextFromRecord(asRecord(decoded?.["candidate_context"]), queryThreadId) ??
        candidateContextFromRecord(asRecord(decoded?.["candidate_profile"]), queryThreadId) ??
        candidateContextFromIds({
          candidateId: stringField(decoded, "candidate_id", "candidateId"),
          profileId: stringField(decoded, "profile_id", "profileId"),
          threadId: stringField(decoded, "thread_id", "threadId") ?? queryThreadId,
        });
    } catch {
      return c.json(
        {
          error: {
            code: "INVALID_PARAMS",
            message: "The `params` query parameter is not valid base64 JSON.",
          },
        },
        400,
      );
    }
  }

  let message: string;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let submission: Record<string, unknown> | undefined;
  let artifactRefs: InterviewRequest["artifactRefs"];
  let bodyCandidateContext: CandidateContext | undefined;
  let bodyIdContext: CandidateContext | undefined;
  let configRoot: string | undefined;

  try {
    const body = await c.req.json<Record<string, unknown>>();
    const bodyRecord = asRecord(body) ?? {};

    message =
      typeof bodyRecord["message"] === "string" && bodyRecord["message"].length > 0
        ? bodyRecord["message"]
        : "Continue the interview.";
    threadId = stringField(bodyRecord, "thread_id", "threadId") ?? queryThreadId;
    turnId = stringField(bodyRecord, "turn_id", "turnId");
    submission = asRecord(bodyRecord["submission"]);
    artifactRefs = Array.isArray(bodyRecord["artifact_refs"])
      ? (bodyRecord["artifact_refs"] as InterviewRequest["artifactRefs"])
      : Array.isArray(bodyRecord["artifactRefs"])
        ? (bodyRecord["artifactRefs"] as InterviewRequest["artifactRefs"])
        : undefined;

    bodyCandidateContext =
      candidateContextFromRecord(asRecord(bodyRecord["candidate_context"]), threadId) ??
      candidateContextFromRecord(asRecord(bodyRecord["candidate_profile"]), threadId);

    bodyIdContext = candidateContextFromIds({
      candidateId: stringField(bodyRecord, "candidate_id", "candidateId"),
      profileId: stringField(bodyRecord, "profile_id", "profileId"),
      threadId,
    });

    configRoot = stringField(asRecord(bodyRecord["metadata"]), "configRoot", "config_root");
  } catch {
    return c.json(
      {
        error: {
          code: "INVALID_JSON",
          message: "Request body must be valid JSON.",
        },
      },
      400,
    );
  }

  const mergedCandidateContext = hydrateCandidateContext(
    c.var.persistence,
    bodyCandidateContext ?? bodyIdContext ?? paramsCandidateContext ?? queryCandidateContext,
  );
  const artifactStore = new LocalArtifactStore();
  const submissionArtifactRefs = resolveArtifactReferences(
    artifactStore,
    artifactRefsFromSubmission(submission),
  );
  const mergedArtifactRefs = [
    ...(artifactRefs ?? []),
    ...submissionArtifactRefs,
  ];

  // Build audio grading client (best-effort; if GMI grading is unconfigured, skip)
  let audioGradingClient: OpenAI | undefined;
  let audioGradingModel: string | undefined;
  try {
    const gradingConfig = readGmiGradingConfig();
    audioGradingClient = createGmiGradingClient(gradingConfig);
    audioGradingModel = gradingConfig.model;
  } catch {
    console.warn("[interview] GMI grading not configured — audio grading will be skipped");
  }

  const cacheKey = `${companyId}/${jobId}:${configRoot ?? "default"}:${artifactStore.root}`;
  const cache = c.var.interviewAgentCache;

  let agentResult: CreateInterviewAgentResult;
  const cached = cache.get(cacheKey);
  if (cached instanceof Promise) {
    agentResult = await cached;
  } else if (cached) {
    agentResult = cached;
  } else {
    const agentPromise = createInterviewAgent(
      {
        gmi: {
          baseURL: gmiConfig.baseURL,
          apiKey: gmiConfig.apiKey,
          modelId: gmiConfig.model || DEFAULT_GMI_MODEL,
        },
        companyId,
        jobId,
        persistence: c.var.persistence ?? undefined,
        artifactStore,
        audioGradingClient,
        audioGradingModel,
      },
      configRoot ? { configRoot } : undefined,
    );
    cache.set(cacheKey, agentPromise);
    agentResult = await agentPromise;
    cache.set(cacheKey, agentResult);
  }

  const interviewRequest: InterviewRequest = {
    message,
    threadId,
    turnId,
    submission,
    artifactRefs: mergedArtifactRefs.length > 0 ? mergedArtifactRefs : undefined,
    candidateContext: mergedCandidateContext,
  };

  let response: InterviewResponse;
  try {
    response = await agentResult.handleInteraction(interviewRequest);
  } catch (error) {
    if (error instanceof InterviewError) {
      const statusCode = interviewErrorStatusCode(error.code) as 400 | 404 | 409 | 422 | 500;
      return c.json(
        { error: error.toResponsePayload() },
        statusCode,
      );
    }

    const msg = error instanceof Error ? error.message : String(error);
    console.error(
      "[interview] handleInteraction error for %s/%s: %s",
      companyId,
      jobId,
      msg,
    );
    return c.json(
      {
        error: {
          code: "INTERVIEW_AGENT_FAILED",
          message: `Interview agent error: ${msg}`,
        },
      },
      500,
    );
  }

  return c.json(
    {
      thread_id: response.threadId,
      company_id: companyId,
      job_id: jobId,
      state: response.state,
      message: response.message,
      next_submission: response.nextSubmission ?? null,
      complete: response.isComplete,
      final_evaluation: response.evaluation ?? null,
    },
    200,
  );
});

export { router as interviewRouter, createAgentCache };
export type { InterviewAgentCache };
