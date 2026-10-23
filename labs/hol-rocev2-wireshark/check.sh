#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hol-rocev2-wireshark: verify that a capture contains decodable RoCEv2 traffic.
#
# Usage: ./check.sh [capture.pcap ...]
#   default: /tmp/roce-send.pcap (Task 1). Pass several files to check them all,
#   for example: ./check.sh /tmp/roce-send.pcap /tmp/roce-write.pcap /tmp/roce-read.pcap
#   The synthetic fallback file also works: ./check.sh roce-synthetic.pcap
set -euo pipefail

FAILS=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILS=$((FAILS + 1)); }

if command -v tshark >/dev/null 2>&1; then
  pass "tshark is installed ($(tshark --version 2>/dev/null | head -1))"
else
  echo "FAIL: tshark is not installed (sudo apt-get install -y tshark)"
  exit 1
fi

if [[ $# -eq 0 ]]; then
  set -- /tmp/roce-send.pcap
fi

for f in "$@"; do
  echo "--- $f"
  if [[ ! -r "$f" ]]; then
    fail "$f does not exist or is not readable"
    continue
  fi
  pass "$f exists"

  n_udp=$(tshark -r "$f" -Y 'udp.dstport == 4791' 2>/dev/null | wc -l || true)
  if [[ $n_udp -gt 0 ]]; then
    pass "$f has $n_udp packet(s) to UDP port 4791"
  else
    fail "$f has no packets to UDP port 4791 (wrong interface, or loopback rxe traffic that never hits the wire?)"
  fi

  opcodes=$(tshark -r "$f" -Y 'infiniband.bth' -T fields -e infiniband.bth.opcode 2>/dev/null | sort -n | uniq -c || true)
  n_bth=$(printf '%s\n' "$opcodes" | awk 'NF==2 {s+=$1} END {print s+0}')
  if [[ $n_bth -gt 0 ]]; then
    pass "$f: Wireshark decoded $n_bth packet(s) with an InfiniBand BTH"
    echo "      count opcode"
    printf '%s\n' "$opcodes" | sed 's/^/     /'
  else
    fail "$f: no packet decoded as InfiniBand BTH (try: tshark -r $f -d udp.port==4791,infiniband)"
  fi

  # The responder acknowledges with RC ACKNOWLEDGE (17), or for RDMA READ with the READ RESPONSE
  # First/Last/Only packets (13/15/16), which carry the AETH themselves: a READ capture has no opcode 17.
  if printf '%s\n' "$opcodes" | awk '$2 == 17 {found=1} END {exit !found}'; then
    pass "$f contains at least one RC ACKNOWLEDGE (opcode 17)"
  elif printf '%s\n' "$opcodes" | awk '$2 == 13 || $2 == 15 || $2 == 16 {found=1} END {exit !found}'; then
    pass "$f contains RDMA READ responses (opcodes 13/15/16), which carry the acknowledgement (AETH)"
  else
    fail "$f contains no acknowledgement (no RC ACKNOWLEDGE 17 and no READ response 13/15/16)"
  fi
done

echo
if [[ $FAILS -eq 0 ]]; then
  echo "All checks passed."
else
  echo "$FAILS check(s) failed."
  exit 1
fi
