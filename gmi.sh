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

# Fetch the deployment record (contains current image_url + env array).
get_deployment() {
  _req "${API}/agents/deployments/${DEPLOYMENT}" "${AUTH[@]}"
}

# Point the deployment at a new image tag WITHOUT touching env.
# PATCH replaces the whole env array, so we read the live env from the current
# record and send it straight back, swapping only image_url. This preserves the
# locked GMI_MAAS_* vars and ANTHROPIC_API_KEY. Re-uses an immutable tag so GMI
# is forced to re-pull (a re-used tag may be cached and silently ignored).
#   ./gmi.sh deploy v3   ->  image docker.io/braahulm/beta-career:v3
set_image() {
  local tag="${1:?need image tag, e.g. v3}"
  local repo="${GMI_IMAGE_REPO:-docker.io/braahulm/beta-career}"
  local image="${repo}:${tag}"
  echo "reading current deployment env ..." >&2
  local cur env body
  cur="$(get_deployment)"
  env="$(echo "${cur}" | jq -c '.env // .spec.env // []')"
  if [ "${env}" = "[]" ]; then
    echo "WARNING: current env came back empty; PATCH would wipe env vars." >&2
    echo "Aborting. Inspect with: ./gmi.sh get" >&2
    return 1
  fi
  echo "patching image_url -> ${image} (preserving $(echo "${env}" | jq 'length') env vars)" >&2
  body="$(jq -cn --arg img "${image}" --argjson env "${env}" '{image_url:$img, env:$env}')"
  _req -X PATCH "${API}/agents/deployments/${DEPLOYMENT}" \
    "${AUTH[@]}" -H 'Content-Type: application/json' -d "${body}"
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
  get)       get_deployment | pp ;;
  deploy)    set_image "${1:-}" | pp ;;
  terminate) terminate "${1:-}" ;;
  *) echo "usage: $0 {provision|list|status <id>|wait <id>|up|get|deploy <tag>|terminate <id>}" >&2; exit 2 ;;
esac
