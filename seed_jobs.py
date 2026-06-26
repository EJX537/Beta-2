"""Seed sample job postings for the UI demo.

Local DB (writes agent1.db directly):
    .venv/bin/python seed_jobs.py

Remote over HTTP (POST /jobs to a running deployment, e.g. on GMI):
    .venv/bin/python seed_jobs.py https://<host>
    # or: SEED_URL=https://<host> .venv/bin/python seed_jobs.py
"""

import json
import os
import sys
import urllib.request
import uuid

SAMPLE_JOBS = [
    {
        "title": "Senior Backend Engineer (Python)",
        "description": "Build and own scalable async APIs serving millions of users. "
        "Mentor engineers and drive technical decisions.",
        "ranking_config": {
            "skills": [
                {"name": "Python & async backends", "weight": 4, "must_have": True},
                {"name": "Distributed systems / scaling", "weight": 3},
                {"name": "Leadership / mentoring", "weight": 2},
                {"name": "Cloud (AWS/GCP)", "weight": 1},
            ],
            "instructions": "Value measurable impact over keywords.",
            "scale": 100,
        },
    },
    {
        "title": "Machine Learning Engineer",
        "description": "Train, ship, and monitor ML models in production.",
        "ranking_config": {
            "skills": [
                {"name": "Python & ML frameworks", "weight": 4, "must_have": True},
                {"name": "Production deployment / MLOps", "weight": 3},
                {"name": "Data wrangling / SQL", "weight": 2},
            ],
            "instructions": "Strongly prefer candidates who shipped models to real users.",
            "scale": 100,
        },
    },
    {
        "title": "Frontend Engineer (React)",
        "description": "Build delightful, accessible UIs in React and TypeScript.",
        "ranking_config": {
            "skills": [
                {"name": "React & TypeScript", "weight": 4, "must_have": True},
                {"name": "UI/UX & accessibility", "weight": 3},
                {"name": "Testing & performance", "weight": 2},
            ],
            "instructions": "Reward polished, shipped products.",
            "scale": 100,
        },
    },
    {
        "title": "Data Engineer",
        "description": "Design and run reliable batch and streaming data pipelines.",
        "ranking_config": {
            "skills": [
                {"name": "SQL & data modeling", "weight": 4, "must_have": True},
                {"name": "Python / pipeline tooling (Airflow, Spark)", "weight": 3},
                {"name": "Cloud data warehouses", "weight": 2},
            ],
            "scale": 100,
        },
    },
]


def seed_http(base_url: str) -> None:
    """Seed by POSTing /jobs to a running deployment (works against GMI)."""
    base = base_url.rstrip("/")
    for job in SAMPLE_JOBS:
        body = json.dumps(
            {
                "title": job["title"],
                "description": job["description"],
                "ranking_config": job["ranking_config"],
            }
        ).encode()
        req = urllib.request.Request(
            f"{base}/jobs",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                created = json.load(resp)
            print(f"  + {created['title']}  ({created['id']})")
        except Exception as exc:  # keep going so one failure doesn't stop the rest
            print(f"  ! {job['title']} -> {exc}")
    print(f"Seeded {len(SAMPLE_JOBS)} jobs into {base}")


def seed_local() -> None:
    """Seed by writing the local SQLite store directly."""
    import agent1

    agent1.init_db()
    with agent1.db() as conn:
        for job in SAMPLE_JOBS:
            config = agent1.validate_ranking_config(job["ranking_config"])
            job_id = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO jobs (id, title, description, ranking_config, created_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (
                    job_id,
                    job["title"],
                    job["description"],
                    json.dumps(config),
                    agent1.now_iso(),
                ),
            )
            print(f"  + {job['title']}  ({job_id})")
    print(f"Seeded {len(SAMPLE_JOBS)} jobs into {agent1.DB_PATH.resolve()}")


def main() -> None:
    target = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("SEED_URL")
    if target:
        seed_http(target)
    else:
        seed_local()


if __name__ == "__main__":
    main()
