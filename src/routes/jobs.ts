import { Hono } from "hono";
import type { JobStore } from "../jobStore.js";
import type { JobView } from "../types.js";

interface Env {
  Variables: {
    store: JobStore;
  };
}

const router = new Hono<Env>();

router.get("/jobs/:jobId", (c) => {
  const { jobId } = c.req.param();
  const record = c.var.store.get(jobId);

  if (!record) {
    return c.json({ error: "job not found" }, 404);
  }

  const view: JobView = { status: record.status };
  if (record.result) view.result = record.result;
  if (record.error) view.error = record.error;

  return c.json(view, 200);
});

export { router as jobsRouter };
