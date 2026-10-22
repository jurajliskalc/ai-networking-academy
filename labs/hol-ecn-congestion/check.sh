#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hol-ecn-congestion: verify the topology and that ECN marking works end to end.
# Expects the bottleneck in red-ecn mode (sudo ./bottleneck.sh red-ecn).
# Runs a 3-second DCTCP flow from ecn-s2, temporarily switching ecn-s2 and ecn-rcv
# to DCTCP/ECN and restoring their previous settings afterwards.
#
# Usage: sudo ./check.sh
set -euo pipefail

FAILS=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILS=$((FAILS + 1)); }

if [[ $EUID -ne 0 ]]; then
  echo "FAIL: run as root (sudo $0)"
  exit 1
fi

for ns in ecn-s1 ecn-s2 ecn-s3 ecn-r ecn-rcv; do
  if ! ip netns list | grep -qw "$ns"; then
    echo "FAIL: namespace $ns missing (run sudo ./setup.sh)"
    exit 1
  fi
done
pass "all five namespaces exist"

if ip netns exec ecn-s1 ping -c 2 -W 1 -q 10.6.9.2 >/dev/null 2>&1; then
  pass "s1 can reach the receiver"
else
  fail "s1 cannot reach the receiver"
fi

listening=$(ip netns exec ecn-rcv ss -ltnH 2>/dev/null | grep -cE ':520[123]\b' || true)
if [[ $listening -eq 3 ]]; then pass "3 iperf3 servers listening on the receiver"; else fail "$listening/3 iperf3 servers listening (re-run setup.sh)"; fi

if grep -qw dctcp /proc/sys/net/ipv4/tcp_available_congestion_control; then
  pass "dctcp congestion control is available"
else
  fail "dctcp is not available (sudo modprobe tcp_dctcp)"
fi

dctcp_ok=0
if grep -qw dctcp /proc/sys/net/ipv4/tcp_allowed_congestion_control; then
  pass "dctcp is in net.ipv4.tcp_allowed_congestion_control (namespaces may select it)"
  dctcp_ok=1
else
  fail "dctcp is not in net.ipv4.tcp_allowed_congestion_control (namespaces get EPERM; re-run setup.sh)"
fi

qd=$(ip netns exec ecn-r tc qdisc show dev to-rcv)
if grep -q 'htb' <<<"$qd"; then pass "HTB shaper present on ecn-r to-rcv"; else fail "no HTB shaper on ecn-r to-rcv"; fi
if grep -qE '^qdisc red .* ecn' <<<"$qd"; then
  pass "RED with ECN marking configured"
else
  fail "RED with ECN not configured (sudo ./bottleneck.sh red-ecn)"
fi

marked() { ip netns exec ecn-r tc -s qdisc show dev to-rcv | grep -o 'marked [0-9]*' | awk '{s+=$2} END {print s+0}'; }
ce() { ip netns exec ecn-rcv nstat -saz IpExtInCEPkts | awk '$1=="IpExtInCEPkts" {print $2+0}'; }

s2_cc=$(ip netns exec ecn-s2 sysctl -n net.ipv4.tcp_congestion_control)
s2_ecn=$(ip netns exec ecn-s2 sysctl -n net.ipv4.tcp_ecn)
rcv_cc=$(ip netns exec ecn-rcv sysctl -n net.ipv4.tcp_congestion_control)
restore() {
  ip netns exec ecn-s2 sysctl -q -w net.ipv4.tcp_congestion_control="$s2_cc" || true
  ip netns exec ecn-s2 sysctl -q -w net.ipv4.tcp_ecn="$s2_ecn" || true
  ip netns exec ecn-rcv sysctl -q -w net.ipv4.tcp_congestion_control="$rcv_cc" || true
}
trap restore EXIT

if [[ $dctcp_ok -eq 1 ]]; then
  ip netns exec ecn-s2 sysctl -q -w net.ipv4.tcp_congestion_control=dctcp
  ip netns exec ecn-s2 sysctl -q -w net.ipv4.tcp_ecn=1
  ip netns exec ecn-rcv sysctl -q -w net.ipv4.tcp_congestion_control=dctcp

  # A fresh one-off server on port 5299: its listening socket is created now, with DCTCP.
  # (Linux accepts ECN from a DCTCP sender, whose SYN is ECT-marked, only if the listener's
  # congestion control is DCTCP; the long-running servers may have been started with CUBIC.)
  ip netns exec ecn-rcv timeout 30 iperf3 -s -1 -p 5299 >/dev/null 2>&1 &
  srv_pid=$!
  sleep 1
  m0=$(marked); c0=$(ce)
  if ip netns exec ecn-s2 timeout 20 iperf3 -c 10.6.9.2 -p 5299 -t 3 >/dev/null 2>&1; then
    pass "3-second DCTCP flow s2 -> receiver completed"
  else
    fail "DCTCP iperf3 flow failed"
  fi
  m1=$(marked); c1=$(ce)
  kill "$srv_pid" 2>/dev/null || true
  wait "$srv_pid" 2>/dev/null || true

  if [[ $((m1 - m0)) -gt 0 ]]; then pass "RED marked $((m1 - m0)) packets CE"; else fail "RED marked no packets (is the link really the bottleneck?)"; fi
  if [[ $((c1 - c0)) -gt 0 ]]; then pass "receiver saw $((c1 - c0)) CE-marked packets (IpExtInCEPkts)"; else fail "receiver saw no CE-marked packets"; fi
fi

echo
if [[ $FAILS -eq 0 ]]; then
  echo "All checks passed."
else
  echo "$FAILS check(s) failed."
  exit 1
fi
