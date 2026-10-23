#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-09-infiniband-bringup: start OpenSM on this host and remember what was done, so stop-sm.sh only
# undoes this lab's change.
# Usage: sudo ./start-sm.sh [--force]    (--force: start even if a master SM already answers sminfo)
set -uo pipefail
. "$(dirname "$0")/../hw-toolkit/lib.sh"
need_root
aina_load_env >/dev/null
FORCE=0; [[ "${1:-}" == "--force" ]] && FORCE=1
# Name the InfiniBand device and port explicitly: without -C/-P the umad tools open the first RDMA
# device, which on a host with a RoCE port next to the IB port fails ("Failed to open '(null)' port '0'").
DEV=${AINA_SM_DEV:-$A_RDMA_DEV}
SM=(sminfo -C "$DEV" -P "$RDMA_PORT")
# Port GUID = the low 64 bits of GID 0 (fe80:0000:0000:0000:<port GUID>).
PGUID=0x$(sed 's/^fe80:0000:0000:0000://; s/://g' "/sys/class/infiniband/$DEV/ports/$RDMA_PORT/gids/0" 2>/dev/null)
STATE=$(aina_state_dir hw-09-infiniband-bringup)
mkdir -p "$STATE"

command -v opensm >/dev/null 2>&1 || die "opensm is not installed (labs/hw-toolkit/setup-rdma-host.sh --opensm)"

if pgrep -x opensm >/dev/null 2>&1; then
  echo "OpenSM is already running on this host; leaving it alone."
  [[ -f "$STATE/method" ]] || echo "preexisting" >"$STATE/method"
  exit 0
fi
if [[ $FORCE -eq 0 ]] && command -v sminfo >/dev/null 2>&1 && "${SM[@]}" >/dev/null 2>&1; then
  echo "A subnet manager already answers on this fabric:"
  "${SM[@]}"
  echo "Not starting a second one (switch-embedded SM or UFM?). Use --force to experiment with priorities."
  echo "preexisting" >"$STATE/method"
  exit 0
fi

rm -f "$STATE/method"   # a stale record from an earlier run must not mask a failed start below
if systemctl cat opensm.service >/dev/null 2>&1; then
  echo "+ systemctl start opensm"
  systemctl start opensm && echo "systemd" >"$STATE/method"
fi
if [[ "$(cat "$STATE/method" 2>/dev/null)" != systemd ]]; then
  if [[ "$PGUID" =~ ^0x[0-9a-f]{16}$ ]]; then
    echo "+ opensm -B -g $PGUID      # bound to $DEV port $RDMA_PORT"
    opensm -B -g "$PGUID" >/dev/null 2>&1 && echo "daemon" >"$STATE/method"
  else
    echo "+ opensm -B"
    opensm -B >/dev/null 2>&1 && echo "daemon" >"$STATE/method"
  fi
fi
[[ -f "$STATE/method" ]] || die "could not start OpenSM; run 'opensm' in the foreground to see why"

for _ in $(seq 1 15); do
  sleep 1
  if command -v sminfo >/dev/null 2>&1 && "${SM[@]}" >/dev/null 2>&1; then
    "${SM[@]}"
    echo "OpenSM started ($(cat "$STATE/method")). Check ports with: ibstat $DEV $RDMA_PORT"
    exit 0
  fi
done
echo "OpenSM was started ($(cat "$STATE/method")) but sminfo does not answer yet."
echo "If ports stay in INIT: sudo ./stop-sm.sh, then run 'sudo opensm -B' (or bind a port with -g <port GUID>)."
