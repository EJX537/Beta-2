import {
  createSignal,
  createEffect,
  Show,
  For,
  Switch,
  Match,
  onCleanup,
} from "solid-js";
import {
  interviewTurn,
  uploadArtifact,
  type MatchResult,
  type InterviewResponse,
  type SubmissionRequirement,
  type FinalEvaluation,
} from "../lib/api";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ConversationEntry {
  role: "agent" | "user";
  text: string;
  timestamp: number;
}

interface ScoreMap {
  [category: string]: number;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const SCORE_MAX: Record<string, number> = {
  communication: 10,
  technical_depth: 10,
  problem_solving: 10,
  role_fit: 10,
};

function getScoreMax(category: string): number {
  return SCORE_MAX[category] ?? 10;
}

const SCORE_COLOR: Record<string, string> = {
  communication: "bg-indigo-500",
  technical_depth: "bg-emerald-500",
  problem_solving: "bg-amber-500",
  role_fit: "bg-violet-500",
};

function getScoreColor(category: string): string {
  return SCORE_COLOR[category] ?? "bg-indigo-400";
}

function recColor(value: string): string {
  switch (value) {
    case "strong_yes":
      return "text-emerald-400 border-emerald-500/30 bg-emerald-500/10";
    case "yes":
      return "text-indigo-300 border-indigo-500/30 bg-indigo-500/10";
    case "consider":
      return "text-amber-300 border-amber-500/30 bg-amber-500/10";
    case "no":
      return "text-red-400 border-red-500/30 bg-red-500/10";
    default:
      return "text-zinc-400 border-zinc-700 bg-zinc-800";
  }
}

function recLabel(value: string): string {
  switch (value) {
    case "strong_yes":
      return "Strong Yes";
    case "yes":
      return "Yes";
    case "consider":
      return "Consider";
    case "no":
      return "No";
    default:
      return value;
  }
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

interface Props {
  match: MatchResult;
  candidateName: string;
  onBack: () => void;
}

export default function InterviewFlow(props: Props) {
  /* ── Signals ────────────────────────────────────────────────────── */
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Interview state
  const [threadId, setThreadId] = createSignal<string | null>(null);
  const [agentMessage, setAgentMessage] = createSignal("");
  const [currentStateId, setCurrentStateId] = createSignal("");
  const [currentStateLabel, setCurrentStateLabel] = createSignal("");
  const [scores, setScores] = createSignal<ScoreMap>({});
  const [nextSubmission, setNextSubmission] =
    createSignal<SubmissionRequirement | null>(null);
  const [complete, setComplete] = createSignal(false);
  const [finalEvaluation, setFinalEvaluation] =
    createSignal<FinalEvaluation | null>(null);
  const [conversation, setConversation] = createSignal<ConversationEntry[]>([]);

  // Submission widgets
  const [textValue, setTextValue] = createSignal("");
  const [codeValue, setCodeValue] = createSignal("");
  const [codeLang, setCodeLang] = createSignal("javascript");
  const [entrypoint, setEntrypoint] = createSignal("solution.js");

  // Audio recording
  const [recording, setRecording] = createSignal(false);
  const [recordedBlob, setRecordedBlob] = createSignal<Blob | null>(null);
  const [recordingDuration, setRecordingDuration] = createSignal(0);
  const [fallbackText, setFallbackText] = createSignal("");

  let mediaRecorder: MediaRecorder | null = null;
  let recordingTimer: number | undefined;
  let audioChunks: BlobPart[] = [];
  let conversationRef: HTMLDivElement | undefined;

  /* ── Start interview on mount ───────────────────────────────────── */
  createEffect(() => {
    startInterview();
  });

  async function startInterview() {
    setLoading(true);
    setError(null);
    try {
      const res: InterviewResponse = await interviewTurn(
        "demo-company",
        "senior-developer",
        {
          message: "Hello, I am ready to begin.",
          candidate_context: {
            candidate_id: props.candidateName || "candidate",
            source: "beta-demo",
          },
        }
      );
      applyResponse(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to start interview");
    } finally {
      setLoading(false);
    }
  }

  async function sendTurn(
    msg: string,
    submission?: Record<string, unknown>
  ) {
    const tid = threadId();
    if (!tid) return;
    setLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { message: msg };
      if (submission && Object.keys(submission).length > 0) {
        body.submission = submission;
      }
      const res: InterviewResponse = await interviewTurn(
        "demo-company",
        "senior-developer",
        { ...body, thread_id: tid }
      );
      applyResponse(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  function applyResponse(res: InterviewResponse) {
    setThreadId(res.thread_id);
    setAgentMessage(res.message || "");
    setCurrentStateId(res.state.currentStateId);
    setCurrentStateLabel(res.state.currentStateLabel);
    setScores(res.state.scores || {});
    setNextSubmission(res.next_submission ?? null);
    setComplete(res.complete);
    setFinalEvaluation(res.final_evaluation ?? null);

    // Add agent message to conversation
    if (res.message) {
      setConversation((prev) => [
        ...prev,
        { role: "agent", text: res.message, timestamp: Date.now() },
      ]);
    }

    // Reset submission widgets
    setTextValue("");
    setCodeValue("");
    setCodeLang("javascript");
    setEntrypoint("solution.js");
    setRecordedBlob(null);
    setFallbackText("");

    // Auto-continue on 'none' submission
    if (res.next_submission?.type === "none") {
      setTimeout(() => {
        if (!complete()) {
          sendTurn("Continue");
        }
      }, 600);
    }
  }

  /* ── Submission handlers ────────────────────────────────────────── */

  async function handleTextSubmit() {
    const val = textValue().trim();
    if (!val) return;
    setConversation((prev) => [
      ...prev,
      { role: "user", text: val, timestamp: Date.now() },
    ]);
    await sendTurn("", { text: val });
  }

  async function handleCodeSubmit() {
    const code = codeValue().trim();
    if (!code) return;
    const ep = entrypoint().trim() || "solution.js";
    const files: Record<string, string> = {};
    files[ep] = code;

    setConversation((prev) => [
      ...prev,
      {
        role: "user",
        text: `[Code submission] ${ep} (${codeLang()})`,
        timestamp: Date.now(),
      },
    ]);

    setLoading(true);
    setError(null);
    try {
      const upload = await uploadArtifact(
        "demo-company",
        "senior-developer",
        threadId()!,
        {
          state_id: currentStateId(),
          kind: "code",
          field_hint: "code_artifact_ref",
          files,
        }
      );
      const patch = (upload.submission_patch || {}) as Record<string, unknown>;
      const submission: Record<string, unknown> = {
        ...patch,
        code_artifact_ref: upload.artifact.ref,
      };
      await sendTurn("", submission);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Code upload failed");
      setLoading(false);
    }
  }

  async function handleAudioSubmit() {
    const blob = recordedBlob();
    if (!blob) return;

    setConversation((prev) => [
      ...prev,
      {
        role: "user",
        text: `[Audio submission — ${(blob.size / 1024).toFixed(0)} KB]`,
        timestamp: Date.now(),
      },
    ]);

    setLoading(true);
    setError(null);
    try {
      const file = new File([blob], "answer.webm", { type: blob.type });
      const upload = await uploadArtifact(
        "demo-company",
        "senior-developer",
        threadId()!,
        {
          state_id: currentStateId(),
          kind: "audio",
          field_hint: "audio_artifact_ref",
          file,
        }
      );
      const patch = (upload.submission_patch || {}) as Record<string, unknown>;
      const submission: Record<string, unknown> = {
        ...patch,
        audio_artifact_ref: upload.artifact.ref,
      };

      // If there's fallback transcript text, include it
      const fb = fallbackText().trim();
      if (fb) {
        submission.transcript = fb;
      }
      await sendTurn("", submission);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Audio upload failed");
      setLoading(false);
    }
  }

  /* ── Recording helpers ──────────────────────────────────────────── */

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";
      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      mediaRecorder = mr;
      audioChunks = [];
      setRecordedBlob(null);
      setRecordingDuration(0);

      mr.ondataavailable = (e: BlobEvent) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mr.onstop = () => {
        const blob = new Blob(audioChunks, { type: mr.mimeType });
        setRecordedBlob(blob);
        stream.getTracks().forEach((t) => t.stop());
        clearInterval(recordingTimer);
        recordingTimer = undefined;
      };

      mr.start();
      setRecording(true);
      recordingTimer = window.setInterval(() => {
        setRecordingDuration((d) => d + 1);
      }, 1000);
    } catch {
      setError("Microphone access denied or unavailable");
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
    setRecording(false);
  }

  onCleanup(() => {
    if (recordingTimer) clearInterval(recordingTimer);
  });

  function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }

  /* ── Render helpers ─────────────────────────────────────────────── */

  function renderScores(s: ScoreMap) {
    const keys = Object.keys(s);
    if (keys.length === 0) return null;
    return (
      <div class="space-y-2">
        <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Live Scores
        </h3>
        <For each={keys}>
          {(key) => {
            const val = s[key];
            const max = getScoreMax(key);
            const pct = Math.min(100, (val / max) * 100);
            return (
              <div>
                <div class="flex justify-between text-xs mb-1">
                  <span class="capitalize text-zinc-300">
                    {key.replace(/_/g, " ")}
                  </span>
                  <span class="text-zinc-500">
                    {val.toFixed(1)}/{max}
                  </span>
                </div>
                <div class="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    class={`h-full rounded-full transition-all duration-500 ${getScoreColor(key)}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          }}
        </For>
      </div>
    );
  }

  function renderSubmissionWidget() {
    const sub = nextSubmission();
    if (!sub) return null;

    return (
      <Switch>
        <Match when={sub.type === "none"}>
          <div class="flex items-center gap-2 text-zinc-500 text-sm italic">
            <span class="inline-block w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
            Continuing interview…
          </div>
        </Match>

        <Match when={sub.type === "text"}>
          <div class="space-y-3">
            <textarea
              value={textValue()}
              onInput={(e) => setTextValue(e.currentTarget.value)}
              placeholder="Type your response…"
              rows={4}
              disabled={loading()}
              class="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
            />
            <button
              onClick={handleTextSubmit}
              disabled={loading() || !textValue().trim()}
              class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {loading() ? "Submitting…" : "Submit"}
            </button>
          </div>
        </Match>

        <Match when={sub.type === "video"}>
          <div class="space-y-3">
            {/* Record / stop button */}
            <div class="flex items-center gap-3">
              <Show
                when={!recording()}
                fallback={
                  <button
                    onClick={stopRecording}
                    class="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-500"
                  >
                    <span class="inline-block w-2.5 h-2.5 rounded-full bg-white animate-pulse" />
                    Stop Recording ({formatDuration(recordingDuration())})
                  </button>
                }
              >
                <button
                  onClick={startRecording}
                  disabled={loading()}
                  class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-40"
                >
                  Start Recording
                </button>
              </Show>
            </div>

            {/* Playback */}
            <Show when={recordedBlob()}>
              <audio
                src={URL.createObjectURL(recordedBlob()!)}
                controls
                class="w-full max-w-md"
              />
            </Show>

            {/* Fallback transcript */}
            <textarea
              value={fallbackText()}
              onInput={(e) => setFallbackText(e.currentTarget.value)}
              placeholder="Or paste a transcript here…"
              rows={3}
              disabled={loading()}
              class="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
            />

            {/* Submit */}
            <button
              onClick={handleAudioSubmit}
              disabled={loading() || !recordedBlob()}
              class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {loading() ? "Uploading…" : "Submit Response"}
            </button>
          </div>
        </Match>

        <Match when={sub.type === "code"}>
          <div class="space-y-3">
            <div class="flex gap-3">
              <div class="flex-1">
                <label class="block text-xs text-zinc-500 mb-1">Language</label>
                <select
                  value={codeLang()}
                  onChange={(e) => setCodeLang(e.currentTarget.value)}
                  disabled={loading()}
                  class="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
                >
                  <option value="javascript">JavaScript</option>
                  <option value="typescript">TypeScript</option>
                  <option value="python">Python</option>
                  <option value="java">Java</option>
                  <option value="go">Go</option>
                  <option value="rust">Rust</option>
                </select>
              </div>
              <div class="flex-1">
                <label class="block text-xs text-zinc-500 mb-1">
                  Entrypoint
                </label>
                <input
                  value={entrypoint()}
                  onInput={(e) => setEntrypoint(e.currentTarget.value)}
                  disabled={loading()}
                  class="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
                />
              </div>
            </div>
            <textarea
              value={codeValue()}
              onInput={(e) => setCodeValue(e.currentTarget.value)}
              placeholder={`Write your ${codeLang()} code here…`}
              rows={10}
              disabled={loading()}
              class="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-mono text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
            />
            <button
              onClick={handleCodeSubmit}
              disabled={loading() || !codeValue().trim()}
              class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {loading() ? "Submitting…" : "Submit Code"}
            </button>
          </div>
        </Match>
      </Switch>
    );
  }

  /* ── Auto-scroll conversation ───────────────────────────────────── */
  createEffect(() => {
    const el = conversationRef;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  });

  /* ── Main render ────────────────────────────────────────────────── */

  return (
    <div class="mx-auto w-full max-w-3xl px-4 py-6">
      {/* ── Header ────────────────────────────────────────── */}
      <header class="mb-6 flex items-center justify-between">
        <div>
          <h1 class="text-xl font-semibold text-zinc-100">
            {props.candidateName || "Candidate"}
          </h1>
          <p class="text-sm text-zinc-500">{props.match.title}</p>
        </div>
        <button
          onClick={props.onBack}
          class="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
        >
          Exit interview
        </button>
      </header>

      {/* ── Error banner ──────────────────────────────────── */}
      <Show when={error()}>
        <div class="mb-4 flex items-center justify-between rounded-lg border border-red-800/40 bg-red-900/20 px-4 py-3">
          <p class="text-sm text-red-300">{error()}</p>
          <button
            onClick={() => setError(null)}
            class="ml-3 text-sm text-red-400 underline hover:text-red-300"
          >
            Dismiss
          </button>
        </div>
      </Show>

      {/* ── Loading state (initial) ───────────────────────── */}
      <Show when={loading() && conversation().length === 0 && !error()}>
        <div class="flex flex-col items-center justify-center gap-3 py-16">
          <div class="w-8 h-8 rounded-full border-2 border-zinc-700 border-t-indigo-500 animate-spin" />
          <p class="text-sm text-zinc-500">Starting interview…</p>
        </div>
      </Show>

      {/* ── Conversation log ──────────────────────────────── */}
      <Show when={conversation().length > 0}>
        <div
          ref={conversationRef}
          class="mb-6 max-h-[400px] space-y-3 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900/50 p-4"
        >
          <For each={conversation()}>
            {(entry) => (
              <div
                class={`flex ${entry.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  class={`max-w-[80%] rounded-xl px-4 py-2 text-sm leading-relaxed ${
                    entry.role === "user"
                      ? "bg-indigo-600/20 text-indigo-200"
                      : "bg-zinc-800 text-zinc-200"
                  }`}
                >
                  {entry.text}
                </div>
              </div>
            )}
          </For>
          <Show when={loading() && conversation().length > 0}>
            <div class="flex justify-start">
              <div class="rounded-xl bg-zinc-800 px-4 py-2 text-sm text-zinc-500">
                <span class="inline-flex gap-1">
                  <span
                    class="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce"
                    style="animation-delay:0ms"
                  />
                  <span
                    class="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce"
                    style="animation-delay:150ms"
                  />
                  <span
                    class="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce"
                    style="animation-delay:300ms"
                  />
                </span>
              </div>
            </div>
          </Show>
        </div>
      </Show>

      {/* ── Interview content ─────────────────────────────── */}
      <Show when={!complete() || conversation().length > 0}>
        <div class="space-y-5">
          {/* Current state badge */}
          <Show when={currentStateLabel()}>
            <div class="inline-flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-300">
              <span class="w-1.5 h-1.5 rounded-full bg-indigo-500" />
              {currentStateLabel()}
            </div>
          </Show>

          {/* Scores */}
          <Show when={Object.keys(scores()).length > 0}>
            {renderScores(scores())}
          </Show>

          {/* Current agent message (not yet in conversation) */}
          <Show when={agentMessage() && !loading()}>
            <div class="rounded-xl bg-zinc-800/70 px-4 py-3 text-sm leading-relaxed text-zinc-200">
              {agentMessage()}
            </div>
          </Show>

          {/* Submission widget */}
          <Show when={nextSubmission()}>
            <div class="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              {renderSubmissionWidget()}
            </div>
          </Show>
        </div>
      </Show>

      {/* ── Final Scorecard ───────────────────────────────── */}
      <Show when={complete() && finalEvaluation()}>
        <FinalScorecard evaluation={finalEvaluation()!} onFinish={props.onBack} />
      </Show>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Final Scorecard sub-component                                      */
/* ------------------------------------------------------------------ */

function FinalScorecard(props: {
  evaluation: FinalEvaluation;
  onFinish: () => void;
}) {
  const e = () => props.evaluation;
  const scores = () => e().scores || {};
  const scoreKeys = () => Object.keys(scores());

  return (
    <div class="mt-8 space-y-6 rounded-2xl border border-zinc-800 bg-zinc-900/80 p-6">
      <h2 class="text-lg font-semibold text-zinc-100">Final Scorecard</h2>

      {/* Recommendation badge */}
      <div
        class={`inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-semibold ${recColor(e().recommendation)}`}
      >
        {recLabel(e().recommendation)}
      </div>

      {/* Summary */}
      <Show when={e().summary}>
        <p class="text-sm leading-relaxed text-zinc-300">{e().summary}</p>
      </Show>

      {/* Score grid */}
      <Show when={scoreKeys().length > 0}>
        <div class="space-y-3">
          <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Scores
          </h3>
          <div class="grid grid-cols-2 gap-4">
            <For each={scoreKeys()}>
              {(key) => {
                const val = scores()[key];
                const max = getScoreMax(key);
                const pct = Math.min(100, (val / max) * 100);
                return (
                  <div>
                    <div class="flex justify-between text-xs mb-1">
                      <span class="capitalize text-zinc-300">
                        {key.replace(/_/g, " ")}
                      </span>
                      <span class="text-zinc-500">
                        {val.toFixed(1)}/{max}
                      </span>
                    </div>
                    <div class="h-2 bg-zinc-800 rounded-full overflow-hidden">
                      <div
                        class={`h-full rounded-full transition-all duration-700 ${getScoreColor(key)}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </div>
      </Show>

      {/* Strengths */}
      <Show when={e().strengths && e().strengths.length > 0}>
        <div>
          <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-emerald-400">
            Strengths
          </h3>
          <ul class="space-y-1">
            <For each={e().strengths}>
              {(s) => (
                <li class="flex items-start gap-2 text-sm text-zinc-300">
                  <span class="mt-0.5 text-emerald-400">+</span>
                  {s}
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>

      {/* Risks */}
      <Show when={e().risks && e().risks.length > 0}>
        <div>
          <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-400">
            Areas to consider
          </h3>
          <ul class="space-y-1">
            <For each={e().risks}>
              {(r) => (
                <li class="flex items-start gap-2 text-sm text-zinc-300">
                  <span class="mt-0.5 text-amber-400">—</span>
                  {r}
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>

      {/* Finish button */}
      <div class="pt-2">
        <button
          onClick={props.onFinish}
          class="rounded-lg bg-indigo-600 px-6 py-2 text-sm font-medium text-white transition hover:bg-indigo-500"
        >
          Finish
        </button>
      </div>
    </div>
  );
}
