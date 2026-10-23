#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-10-ib-sm-failover: watch the master subnet manager once per second and time a takeover.
# Prints elapsed seconds, the port's state and SM LID (sysfs) and what sminfo answers. Stops when a
# master answers at a different SM LID than at the start (the takeover), or after --timeout seconds.
#
# Usage (as root, on the host whose port you want to watch; start it, then kill the master SM):
#   sudo ./watch-sm.sh [--role A|B] [--timeout 120]
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../hw-toolkit/lib.sh"
aina_load_env >/dev/null
need_root
ROLE=A TIMEOUT=120
while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) ROLE=${2:-}; shift 2 ;;
    --timeout) TIMEOUT=${2:-}; shift 2 ;;
    *) echo "usage: sudo $0 [--role A|B] [--timeout SECONDS]"; exit 2 ;;
  esac
done
DEV=$(rdma_of "$ROLE")
P=/sys/class/infiniband/$DEV/ports/$RDMA_PORT
[[ -r $P/sm_lid ]] || die "no RDMA device $DEV port $RDMA_PORT"
first=$(( $(cat "$P/sm_lid") ))
echo "watching $DEV port $RDMA_PORT: SM LID $first at start; kill the master SM now (Ctrl-C to stop)"
start=$(date +%s); lost=""
while :; do
  t=$(( $(date +%s) - start ))
  smlid=$(( $(cat "$P/sm_lid") ))
  s=$(sminfo -C "$DEV" -P "$RDMA_PORT" 2>&1 | tail -1)
  printf '%3d s  %-10s sm_lid %-3s %s\n' "$t" "$(cut -d' ' -f2 "$P/state")" "$smlid" "$s"
  [[ -z "$lost" && "$s" != *SMINFO_MASTER* ]] && lost=$t
  if [[ "$s" == *SMINFO_MASTER* && "$smlid" != "$first" ]]; then
    echo "takeover: a new master SM (LID $smlid) answered $(( t - ${lost:-0} )) s after the first failed sminfo (at ${lost:-?} s)"
    exit 0
  fi
  (( t >= TIMEOUT )) && { echo "no takeover within $TIMEOUT s"; exit 1; }
  sleep 1
done
