import { describe, it, expect } from "vitest";
import { JobStore } from "../src/jobStore.js";

describe("JobStore", () => {
  it("inserts and retrieves a job", () => {
    const store = new JobStore();
    store.insert({
      id: "abc-123",
      status: "pending",
      payload: { message: "hello" },
      created_at: Date.now(),
    });

    const job = store.get("abc-123");
    expect(job).toBeDefined();
    expect(job!.status).toBe("pending");
    expect(job!.payload.message).toBe("hello");
  });

  it("returns undefined for unknown id", () => {
    const store = new JobStore();
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("updates job status to completed with result", () => {
    const store = new JobStore();
    store.insert({
      id: "job-1",
      status: "pending",
      payload: { message: "test" },
      created_at: Date.now(),
    });

    store.updateStatus("job-1", "completed", {
      result: { message: "reply", thread_id: "thread-1" },
    });

    const job = store.get("job-1");
    expect(job!.status).toBe("completed");
    expect(job!.result!.message).toBe("reply");
    expect(job!.terminal_at).toBeDefined();
  });

  it("updates job status to failed with error", () => {
    const store = new JobStore();
    store.insert({
      id: "job-2",
      status: "running",
      payload: { message: "oops" },
      created_at: Date.now(),
    });

    store.updateStatus("job-2", "failed", { error: "something went wrong" });

    const job = store.get("job-2");
    expect(job!.status).toBe("failed");
    expect(job!.error).toBe("something went wrong");
    expect(job!.terminal_at).toBeDefined();
  });

  it("sweeps only terminal jobs past retention", () => {
    const store = new JobStore();
    const old = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago

    store.insert({
      id: "old-terminal",
      status: "completed",
      payload: { message: "old" },
      created_at: old,
      terminal_at: old,
    });

    store.insert({
      id: "recent-terminal",
      status: "completed",
      payload: { message: "recent" },
      created_at: Date.now(),
      terminal_at: Date.now(),
    });

    store.insert({
      id: "still-running",
      status: "running",
      payload: { message: "running" },
      created_at: old,
    });

    store.sweep();

    expect(store.get("old-terminal")).toBeUndefined();
    expect(store.get("recent-terminal")).toBeDefined();
    expect(store.get("still-running")).toBeDefined();
  });
});
