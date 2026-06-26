import { extname } from "node:path";
import OpenAI from "openai";
import type { LocalArtifactStore } from "../artifacts/store.js";
import type {
  AudioGradeResult,
  AudioGradingRubric,
} from "../types.js";

// ── Input ───────────────────────────────────────────────────────────────

export interface GradeAudioArtifactInput {
  /** Artifact ref to resolve via the artifact store. */
  artifactRef: string;
  /** The question text the candidate was responding to. */
  questionText: string;
  /** Grading rubric with categories. */
  rubric: AudioGradingRubric;
  /** Local artifact store for reading the audio bytes. */
  artifactStore: LocalArtifactStore;
  /** OpenAI-compatible client (GMI MaaS). */
  client: OpenAI;
  /** Model identifier (e.g. "google/gemini-3.5-flash"). */
  model: string;
}

// ── Implementation ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a strict audio-grading assistant for an interview platform.
You receive an audio recording of a candidate's answer to an interview question.
Your job is to evaluate the response against the provided rubric categories and return a JSON object.

Respond **only** with a JSON object in this exact shape (no markdown, no code fences):
{
  "score": <number>,
  "maxScore": <number>,
  "summary": "<brief summary of the evaluation>",
  "strengths": ["<strength 1>", "<strength 2>", ...],
  "risks": ["<risk 1>", "<risk 2>", ...],
  "details": {
    "<category label>": {
      "score": <number>,
      "maxScore": <number>,
      "rationale": "<short rationale for this category>"
    },
    ...
  }
}

- "score" must be the total weighted score across all categories.
- "maxScore" must be the sum of all category maxScores.
- Each category in "details" must contain its own score, maxScore, and rationale.
- Be thorough but fair. Consider clarity, relevance, depth, and any other rubric categories.
- If the audio is empty, garbled, or inaudible, note that in the summary and score accordingly.`;

/**
 * Grade an audio artifact submission using the configured GMI grading model.
 */
export async function gradeAudioArtifact(
  input: GradeAudioArtifactInput,
): Promise<AudioGradeResult> {
  const { artifactRef, questionText, rubric, artifactStore, client, model } =
    input;

  // 1. Read audio bytes from artifact store
  let audioBuffer: Buffer;
  let contentType: string;
  let fileName: string;

  try {
    const metadata = artifactStore.resolve(artifactRef);
    audioBuffer = artifactStore.read(artifactRef);
    contentType = metadata.contentType;
    fileName = metadata.fileName;
  } catch (error) {
    throw new Error(
      `Audio artifact not found or unreadable: ${artifactRef}. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (audioBuffer.length === 0) {
    throw new Error(`Audio artifact is empty: ${artifactRef}`);
  }

  // 2. Infer audio format from contentType or fileName
  const audioFormat = inferAudioFormat(contentType, fileName);

  // 3. Build rubric description for the prompt
  const rubricDescription = rubric.categories
    .map(
      (cat, i) =>
        `${i + 1}. "${cat.label}" (weight: ${cat.weight}, max score: ${cat.maxScore}) — ${cat.description}`,
    )
    .join("\n");

  const maxScore = rubric.categories.reduce(
    (sum, cat) => sum + cat.maxScore,
    0,
  );

  // 4. Send to grading model
  const base64Audio = audioBuffer.toString("base64");

  // Build the multimodal content parts.
  // The input_audio part type is supported by the GMI MaaS endpoint
  // (OpenAI-compatible) but not yet in the openai SDK type definitions.
  const userContent: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: `Interview question: "${questionText}"\n\nRubric:\n${rubricDescription}\n\nPlease grade the following audio response.`,
    },
    {
      type: "input_audio",
      input_audio: {
        data: base64Audio,
        format: audioFormat,
      },
    },
  ];

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: userContent as unknown as Array<{
          type: "text";
          text: string;
        }>,
      },
    ],
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error(
      "Grading model returned an empty response. Check model availability and API key.",
    );
  }

  // 5. Parse JSON response
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Failed to parse grading model response as JSON. Raw: ${content.slice(0, 200)}`,
    );
  }

  // 6. Validate and return
  const score = Number(parsed["score"]) ?? 0;
  const summary = String(parsed["summary"] ?? "");
  const strengths = ensureStringArray(parsed["strengths"]);
  const risks = ensureStringArray(parsed["risks"]);
  const details = parsed["details"] as Record<string, unknown> | undefined;

  return {
    score: isNaN(score) ? 0 : score,
    maxScore: Number(parsed["maxScore"]) ?? maxScore,
    summary,
    strengths,
    risks,
    details,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Infer the audio format string (as used by OpenAI `input_audio.format`)
 * from the artifact's contentType or fileName.
 */
function inferAudioFormat(
  contentType: string,
  fileName: string,
): "wav" | "mp3" | "flac" | "opus" | "aac" | "pcm" | "webm" {
  // Check fileName extension first
  const ext = extname(fileName).toLowerCase().replace(".", "");
  if (isSupportedFormat(ext)) return ext as "wav" | "mp3" | "flac" | "opus" | "aac" | "pcm" | "webm";

  // Fall back to contentType
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("mp3")) return "mp3";
  if (contentType.includes("flac")) return "flac";
  if (contentType.includes("opus")) return "opus";
  if (contentType.includes("aac")) return "aac";
  if (contentType.includes("pcm")) return "pcm";
  if (contentType.includes("webm")) return "webm";

  return "wav"; // safest default
}

const SUPPORTED_FORMATS = new Set([
  "wav",
  "mp3",
  "flac",
  "opus",
  "aac",
  "pcm",
  "webm",
]);

function isSupportedFormat(ext: string): boolean {
  return SUPPORTED_FORMATS.has(ext);
}

function ensureStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  return [];
}
