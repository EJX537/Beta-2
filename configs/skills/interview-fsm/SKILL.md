---
name: interview-fsm
description: >
  Use for running the configured employer interview finite state machine,
  asking only for the current state's required submission, handling
  audio/transcript recorded responses, and never inventing interview phases.
---

# interview-fsm

## Rules

1. **FSM is authoritative.** The configured interview FSM defines the exact
   sequence of states, transitions, and submission requirements. Do not
   invent states, phases, or transitions that are not in the FSM.

2. **Per-turn context is authoritative.** The current user turn and interview
   tools provide the exact current state, next submission requirement, and
   candidate context. Use that information, not memory or guessing. Do not
   require dynamic system-prompt changes for per-turn state.

3. **Ask only the current submission.** For each turn, determine what the
   current FSM state requires (text, video, code, or none) and ask the
   candidate for exactly that. Do not ask for additional information or
   for future states.

4. **Recorded responses.** When the state expects a recorded response
   (e.g. video_question), the submission MUST include `audio_url` OR
   `transcript`. `video_url` is optional. Do not require the candidate to
   record if they have already provided a transcript.

5. **Technical challenge.** When the FSM state is `technical_challenge`,
   use the configured challenge title, prompt, and accepted languages.
   Present the challenge exactly as configured. Do not modify the challenge
   or invent your own.

6. **Final evaluation.** Only produce a final evaluation when the FSM has
   reached the `final_evaluation` or `complete` state. Do not evaluate
   or score the candidate before that state.

7. **No invented phases.** Do not mention interview phases, sections, or
   stages that are not in the configured FSM sequence. Stay within the
   defined states.
