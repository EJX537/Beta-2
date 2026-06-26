import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalArtifactStore } from "../src/agents/interview/artifacts/store.js";

describe("LocalArtifactStore", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function createStore(): LocalArtifactStore {
    const root = mkdtempSync(join(tmpdir(), "artifact-store-"));
    roots.push(root);
    return new LocalArtifactStore({ root });
  }

  it("stores transcript content locally and resolves a qualified artifact ref", () => {
    const store = createStore();
    const result = store.store({
      companyId: "demo-company",
      jobId: "software-developer",
      threadId: "thread-1",
      stateId: "video_question_1",
      kind: "transcript",
      fieldHint: "transcript_artifact_ref",
      contentType: "text/plain",
      fileName: "answer.txt",
      data: "I built a queue service.",
    });

    expect(result.artifact.ref).toMatch(
      /^artifact:\/\/interview\/v1\/demo-company\/software-developer\/thread-1\/video_question_1\/art_/
    );
    expect(result.submissionPatch).toEqual({
      transcript_artifact_ref: result.artifact.ref,
    });
    expect(existsSync(result.artifact.path)).toBe(true);
    expect(store.read(result.artifact.ref).toString("utf-8")).toBe(
      "I built a queue service.",
    );

    const candidateRef = store.toCandidateReference(result.artifact.ref);
    expect(candidateRef).toMatchObject({
      uri: result.artifact.ref,
      media_type: "text/plain",
      field_hint: "transcript_artifact_ref",
    });
  });

  it("stores code file maps and materializes runner files", () => {
    const store = createStore();
    const result = store.store({
      companyId: "demo-company",
      jobId: "software-developer",
      threadId: "thread-2",
      stateId: "technical_challenge",
      kind: "code",
      fieldHint: "code_artifact_ref",
      contentType: "application/json",
      fileName: "code.json",
      data: JSON.stringify({
        files: {
          "solution.js": "module.exports.answer = 42;",
          "README.md": "notes",
        },
      }),
    });

    expect(store.readCodeFiles(result.artifact.ref)).toEqual([
      { path: "solution.js", content: "module.exports.answer = 42;" },
      { path: "README.md", content: "notes" },
    ]);
  });

  it("rejects refs that do not belong to the expected interview state", () => {
    const store = createStore();
    const result = store.store({
      companyId: "demo-company",
      jobId: "software-developer",
      threadId: "thread-3",
      stateId: "video_question_1",
      kind: "audio",
      data: Buffer.from("audio bytes"),
    });

    expect(() =>
      store.validateOwnership(result.artifact.ref, {
        companyId: "demo-company",
        jobId: "software-developer",
        threadId: "thread-3",
        stateId: "video_question_2",
      }),
    ).toThrow(/does not belong/);
  });
});
