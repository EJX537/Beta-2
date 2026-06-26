import { describe, expect, it } from "vitest";
import { runLocalCodeSubmission } from "../src/agents/interview/skills/local-runner.js";
import type { TechnicalChallengeConfig } from "../src/agents/interview/types.js";

function baseChallenge(overrides: Partial<TechnicalChallengeConfig> = {}): TechnicalChallengeConfig {
  return {
    title: "Local Runner Test",
    prompt: "Implement fizzBuzz(n).",
    acceptedLanguages: ["javascript"],
    accepted_languages: ["javascript"],
    requiredFiles: ["solution.js"],
    required_files: ["solution.js"],
    scoring_rubric: [{ criterion: "correctness", weight: 1 }],
    maxScore: 10,
    max_score: 10,
    runner: {
      parser: "stdout-json-last-line",
      scorePath: "score",
      passedPath: "passed",
      summaryPath: "summary",
      fallback: {
        score: 0,
        passed: false,
        summary: "fallback failure",
      },
      config: {
        command: "node verifier.js",
        cwd: ".",
        timeoutMs: 1_000,
        allowInstall: false,
        supportFiles: {
          "verifier.js": `
const solution = require('./solution.js');
const fn = typeof solution === 'function' ? solution : solution.fizzBuzz;
const actual = fn(15);
const passed = actual === 'FizzBuzz';
console.log('verifier ran');
console.log(JSON.stringify({ passed, score: passed ? 10 : 0, summary: passed ? 'ok' : 'wrong answer' }));
process.exit(passed ? 0 : 1);
`,
        },
      },
    },
    ...overrides,
  };
}

describe("runLocalCodeSubmission", () => {
  it("executes submitted code and parses JSON from the last stdout line", async () => {
    const result = await runLocalCodeSubmission(
      {
        type: "code",
        language: "javascript",
        entrypoint: "solution.js",
        files: [
          {
            path: "solution.js",
            content:
              "module.exports = function fizzBuzz(n) { return n % 15 === 0 ? 'FizzBuzz' : String(n); };",
          },
        ],
      },
      baseChallenge(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(10);
    expect(result.maxScore).toBe(10);
    expect(result.summary).toBe("ok");
    expect(result.stdout).toContain("verifier ran");
  });

  it("returns failed fallback output for non-zero execution", async () => {
    const result = await runLocalCodeSubmission(
      {
        language: "javascript",
        files: {
          "solution.js": "process.exit(1);",
        },
      },
      baseChallenge({
        runner: {
          parser: "exit-code-fallback",
          scorePath: "score",
          passedPath: "passed",
          summaryPath: "summary",
          fallback: {
            score: 10,
            passed: true,
            summary: "command failed",
          },
          config: {
            command: "node solution.js",
            cwd: ".",
            timeoutMs: 1_000,
          },
        },
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.summary).toBe("command failed");
  });

  it("marks execution as timed out", async () => {
    const result = await runLocalCodeSubmission(
      {
        language: "javascript",
        files: {
          "solution.js": "while (true) {}",
        },
      },
      baseChallenge({
        runner: {
          parser: "exit-code-fallback",
          scorePath: "score",
          passedPath: "passed",
          summaryPath: "summary",
          fallback: {
            score: 10,
            passed: true,
            summary: "timed out",
          },
          config: {
            command: "node solution.js",
            cwd: ".",
            timeoutMs: 100,
          },
        },
      }),
    );

    expect(result.timedOut).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.stderr).toContain("timed out");
  });

  it("rejects missing required files before execution", async () => {
    await expect(
      runLocalCodeSubmission(
        {
          language: "javascript",
          files: {
            "other.js": "module.exports = () => 'FizzBuzz';",
          },
        },
        baseChallenge(),
      ),
    ).rejects.toThrow('Missing required file: "solution.js"');
  });

  it("rejects unsupported languages before execution", async () => {
    await expect(
      runLocalCodeSubmission(
        {
          language: "python",
          files: {
            "solution.js": "module.exports = () => 'FizzBuzz';",
          },
        },
        baseChallenge(),
      ),
    ).rejects.toThrow('Unsupported language "python"');
  });

  it("rejects path traversal before execution", async () => {
    await expect(
      runLocalCodeSubmission(
        {
          language: "javascript",
          files: {
            "../solution.js": "module.exports = () => 'FizzBuzz';",
          },
        },
        baseChallenge({ requiredFiles: [], required_files: [] }),
      ),
    ).rejects.toThrow("Unsafe file path");
  });
});
