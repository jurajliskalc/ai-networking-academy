# shellcheck shell=bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# AI Networking Academy: shared helpers for real-hardware lab scripts.
#
# Source from a lab script:   . "$(dirname "$0")/../hw-toolkit/lib.sh"
#
# Conventions
#   - Check scripts run on host A. They reach hosts B and C with key-based SSH (SSH_USER@HOST_B ...).
#   - Every value comes from lab.env (generated on the academy's Connect page). AINA_ENV overrides
#     its location; the default is labs/hw-toolkit/lab.env.
#   - Output lines start with PASS:, FAIL:, WARN:, SKIP: or INFO:. "aina-hw check" turns them into a
#     result file the academy can import. `aina_finish` exits non-zero if anything failed.
#   - `task N "title"` starts the checks for the lab's Task N (prints "TASK: N title"); results after it
#     count for that task, results before the first one are the "Before you start" prerequisites.
#     Guard each task block with `if task N "title"; then ... fi`: with AINA_TASK=N in the environment
#     (`aina-hw check LAB --task N`) only that task's block runs, so a learner can resume a lab.
#   - `require TASK KEY "what"` declares a measurement the lab is not complete without (prints
#     "REQUIRE: TASK KEY what"); declare them all at the top, before any check can stop the script.
#     `met KEY` (or `pass_met KEY "..."`) records that it was made. `perf_ok KEY "..."` /
#     `perf_low KEY "..."` record a measurement and whether it reached the lab's performance target
#     ("PERF: KEY ok|low"). A run is PASSED only with no failure, every requirement met, no declared
#     task left unrun and no measurement below target; otherwise FAILED, INCONCLUSIVE or BELOW_TARGET.

AINA_TOOLKIT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
AINA_FAILS=0
AINA_WARNS=0
AINA_PERF_LOW=0
declare -A AINA_REQ_TASK=() AINA_MET=()

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; AINA_FAILS=$((AINA_FAILS + 1)); }
warn() { echo "WARN: $*"; AINA_WARNS=$((AINA_WARNS + 1)); }
skip() { echo "SKIP: $*"; }
info() { echo "INFO: $*"; }
die() { echo "FAIL: $*"; exit 1; }

# require TASK KEY WHAT : the lab is not complete until `met KEY` (task 0 = the prerequisites).
require() { AINA_REQ_TASK[$2]=$1; echo "REQUIRE: $1 $2 ${*:3}"; }
met() { AINA_MET[$1]=1; echo "MET: $1"; }
pass_met() { local k=$1; shift; pass "$@"; met "$k"; }
# A measurement with a performance target: made (met) either way; below target is a warning, not a pass.
perf_ok() { local k=$1; shift; pass "$@"; met "$k"; echo "PERF: $k ok"; }
perf_low() { local k=$1; shift; warn "$@"; met "$k"; echo "PERF: $k low"; AINA_PERF_LOW=$((AINA_PERF_LOW + 1)); }

# aina_tasks N... : declare which of the lab's tasks this check covers (prints "TASKS: N ..."), so a run that
# stops early (failed prerequisites) reports the others as not run rather than not covered.
aina_tasks() { echo "TASKS: $*"; }

# task N TITLE : start the checks of the lab's Task N. Returns 1 (prints nothing) when AINA_TASK picks
# another task, so `if task N "..."; then ... fi` skips the block.
task() {
  if [[ -n "${AINA_TASK:-}" && "$AINA_TASK" != "$1" ]]; then return 1; fi
  echo "TASK: $1 $2"
}

# task_selected N... : true when no AINA_TASK filter is set or it names one of these tasks. For work that
# several tasks share (one perftest run measured by two tasks), run it if any of them is selected.
task_selected() {
  local n
  [[ -z "${AINA_TASK:-}" ]] && return 0
  for n in "$@"; do [[ "$AINA_TASK" == "$n" ]] && return 0; done
  return 1
}

# Load lab.env and fill defaults for anything it does not set. Defaults match content/hardware/hardware.yaml.
aina_load_env() {
  local env_file=${AINA_ENV:-$AINA_TOOLKIT/lab.env}
  if [[ -r "$env_file" ]]; then
    # shellcheck disable=SC1090
    . "$env_file"
  else
    echo "INFO: no lab.env at $env_file; using defaults (generate yours on the academy's Connect page)"
  fi
  : "${LAB_NAME:=my-lab}" "${FABRIC:=roce}" "${SSH_USER:=}" "${HOST_COUNT:=2}"
  : "${HOST_A:=node-a}" "${HOST_B:=node-b}" "${HOST_C:=node-c}"
  : "${A_IP:=192.168.50.11}" "${B_IP:=192.168.50.12}" "${C_IP:=192.168.50.13}" "${PREFIX_LEN:=24}"
  : "${A_NETDEV:=ens1f0np0}" "${B_NETDEV:=ens1f0np0}" "${C_NETDEV:=ens1f0np0}"
  : "${A_RDMA_DEV:=mlx5_0}" "${B_RDMA_DEV:=mlx5_0}" "${C_RDMA_DEV:=mlx5_0}" "${RDMA_PORT:=1}"
  : "${MTU:=9000}" "${GID_INDEX:=3}" "${ROCE_PRIO:=3}" "${ROCE_DSCP:=26}" "${CNP_DSCP:=48}"
  : "${SWITCH:=leaf1}" "${SWITCH_OS:=none}" "${GPUS_PER_NODE:=1}" "${GPU_INDEX:=0}" "${NCCL_TESTS_DIR:=$HOME/nccl-tests/build}"
  TCLASS=$((ROCE_DSCP * 4 + 2))
  export LAB_NAME FABRIC SSH_USER HOST_COUNT HOST_A HOST_B HOST_C A_IP B_IP C_IP PREFIX_LEN \
    A_NETDEV B_NETDEV C_NETDEV A_RDMA_DEV B_RDMA_DEV C_RDMA_DEV RDMA_PORT MTU GID_INDEX \
    ROCE_PRIO ROCE_DSCP CNP_DSCP TCLASS SWITCH SWITCH_OS GPUS_PER_NODE GPU_INDEX NCCL_TESTS_DIR
}

# Role lookups: host_of B -> node-b, ip_of B -> 192.168.50.12, ...
host_of() { local v="HOST_$1"; echo "${!v}"; }
ip_of() { local v="$1_IP"; echo "${!v}"; }
netdev_of() { local v="$1_NETDEV"; echo "${!v}"; }
rdma_of() { local v="$1_RDMA_DEV"; echo "${!v}"; }

# excerpt FILE [N] : one-line excerpt of a tool log for a FAIL message, without libibverbs provider warnings
# (DOCA's rdma-core prints "libibverbs: Warning: couldn't load driver ..." for absent providers).
excerpt() { grep -v '^libibverbs: Warning' "$1" 2>/dev/null | tr '\n' ' ' | cut -c1-"${2:-160}"; }

need_root() { [[ $EUID -eq 0 ]] || die "run as root: sudo $0"; }

# need_cmd tool... : PASS/FAIL per tool; returns non-zero if any is missing.
need_cmd() {
  local t rc=0
  for t in "$@"; do
    if command -v "$t" >/dev/null 2>&1; then pass "$t is installed"; else fail "$t is missing (labs/hw-toolkit/setup-rdma-host.sh installs it)"; rc=1; fi
  done
  return $rc
}

_ssh_target() { local h; h=$(host_of "$1"); if [[ -n "$SSH_USER" ]]; then echo "$SSH_USER@$h"; else echo "$h"; fi; }

# on_host ROLE CMD [ARGS...] : run on host A locally, on B/C over SSH. Arguments are quoted safely.
on_host() {
  local role=$1; shift
  if [[ "$role" == "A" ]]; then
    "$@"
  else
    # shellcheck disable=SC2029
    ssh -n -o BatchMode=yes -o ConnectTimeout=8 "$(_ssh_target "$role")" -- "$(printf '%q ' "$@")"
  fi
}

# on_host_sh ROLE 'shell snippet' : like on_host but runs a shell snippet (pipes, redirections).
on_host_sh() {
  local role=$1 snippet=$2
  if [[ "$role" == "A" ]]; then
    bash -c "$snippet"
  else
    # The snippet travels on stdin, so it works whatever the remote login shell is.
    ssh -o BatchMode=yes -o ConnectTimeout=8 "$(_ssh_target "$role")" -- bash -s <<<"$snippet"
  fi
}

# check_ssh ROLE... : PASS/FAIL whether each role is reachable non-interactively.
check_ssh() {
  local r rc=0 err
  for r in "$@"; do
    [[ "$r" == "A" ]] && continue
    if err=$(on_host "$r" true 2>&1); then
      pass "SSH to host $r ($(host_of "$r")) works without a password"
    else
      err=$(tr '\n' ' ' <<<"$err" | cut -c1-160)
      case "$err" in
        *"Permission denied"*|*"Host key verification failed"*)
          fail "cannot SSH to host $r ($(_ssh_target "$r")) non-interactively: ${err% } (set up keys: ssh-copy-id $(_ssh_target "$r"))" ;;
        *)
          # Unreachable rather than refused: if HOST_$r is a data-network address, a fault on the data
          # interface also cuts the checks off. HOST_* should be management addresses.
          fail "cannot reach host $r ($(_ssh_target "$r")) over SSH: ${err% } (is HOST_$r on the management network and the host up?)" ;;
      esac
      rc=1
    fi
  done
  return $rc
}

# need_cmd_on ROLE tool... : like need_cmd, but on host ROLE (over SSH for B/C). Checks that start a server
# on another host call it so a missing tool there is a clear FAIL instead of a failed test later.
need_cmd_on() {
  local role=$1 t rc=0; shift
  [[ "$role" == "A" ]] && { need_cmd "$@"; return; }
  for t in "$@"; do
    if on_host "$role" command -v "$t" >/dev/null 2>&1; then pass "$t is installed on host $role"
    else fail "$t is missing on host $role (run labs/hw-toolkit/setup-rdma-host.sh there)"; rc=1; fi
  done
  return $rc
}

# port_attr ROLE ATTR : read /sys/class/infiniband/<dev>/ports/<port>/<ATTR> on that host.
port_attr() {
  on_host_sh "$1" "cat /sys/class/infiniband/$(rdma_of "$1")/ports/$RDMA_PORT/$2 2>/dev/null"
}

# roce_gid ROLE : index of the RoCE v2 GID that carries the host's IPv4 data address; falls back to GID_INDEX.
roce_gid() {
  local role=$1 dev ip hex idx
  dev=$(rdma_of "$role"); ip=$(ip_of "$role")
  # shellcheck disable=SC2086  # split the dotted quad into four printf arguments
  hex=$(printf '%02x%02x:%02x%02x' ${ip//./ })
  idx=$(on_host_sh "$role" "d=/sys/class/infiniband/$dev/ports/$RDMA_PORT
    for g in \$(ls \$d/gids 2>/dev/null | sort -n); do
      t=\$(cat \$d/gid_attrs/types/\$g 2>/dev/null) || continue
      v=\$(cat \$d/gids/\$g 2>/dev/null)
      case \"\$t\" in *v2*|*V2*) [ \"\${v#0000:0000:0000:0000:0000:ffff:}\" = \"$hex\" ] && { echo \$g; exit 0; } ;; esac
    done")
  echo "${idx:-$GID_INDEX}"
}

# counter ROLE NETDEV NAME : one ethtool -S counter (empty if absent).
counter() {
  on_host_sh "$1" "ethtool -S $2 2>/dev/null | awk -F': *' '\$1 ~ /^ *$3\$/ {print \$2; exit}'"
}

# hw_counter ROLE NAME : one RDMA hw_counters value (empty if absent).
hw_counter() {
  port_attr "$1" "hw_counters/$2"
}

# Background server for client/server tools (perftest, ibv_*_pingpong) on a remote host.
# start_server ROLE LOGFILE CMD... ; then run the client locally; then stop_server.
# Wrap the server command in `timeout N` so it never outlives the check if the client fails.
AINA_SERVER_PID=""
start_server() {
  local role=$1 log=$2; shift 2
  if [[ "$role" == "A" ]]; then
    "$@" >"$log" 2>&1 &
  else
    # shellcheck disable=SC2029
    ssh -n -o BatchMode=yes -o ConnectTimeout=8 "$(_ssh_target "$role")" -- "$(printf '%q ' "$@")" >"$log" 2>&1 &
  fi
  AINA_SERVER_PID=$!
  sleep 2
}
stop_server() {
  [[ -n "$AINA_SERVER_PID" ]] || return 0
  wait "$AINA_SERVER_PID" 2>/dev/null || true
  AINA_SERVER_PID=""
}
kill_server() {
  [[ -n "$AINA_SERVER_PID" ]] || return 0
  kill "$AINA_SERVER_PID" 2>/dev/null || true
  wait "$AINA_SERVER_PID" 2>/dev/null || true
  AINA_SERVER_PID=""
}

# bw_average FILE : the "BW average" column of the last perftest result row (Gb/s with --report_gbits).
bw_average() {
  awk '/^ *[0-9]+ +[0-9]+ +[0-9.]+ +[0-9.]+/ {v=$4} END {if (v != "") print v}' "$1"
}

# Saved state for labs that change settings: /var/lib/aina/state/<lab>/ (root-owned, so it is the same
# path whether a script runs under sudo or not; override with AINA_STATE).
aina_state_dir() { echo "${AINA_STATE:-/var/lib/aina/state}/$1"; }

# Prints the verdict. Exit status: 1 if a check failed, else 0 (aina-hw check grades the run from the
# output: an exit status of 0 alone does not mean the lab is verified).
aina_finish() {
  local k missing=()
  echo
  if [[ $AINA_FAILS -gt 0 ]]; then echo "$AINA_FAILS check(s) failed."; exit 1; fi
  for k in "${!AINA_REQ_TASK[@]}"; do
    # A single-task run (AINA_TASK) only owes that task's requirements and the prerequisites'.
    if [[ -n "${AINA_TASK:-}" && "${AINA_REQ_TASK[$k]}" != "$AINA_TASK" && "${AINA_REQ_TASK[$k]}" != 0 ]]; then continue; fi
    [[ -n "${AINA_MET[$k]:-}" ]] || missing+=("$k")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "Inconclusive: nothing failed, but required measurement(s) were not made: $(printf '%s\n' "${missing[@]}" | sort | tr '\n' ' ')"
  elif [[ $AINA_PERF_LOW -gt 0 ]]; then
    echo "Functional checks passed, but $AINA_PERF_LOW measurement(s) are below the performance target."
  elif [[ $AINA_WARNS -gt 0 ]]; then echo "All checks passed ($AINA_WARNS warning(s))."
  else echo "All checks passed."
  fi
  exit 0
}
