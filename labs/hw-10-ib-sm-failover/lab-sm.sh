#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# Start or stop a lab OpenSM on THIS host, bound to the lab's InfiniBand port. Used by hw-10 (two SMs
# with priorities), hw-11 (IPoIB broadcast MTU) and hw-12 (P_Key partitions).
#
# Usage (as root, on the host that should run the SM):
#   sudo ./lab-sm.sh start [--role A|B] [--priority N] [--fast] [--partitions FILE]
#   sudo ./lab-sm.sh stop                stops only an OpenSM this script started (pid file)
#        ./lab-sm.sh status
#
#   --role A|B        which profile device to bind to: A_RDMA_DEV (default) or B_RDMA_DEV
#   --priority N      SM priority 0-15 (opensm -p); default 0
#   --fast            poll the master SM every 1 s and declare it dead after 2 missed polls instead
#                     of OpenSM's defaults (10 s and 4 retries): written to a small config file (-F)
#   --partitions FILE partition configuration (opensm -P); default: none (OpenSM's built-in default
#                     partition 0x7fff with every port a full member)
#
# The OpenSM log goes to /var/log/opensm-aina.log. State (pid file, generated config) lives in
# /var/lib/aina/state/ib-lab-sm/.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../hw-toolkit/lib.sh"
aina_load_env >/dev/null
STATE=$(aina_state_dir ib-lab-sm)
LOG=/var/log/opensm-aina.log

usage() { sed -n '5,19p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

cmd=${1:-}; shift || true
ROLE=A PRIO=0 FAST=0 PART=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) ROLE=${2:-}; shift 2 ;;
    --priority) PRIO=${2:-}; shift 2 ;;
    --fast) FAST=1; shift ;;
    --partitions) PART=${2:-}; shift 2 ;;
    *) usage ;;
  esac
done
[[ "$ROLE" == A || "$ROLE" == B ]] || die "--role must be A or B"
[[ "$PRIO" =~ ^([0-9]|1[0-5])$ ]] || die "--priority must be 0-15"
DEV=$(rdma_of "$ROLE")
PORTDIR=/sys/class/infiniband/$DEV/ports/$RDMA_PORT

running_pid() {
  local pid
  pid=$(cat "$STATE/opensm.pid" 2>/dev/null) || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] && [[ "$(cat "/proc/$pid/comm" 2>/dev/null)" == opensm ]] && echo "$pid"
}

case "$cmd" in
  start)
    need_root
    command -v opensm >/dev/null 2>&1 || die "opensm is not installed (labs/hw-toolkit/setup-rdma-host.sh --opensm)"
    [[ "$(cat "$PORTDIR/link_layer" 2>/dev/null)" == InfiniBand ]] \
      || die "$DEV port $RDMA_PORT is not an InfiniBand port (link layer '$(cat "$PORTDIR/link_layer" 2>/dev/null)'): check the profile (*_RDMA_DEV)"
    if pgrep -x opensm >/dev/null 2>&1; then
      die "an OpenSM already runs on this host ($(pgrep -ax opensm | head -1)); stop it first (hw-09: sudo ./stop-sm.sh, this script: sudo ./lab-sm.sh stop)"
    fi
    if [[ -n "$PART" ]]; then
      [[ -r "$PART" ]] || die "partition file $PART not readable"
      PART=$(cd "$(dirname "$PART")" && pwd)/$(basename "$PART")
    fi
    # Port GUID = the low 64 bits of GID 0 (fe80:0000:0000:0000:<port GUID>).
    PGUID=0x$(sed 's/^fe80:0000:0000:0000://; s/://g' "$PORTDIR/gids/0")
    [[ "$PGUID" =~ ^0x[0-9a-f]{16}$ ]] || die "could not read the port GUID of $DEV port $RDMA_PORT"
    mkdir -p "$STATE"
    args=(-B -g "$PGUID" -p "$PRIO" -f "$LOG" -J "$STATE/opensm.pid")
    if [[ $FAST -eq 1 ]]; then
      printf 'sminfo_polling_timeout 1000\npolling_retry_number 2\n' >"$STATE/opensm-fast.conf"
      args+=(-F "$STATE/opensm-fast.conf")
    fi
    [[ -n "$PART" ]] && args+=(-P "$PART")
    echo "+ opensm ${args[*]}"
    opensm "${args[@]}" >/dev/null 2>&1 || die "opensm failed to start; run it in the foreground without -B to see why"
    for _ in $(seq 1 15); do
      sleep 1
      if s=$(sminfo -C "$DEV" -P "$RDMA_PORT" 2>/dev/null); then
        echo "$s"
        echo "OpenSM started on $DEV port $RDMA_PORT (priority $PRIO$([[ $FAST -eq 1 ]] && echo ', fast failover polling')$([[ -n "$PART" ]] && echo ", partitions $PART")). Log: $LOG"
        exit 0
      fi
    done
    echo "OpenSM started (pid $(running_pid || echo '?')) but sminfo does not answer yet; check $LOG"
    ;;
  stop)
    need_root
    if pid=$(running_pid); then
      echo "+ kill $pid    # the OpenSM started by lab-sm.sh"
      kill "$pid"
      for _ in $(seq 1 10); do [[ -d /proc/$pid ]] || break; sleep 1; done
    else
      echo "No OpenSM started by lab-sm.sh is running; nothing to do."
    fi
    rm -f "$STATE/opensm.pid" "$STATE/opensm-fast.conf"
    ;;
  status)
    if pid=$(running_pid); then echo "lab OpenSM running: $(tr '\0' ' ' <"/proc/$pid/cmdline")"
    else echo "no lab OpenSM running on this host"; fi
    others=$(pgrep -ax opensm | grep -v "^${pid:-x} " || true)
    [[ -n "$others" ]] && echo "other OpenSM processes: $others"
    exit 0
    ;;
  *) usage ;;
esac
