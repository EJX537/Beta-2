import { createSignal, Match, Switch } from "solid-js";
import ResumeFlow from "./components/ResumeFlow";
import InterviewFlow from "./components/InterviewFlow";
import type { MatchResult } from "./lib/api";

export default function App() {
  const [screen, setScreen] = createSignal<"resume" | "interview">("resume");
  const [selectedMatch, setSelectedMatch] = createSignal<MatchResult | null>(null);
  const [candidateName, setCandidateName] = createSignal("");

  return (
    <div class="min-h-screen bg-zinc-950 text-zinc-100">
      <Switch>
        <Match when={screen() === "resume"}>
          <ResumeFlow
            onStartInterview={(match, name) => {
              setSelectedMatch(match);
              setCandidateName(name);
              setScreen("interview");
            }}
          />
        </Match>
        <Match when={screen() === "interview" && selectedMatch()}>
          <InterviewFlow
            match={selectedMatch()!}
            candidateName={candidateName()}
            onBack={() => setScreen("resume")}
          />
        </Match>
      </Switch>
    </div>
  );
}
