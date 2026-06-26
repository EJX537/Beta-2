# Beta Agent — AgentBox-Compatible Interviewing Agent

A TypeScript + [Hono](https://hono.dev) server implementing the [GMI AgentBox](https://gmi-serving.com) contract with a structured interviewing agent. Designed for the Beta Hackathon.

## Overview

This project provides two distinct AI agent capabilities:

1. **AgentBox generic agent** (`POST /run`, `GET /jobs/:id`, `GET /health`) — a simple job-based agent that accepts messages, calls a configured LLM via GMI MaaS, and returns results asynchronously.

2. **Interviewing agent** (`POST /interview/:companyId/:jobId/:threadId`, `POST .../uploads`) — a state-machine-driven interview platform that runs structured interviews with audio grading, code submission verification, and deterministic final evaluation.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Hono HTTP Server                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ /health  │  │ /run     │  │ /jobs/:id│  │ /interview/... │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────────────┘  │
│                                                   │             │
│                                          ┌────────▼────────┐   │
│                                          │ Interview Agent  │   │
│                                          │  (pi SDK FSM)    │   │
│                                          └────────┬────────┘   │
│                                                   │             │
│              ┌────────────────────────────────────┼─────┐      │
│              ▼            ▼            ▼          ▼     ▼      │
│         ┌────────┐ ┌──────────┐ ┌────────┐ ┌──────┐ ┌────┐   │
│         │ Config │ │ FSM/     │ │ Tools  │ │Artif.│ │Persistence│
│         │ Loader │ │ Session  │ │(state │ │Store │ │Bridge │   │
│         └────────┘ └──────────┘ │advance,│ └──────┘ └──────┘   │
│                                 │validate,│                     │
│                                 │grade)   │                     │
│                                 └─────────┘                     │
│                                                                  │
│  ┌──────────────┐  ┌─────────────┐  ┌───────────────────────┐  │
│  │ Audio Grader │  │ Code Runner │  │ Final Evaluator       │  │
│  │ (GMI MaaS)   │  │ (local exec)│  │ (deterministic scores)│  │
│  └──────────────┘  └─────────────┘  └───────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Key components

- **Hono server** — Lightweight web framework, routes mounted in `src/index.ts`
- **GMI model integration** — OpenAI-compatible client configured via environment variables; used for both general completions and audio grading
- **Interview FSM** — Finite-state machine defined in `configs/companies/<id>/jobs/<jobId>/interview.json`; each state defines what to ask, what to collect, and where to transition
- **Agent-owned state advancement** — The pi SDK agent (the LLM) interrogates the current state via tools and calls `advance_interview_state` to move exactly one transition
- **SQLite persistence bridge** — Conflict-free `interview.db` snapshots; optional read-only attach to `agent1.db` (Python screening DB) for candidate profile hydration
- **Artifact store** — Local filesystem store for uploaded audio, transcripts, video, and code artifacts with URI-based references
- **Audio grading** — GMI MaaS multimodal model grades audio responses against configured rubrics
- **Code runner** — Temporary workspace execution of submitted code with configurable verification scripts
- **Final evaluation** — Deterministic score aggregation from per-state weighted categories mapped to recommendation levels

## Directory Structure

```
├── configs/                          # Interview configuration tree
│   ├── companies/
│   │   └── demo-company/
│   │       ├── company.json          # Company profile
│   │       └── jobs/
│   │           └── software-developer/
│   │               ├── job.json              # Job posting
│   │               ├── interview.json        # FSM definition
│   │               └── technical-challenge.json  # Code challenge
│   └── skills/
│       └── interview-fsm/
│           └── SKILL.md              # pi SDK skill definition
├── src/
│   ├── index.ts                      # Server entry point
│   ├── types.ts                      # Shared types
│   ├── jobStore.ts                   # In-memory job store (AgentBox)
│   ├── gmi.ts                        # GMI MaaS client configuration
│   ├── routes/
│   │   ├── health.ts                 # GET /health
│   │   ├── run.ts                    # POST /run
│   │   ├── jobs.ts                   # GET /jobs/:id
│   │   └── interview.ts             # POST /interview/:companyId/:jobId/:threadId
│   │                                   POST /interview/:companyId/:jobId/:threadId/uploads
│   └── agents/interview/
│       ├── agent.ts                  # Agent factory (pi SDK wiring)
│       ├── types.ts                  # Interview domain types
│       ├── errors.ts                 # Structured error classes
│       ├── resource-loader.ts        # pi SDK resource loader with JIT context
│       ├── config/
│       │   └── loader.ts             # JSON config loader + validator
│       ├── state/
│       │   ├── fsm.ts                # Interview FSM logic
│       │   └── session-store.ts      # In-memory session store
│       ├── tools/
│       │   └── index.ts              # Custom pi SDK tools (advance, validate, etc.)
│       ├── skills/
│       │   ├── audio-grader.ts       # Audio/video response grading
│       │   ├── final-evaluator.ts    # Deterministic score → recommendation
│       │   └── local-runner.ts       # Code submission executor
│       ├── artifacts/
│       │   └── store.ts              # Local filesystem artifact store
│       ├── persistence/
│       │   ├── bridge.ts             # SQLite persistence bridge
│       │   └── index.ts              # Re-exports
│       └── prompts/
│           └── system.md             # System prompt template
├── tests/                            # Vitest test suite (98 tests)
├── static/
│   └── index.html                    # Demo landing page
├── agent1.py                         # Screening agent (Python)
├── seed_jobs.py                      # DB seeding script
├── docker-compose.yml
├── Dockerfile
├── .env.example                      # Environment template (no real keys)
└── package.json
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP server port |
| `NODE_ENV` | `production` | Runtime environment |
| `GMI_MAAS_BASE_URL` | `https://api.gmi-serving.com` | GMI MaaS API base URL |
| `GMI_MAAS_API_KEY` | _(required)_ | GMI MaaS API key |
| `GMI_MODELS` | `nvidia/nemotron-3-ultra-550b-a55b` | Default model for AgentBox /run and interview agent |
| `GMI_GRADING_MODEL` | `google/gemini-3.5-flash` | Model for audio response grading |
| `INTERVIEW_DB` | `/data/interview.db` | SQLite path for interview snapshots |
| `AGENT_DB` | `/data/agent1.db` | SQLite path for Python screening DB (attached read-only) |
| `INTERVIEW_ARTIFACT_ROOT` | `/data/interview-artifacts` | Filesystem root for uploaded artifacts |

See [`.env.example`](.env.example) for the template.

## Endpoints

### AgentBox Contract

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Returns `{"status":"ok"}` |
| `POST` | `/run` | Submit a job; accepts `{"payload":{"message":"..."}}`. Returns `202` with `job_id`. |
| `GET` | `/jobs/:id` | Poll job status; returns `{status, result?, error?}` |

### Interview Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/interview/:companyId/:jobId` | Start or continue an interview session |
| `POST` | `/interview/:companyId/:jobId/:threadId/uploads` | Upload an artifact (audio, transcript, code) |

Full request/response schemas are documented in [`src/agents/interview/types.ts`](src/agents/interview/types.ts).

## How to Run Locally

### Prerequisites

- Node.js 24+
- npm 10+
- Docker (optional, for containerized runs)

### Bare metal

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Start the server
npm start
```

### Docker Compose

```bash
# Copy the environment template (edit with your GMI API key)
cp .env.example .env
# Edit .env with your GMI_MAAS_API_KEY

# Build and start
docker compose up --build

# The server will be available at http://localhost:8080
```

### Docker (without compose)

```bash
docker build -t beta-agent .
docker run -p 8080:8080 --env-file .env beta-agent
```

## How to Run Tests

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch
```

The test suite includes:

- **Job store tests** — AgentBox job lifecycle
- **FSM tests** — State initialization, transitions, validation
- **Error tests** — Structured error classes, tool error propagation
- **Artifact store tests** — Local storage, reference resolution, ownership validation
- **Persistence tests** — SQLite bridge, screening DB hydration, snapshot round-trip
- **Local runner tests** — Code execution, timeout handling, path safety
- **Audio grader tests** — Mocked grading pipeline, format inference
- **Final evaluation tests** — Score aggregation, thresholds, strengths/risks
- **JIT context tests** — Per-turn context string generation
- **Tool tests** — Tool-based state advancement with idempotency
- **E2E tests** — Full three-round technical interview FSM with code execution

## Config Format

Company and job configurations are JSON files under `configs/companies/<companyId>/`.

### `company.json`

```json
{
  "id": "acme-corp",
  "name": "Acme Corp",
  "description": "...",
  "values": ["innovation", "quality"],
  "hiring_style": "thorough-but-friendly",
  "agent_tone": "professional-warm"
}
```

### `jobs/<jobId>/job.json`

```json
{
  "id": "software-developer",
  "title": "Software Developer",
  "company_id": "acme-corp",
  "level": "mid",
  "description": "...",
  "required_skills": ["TypeScript", "Node.js"],
  "evaluation_priorities": ["problem_solving", "code_quality"]
}
```

### `jobs/<jobId>/interview.json`

Defines the interview FSM with ordered states, each specifying:

- `id` — unique state identifier
- `label` — human-readable label
- `agent_instruction` — instruction to the LLM for this state
- `expected_submission` — type (`text|video|code|none`), required fields
- `transitions_to` — ordered list of next state IDs
- `score_weights` — per-category score weight for this state
- `audioRubric` — optional grading rubric for video states

### `jobs/<jobId>/technical-challenge.json`

Defines a coding challenge with runner configuration for local execution.

## License

Beta Hackathon — internal use.
