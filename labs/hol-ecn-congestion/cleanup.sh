#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hol-ecn-congestion: stop iperf3 servers and remove the lab namespaces.
set -uo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

for i in 1 2 3; do
  f=/tmp/ecn-iperf3-$i.pid
  if [[ -f $f ]]; then
    echo "+ stopping iperf3 server $i (pid $(cat "$f"))"
    kill "$(cat "$f")" 2>/dev/null || true
    rm -f "$f"
  fi
done

for ns in ecn-s1 ecn-s2 ecn-s3 ecn-r ecn-rcv; do
  if ip netns list | grep -qw "$ns"; then
    echo "+ ip netns del $ns"
    ip netns del "$ns"
  fi
done
ip link del ecntmp1 2>/dev/null || true

if [[ -f /tmp/ecn-allowed-cc.orig ]]; then
  orig=$(cat /tmp/ecn-allowed-cc.orig)
  echo "+ sysctl -w net.ipv4.tcp_allowed_congestion_control=\"$orig\""
  sysctl -q -w net.ipv4.tcp_allowed_congestion_control="$orig" || true
  rm -f /tmp/ecn-allowed-cc.orig
fi
echo "Cleanup complete."
