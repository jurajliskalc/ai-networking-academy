#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-09-infiniband-bringup: start OpenSM on this host and remember what was done, so stop-sm.sh only
# undoes this lab's change.
# Usage: sudo ./start-sm.sh [--force]    (--force: start even if a master SM already answers sminfo)
set -uo pipefail
. "$(dirname "$0")/../hw-toolkit/lib.sh"
need_root
FORCE=0; [[ "${1:-}" == "--force" ]] && FORCE=1
STATE=$(aina_state_dir hw-09-infiniband-bringup)
mkdir -p "$STATE"

command -v opensm >/dev/null 2>&1 || die "opensm is not installed (labs/hw-toolkit/setup-rdma-host.sh --opensm)"

if pgrep -x opensm >/dev/null 2>&1; then
  echo "OpenSM is already running on this host; leaving it alone."
  [[ -f "$STATE/method" ]] || echo "preexisting" >"$STATE/method"
  exit 0
fi
if [[ $FORCE -eq 0 ]] && command -v sminfo >/dev/null 2>&1 && sminfo >/dev/null 2>&1; then
  echo "A subnet manager already answers on this fabric:"
  sminfo
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
  echo "+ opensm -B"
  opensm -B >/dev/null 2>&1 && echo "daemon" >"$STATE/method"
fi
[[ -f "$STATE/method" ]] || die "could not start OpenSM; run 'opensm' in the foreground to see why"

for _ in $(seq 1 15); do
  sleep 1
  if command -v sminfo >/dev/null 2>&1 && sminfo >/dev/null 2>&1; then
    sminfo
    echo "OpenSM started ($(cat "$STATE/method")). Check ports with: ibstat"
    exit 0
  fi
done
echo "OpenSM was started ($(cat "$STATE/method")) but sminfo does not answer yet."
echo "If ports stay in INIT: sudo ./stop-sm.sh, then run 'sudo opensm -B' (or bind a port with -g <port GUID>)."
