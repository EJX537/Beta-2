# Screening → Interview Handoff Contract

This repo has two hackathon agents that intentionally do **not** share an implementation language:

- `agent1.py` / screening agent owns candidate screening and writes `agent1.db`.
- TypeScript interview agent owns interview sessions and writes `interview.db`.

The stable handoff key is `profile_id`.

## Source of truth

The screening agent's SQLite database remains the source of truth for screened candidate profiles.

```txt
agent1.db
└── profiles
    ├── id                 ← profile_id, stable primary key
    ├── job_id
    ├── candidate_name
    ├── resume_text
    ├── overall_score
    ├── verdict
    ├── analysis           ← JSON string from screening agent
    └── created_at
```

The interview agent attaches this DB **read-only** as the `screening` schema. It never writes to `agent1.db` and never changes the Python agent schema.

## Interview-owned persistence

The interview agent writes only to its own DB:

```txt
interview.db
└── interview_snapshots
    ├── thread_id          ← interview session id
    ├── profile_id         ← screening.profiles.id, when available
    ├── candidate_id       ← defaults to profile_id unless overridden
    ├── company_id
    ├── job_id
    ├── status             ← in_progress | complete
    ├── current_state
    ├── candidate_context_json
    ├── submissions_json
    ├── scores_json
    ├── final_evaluation_json
    ├── created_at
    └── updated_at
```

Default runtime paths:

```txt
AGENT_DB=/data/agent1.db
INTERVIEW_DB=/data/interview.db
```

Docker Compose mounts `./data:/data`, so local demos should place the screening DB at:

```txt
./data/agent1.db
```

## API handoff from frontend/orchestrator

Start or continue an interview with:

```http
POST /interview/:companyId/:jobId
Content-Type: application/json
```

Minimum new interview request after screening:

```json
{
  "profile_id": "profile-uuid-from-agent1",
  "message": "Start the interview."
}
```

Continue an existing interview:

```json
{
  "thread_id": "thread-id-from-previous-response",
  "profile_id": "profile-uuid-from-agent1",
  "message": "Here is my answer.",
  "submission": {
    "answer": "I'm ready."
  }
}
```

The API response includes the thread to reuse:

```json
{
  "thread_id": "interview-thread-id",
  "company_id": "demo-company",
  "job_id": "software-developer",
  "state": {
    "currentStateId": "video_question_1",
    "nextSubmission": {
      "type": "video",
      "fields": [],
      "any_of_fields": ["audio_url", "transcript"],
      "optional_fields": ["video_url"]
    }
  },
  "message": "...candidate-facing prompt...",
  "next_submission": { "type": "video" },
  "complete": false,
  "final_evaluation": null
}
```

## Identity rules

- `profile_id` maps strictly to `screening.profiles.id`.
- Candidate name lookup is intentionally unsupported to avoid collisions.
- If both `profile_id` and `candidate_id` are provided, `profile_id` is used for screening DB hydration and `candidate_id` may be preserved as an external/display identity.
- If only `candidate_profile` / `candidate_context` is provided, the interview can still run, but it is not linked to `agent1.db` unless that object includes the screening profile id.

## Resume behavior

When a request includes `thread_id`, the interview agent first checks its in-memory store. If absent, it restores from `interview_snapshots` in `INTERVIEW_DB` as long as the stored `company_id` and `job_id` match the route.

This allows demo restarts without modifying `agent1.db`.
