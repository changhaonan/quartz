#!/usr/bin/env bash
# Helper library — source me, don't execute.

# Print the PID listening on the given TCP port (first match), or empty.
listener_pid_on_port() {
  local port="$1"
  [[ -z "$port" ]] && return 1
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1
}
