#!/usr/bin/env bash
set -euo pipefail

mkdir -p /home/agent/agents /run/parly/agents
chmod 0700 /run/parly

trap 'exit 0' TERM INT

# On GKE the pod is one agent (its keys in the env): it reads its own mail in a loop, a child of PID 1. Its files
# are a tarball in its own folder of the homes bucket (only its identity can reach it): restored now, then saved
# every few minutes while something changes and once more when the pod is told to stop, so a turn that gets cut
# off keeps its work. Chromium's profile stays out (it's large and rebuilt on the next start).
if [ -n "${PARLY_AGENT_ID:-}" ]; then
  home="/home/agent/agents/$PARLY_AGENT_ID"
  run_dir="/run/parly/agents/$PARLY_AGENT_ID"
  mkdir -p "$home" "$run_dir"
  chmod 0700 "$run_dir"
  if [ -n "${PARLY_AGENT_TOKEN:-}" ]; then
    rm -f "$run_dir/agent-token"
    (umask 0377 && printf '%s' "$PARLY_AGENT_TOKEN" >"$run_dir/agent-token")
    unset PARLY_AGENT_TOKEN
  fi
  if [ -n "${PARLY_LLM_KEY:-}" ]; then
    rm -f "$run_dir/llm-key"
    (umask 0377 && printf '%s' "$PARLY_LLM_KEY" >"$run_dir/llm-key")
    unset PARLY_LLM_KEY
  fi
  exec >>"$run_dir/runner.log" 2>&1
  gcs="https://storage.googleapis.com"
  token() { curl -sf -H Metadata-Flavor:Google http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token | jq -er '.access_token | select(type == "string" and length > 0)'; }
  # Only a 404 means there's nothing to restore: anything else mustn't look like an empty home that then gets saved.
  restore() {
    for _ in 1 2 3 4 5 6; do
      code=$(curl -s -o /run/parly/home.tgz -w '%{http_code}' -H "Authorization: Bearer $(token)" "$gcs/storage/v1/b/$PARLY_HOMES_BUCKET/o/agents%2F$PARLY_AGENT_ID%2Fhome.tgz?alt=media") || code=000
      case "$code" in
        200) tar xzf /run/parly/home.tgz -C "$home" && return 0 ;;
        404) echo "no saved files restored (a new agent has none)"; return 0 ;;
      esac
      sleep 5
    done
    return 1
  }
  # tar exits 1 when a file changed while it read it, which a save during a turn will often see.
  save() {
    [ -e /run/parly/nosave ] && return 0
    if [ "${1:-}" = "force" ]; then
      [ -n "$(find "$home" -mindepth 1 -path "$home/browser-profile" -prune -o -print -quit)" ] || return 0
    else
      [ -n "$(find "$home" -path "$home/browser-profile" -prune -o -newer /run/parly/saved -print -quit)" ] || return 0
    fi
    touch /run/parly/saving
    { tar czf /run/parly/home.tgz -C "$home" --exclude=./browser-profile . || [ $? -eq 1 ]; } \
      && curl -sf -o /dev/null -X POST -H "Authorization: Bearer $(token)" --data-binary @/run/parly/home.tgz \
        "$gcs/upload/storage/v1/b/$PARLY_HOMES_BUCKET/o?uploadType=media&name=agents/$PARLY_AGENT_ID/home.tgz" \
      && mv /run/parly/saving /run/parly/saved
  }
  restore || { echo "couldn't restore saved files: not saving over them"; touch /run/parly/nosave; }
  touch /run/parly/saved
  # ponytail: one writer on a timer, so a save can't overlap another; up to PARLY_SAVE_SECONDS of work is lost if a pod dies without a TERM.
  (
    trap 'exit 0' TERM INT
    while [ ! -e /run/parly/stopping ]; do
      for _ in $(seq "$((${PARLY_SAVE_SECONDS:-300} / 5))"); do
        [ -e /run/parly/stopping ] && exit 0
        sleep 5 &
        wait $! || true
      done
      [ -e /run/parly/stopping ] && exit 0
      trap '' TERM INT
      save || echo "saving files failed; retrying"
      trap 'exit 0' TERM INT
    done
  ) &
  saver=$!
  tree_pids() {
    local p
    for p in $(pgrep -P "$1" 2>/dev/null || true); do
      tree_pids "$p"
    done
    echo "$1"
  }
  alive() {
    kill -0 "$1" 2>/dev/null && ! ps -o stat= -p "$1" 2>/dev/null | grep -q '^Z'
  }
  stop_tree() {
    local pids p c live _
    pids=$(tree_pids "$1")
    [ -n "$pids" ] || return 0
    kill -TERM $pids 2>/dev/null || true
    for _ in $(seq "$((${PARLY_STOP_SECONDS:-30} * 20))"); do
      live=""
      for p in $pids; do
        for c in $(pgrep -P "$p" 2>/dev/null || true); do
          case " $pids $live " in *" $c "*) ;; *) live="$live $c" ;; esac
        done
        alive "$p" && live="$live $p" || true
      done
      pids=${live# }
      [ -z "$pids" ] && return 0
      sleep 0.05
    done
    kill -KILL $pids 2>/dev/null || true
  }
  (
    runner_pid=""
    on_runner_stop() {
      if [ -n "$runner_pid" ]; then
        stop_tree "$runner_pid"
        wait "$runner_pid" 2>/dev/null || true
      fi
      exit 0
    }
    trap on_runner_stop TERM INT
    while [ ! -e /run/parly/stopping ]; do
      PARLY_WAIT=1 /usr/local/bin/parly-agent-runner </dev/null &
      runner_pid=$!
      wait "$runner_pid" || { [ -e /run/parly/stopping ] || sleep 5; }
      runner_pid=""
    done
  ) &
  runner=$!
  on_term() {
    touch /run/parly/stopping
    kill -TERM "$runner" "$saver" 2>/dev/null || true
    wait "$runner" 2>/dev/null || true
    wait "$saver" 2>/dev/null || true
    save force || echo "saving files failed"
    exit 0
  }
  trap on_term TERM INT
fi
# PID 1 stays up while the loop runs, and exits cleanly when the pod is deleted.
sleep infinity &
wait
