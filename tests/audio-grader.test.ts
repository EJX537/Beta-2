import { describe, expect, it, vi } from "vitest";
import { gradeAudioArtifact } from "../src/agents/interview/skills/audio-grader.js";
import type { LocalArtifactStore } from "../src/agents/interview/artifacts/store.js";
import type { StoredArtifactMetadata } from "../src/agents/interview/artifacts/store.js";
import type {
  AudioGradeResult,
  AudioGradingRubric,
} from "../src/agents/interview/types.js";

// ── Mocks ───────────────────────────────────────────────────────────────

function createMockArtifactStore(
  audioBytes: Buffer,
  contentType = "audio/webm",
  fileName = "response.webm",
): LocalArtifactStore {
  const metadata: StoredArtifactMetadata = {
    ref: "artifact://interview/v1/demo/job/thread/state/art_test123",
    uri: "artifact://interview/v1/demo/job/thread/state/art_test123",
    artifactId: "art_test123",
    companyId: "demo",
    jobId: "job",
    threadId: "thread",
    stateId: "state",
    kind: "audio",
    contentType,
    fileName,
    sizeBytes: audioBytes.length,
    sha256: "abc123",
    path: "/tmp/fake/response.webm",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  return {
    resolve: vi.fn().mockReturnValue(metadata),
    read: vi.fn().mockReturnValue(audioBytes),
    store: vi.fn(),
    toCandidateReference: vi.fn(),
    readCodeFiles: vi.fn(),
    validateOwnership: vi.fn(),
    root: "/tmp/fake",
    maxBytes: 25 * 1024 * 1024,
  } as unknown as LocalArtifactStore;
}

function createMockClient(response: unknown) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify(response),
              },
            },
          ],
        }),
      },
    },
  };
}

const rubric: AudioGradingRubric = {
  categories: [
    { label: "Clarity", description: "Clarity of speech", weight: 0.4, maxScore: 10 },
    { label: "Relevance", description: "Relevance to question", weight: 0.3, maxScore: 10 },
    { label: "Depth", description: "Depth of response", weight: 0.3, maxScore: 10 },
  ],
};

const questionText = "Tell me about your background and motivation.";

// ── Tests ───────────────────────────────────────────────────────────────

describe("gradeAudioArtifact", () => {
  it("reads artifact and returns parsed grade result", async () => {
    const artifactStore = createMockArtifactStore(
      Buffer.from("fake-audio-data"),
    );
    const mockResponse: AudioGradeResult = {
      score: 24,
      maxScore: 30,
      summary: "Good clarity and relevance, solid depth.",
      strengths: ["Clear articulation", "Relevant example"],
      risks: ["Could be more specific"],
      details: {
        Clarity: { score: 9, maxScore: 10, rationale: "Very clear" },
        Relevance: { score: 8, maxScore: 10, rationale: "On topic" },
        Depth: { score: 7, maxScore: 10, rationale: "Good depth" },
      },
    };
    const client = createMockClient(mockResponse);

    const result = await gradeAudioArtifact({
      artifactRef: "artifact://interview/v1/demo/job/thread/state/art_test123",
      questionText,
      rubric,
      artifactStore,
      client: client as never,
      model: "google/gemini-3.5-flash",
    });

    expect(result.score).toBe(24);
    expect(result.maxScore).toBe(30);
    expect(result.summary).toBe("Good clarity and relevance, solid depth.");
    expect(result.strengths).toEqual(["Clear articulation", "Relevant example"]);
    expect(result.risks).toEqual(["Could be more specific"]);
    expect(result.details).toBeDefined();
    expect((result.details!["Clarity"] as Record<string, unknown>)["score"]).toBe(9);

    // Verify the client was called with input_audio content part
    const createCall = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const userContent = createCall[0].messages[1].content;
    expect(userContent).toHaveLength(2);
    expect(userContent[1]).toHaveProperty("type", "input_audio");
    expect(userContent[1].input_audio.data).toBe(
      Buffer.from("fake-audio-data").toString("base64"),
    );

    // Verify artifact store was consulted
    expect(artifactStore.resolve).toHaveBeenCalledOnce();
    expect(artifactStore.read).toHaveBeenCalledOnce();
  });

  it("handles score=0 when parsing fails gracefully", async () => {
    const artifactStore = createMockArtifactStore(Buffer.from("data"));
    const client = createMockClient({
      score: 0,
      maxScore: 30,
      summary: "Inaudible response.",
      strengths: [],
      risks: ["Could not evaluate"],
    });

    const result = await gradeAudioArtifact({
      artifactRef: "artifact://interview/v1/demo/job/thread/state/art_test123",
      questionText,
      rubric,
      artifactStore,
      client: client as never,
      model: "google/gemini-3.5-flash",
    });

    expect(result.score).toBe(0);
    expect(result.maxScore).toBe(30);
    expect(result.summary).toBe("Inaudible response.");
  });

  it("throws when artifact is not found", async () => {
    const artifactStore = {
      resolve: vi.fn().mockImplementation(() => {
        throw new Error("Artifact not found");
      }),
      read: vi.fn(),
    } as unknown as LocalArtifactStore;

    const client = createMockClient({});

    await expect(
      gradeAudioArtifact({
        artifactRef: "artifact://missing",
        questionText,
        rubric,
        artifactStore,
        client: client as never,
        model: "google/gemini-3.5-flash",
      }),
    ).rejects.toThrow("Audio artifact not found");
  });

  it("throws when artifact is empty", async () => {
    const artifactStore = createMockArtifactStore(Buffer.alloc(0));

    const client = createMockClient({});

    await expect(
      gradeAudioArtifact({
        artifactRef: "artifact://interview/v1/demo/job/thread/state/art_test123",
        questionText,
        rubric,
        artifactStore,
        client: client as never,
        model: "google/gemini-3.5-flash",
      }),
    ).rejects.toThrow("Audio artifact is empty");
  });

  it("infers audio format from contentType", async () => {
    const artifactStore = createMockArtifactStore(
      Buffer.from("data"),
      "audio/mp3",
      "response.bin",
    );
    const client = createMockClient({
      score: 15,
      maxScore: 30,
      summary: "OK",
      strengths: [],
      risks: [],
    });

    await gradeAudioArtifact({
      artifactRef: "artifact://interview/v1/demo/job/thread/state/art_test123",
      questionText,
      rubric,
      artifactStore,
      client: client as never,
      model: "google/gemini-3.5-flash",
    });

    const createCall = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(createCall[0].messages[1].content[1].input_audio.format).toBe("mp3");
  });

  it("throws when the model returns non-JSON", async () => {
    const artifactStore = createMockArtifactStore(Buffer.from("data"));
    const client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: "This is not JSON at all",
                },
              },
            ],
          }),
        },
      },
    };

    await expect(
      gradeAudioArtifact({
        artifactRef: "artifact://interview/v1/demo/job/thread/state/art_test123",
        questionText,
        rubric,
        artifactStore,
        client: client as never,
        model: "google/gemini-3.5-flash",
      }),
    ).rejects.toThrow("Failed to parse grading model response as JSON");
  });

  it("throws when model returns empty content", async () => {
    const artifactStore = createMockArtifactStore(Buffer.from("data"));
    const client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: null,
                },
              },
            ],
          }),
        },
      },
    };

    await expect(
      gradeAudioArtifact({
        artifactRef: "artifact://interview/v1/demo/job/thread/state/art_test123",
        questionText,
        rubric,
        artifactStore,
        client: client as never,
        model: "google/gemini-3.5-flash",
      }),
    ).rejects.toThrow("Grading model returned an empty response");
  });

  it("uses wav as default format when nothing can be inferred", async () => {
    const artifactStore = createMockArtifactStore(
      Buffer.from("data"),
      "application/octet-stream",
      "response.bin",
    );
    const client = createMockClient({
      score: 15,
      maxScore: 30,
      summary: "OK",
      strengths: [],
      risks: [],
    });

    await gradeAudioArtifact({
      artifactRef: "artifact://interview/v1/demo/job/thread/state/art_test123",
      questionText,
      rubric,
      artifactStore,
      client: client as never,
      model: "google/gemini-3.5-flash",
    });

    const createCall = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(createCall[0].messages[1].content[1].input_audio.format).toBe("wav");
  });
});
