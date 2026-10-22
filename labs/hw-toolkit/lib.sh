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

AINA_TOOLKIT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
AINA_FAILS=0
AINA_WARNS=0

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; AINA_FAILS=$((AINA_FAILS + 1)); }
warn() { echo "WARN: $*"; AINA_WARNS=$((AINA_WARNS + 1)); }
skip() { echo "SKIP: $*"; }
info() { echo "INFO: $*"; }
die() { echo "FAIL: $*"; exit 1; }

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

need_root() { [[ $EUID -eq 0 ]] || die "run as root: sudo $0 $*"; }

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
  local r rc=0
  for r in "$@"; do
    [[ "$r" == "A" ]] && continue
    if on_host "$r" true 2>/dev/null; then
      pass "SSH to host $r ($(host_of "$r")) works without a password"
    else
      fail "cannot SSH to host $r ($(_ssh_target "$r")) non-interactively (set up keys: ssh-copy-id $(_ssh_target "$r"))"
      rc=1
    fi
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

aina_finish() {
  echo
  if [[ $AINA_FAILS -eq 0 ]]; then
    if [[ $AINA_WARNS -gt 0 ]]; then echo "All checks passed ($AINA_WARNS warning(s))."; else echo "All checks passed."; fi
    exit 0
  fi
  echo "$AINA_FAILS check(s) failed."
  exit 1
}
