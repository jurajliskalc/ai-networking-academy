#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-06-switch-lossless-incast: run a 2 -> 1 RDMA WRITE incast (A and C into B) and print how the
# congestion counters moved. Run on host A. Read-only (changes no settings).
# Usage: ./incast.sh [seconds]     (default 10; TCP ports 18610 and 18611)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../hw-toolkit/lib.sh"
aina_load_env >/dev/null
. "$HERE/incast-lib.sh"
[[ "$HOST_COUNT" == 3 ]] || die "this lab needs HOST_COUNT=3 in lab.env (hosts A, B and C)"
SECS=${1:-10}
echo "Incast: $HOST_A and $HOST_C -> $HOST_B ($B_IP), $SECS s, 4 QPs each, traffic class $TCLASS (priority $ROCE_PRIO)"
run_incast "$SECS"
[[ $INCAST_OK -eq 1 ]] || echo "WARNING: a sender failed: ${INCAST_ERR:-}"
echo
print_incast
echo
echo "Empty counters are not exposed by this driver. np_* move on the receiver (B), rp_* and rx_prio*_pause on the senders."
