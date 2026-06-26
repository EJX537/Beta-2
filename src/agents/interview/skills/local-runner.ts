import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type {
  CodeSubmission,
  LocalRunnerOutput,
  RunnerConfig,
  RunnerFile,
  TechnicalChallengeConfig,
} from "../types.js";

interface EffectiveRunner {
  config: RunnerConfig;
  parser: "stdout-json-last-line" | "exit-code-fallback";
  scorePath: string;
  passedPath: string;
  summaryPath: string;
  fallback: {
    score: number;
    passed: boolean;
    summary: string;
  };
}

interface ExecFailure extends Error {
  status?: number | null;
  signal?: NodeJS.Signals | string | null;
  killed?: boolean;
  stdout?: Buffer | string;
  stderr?: Buffer | string;
}

/**
 * Run a candidate code submission locally inside a temporary workspace.
 * This is intentionally hackathon-only execution; no sandbox isolation is attempted.
 */
export async function runLocalCodeSubmission(
  submission: CodeSubmission,
  challenge: TechnicalChallengeConfig,
): Promise<LocalRunnerOutput> {
  const runner = getEffectiveRunner(challenge);
  const files = normalizeFiles(submission.files, "submission.files");
  const supportFiles = normalizeFiles(
    runner.config.supportFiles ?? {},
    "runner.supportFiles",
  );
  const acceptedLanguages = getAcceptedLanguages(challenge);
  const requiredFiles = challenge.requiredFiles ?? challenge.required_files ?? [];
  const maxScore = challenge.maxScore ?? challenge.max_score ?? 10;

  if (
    acceptedLanguages.length > 0 &&
    !acceptedLanguages.includes(submission.language.toLowerCase())
  ) {
    throw new Error(
      `Unsupported language "${submission.language}". Accepted: ${acceptedLanguages.join(", ")}`,
    );
  }

  for (const file of [...supportFiles, ...files]) {
    assertSafeRelativePath(file.path);
  }

  const submittedPaths = new Set(files.map((file) => file.path));
  for (const requiredFile of requiredFiles) {
    assertSafeRelativePath(requiredFile);
    if (!submittedPaths.has(requiredFile)) {
      throw new Error(`Missing required file: "${requiredFile}"`);
    }
  }

  const workspaceDir = mkdtempSync(join(tmpdir(), "interview-runner-"));
  const startedAt = performance.now();
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = 0;
  let timedOut = false;

  try {
    for (const file of supportFiles) {
      writeWorkspaceFile(workspaceDir, file);
    }
    for (const file of files) {
      writeWorkspaceFile(workspaceDir, file);
    }

    if (runner.config.allowInstall && runner.config.installCommand) {
      execSync(runner.config.installCommand, {
        cwd: workspaceDir,
        timeout: runner.config.timeoutMs,
        stdio: "pipe",
        env: { ...process.env },
        maxBuffer: 10 * 1024 * 1024,
      });
    }

    const commandCwd = resolveWorkspacePath(workspaceDir, runner.config.cwd ?? ".");
    const commandStartedAt = performance.now();

    try {
      const output = execSync(runner.config.command, {
        cwd: commandCwd,
        timeout: runner.config.timeoutMs,
        stdio: "pipe",
        env: { ...process.env },
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = output.toString("utf-8");
      exitCode = 0;
    } catch (error) {
      const failure = toExecFailure(error);
      stdout = bufferToString(failure.stdout);
      stderr = bufferToString(failure.stderr);
      exitCode = typeof failure.status === "number" ? failure.status : null;
      timedOut =
        failure.killed === true ||
        failure.signal === "SIGTERM" ||
        performance.now() - commandStartedAt >= runner.config.timeoutMs - 25;

      if (timedOut) {
        stderr = stderr ? `${stderr}\n[timed out]` : "[timed out]";
      }
    }

    return parseRunnerOutput({
      stdout,
      stderr,
      exitCode,
      timedOut,
      durationMs: Math.round(performance.now() - startedAt),
      maxScore,
      runner,
    });
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}

function getEffectiveRunner(challenge: TechnicalChallengeConfig): EffectiveRunner {
  if (challenge.runner) {
    return {
      config: challenge.runner.config,
      parser: challenge.runner.parser,
      scorePath: challenge.runner.scorePath ?? "score",
      passedPath: challenge.runner.passedPath ?? "passed",
      summaryPath: challenge.runner.summaryPath ?? "summary",
      fallback: challenge.runner.fallback,
    };
  }

  return {
    config: {
      command: challenge.test_command ?? "node solution.js",
      cwd: ".",
      timeoutMs: (challenge.timeout_seconds ?? 10) * 1000,
    },
    parser: "exit-code-fallback",
    scorePath: "score",
    passedPath: "passed",
    summaryPath: "summary",
    fallback: {
      score: challenge.maxScore ?? challenge.max_score ?? 10,
      passed: true,
      summary: "Execution completed successfully.",
    },
  };
}

function getAcceptedLanguages(challenge: TechnicalChallengeConfig): string[] {
  return (challenge.acceptedLanguages ?? challenge.accepted_languages ?? []).map(
    (language) => language.toLowerCase(),
  );
}

function normalizeFiles(
  input: Record<string, string> | RunnerFile[],
  label: string,
): RunnerFile[] {
  if (Array.isArray(input)) {
    return input.map((file, index) => {
      if (
        !file ||
        typeof file.path !== "string" ||
        typeof file.content !== "string"
      ) {
        throw new Error(`${label}[${index}] must include string path and content`);
      }
      return { path: file.path, content: file.content };
    });
  }

  if (!input || typeof input !== "object") {
    throw new Error(`${label} must be an object map or file array`);
  }

  return Object.entries(input).map(([path, content]) => {
    if (typeof content !== "string") {
      throw new Error(`${label}.${path} content must be a string`);
    }
    return { path, content };
  });
}

function assertSafeRelativePath(filePath: string): void {
  if (!filePath || isAbsolute(filePath)) {
    throw new Error(`Unsafe file path: "${filePath}"`);
  }

  const parts = filePath.split(/[/\\]/);
  if (parts.includes("..")) {
    throw new Error(`Unsafe file path: "${filePath}"`);
  }
}

function resolveWorkspacePath(workspaceDir: string, relativePath: string): string {
  assertSafeRelativePath(relativePath);
  const absolutePath = resolve(workspaceDir, relativePath);
  const pathFromWorkspace = relative(workspaceDir, absolutePath);
  if (pathFromWorkspace.startsWith("..") || isAbsolute(pathFromWorkspace)) {
    throw new Error(`Path escapes workspace: "${relativePath}"`);
  }
  return absolutePath;
}

function writeWorkspaceFile(workspaceDir: string, file: RunnerFile): void {
  const absolutePath = resolveWorkspacePath(workspaceDir, file.path);
  const directory = dirname(absolutePath);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(absolutePath, file.content, "utf-8");
}

function parseRunnerOutput(input: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  maxScore: number;
  runner: EffectiveRunner;
}): LocalRunnerOutput {
  const { stdout, stderr, exitCode, timedOut, durationMs, maxScore, runner } =
    input;

  if (runner.parser === "stdout-json-last-line") {
    const lastLine = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);

    if (lastLine) {
      try {
        const parsed = JSON.parse(lastLine) as Record<string, unknown>;
        const parsedPassed = readPath(parsed, runner.passedPath);
        const parsedScore = readPath(parsed, runner.scorePath);
        const parsedSummary = readPath(parsed, runner.summaryPath);

        return {
          exitCode,
          stdout,
          stderr,
          timedOut,
          durationMs,
          passed:
            typeof parsedPassed === "boolean"
              ? parsedPassed
              : runner.fallback.passed,
          score: clampScore(
            typeof parsedScore === "number" ? parsedScore : runner.fallback.score,
            maxScore,
          ),
          maxScore,
          summary:
            typeof parsedSummary === "string"
              ? parsedSummary
              : runner.fallback.summary,
          details: parsed,
        };
      } catch {
        // Fall through to exit-code fallback.
      }
    }
  }

  const passed = exitCode === 0 && !timedOut;
  return {
    exitCode,
    stdout,
    stderr,
    timedOut,
    durationMs,
    passed,
    score: passed ? clampScore(runner.fallback.score, maxScore) : 0,
    maxScore,
    summary: passed ? "Execution completed successfully." : runner.fallback.summary,
  };
}

function readPath(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function clampScore(score: number, maxScore: number): number {
  return Math.max(0, Math.min(maxScore, score));
}

function toExecFailure(error: unknown): ExecFailure {
  if (error instanceof Error) {
    return error as ExecFailure;
  }
  return new Error(String(error)) as ExecFailure;
}

function bufferToString(value: Buffer | string | undefined): string {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf-8");
  }
  return value ?? "";
}
