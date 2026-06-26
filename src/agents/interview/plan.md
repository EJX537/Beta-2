# Interviewing Agent Plan

## Purpose

This directory is for the second part of the system: the interviewing agent.

The interviewing agent is responsible for running an end-to-end interview process for a configured company and job posting. It receives candidate context from the screening agent, conducts the interview according to job-specific configuration, collects required submissions, and produces a final evaluation only at the end.

Implementation code for this agent should live under:

```text
src/agents/interview/
```

---

## System Context

The full system has two parts:

1. **Screening Agent**
   - Builds a candidate profile.
   - Passes candidate context into the interviewing agent.

2. **Interviewing Agent**
   - Loads company/job/interview configuration.
   - Runs a finite-state interview process.
   - Controls what the candidate must submit at each step.
   - Produces a final scorecard/evaluation.

This directory is focused on part 2.

---

## Framework Direction

The interviewing agent should use the **pi coding agent SDK**.

However, the default pi coding-agent behavior should be heavily overridden. This is not intended to behave like a normal coding assistant. It should behave like a constrained interview-running agent with job-specific tools, skills, prompts, and state.

Expected SDK direction:

- custom session factory
- custom system prompt
- custom resource loader
- custom tool allowlist
- custom interview tools
- custom interview skills/business logic
- no default file-system/code-editing behavior unless explicitly needed
- model provider wired through the deployment/runtime environment

Previous failed implementation for reference/inspiration:

```text
/Users/ejx/Documents/Github/Hackathon/Global-Qwen/src/agents/interviewer-scheduler
```

Useful ideas from that implementation:

```text
agent.ts        # pi SDK session factory pattern
index.ts        # barrel exports
types.ts        # domain types
tools/index.ts  # SDK tool definitions
skills/index.ts # deterministic business logic used by tools
```

Do not copy it directly. The scheduler domain is different. Use its structure only as inspiration for organizing the interviewing agent.

---

## Proposed Directory Shape

```text
src/agents/interview/
  plan.md
  agent.ts
  index.ts
  types.ts
  prompts/
    system.md
  tools/
    index.ts
  skills/
    index.ts
  config/
    loader.ts
  state/
    fsm.ts
    session-store.ts
```

This is only the proposed shape. Implementation should wait until confirmed.

---

## Public Agent Entry Point

The interviewing agent should expose a single interview interaction endpoint shaped around company/job configuration:

```text
/interview/:companyId/:jobId?params=<base64-json>
```

Conceptually, this behaves like an AI completion/chat endpoint.

The caller sends:

- candidate/user message
- optional thread/session id
- optional submission payload
- candidate profile/context, either in `params` or body

The agent responds with:

- current interview state
- message to show to candidate
- required next submission shape
- whether the interview is complete
- final evaluation only when complete

---

## URL Params

For hackathon scope, `params` may be base64-encoded JSON.

Example contents:

```json
{
  "candidate_id": "candidate-123",
  "candidate_profile": {},
  "source": "screening-agent"
}
```

In production this would likely be replaced by signed URLs, database ids, object storage, or another secure handoff mechanism. Security is not in scope for the hackathon MVP.

---

## Configuration Directory

Add a mock configuration area for company/job data:

```text
configs/
  companies/
    demo-company/
      company.json
      jobs/
        software-developer/
          job.json
          interview.json
          technical-challenge.json
```

Planned responsibilities:

### `company.json`

Company-level context:

- company name
- description
- values
- hiring style
- tone/personality for the interview agent

### `job.json`

Job posting context:

- title
- level
- responsibilities
- required skills
- preferred skills
- evaluation priorities

### `interview.json`

Interview finite-state-machine definition:

- ordered states
- state ids
- prompts/instructions
- expected submission type
- required fields
- state transition rules
- completion criteria

### `technical-challenge.json`

Technical assessment definition:

- challenge title
- prompt/requirements
- accepted languages or format
- scoring rubric
- test/reward description
- sandbox/evaluator integration metadata, if any

---

## Interview FSM Concept

The interview should be driven by a finite-state machine owned by the job configuration.

Possible MVP states:

```text
intro
video_question_1
video_question_2
technical_challenge
technical_submission_review
final_evaluation
complete
```

The FSM controls:

- what the agent asks next
- what kind of submission is expected
- whether the state can advance
- what data is collected
- when final evaluation occurs

The agent should not require separate fixed routes for each type of submission. The current state defines the expected submission JSON blob.

---

## Submission Model

Each state can define its own required submission shape.

Examples:

### Audio/transcript-style response

For recorded candidate answers, the interviewer only needs audio or transcribed text for grading. A video URL may be stored as optional metadata, but it is not required by the agent.

```json
{
  "type": "video",
  "requirements": {
    "max_seconds": 30,
    "fields": [],
    "any_of_fields": ["audio_url", "transcript"],
    "optional_fields": ["video_url"]
  }
}
```

### Text response

```json
{
  "type": "text",
  "requirements": {
    "fields": ["answer"]
  }
}
```

### Code response

```json
{
  "type": "code",
  "requirements": {
    "fields": ["language", "files", "entrypoint"]
  }
}
```

The agent response should always tell the caller what is required next.

---

## Technical Challenge Direction

For the software developer hackathon MVP, the technical interview should be open-ended, job-relevant, and must execute the submitted code.

Required direction:

- the agent presents requirements for a small coding task
- candidate submits code or a code artifact
- the service writes the submitted files into a temporary workspace
- the service runs the submitted code locally inside the agent container
- the runner executes configured tests or verification commands
- execution output is converted into a structured technical score/result
- score/result is fed back into the interview state
- final evaluation incorporates the result

Hackathon MVP evaluator:

- local runner inside the deployed container
- temporary per-submission workspace
- command timeout
- stdout/stderr capture
- exit code capture
- configured verification command from `technical-challenge.json`
- optional static review/LLM review only as supplemental evidence, not a replacement for running code

Accepted hackathon constraint:

- running submitted code locally is insecure and accepted for this MVP
- production sandboxing is out of scope
- future versions can replace the local runner with an external sandbox

---

## Tool And Skill Direction

The pi SDK agent should expose narrow custom tools rather than broad coding-agent tools.

Potential interview tools:

- load_company_job_config
- get_current_interview_state
- validate_submission
- advance_interview_state
- record_submission
- generate_next_interview_message
- produce_final_scorecard
- evaluate_technical_submission

Potential skills/business logic:

- decode base64 params
- load config by company/job id
- validate FSM config
- validate candidate submission shape
- transition FSM state
- summarize collected submissions
- construct final evaluation context
- normalize final scorecard JSON
- create temporary execution workspace
- write submitted files to disk
- run configured technical challenge verification command
- capture exit code, stdout, stderr, duration, and timeout state

The agent can reason, but the FSM should remain authoritative.

---

## Final Evaluation

Evaluation should happen only at the end of the FSM.

Final output should include a structured scorecard, for example:

```json
{
  "recommendation": "strong_yes | yes | mixed | no",
  "scores": {
    "communication": 0,
    "technical_depth": 0,
    "problem_solving": 0,
    "role_fit": 0
  },
  "strengths": [],
  "risks": [],
  "summary": ""
}
```

Exact fields are TBD and should be driven by the job/interview config.

---

## Required Decisions Before Implementation

1. Exact request/response shape for the interview completion endpoint.
2. How SDK sessions map to interview threads.
3. Whether state is stored in memory, database, file, or external store.
4. Whether `params` contains full candidate profile or only a reference/id.
5. How video answers are represented for the hackathon:
   - URL only
   - transcript only
   - URL + transcript
   - raw upload handled elsewhere
6. Exact local runner command format and timeout defaults.
7. Whether demo UI lives in this repo or separately.
8. Whether existing AgentBox `/run` endpoint wraps the interview endpoint or stays separate.
9. Which default pi tools, if any, should remain enabled.
10. Which model provider configuration should be used for the SDK session in deployment.

---

## Hackathon MVP Acceptance Criteria

The MVP should demonstrate:

- company/job config can be selected by URL
- candidate profile can be passed into the agent
- interview state progresses through configured FSM states
- each response includes next submission requirements
- video-style questions are represented as 30-second response requirements
- technical challenge is represented as an open-ended code task
- submitted technical challenge code is executed locally in the agent container
- execution result includes exit code, stdout/stderr, timeout status, and score
- final evaluation is produced only after required steps are complete
- deployment remains compatible with the existing container/GMI setup
- pi SDK agent is constrained to interview-specific behavior

---

## Non-Goals For Initial Implementation

- production auth/security
- real video hosting
- real transcription pipeline
- production-grade code sandboxing
- secure isolation for untrusted code
- multi-tenant database design
- polished frontend UI
- replacing the existing deployment infrastructure
- general-purpose coding assistant behavior

---

## Immediate Next Step

Confirm the SDK session architecture and request/response contract before writing implementation code.
