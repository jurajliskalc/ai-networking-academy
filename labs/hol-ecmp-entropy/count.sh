#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hol-ecmp-entropy: run a command and show how its traffic split across the two spines.
#
# Counts packets/bytes RECEIVED by each spine on its leaf1-facing interface, i.e. the
# forward direction h1 -> h2 as hashed by leaf1.
#
# Usage: sudo ./count.sh <command> [args...]
#   e.g. sudo ./count.sh ip netns exec ecmp-h1 iperf3 -c 10.5.2.10 -P 8 -t 5
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0 <command>" >&2
  exit 1
fi
if [[ $# -eq 0 ]]; then
  echo "Usage: sudo $0 <command> [args...]" >&2
  exit 1
fi

ctr() { # spine counter
  ip netns exec "ecmp-$1" cat "/sys/class/net/to-leaf1/statistics/$2"
}

declare -A p0 b0
for s in sp1 sp2; do
  p0[$s]=$(ctr "$s" rx_packets)
  b0[$s]=$(ctr "$s" rx_bytes)
done

policy=$(ip netns exec ecmp-leaf1 sysctl -n net.ipv4.fib_multipath_hash_policy)
echo "leaf1 fib_multipath_hash_policy=$policy"
echo "+ $*"
"$@" || echo "(command exited with status $?)"

declare -A dp db
tp=0; tb=0
for s in sp1 sp2; do
  dp[$s]=$(( $(ctr "$s" rx_packets) - ${p0[$s]} ))
  db[$s]=$(( $(ctr "$s" rx_bytes) - ${b0[$s]} ))
  tp=$(( tp + ${dp[$s]} ))
  tb=$(( tb + ${db[$s]} ))
done

echo
printf '%-6s %12s %8s %16s %8s\n' spine packets pkt% bytes byte%
for s in sp1 sp2; do
  pp=0; bp=0
  [[ $tp -gt 0 ]] && pp=$(( 100 * ${dp[$s]} / tp ))
  [[ $tb -gt 0 ]] && bp=$(( 100 * ${db[$s]} / tb ))
  printf '%-6s %12d %7d%% %16d %7d%%\n' "$s" "${dp[$s]}" "$pp" "${db[$s]}" "$bp"
done
