#!/usr/bin/env bash
# GMI Cloud agent deployment lifecycle for the resume agent.
#
# Auth: export your token first so it never lands in shell history / source:
#   export GMI_API_TOKEN=...        # required
#
# Optional overrides (defaults match the resume-agent deployment):
#   GMI_DEPLOYMENT   (default: beta-career)
#   GMI_IDC          (default: us-central-iowa1)
#   GMI_INSTANCE     (default: gmi.container.intel.x4660.large)
#   GMI_TEMPLATE_ID  (default: 827601fd-e3dc-4b60-98ba-d4cb14e81abf)
#
# Usage:
#   ./gmi.sh provision           # start a container; prints the new TASK_ID
#   ./gmi.sh list                # list tasks under the deployment
#   ./gmi.sh status <TASK_ID>    # one-shot status
#   ./gmi.sh up                  # provision + poll until running + print endpoint
#   ./gmi.sh wait <TASK_ID>      # poll an existing task until running
#   ./gmi.sh terminate <TASK_ID> # delete a task (call when the session ends)
set -euo pipefail

API="https://api.gmi-serving.com/v1"
DEPLOYMENT="${GMI_DEPLOYMENT:-beta-career}"
IDC="${GMI_IDC:-us-central-iowa1}"
INSTANCE="${GMI_INSTANCE:-gmi.container.intel.x4660.large}"
TEMPLATE_ID="${GMI_TEMPLATE_ID:-827601fd-e3dc-4b60-98ba-d4cb14e81abf}"

: "${GMI_API_TOKEN:?Set GMI_API_TOKEN first:  export GMI_API_TOKEN=...}"
AUTH=(-H "Authorization: Bearer ${GMI_API_TOKEN}")

# Run a request; always print the response body (so 4xx/5xx explanations show),
# print "HTTP <code>" to stderr, and return non-zero on >=400.
_req() {
  local out code
  out="$(curl -sS -w $'\n%{http_code}' "$@")"
  code="${out##*$'\n'}"; out="${out%$'\n'*}"
  printf '%s' "${out}"
  echo "HTTP ${code}" >&2
  [ "${code}" -lt 400 ]
}

provision() {
  _req -X POST "${API}/agents/deployments/${DEPLOYMENT}/tasks" \
    "${AUTH[@]}" -H 'Content-Type: application/json' \
    -d "{\"idc_name\":\"${IDC}\",\"instance_type\":\"${INSTANCE}\",\"template_id\":\"${TEMPLATE_ID}\"}"
}

list() {
  _req "${API}/agents/deployments/${DEPLOYMENT}/tasks" "${AUTH[@]}"
}

status() {
  _req "${API}/agents/tasks/${1:?need TASK_ID}" "${AUTH[@]}"
}

terminate() {
  _req -X DELETE "${API}/agents/tasks/${1:?need TASK_ID}" "${AUTH[@]}"
  echo "terminated ${1}"
}

# Poll a task until task_status=running & health=healthy, then print the full
# record (GMI uses .task_status / .health, NOT .status).
wait_running() {
  local id="${1:?need TASK_ID}" tries=0 st he
  echo "polling task ${id} ..." >&2
  while :; do
    local body; body="$(status "${id}")"
    st="$(echo "${body}" | jq -r '.task_status // "unknown"')"
    he="$(echo "${body}" | jq -r '.health // "unknown"')"
    echo "  [$((tries))] task_status=${st} health=${he}" >&2
    case "${st}" in
      running|RUNNING) [ "${he}" = "healthy" ] && { echo "${body}" | jq .; return 0; } ;;
      failed|FAILED|error|ERROR) echo "${body}" | jq .; echo "task failed" >&2; return 1 ;;
    esac
    tries=$((tries+1)); [ "${tries}" -gt 60 ] && { echo "timed out" >&2; return 1; }
    sleep 5
  done
}

up() {
  local resp id
  resp="$(provision)"
  id="$(echo "${resp}" | jq -r '.id // .task_id // .data.id')"
  [ -z "${id}" ] || [ "${id}" = "null" ] && { echo "no task id in response:" >&2; echo "${resp}" | jq .; return 1; }
  echo "provisioned task: ${id}" >&2
  wait_running "${id}"
}

# Pretty-print JSON, falling back to raw text (e.g. plain-text 4xx bodies).
pp() { local b; b="$(cat)"; echo "${b}" | jq . 2>/dev/null || echo "${b}"; }

cmd="${1:-}"; shift || true
case "${cmd}" in
  provision) provision | pp ;;
  list)      list | pp ;;
  status)    status "${1:-}" | pp ;;
  wait)      wait_running "${1:-}" ;;
  up)        up ;;
  terminate) terminate "${1:-}" ;;
  *) echo "usage: $0 {provision|list|status <id>|wait <id>|up|terminate <id>}" >&2; exit 2 ;;
esac
