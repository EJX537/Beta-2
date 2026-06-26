#!/bin/sh
# Container entrypoint for the combined image. Seeds demo roles into the resume
# agent's DB (idempotent) BEFORE the apps start serving, so a fresh GMI task
# never shows the empty "No open roles yet" state. Then hands off to supervisor.
set -e

if [ "${SEED_ON_START:-1}" = "1" ]; then
  echo "[entrypoint] seeding demo roles into ${AGENT_DB:-/data/agent1.db} ..."
  # Run as the non-root app user so the DB file is owned correctly.
  ( cd /app && su -s /bin/sh app -c "python seed_jobs.py" ) \
    || echo "[entrypoint] seed skipped/failed (non-fatal), continuing"
fi

exec supervisord -c /etc/supervisor/conf.d/agents.conf
