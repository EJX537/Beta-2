import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import OpenAI from "openai";
import { JobStore } from "./jobStore.js";
import { readGmiConfig, createGmiClient } from "./gmi.js";
import { healthRouter } from "./routes/health.js";
import { runRouter } from "./routes/run.js";
import { jobsRouter } from "./routes/jobs.js";
import { interviewRouter, createAgentCache } from "./routes/interview.js";
import { InterviewPersistenceBridge } from "./agents/interview/persistence/index.js";

const port = Number(process.env["PORT"] ?? 8080);

// ── Bootstrap ────────────────────────────────────────────────────────────
const store = new JobStore();

const gmiConfig = readGmiConfig();
const gmiClient = gmiConfig ? createGmiClient(gmiConfig) : null;
const gmiModel = gmiConfig?.model ?? null;
const interviewAgentCache = createAgentCache();
const interviewPersistence = createInterviewPersistenceBridge();

type AppEnv = {
  Variables: {
    store: JobStore;
    gmiClient: OpenAI | null;
    gmiModel: string | null;
    gmiConfig: ReturnType<typeof readGmiConfig>;
    interviewAgentCache: ReturnType<typeof createAgentCache>;
    persistence: InterviewPersistenceBridge | null;
  };
};

function createInterviewPersistenceBridge(): InterviewPersistenceBridge | null {
  try {
    return new InterviewPersistenceBridge();
  } catch (error) {
    console.warn(
      "[persistence] Interview DB unavailable; continuing without persistence: %s",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

// ── App ──────────────────────────────────────────────────────────────────
const app = new Hono<AppEnv>();

app.use("*", cors());

// Inject shared state into context
app.use("*", async (c, next) => {
  c.set("store", store);
  c.set("gmiClient", gmiClient);
  c.set("gmiModel", gmiModel);
  c.set("gmiConfig", gmiConfig);
  c.set("interviewAgentCache", interviewAgentCache);
  c.set("persistence", interviewPersistence);
  await next();
});

// Mount routes
app.route("/", healthRouter);
app.route("/", runRouter);
app.route("/", jobsRouter);
app.route("/", interviewRouter);

// ── Start ────────────────────────────────────────────────────────────────
console.info("[server] starting on port %d", port);

serve(
  { fetch: app.fetch, port },
  (info) => {
    console.info("[server] listening on http://0.0.0.0:%d", info.port);
  },
);
