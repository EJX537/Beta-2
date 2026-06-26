import { Hono } from "hono";
import type OpenAI from "openai";
import type { JobStore } from "../jobStore.js";
import type { GmiConfig } from "../gmi.js";
import { DEFAULT_GMI_MODEL } from "../gmi.js";
import { createInterviewAgent } from "../agents/interview/agent.js";
import type { CreateInterviewAgentResult } from "../agents/interview/agent.js";
import type { InterviewPersistenceBridge } from "../agents/interview/persistence/bridge.js";
import type {
  CandidateContext,
  InterviewRequest,
  InterviewResponse,
} from "../agents/interview/types.js";

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

// ── Router ───────────────────────────────────────────────────────────────

const router = new Hono<Env>();

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
  let submission: Record<string, unknown> | undefined;
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
    submission = asRecord(bodyRecord["submission"]);

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

  const cacheKey = `${companyId}/${jobId}:${configRoot ?? "default"}`;
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
    submission,
    candidateContext: mergedCandidateContext,
  };

  let response: InterviewResponse;
  try {
    response = await agentResult.handleInteraction(interviewRequest);
  } catch (error) {
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
          code: "AGENT_ERROR",
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
