import { describe, expect, it } from "vitest";
import { loadInterviewConfig } from "../src/agents/interview/config/loader.js";
import { runLocalCodeSubmission } from "../src/agents/interview/skills/local-runner.js";
import type { CodeSubmission, TechnicalChallengeConfig } from "../src/agents/interview/types.js";

describe("multi-challenge senior-developer interview config", () => {
  it("loads senior-developer config with two technical challenges", async () => {
    const config = await loadInterviewConfig("demo-company", "senior-developer");

    expect(config.job.title).toBe("Senior Software Developer");
    expect(config.job.level).toBe("senior");
    expect(config.interview.states).toHaveLength(8);
    expect(config.interview.states[0]!.id).toBe("behavioral_1");

    // Verify multi-challenge loading
    expect(config.technicalChallenges).toBeDefined();
    expect(Object.keys(config.technicalChallenges!)).toEqual(
      expect.arrayContaining(["fizzbuzz", "palindrome"]),
    );

    // Verify challenge_id mappings on code states
    const tech1 = config.interview.states.find((s) => s.id === "technical_1");
    const tech2 = config.interview.states.find((s) => s.id === "technical_2");
    expect(tech1?.challenge_id).toBe("fizzbuzz");
    expect(tech2?.challenge_id).toBe("palindrome");

    // Verify the challenges loaded correctly
    const fizzbuzz = config.technicalChallenges!["fizzbuzz"]!;
    const palindrome = config.technicalChallenges!["palindrome"]!;
    expect(fizzbuzz.title).toBe("FizzBuzz Implementation");
    expect(palindrome.title).toBe("Palindrome Detector");
    expect(fizzbuzz.runner).toBeDefined();
    expect(palindrome.runner).toBeDefined();
  });

  it("runs FizzBuzz verifier via runLocalCodeSubmission", async () => {
    const config = await loadInterviewConfig("demo-company", "senior-developer");
    const fizzbuzz = config.technicalChallenges!["fizzbuzz"]!;

    const submission: CodeSubmission = {
      language: "javascript",
      entrypoint: "solution.js",
      files: {
        "solution.js": `for (let i = 1; i <= 100; i++) {
  if (i % 15 === 0) console.log("FizzBuzz");
  else if (i % 3 === 0) console.log("Fizz");
  else if (i % 5 === 0) console.log("Buzz");
  else console.log(String(i));
}
`,
      },
    };

    const result = await runLocalCodeSubmission(submission, fizzbuzz);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(10);
    expect(result.maxScore).toBe(10);
    expect(result.summary).toContain("All FizzBuzz tests passed");
  });

  it("runs Palindrome verifier via runLocalCodeSubmission", async () => {
    const config = await loadInterviewConfig("demo-company", "senior-developer");
    const palindrome = config.technicalChallenges!["palindrome"]!;

    const submission: CodeSubmission = {
      language: "javascript",
      entrypoint: "solution.js",
      files: {
        "solution.js": `const inputs = ["racecar","hello","A man a plan a canal Panama","world","Was it a car or a cat I saw"];
for (const s of inputs) {
  const clean = s.toLowerCase().replace(/[^a-z0-9]/g, "");
  console.log(clean === clean.split("").reverse().join("") ? "true" : "false");
}
`,
      },
    };

    const result = await runLocalCodeSubmission(submission, palindrome);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(10);
    expect(result.maxScore).toBe(10);
    expect(result.summary).toContain("All palindrome tests passed");
  });

  it("resolves correct challenge per state id (simulates agent resolver)", async () => {
    const config = await loadInterviewConfig("demo-company", "senior-developer");

    // Build the same challenge map + resolver logic as the agent
    const challengeMap: Record<string, TechnicalChallengeConfig> = {
      ...(config.technicalChallenges ?? {}),
    };
    if (config.technicalChallenge && !challengeMap["default"]) {
      challengeMap["default"] = config.technicalChallenge;
    }

    function resolveChallenge(stateId: string): TechnicalChallengeConfig | undefined {
      const state = config.interview.states.find((s) => s.id === stateId);
      if (!state) return undefined;
      const cid = state.challenge_id ?? (state.expected_submission.type === "code" ? "default" : undefined);
      return cid ? challengeMap[cid] : undefined;
    }

    // Non-code states should have no challenge
    expect(resolveChallenge("behavioral_1")).toBeUndefined();
    expect(resolveChallenge("behavioral_2")).toBeUndefined();
    expect(resolveChallenge("behavioral_3")).toBeUndefined();
    expect(resolveChallenge("technical_submission_review")).toBeUndefined();
    expect(resolveChallenge("final_evaluation")).toBeUndefined();

    // Code states should resolve to their challenge_id
    const tech1Challenge = resolveChallenge("technical_1");
    expect(tech1Challenge).toBeDefined();
    expect(tech1Challenge!.title).toBe("FizzBuzz Implementation");

    const tech2Challenge = resolveChallenge("technical_2");
    expect(tech2Challenge).toBeDefined();
    expect(tech2Challenge!.title).toBe("Palindrome Detector");
  });
});
