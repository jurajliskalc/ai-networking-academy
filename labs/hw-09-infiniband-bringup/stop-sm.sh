#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-09-infiniband-bringup: stop OpenSM only if start-sm.sh started it.
# Usage: sudo ./stop-sm.sh
set -uo pipefail
. "$(dirname "$0")/../hw-toolkit/lib.sh"
need_root
STATE=$(aina_state_dir hw-09-infiniband-bringup)
method=$(cat "$STATE/method" 2>/dev/null || echo none)
case "$method" in
  systemd) echo "+ systemctl stop opensm"; systemctl stop opensm ;;
  daemon) echo "+ pkill -x opensm"; pkill -x opensm || true ;;
  preexisting) echo "The subnet manager was not started by this lab; leaving it running." ;;
  *) echo "No record of this lab starting OpenSM; nothing to do." ;;
esac
rm -f "$STATE/method"
