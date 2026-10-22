#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hol-ecn-congestion: configure the bottleneck on ecn-r's egress towards the receiver.
#
# Usage: sudo ./bottleneck.sh MODE
#   fifo      HTB at $RATE + a short packet FIFO (tail drop, no ECN)
#   red-ecn   HTB at $RATE + RED that marks ECN-capable packets (step-like threshold)
#   fq_codel  HTB at $RATE + fq_codel with ECN
#   off       remove the shaper (no bottleneck)
#   show      print the current qdiscs with statistics
#
# Environment: RATE (default 100mbit), FIFO_LIMIT (packets, default 50),
#              RED_MIN / RED_MAX (bytes, default 30000 / 35000)
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0 MODE" >&2
  exit 1
fi

MODE=${1:-show}
RATE=${RATE:-100mbit}
FIFO_LIMIT=${FIFO_LIMIT:-50}
RED_MIN=${RED_MIN:-30000}
RED_MAX=${RED_MAX:-35000}
NS=ecn-r
DEV=to-rcv

t() { echo "+ tc $*"; ip netns exec "$NS" tc "$@"; }

reset() {
  ip netns exec "$NS" tc qdisc del dev "$DEV" root 2>/dev/null || true
}

shaper() {
  t qdisc add dev "$DEV" root handle 1: htb default 10
  t class add dev "$DEV" parent 1: classid 1:10 htb rate "$RATE" ceil "$RATE" quantum 1514
}

case "$MODE" in
  fifo)
    reset; shaper
    t qdisc add dev "$DEV" parent 1:10 handle 10: pfifo limit "$FIFO_LIMIT"
    ;;
  red-ecn)
    reset; shaper
    # Marking starts when the average queue passes RED_MIN bytes and reaches probability 1.0
    # at RED_MAX: close to the single-threshold (K) marking DCTCP was designed for.
    # burst must be at least RED_MIN/avpkt (tc refuses smaller values).
    t qdisc add dev "$DEV" parent 1:10 handle 10: red limit 400000 \
      min "$RED_MIN" max "$RED_MAX" avpkt 1500 burst 25 probability 1.0 bandwidth "$RATE" ecn
    ;;
  fq_codel)
    reset; shaper
    t qdisc add dev "$DEV" parent 1:10 handle 10: fq_codel ecn
    ;;
  off)
    reset
    echo "Bottleneck removed."
    ;;
  show)
    ;;
  *)
    echo "Unknown mode '$MODE' (fifo | red-ecn | fq_codel | off | show)" >&2
    exit 1
    ;;
esac

echo
ip netns exec "$NS" tc -s qdisc show dev "$DEV"
