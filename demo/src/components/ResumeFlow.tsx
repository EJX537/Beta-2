import { createSignal, createMemo, Show, For, Switch, Match } from "solid-js";
import { matchResume, applyToJob, type MatchResult } from "../lib/api";

type Step = "upload" | "loading" | "results";

type FileOrText =
  | { kind: "file"; file: File }
  | { kind: "text"; text: string };

interface Props {
  onStartInterview: (match: MatchResult, candidateName: string) => void;
}

const VERDICT_CLASSES: Record<string, string> = {
  strong: "bg-green-900/60 text-green-300 border-green-700",
  consider: "bg-amber-900/60 text-amber-300 border-amber-700",
  weak: "bg-red-900/60 text-red-300 border-red-700",
};

const VERDICT_LABELS: Record<string, string> = {
  strong: "Strong fit",
  consider: "Consider",
  weak: "Weak",
};

function verdictClass(v: string): string {
  return VERDICT_CLASSES[v] ?? "bg-zinc-800 text-zinc-300 border-zinc-600";
}

function verdictLabel(v: string): string {
  return VERDICT_LABELS[v] ?? v;
}

export default function ResumeFlow(props: Props) {
  const [step, setStep] = createSignal<Step>("upload");
  const [source, setSource] = createSignal<FileOrText | null>(null);
  const [candidateName, setCandidateName] = createSignal("");
  const [dragOver, setDragOver] = createSignal(false);
  const [textareaValue, setTextareaValue] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);

  // Results state
  const [matches, setMatches] = createSignal<MatchResult[]>([]);
  const [matchedName, setMatchedName] = createSignal<string | null>(null);
  const [selectedIndex, setSelectedIndex] = createSignal<number | null>(null);

  let fileInputRef!: HTMLInputElement;

  const selectedMatch = createMemo(() => {
    const i = selectedIndex();
    if (i === null) return null;
    return matches()[i] ?? null;
  });

  const isDragActive = () => dragOver();

  // ─── File drop / click handler ────────────────────────────────
  function handleFile(file: File) {
    setSource({ kind: "file", file });
    setError(null);
    // Clear textarea when file chosen
    setTextareaValue("");
  }

  function onDragOver(e: DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }
  function onDragLeave() {
    setDragOver(false);
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file && acceptFile(file.name)) {
      handleFile(file);
    }
  }

  function acceptFile(name: string): boolean {
    return /\.(pdf|docx|txt|md)$/i.test(name);
  }

  function onFileInputChange(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) handleFile(file);
  }

  function onTextareaInput(e: Event) {
    const val = (e.target as HTMLTextAreaElement).value;
    setTextareaValue(val);
    if (val.trim()) {
      setSource({ kind: "text", text: val });
    } else {
      setSource(null);
    }
  }

  // ─── Submit ───────────────────────────────────────────────────
  async function onSubmit() {
    const s = source();
    if (!s) return;
    setError(null);
    setStep("loading");

    try {
      let body: FormData | { resume: string; candidate_name?: string };

      if (s.kind === "file") {
        const fd = new FormData();
        fd.append("resume_file", s.file);
        if (candidateName().trim()) fd.append("candidate_name", candidateName().trim());
        body = fd;
      } else {
        body = { resume: s.text };
        if (candidateName().trim()) body.candidate_name = candidateName().trim();
      }

      const res = await matchResume(body);
      setMatches(res.matches);
      setMatchedName(res.candidate_name ?? null);
      setSelectedIndex(null);
      setStep("results");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setStep("upload");
    }
  }

  // ─── Start interview (detail view CTA) ──────────────────────
  async function handleStartInterview() {
    const m = selectedMatch();
    if (!m) return;
    const name = (matchedName() || candidateName() || "").trim();

    // Best-effort applyToJob
    try {
      await applyToJob(m.job_id, {
        candidate_name: name || null,
        resume_text: source() ? getSourceText(source()!) : null,
        analysis: m.analysis ?? null,
      });
    } catch {
      // ignore – fire-and-forget
    }

    props.onStartInterview(m, name || "Candidate");
  }

  // ─── Helpers ──────────────────────────────────────────────────
  function getSourceText(s: FileOrText): string | null {
    if (s.kind === "text") return s.text;
    return null;
  }

  const canSubmit = () => {
    const s = source();
    if (!s) return false;
    if (s.kind === "file") return true;
    return s.text.trim().length > 0;
  };

  const fileName = () => {
    const s = source();
    return s?.kind === "file" ? s.file.name : null;
  };

  function backToShortlist() {
    setSelectedIndex(null);
  }

  // ─── Render ────────────────────────────────────────────────────
  return (
    <div class="mx-auto w-full max-w-4xl px-4 py-8">
      {/* Header */}
      <header class="mb-10 text-center">
        <div class="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/50 px-4 py-1.5 text-sm font-medium text-zinc-400">
          <span class="flex h-5 w-5 items-center justify-center rounded bg-indigo-500 text-[10px] font-bold text-white">
            β
          </span>
          Beta
        </div>
        <h1 class="mt-3 text-3xl font-bold tracking-tight text-zinc-100">
          AI hiring, end to end
        </h1>
        <p class="mt-1 text-zinc-500">
          Upload a resume and get matched to open roles instantly.
        </p>
      </header>

      <Switch>
        {/* ──────── UPLOAD STEP ──────── */}
        <Match when={step() === "upload"}>
          <section class="space-y-6">
            {/* Drop zone */}
            <div
              class={`relative flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
                isDragActive()
                  ? "border-indigo-500 bg-indigo-500/10"
                  : "border-zinc-700 bg-zinc-900/40 hover:border-zinc-600"
              }`}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onClick={() => fileInputRef?.click()}
            >
              <input
                ref={fileInputRef!}
                type="file"
                accept=".pdf,.docx,.txt,.md"
                class="hidden"
                onChange={onFileInputChange}
              />
              <svg
                class="mb-3 h-10 w-10 text-zinc-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={1.5}
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                />
              </svg>
              <p class="text-sm font-medium text-zinc-300">
                {isDragActive()
                  ? "Drop your file here"
                  : "Drag & drop your resume here"}
              </p>
              <p class="mt-1 text-xs text-zinc-500">
                PDF, DOCX, TXT, or Markdown
              </p>

              <Show when={fileName()}>
                <div class="mt-4 flex items-center gap-2 rounded-lg bg-indigo-500/10 px-3 py-1.5 text-sm text-indigo-300">
                  <svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  {fileName()}
                </div>
              </Show>
            </div>

            {/* Divider */}
            <div class="flex items-center gap-3">
              <span class="h-px flex-1 bg-zinc-800" />
              <span class="text-xs font-medium uppercase tracking-wider text-zinc-500">
                or paste your resume
              </span>
              <span class="h-px flex-1 bg-zinc-800" />
            </div>

            {/* Textarea */}
            <textarea
              value={textareaValue()}
              onInput={onTextareaInput}
              rows={6}
              class="w-full resize-none rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-100 placeholder-zinc-500 outline-none ring-offset-zinc-900 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
              placeholder="Paste the full text of your resume here…"
            />

            {/* Name field */}
            <div>
              <label for="cname" class="mb-1.5 block text-xs font-medium uppercase tracking-wider text-zinc-400">
                Your name <span class="text-zinc-600">(optional)</span>
              </label>
              <input
                id="cname"
                type="text"
                value={candidateName()}
                onInput={(e) => setCandidateName((e.target as HTMLInputElement).value)}
                class="w-full rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
                placeholder="Jane Doe"
              />
            </div>

            {/* Error */}
            <Show when={error()}>
              <div class="rounded-lg border border-red-800 bg-red-900/30 px-4 py-2 text-sm text-red-300">
                {error()}
              </div>
            </Show>

            {/* Submit */}
            <button
              disabled={!canSubmit()}
              onClick={onSubmit}
              class="w-full rounded-xl bg-indigo-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Find my matches
            </button>
          </section>
        </Match>

        {/* ──────── LOADING STEP ──────── */}
        <Match when={step() === "loading"}>
          <section class="flex flex-col items-center justify-center py-20">
            <svg
              class="h-10 w-10 animate-spin text-indigo-400"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path
                class="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            <p class="mt-4 text-sm font-medium text-zinc-300">
              Reading your resume and matching you to open roles…
            </p>
          </section>
        </Match>

        {/* ──────── RESULTS STEP ──────── */}
        <Match when={step() === "results"}>
          <Switch>
            {/* Detail view */}
            <Match when={selectedMatch() !== null}>
              {(() => {
                const m = selectedMatch()!;
                const breakdown = m.analysis?.skill_breakdown ?? [];
                const gaps = m.analysis?.missing_must_haves ?? [];
                const flags = m.analysis?.red_flags ?? [];
                const sources = m.analysis?.sources_checked ?? [];

                return (
                  <section class="space-y-6">
                    {/* Back */}
                    <button
                      onClick={backToShortlist}
                      class="inline-flex items-center gap-1.5 text-sm text-zinc-400 transition hover:text-zinc-200"
                    >
                      <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M15 19l-7-7 7-7" />
                      </svg>
                      Back to shortlist
                    </button>

                    {/* Title row */}
                    <div class="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <h2 class="text-2xl font-bold text-zinc-100">{m.title}</h2>
                        <div class="mt-1 flex items-center gap-3">
                          <span
                            class={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${verdictClass(m.verdict)}`}
                          >
                            {verdictLabel(m.verdict)}
                          </span>
                          <span class="text-sm font-semibold text-zinc-300">
                            {m.score}% match
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Description */}
                    <Show when={m.description}>
                      <p class="leading-relaxed text-zinc-400">{m.description}</p>
                    </Show>

                    {/* Summary */}
                    <Show when={m.analysis?.summary}>
                      <div class="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
                        <p class="text-sm leading-relaxed text-zinc-300">{m.analysis!.summary}</p>
                      </div>
                    </Show>

                    {/* Why you're a fit */}
                    <Show when={breakdown.length > 0}>
                      <div>
                        <h3 class="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">
                          Why you're a fit
                        </h3>
                        <div class="space-y-3">
                          <For each={breakdown}>
                            {(skill) => (
                              <div>
                                <div class="mb-1 flex items-center justify-between text-sm">
                                  <span class="font-medium text-zinc-200">{skill.name}</span>
                                  <span class="text-zinc-400">{skill.score}/100</span>
                                </div>
                                <div class="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                                  <div
                                    class="h-full rounded-full bg-indigo-500 transition-all"
                                    style={{ width: `${Math.min(100, Math.max(0, skill.score))}%` }}
                                  />
                                </div>
                                <Show when={skill.evidence}>
                                  <p class="mt-0.5 text-xs italic text-zinc-500">{skill.evidence}</p>
                                </Show>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>

                    {/* Gaps & red flags */}
                    <Show when={gaps.length > 0 || flags.length > 0}>
                      <div class="flex flex-wrap gap-2">
                        <For each={gaps}>
                          {(g) => (
                            <span class="inline-flex items-center gap-1 rounded-full border border-amber-700 bg-amber-900/30 px-2.5 py-0.5 text-xs font-medium text-amber-300">
                              <svg class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                              </svg>
                              {g}
                            </span>
                          )}
                        </For>
                        <For each={flags}>
                          {(f) => (
                            <span class="inline-flex items-center gap-1 rounded-full border border-red-700 bg-red-900/30 px-2.5 py-0.5 text-xs font-medium text-red-300">
                              <svg class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M6 18V6m0 0L18 18M6 6l12 12" />
                              </svg>
                              {f}
                            </span>
                          )}
                        </For>
                      </div>
                    </Show>

                    {/* Sources */}
                    <Show when={sources.length > 0}>
                      <div>
                        <h4 class="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
                          Sources checked
                        </h4>
                        <div class="flex flex-wrap gap-2">
                          <For each={sources}>
                            {(src) => (
                              <span class="rounded-md border border-zinc-700 bg-zinc-800/50 px-2.5 py-1 text-xs text-zinc-400">
                                {src}
                              </span>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>

                    {/* CTA bar */}
                    <div class="sticky bottom-0 -mx-4 -mb-4 mt-8 border-t border-zinc-800 bg-zinc-950/90 px-4 py-4 backdrop-blur-sm">
                      <div class="flex items-center justify-end gap-3">
                        <button
                          onClick={backToShortlist}
                          class="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 transition hover:text-zinc-200"
                        >
                          Maybe later
                        </button>
                        <button
                          onClick={handleStartInterview}
                          class="rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500"
                        >
                          Start AI interview
                        </button>
                      </div>
                    </div>
                  </section>
                );
              })()}
            </Match>

            {/* Shortlist */}
            <Match when={selectedMatch() === null}>
              <section class="space-y-4">
                <h2 class="text-xl font-bold text-zinc-100">
                  {matchedName()
                    ? `${matchedName()}, here are your top fits`
                    : "Roles that fit you"}
                </h2>

                <Show
                  when={matches().length > 0}
                  fallback={
                    <p class="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-8 text-center text-sm text-zinc-500">
                      No roles matched your resume.
                    </p>
                  }
                >
                  <div class="space-y-3">
                    <For each={matches()}>
                      {(m, i) => (
                        <button
                          onClick={() => setSelectedIndex(i())}
                          class="w-full rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-left transition hover:border-zinc-700 hover:bg-zinc-900/80"
                        >
                          <div class="flex items-start justify-between gap-4">
                            <div class="min-w-0 flex-1">
                              <div class="flex items-center gap-2">
                                <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-zinc-800 text-xs font-bold text-zinc-400">
                                  {i() + 1}
                                </span>
                                <h3 class="truncate text-sm font-semibold text-zinc-100">
                                  {m.title}
                                </h3>
                              </div>
                              <Show when={m.analysis?.summary}>
                                <p class="mt-1 line-clamp-1 text-sm text-zinc-500">
                                  {m.analysis!.summary}
                                </p>
                              </Show>
                            </div>
                            <div class="flex shrink-0 items-center gap-2">
                              <span
                                class={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${verdictClass(m.verdict)}`}
                              >
                                {verdictLabel(m.verdict)}
                              </span>
                              <span class="text-sm font-semibold text-zinc-300">
                                {m.score}%
                              </span>
                            </div>
                          </div>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>

                {/* Try again */}
                <div class="pt-4 text-center">
                  <button
                    onClick={() => {
                      setStep("upload");
                      setSource(null);
                      setTextareaValue("");
                      setCandidateName("");
                    }}
                    class="text-sm text-zinc-500 underline underline-offset-2 transition hover:text-zinc-300"
                  >
                    Upload a different resume
                  </button>
                </div>
              </section>
            </Match>
          </Switch>
        </Match>
      </Switch>
    </div>
  );
}
