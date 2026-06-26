// Fully simulated end-to-end interview run for the senior-developer job.
// Uses GMI minimax-tts-speech-2.6-turbo to generate candidate audio for the
// behavioral (recorded response) rounds, uploads them as artifacts, drives the
// interview FSM through the HTTP API, submits FizzBuzz and Palindrome solutions,
// and prints the final evaluation scorecard.
//
// Audio is cached to data/sim-audio/ and reused across runs; pass --regen to
// force regeneration.
//
// Usage: node scripts/simulate-e2e.mjs [--regen]   (server must be running on $PORT)

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = `http://localhost:${process.env.PORT ?? 8080}`;
const COMPANY_ID = "demo-company";
const JOB_ID = "senior-developer";
const REGEN = process.argv.includes("--regen");

// Load GMI creds from .env (TTS uses the console request-queue API).
const envFile = readFileSync(resolve(process.cwd(), ".env"), "utf8");
const env = Object.fromEntries(
  envFile
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);
const GMI_API_KEY = env.GMI_MAAS_API_KEY;
const TTS_MODEL = "minimax-tts-speech-2.6-turbo";
const TTS_ENDPOINT =
  "https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey/requests";

const AUDIO_CACHE_DIR = resolve(process.cwd(), "data", "sim-audio");
mkdirSync(AUDIO_CACHE_DIR, { recursive: true });

// ── Candidate profile (simulated screening handoff) ─────────────────────────

const CANDIDATE_CONTEXT = {
  candidate_id: "sim-candidate-001",
  profile_id: "sim-candidate-001",
  source: "simulation",
  profile: {
    candidate_name: "Alex Chen",
    resume_text:
      "Alex Chen — Senior Software Engineer, 8 years. TypeScript, Node.js, React, System Design. Led teams building distributed systems and mentoring junior engineers.",
    skills: ["TypeScript", "Node.js", "React", "PostgreSQL", "AWS", "System Design"],
  },
};

// Candidate answers (text -> TTS audio).
const ANSWERS = {
  q1:
    "I'm a senior software engineer with about eight years of experience, mostly building web applications in TypeScript and Node. " +
    "What motivates me is taking messy real-world problems and turning them into clean, maintainable systems. " +
    "In my last role I owned our real-time collaboration layer end to end and mentored three junior engineers. " +
    "I'm looking for a team where I can keep growing as a technical leader while helping the team raise their bar.",
  q2:
    "The toughest problem I tackled was a distributed cache that kept going inconsistent across nodes, which caused stale data for users. " +
    "I traced it to a naive key-to-node mapping that shifted whenever a node joined. " +
    "I replaced it with consistent hashing and added a lightweight background sync for tombstones, which cut cache misses by about forty percent and eliminated the drift. " +
    "I learned to always question the assignment strategy, not just the cache policy.",
  q3:
    "A conflict I handled well was when two teams disagreed on whether to adopt a monorepo or keep separate repositories. " +
    "Instead of escalating, I set up a meeting where each side presented their arguments with data. " +
    "We realized both approaches had merit, so we agreed on a hybrid — shared packages in one repo, independent services in another. " +
    "The compromise improved collaboration while preserving autonomy, and both teams felt heard.",
};

// Correct FizzBuzz solution for the first technical round.
const FIZZBUZZ_SOLUTION = `for (let i = 1; i <= 100; i++) {
  if (i % 15 === 0) console.log("FizzBuzz");
  else if (i % 3 === 0) console.log("Fizz");
  else if (i % 5 === 0) console.log("Buzz");
  else console.log(String(i));
}
`;

// Correct Palindrome solution for the second technical round.
const PALINDROME_SOLUTION = `const inputs = ["racecar","hello","A man a plan a canal Panama","world","Was it a car or a cat I saw"];
for (const s of inputs) {
  const clean = s.toLowerCase().replace(/[^a-z0-9]/g, "");
  console.log(clean === clean.split("").reverse().join("") ? "true" : "false");
}
`;

// ── Helpers ──────────────────────────────────────────────────────────────────

const log = (...a) => console.log(...a);
const dim = (s) => console.log(`  \x1b[2m${s}\x1b[0m`);

function currentStateId(r) {
  return r.state?.currentStateId ?? r.state?.current_state_id;
}
function currentStateLabel(r) {
  return r.state?.currentStateLabel ?? r.state?.current_state_label;
}
function nextSubmission(r) {
  return r.next_submission ?? r.state?.nextSubmission;
}

/** Generate (or load from cache) the mp3 for a given answer key. */
async function getAnswerAudio(key, text, label) {
  const cachePath = resolve(AUDIO_CACHE_DIR, `${key}.mp3`);
  if (existsSync(cachePath) && !REGEN) {
    const buf = readFileSync(cachePath);
    log(`[TTS] Using cached audio for "${label}" (${buf.length} bytes).`);
    return buf;
  }
  log(`\n[TTS] Generating audio for "${label}"...`);
  const submit = await fetch(TTS_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GMI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      payload: {
        text,
        voice_id: "English_expressive_narrator",
        format: "mp3",
        speed: 1.0,
      },
    }),
  });
  const submitted = await submit.json();
  if (!submitted.request_id) {
    throw new Error(`TTS submit failed: ${JSON.stringify(submitted)}`);
  }
  const rid = submitted.request_id;
  dim(`request_id=${rid} status=${submitted.status}`);

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await fetch(`${TTS_ENDPOINT}/${rid}`, {
      headers: { Authorization: `Bearer ${GMI_API_KEY}` },
    });
    const data = await poll.json();
    if (data.status === "success" && data.outcome?.audio_url) {
      dim(`TTS ready after ~${i * 3}s`);
      const audioRes = await fetch(data.outcome.audio_url);
      if (!audioRes.ok) throw new Error(`audio download failed: ${audioRes.status}`);
      const buf = Buffer.from(await audioRes.arrayBuffer());
      writeFileSync(cachePath, buf);
      log(`[TTS] Got ${buf.length} bytes of mp3 (cached to ${cachePath}).`);
      return buf;
    }
    if (data.status === "failed") {
      throw new Error(`TTS failed: ${JSON.stringify(data)}`);
    }
  }
  throw new Error("TTS timed out.");
}

async function uploadArtifact(threadId, stateId, kind, fileName, contentType, data) {
  const url = `${BASE_URL}/interview/${COMPANY_ID}/${JOB_ID}/${threadId}/uploads`;
  const body = {
    state_id: stateId,
    kind,
    field_hint: `${kind}_artifact_ref`,
    filename: fileName,
    content_type: contentType,
    content_base64: Buffer.isBuffer(data)
      ? data.toString("base64")
      : Buffer.from(data).toString("base64"),
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`upload failed (${res.status}): ${JSON.stringify(json)}`);
  return json.artifact.ref;
}

async function postInterview({ threadId, message, submission, artifactRefs }) {
  const url = `${BASE_URL}/interview/${COMPANY_ID}/${JOB_ID}`;
  const body = {
    message,
    candidate_context: CANDIDATE_CONTEXT,
  };
  if (threadId) body.thread_id = threadId;
  if (submission) body.submission = submission;
  if (artifactRefs?.length) body.artifact_refs = artifactRefs;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`interview (${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

function printTurn(n, r) {
  log(`\n═══════ Turn ${n} ═══════`);
  log(`state:      ${currentStateId(r)} (${currentStateLabel(r)})`);
  log(`complete:   ${r.complete}`);
  const ns = nextSubmission(r);
  if (ns) {
    log(`next:       type=${ns.type} fields=${JSON.stringify(ns.fields)} any_of=${JSON.stringify(ns.any_of_fields ?? [])}`);
  } else {
    log(`next:       (none)`);
  }
  log(`agent:      ${(r.message ?? "").replace(/\s+/g, " ").slice(0, 240)}${(r.message ?? "").length > 240 ? "…" : ""}`);
  if (r.state?.scores && Object.keys(r.state.scores).length) {
    log(`scores:     ${JSON.stringify(r.state.scores)}`);
  }
  if (r.final_evaluation) {
    log(`★★ final_evaluation present: ${r.final_evaluation.recommendation}`);
  }
}

// ── Drive the interview ──────────────────────────────────────────────────────

async function main() {
  log("=== Fully Simulated End-to-End Interview ===");
  log(`server: ${BASE_URL}`);
  log(`candidate: ${CANDIDATE_CONTEXT.profile.candidate_name}`);
  log(`audio cache: ${AUDIO_CACHE_DIR} (regen=${REGEN})`);

  // Pre-generate (or load cached) audio for all three behavioral rounds.
  const audio1 = await getAnswerAudio("q1", ANSWERS.q1, "Behavioral Q1");
  const audio2 = await getAnswerAudio("q2", ANSWERS.q2, "Behavioral Q2");
  const audio3 = await getAnswerAudio("q3", ANSWERS.q3, "Behavioral Q3");

  // Turn 1: start at behavioral_1 (no intro state — greeting is folded into agent_instruction).
  let r = await postInterview({ message: "Hi, I'm ready to begin the interview." });
  printTurn(1, r);
  let threadId = r.thread_id;
  const s1 = currentStateId(r);

  // Turn 2: behavioral_1 — upload audio, submit audio_artifact_ref.
  const ref1 = await uploadArtifact(threadId, s1 ?? "behavioral_1", "audio", "answer1.mp3", "audio/mpeg", audio1);
  log(`\n[Upload] answer1.mp3 -> ${ref1}`);
  r = await postInterview({
    threadId,
    message: "Here is my recorded response for the first question.",
    submission: { audio_artifact_ref: ref1 },
    artifactRefs: [{ uri: ref1, mediaType: "audio/mpeg", fieldHint: "audio_artifact_ref" }],
  });
  printTurn(2, r);

  // Turn 3: behavioral_2 — upload audio, submit audio_artifact_ref.
  const s3 = currentStateId(r) ?? "behavioral_2";
  const ref2 = await uploadArtifact(threadId, s3, "audio", "answer2.mp3", "audio/mpeg", audio2);
  log(`\n[Upload] answer2.mp3 -> ${ref2}`);
  r = await postInterview({
    threadId,
    message: "Here is my recorded response for the second question.",
    submission: { audio_artifact_ref: ref2 },
    artifactRefs: [{ uri: ref2, mediaType: "audio/mpeg", fieldHint: "audio_artifact_ref" }],
  });
  printTurn(3, r);

  // Turn 4: behavioral_3 — upload audio, submit audio_artifact_ref.
  const s4 = currentStateId(r) ?? "behavioral_3";
  const ref3 = await uploadArtifact(threadId, s4, "audio", "answer3.mp3", "audio/mpeg", audio3);
  log(`\n[Upload] answer3.mp3 -> ${ref3}`);
  r = await postInterview({
    threadId,
    message: "Here is my recorded response for the third question.",
    submission: { audio_artifact_ref: ref3 },
    artifactRefs: [{ uri: ref3, mediaType: "audio/mpeg", fieldHint: "audio_artifact_ref" }],
  });
  printTurn(4, r);

  // Turn 5: technical_1 (FizzBuzz) — upload code, submit code_artifact_ref.
  const s5 = currentStateId(r) ?? "technical_1";
  const codeRef1 = await uploadArtifact(threadId, s5, "code", "code1.json", "application/json", JSON.stringify({ files: { "solution.js": FIZZBUZZ_SOLUTION } }));
  log(`\n[Upload] FizzBuzz solution -> ${codeRef1}`);
  r = await postInterview({
    threadId,
    message: "Here is my FizzBuzz solution.",
    submission: { language: "javascript", entrypoint: "solution.js", code_artifact_ref: codeRef1 },
    artifactRefs: [{ uri: codeRef1, mediaType: "application/json", fieldHint: "code_artifact_ref" }],
  });
  printTurn(5, r);

  // Turn 6: technical_2 (Palindrome) — upload code, submit code_artifact_ref.
  const s6 = currentStateId(r) ?? "technical_2";
  const codeRef2 = await uploadArtifact(threadId, s6, "code", "code2.json", "application/json", JSON.stringify({ files: { "solution.js": PALINDROME_SOLUTION } }));
  log(`\n[Upload] Palindrome solution -> ${codeRef2}`);
  r = await postInterview({
    threadId,
    message: "Here is my palindrome solution.",
    submission: { language: "javascript", entrypoint: "solution.js", code_artifact_ref: codeRef2 },
    artifactRefs: [{ uri: codeRef2, mediaType: "application/json", fieldHint: "code_artifact_ref" }],
  });
  printTurn(6, r);

  // Auto-advance through none-type states (technical_submission_review -> final_evaluation -> complete).
  let turn = 7;
  let guard = 0;
  while (!r.complete && guard < 8) {
    r = await postInterview({ threadId, message: "Continue the interview." });
    printTurn(turn, r);
    turn++;
    guard++;
  }

  // Final scorecard.
  log("\n\n████████████████████████████████████████████████████████");
  log("                 FINAL EVALUATION");
  log("████████████████████████████████████████████████████████");
  const fe = r.final_evaluation;
  if (!fe) {
    log("(no final evaluation produced)");
  } else {
    log(`Recommendation: ${fe.recommendation}`);
    log(`Summary:        ${fe.summary}`);
    log(`Scores:         ${JSON.stringify(fe.scores)}`);
    log(`Strengths:      ${fe.strengths?.join("; ") || "(none)"}`);
    log(`Risks:          ${fe.risks?.join("; ") || "(none)"}`);
  }
  log("████████████████████████████████████████████████████████\n");
}

main().catch((e) => {
  console.error("\n✖ Simulation failed:", e.message);
  console.error(e.stack);
  process.exit(1);
});
