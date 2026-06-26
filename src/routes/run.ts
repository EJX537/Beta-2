import { Hono } from "hono";
import OpenAI from "openai";
import { v4 as uuid } from "uuid";
import type { JobStore } from "../jobStore.js";
import type { RunPayload } from "../types.js";

interface Env {
  Variables: {
    store: JobStore;
    gmiClient: OpenAI | null;
    gmiModel: string | null;
  };
}

const router = new Hono<Env>();

router.post("/run", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || !body.payload) {
    return c.json({ error: "payload missing" }, 400);
  }

  const payload = body.payload as RunPayload;
  if (!payload.message || typeof payload.message !== "string") {
    return c.json({ error: "payload.message is required" }, 400);
  }

  const jobId = uuid();
  const store = c.var.store;
  const gmiClient = c.var.gmiClient;
  const gmiModel = c.var.gmiModel;

  store.insert({
    id: jobId,
    status: "pending",
    payload,
    created_at: Date.now(),
  });

  // Spawn async worker — don't await, return 202 immediately
  runJob(jobId, payload, store, gmiClient, gmiModel).catch((err) => {
    console.error("[agentbox] job %s unhandled error: %s", jobId, err);
  });

  return c.json({ job_id: jobId }, 202);
});

async function runJob(
  jobId: string,
  payload: RunPayload,
  store: JobStore,
  gmiClient: OpenAI | null,
  gmiModel: string | null,
): Promise<void> {
  store.updateStatus(jobId, "running");

  try {
    const { message, thread_id } = payload;
    const threadId = thread_id ?? jobId;

    let reply: string;

    if (gmiClient && gmiModel) {
      const completion = await gmiClient.chat.completions.create({
        model: gmiModel,
        messages: [
          {
            role: "system",
            content:
              "You are a focused AI agent. Answer the user's request concisely and accurately.",
          },
          { role: "user", content: message },
        ],
        max_tokens: 2048,
      });

      reply =
        completion.choices[0]?.message?.content ??
        "[no response from model]";
    } else {
      // No GMI MaaS configured — echo for local testing
      console.warn(
        "[agentbox] job %s: no GMI MaaS configured, echoing input",
        jobId,
      );
      reply = `Echo: ${message}`;
    }

    store.updateStatus(jobId, "completed", {
      result: { message: reply, thread_id: threadId },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[agentbox] job %s failed: %s", jobId, msg);
    store.updateStatus(jobId, "failed", { error: msg });
  }
}

export { router as runRouter };
