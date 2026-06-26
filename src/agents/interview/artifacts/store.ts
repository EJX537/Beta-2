import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { CandidateArtifactReference, RunnerFile } from "../types.js";

export type ArtifactKind = "audio" | "transcript" | "video" | "code" | "file";

export interface StoreArtifactInput {
  companyId: string;
  jobId: string;
  threadId: string;
  stateId: string;
  kind: ArtifactKind;
  fieldHint?: string;
  contentType?: string;
  fileName?: string;
  data: Buffer | string;
}

export interface StoredArtifactMetadata {
  ref: string;
  uri: string;
  artifactId: string;
  companyId: string;
  jobId: string;
  threadId: string;
  stateId: string;
  kind: ArtifactKind;
  fieldHint?: string;
  contentType: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  path: string;
  createdAt: string;
}

export interface StoredArtifactResult {
  artifact: StoredArtifactMetadata;
  submissionPatch: Record<string, string>;
}

const REF_PREFIX = "artifact://interview/v1";
const DEFAULT_ROOT = "data/interview-artifacts";
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export class LocalArtifactStore {
  readonly root: string;
  readonly maxBytes: number;

  constructor(options?: { root?: string; maxBytes?: number }) {
    this.root = resolve(
      options?.root ?? process.env["INTERVIEW_ARTIFACT_ROOT"] ?? DEFAULT_ROOT,
    );
    this.maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
    mkdirSync(this.root, { recursive: true });
  }

  store(input: StoreArtifactInput): StoredArtifactResult {
    const companyId = sanitizeSegment(input.companyId, "companyId");
    const jobId = sanitizeSegment(input.jobId, "jobId");
    const threadId = sanitizeSegment(input.threadId, "threadId");
    const stateId = sanitizeSegment(input.stateId, "stateId");
    const kind = normalizeKind(input.kind);
    const data = Buffer.isBuffer(input.data)
      ? input.data
      : Buffer.from(input.data, "utf-8");

    if (data.length === 0) {
      throw new Error("Artifact content is empty.");
    }
    if (data.length > this.maxBytes) {
      throw new Error(
        `Artifact is too large: ${data.length} bytes > ${this.maxBytes} bytes`,
      );
    }

    const artifactId = `art_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const extension = extensionFor(input.fileName, input.contentType, kind);
    const fileName = sanitizeFileName(input.fileName ?? `${kind}${extension}`);
    const artifactDir = this.resolveInsideRoot(
      companyId,
      jobId,
      threadId,
      stateId,
      artifactId,
    );
    mkdirSync(artifactDir, { recursive: true });

    const artifactPath = this.resolveInsideRoot(
      companyId,
      jobId,
      threadId,
      stateId,
      artifactId,
      fileName,
    );
    writeFileSync(artifactPath, data);

    const sha256 = createHash("sha256").update(data).digest("hex");
    const ref = buildArtifactRef({ companyId, jobId, threadId, stateId, artifactId });
    const metadata: StoredArtifactMetadata = {
      ref,
      uri: ref,
      artifactId,
      companyId,
      jobId,
      threadId,
      stateId,
      kind,
      fieldHint: input.fieldHint,
      contentType: input.contentType ?? defaultContentType(kind),
      fileName,
      sizeBytes: data.length,
      sha256,
      path: artifactPath,
      createdAt: new Date().toISOString(),
    };

    writeFileSync(
      join(artifactDir, "metadata.json"),
      JSON.stringify(metadata, null, 2),
      "utf-8",
    );

    return {
      artifact: metadata,
      submissionPatch: {
        [input.fieldHint ?? defaultFieldHint(kind)]: ref,
      },
    };
  }

  resolve(ref: string): StoredArtifactMetadata {
    const parsed = parseArtifactRef(ref);
    const metadataPath = this.resolveInsideRoot(
      parsed.companyId,
      parsed.jobId,
      parsed.threadId,
      parsed.stateId,
      parsed.artifactId,
      "metadata.json",
    );

    if (!existsSync(metadataPath)) {
      throw new Error(`Artifact not found: ${ref}`);
    }

    const metadata = JSON.parse(
      readFileSync(metadataPath, "utf-8"),
    ) as StoredArtifactMetadata;
    const artifactPath = resolve(metadata.path);
    this.assertInsideRoot(artifactPath);
    if (!existsSync(artifactPath)) {
      throw new Error(`Artifact file missing: ${ref}`);
    }
    return metadata;
  }

  read(ref: string): Buffer {
    const metadata = this.resolve(ref);
    return readFileSync(metadata.path);
  }

  toCandidateReference(ref: string): CandidateArtifactReference {
    const metadata = this.resolve(ref);
    return {
      uri: metadata.ref,
      path: metadata.path,
      mediaType: metadata.contentType,
      media_type: metadata.contentType,
      fieldHint: metadata.fieldHint,
      field_hint: metadata.fieldHint,
      size: metadata.sizeBytes,
      sha256: metadata.sha256,
    };
  }

  readCodeFiles(ref: string): RunnerFile[] {
    const metadata = this.resolve(ref);
    if (metadata.kind !== "code" && metadata.kind !== "file") {
      throw new Error(`Artifact is not a code artifact: ${ref}`);
    }

    const content = readFileSync(metadata.path, "utf-8");
    if (
      metadata.contentType.includes("json") ||
      metadata.fileName.endsWith(".json")
    ) {
      const parsed = JSON.parse(content) as unknown;
      return normalizeCodeArtifactJson(parsed);
    }

    return [{ path: metadata.fileName, content }];
  }

  validateOwnership(
    ref: string,
    expected: {
      companyId: string;
      jobId: string;
      threadId: string;
      stateId: string;
    },
  ): StoredArtifactMetadata {
    const metadata = this.resolve(ref);
    if (
      metadata.companyId !== expected.companyId ||
      metadata.jobId !== expected.jobId ||
      metadata.threadId !== expected.threadId ||
      metadata.stateId !== expected.stateId
    ) {
      throw new Error(
        `Artifact ${ref} does not belong to ${expected.companyId}/${expected.jobId}/${expected.threadId}/${expected.stateId}`,
      );
    }
    return metadata;
  }

  private resolveInsideRoot(...segments: string[]): string {
    const resolved = resolve(this.root, ...segments);
    this.assertInsideRoot(resolved);
    return resolved;
  }

  private assertInsideRoot(path: string): void {
    const pathFromRoot = relative(this.root, path);
    if (pathFromRoot.startsWith("..") || pathFromRoot === "..") {
      throw new Error(`Path escapes artifact root: ${path}`);
    }
  }
}

export function buildArtifactRef(input: {
  companyId: string;
  jobId: string;
  threadId: string;
  stateId: string;
  artifactId: string;
}): string {
  return [
    REF_PREFIX,
    input.companyId,
    input.jobId,
    input.threadId,
    input.stateId,
    input.artifactId,
  ].join("/");
}

export function parseArtifactRef(ref: string): {
  companyId: string;
  jobId: string;
  threadId: string;
  stateId: string;
  artifactId: string;
} {
  const prefix = `${REF_PREFIX}/`;
  if (!ref.startsWith(prefix)) {
    throw new Error(`Invalid artifact ref: ${ref}`);
  }

  const parts = ref.slice(prefix.length).split("/");
  if (parts.length !== 5) {
    throw new Error(`Invalid artifact ref: ${ref}`);
  }

  const [companyId, jobId, threadId, stateId, artifactId] = parts;
  return {
    companyId: sanitizeSegment(companyId, "companyId"),
    jobId: sanitizeSegment(jobId, "jobId"),
    threadId: sanitizeSegment(threadId, "threadId"),
    stateId: sanitizeSegment(stateId, "stateId"),
    artifactId: sanitizeSegment(artifactId, "artifactId"),
  };
}

function normalizeKind(kind: string): ArtifactKind {
  if (["audio", "transcript", "video", "code", "file"].includes(kind)) {
    return kind as ArtifactKind;
  }
  throw new Error(`Unsupported artifact kind: ${kind}`);
}

function sanitizeSegment(value: string | undefined, label: string): string {
  if (!value || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value ?? ""}`);
  }
  return value;
}

function sanitizeFileName(value: string): string {
  const fileName = value.split(/[\\/]/).at(-1) ?? "artifact.bin";
  if (!fileName || fileName === "." || fileName === "..") {
    throw new Error(`Invalid artifact filename: ${value}`);
  }
  return fileName.replace(/[^A-Za-z0-9._-]/g, "_");
}

function extensionFor(
  fileName: string | undefined,
  contentType: string | undefined,
  kind: ArtifactKind,
): string {
  if (fileName && extname(fileName)) {
    return "";
  }
  if (contentType?.includes("json")) {
    return ".json";
  }
  if (contentType?.includes("webm")) {
    return ".webm";
  }
  if (contentType?.includes("mp4")) {
    return ".mp4";
  }
  if (contentType?.startsWith("text/")) {
    return ".txt";
  }
  if (kind === "transcript") {
    return ".txt";
  }
  if (kind === "code") {
    return ".json";
  }
  return ".bin";
}

function defaultContentType(kind: ArtifactKind): string {
  switch (kind) {
    case "audio":
      return "audio/webm";
    case "transcript":
      return "text/plain";
    case "video":
      return "video/webm";
    case "code":
      return "application/json";
    case "file":
      return "application/octet-stream";
  }
}

function defaultFieldHint(kind: ArtifactKind): string {
  switch (kind) {
    case "audio":
      return "audio_artifact_ref";
    case "transcript":
      return "transcript_artifact_ref";
    case "video":
      return "video_artifact_ref";
    case "code":
      return "code_artifact_ref";
    case "file":
      return "artifact_ref";
  }
}

function normalizeCodeArtifactJson(input: unknown): RunnerFile[] {
  const record = input && typeof input === "object"
    ? (input as Record<string, unknown>)
    : undefined;
  const files = record?.["files"] ?? input;

  if (Array.isArray(files)) {
    return files.map((file, index) => {
      if (
        !file ||
        typeof file !== "object" ||
        typeof (file as Record<string, unknown>)["path"] !== "string" ||
        typeof (file as Record<string, unknown>)["content"] !== "string"
      ) {
        throw new Error(`code artifact files[${index}] must include path and content`);
      }
      return {
        path: (file as Record<string, string>)["path"],
        content: (file as Record<string, string>)["content"],
      };
    });
  }

  if (!files || typeof files !== "object") {
    throw new Error("code artifact JSON must be a files map or file array");
  }

  return Object.entries(files as Record<string, unknown>).map(([path, content]) => {
    if (typeof content !== "string") {
      throw new Error(`code artifact file ${path} content must be a string`);
    }
    return { path, content };
  });
}
