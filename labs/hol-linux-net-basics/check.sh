#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hol-linux-net-basics: verify the end state of the lab.
# Expected end state: Tasks 1-5 done (jumbo MTU fixed on both hosts). Task 6
# (routed path through hol1-r) is checked only if hol1-r exists.
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

ns_exists() { ip netns list | grep -qw "$1"; }

mtu_of() { # ns dev
  ip -n "$1" -o link show dev "$2" 2>/dev/null | sed -n 's/.* mtu \([0-9]*\).*/\1/p'
}

for ns in hol1-a hol1-b; do
  if ns_exists "$ns"; then pass "namespace $ns exists"; else fail "namespace $ns missing (run Task 1 or ./setup.sh)"; fi
done

if ip link show br-hol1 >/dev/null 2>&1; then
  pass "bridge br-hol1 exists"
else
  fail "bridge br-hol1 missing"
fi

for pair in "hol1-a a-eth0" "hol1-b b-eth0"; do
  # shellcheck disable=SC2086
  set -- $pair
  m=$(mtu_of "$1" "$2" || true)
  if [[ "$m" == "9000" ]]; then
    pass "$2 in $1 has MTU 9000"
  else
    fail "$2 in $1 has MTU '${m:-unknown}', expected 9000 (Task 5)"
  fi
done

for dev in a-br b-br; do
  m=$(ip -o link show dev "$dev" 2>/dev/null | sed -n 's/.* mtu \([0-9]*\).*/\1/p' || true)
  if [[ "$m" == "9000" ]]; then
    pass "bridge port $dev has MTU 9000"
  else
    fail "bridge port $dev has MTU '${m:-unknown}', expected 9000 (Task 3)"
  fi
done

if ip netns exec hol1-a ping -c 2 -W 1 -q 10.10.0.2 >/dev/null 2>&1; then
  pass "small ping hol1-a -> hol1-b works"
else
  fail "small ping hol1-a -> hol1-b fails"
  if [[ "$(sysctl -n net.bridge.bridge-nf-call-iptables 2>/dev/null)" == "1" ]] &&
     ! iptables -C FORWARD -i br-hol1 -o br-hol1 -j ACCEPT 2>/dev/null; then
    echo "      hint: bridged traffic is filtered by iptables FORWARD (Docker?); see Task 1:"
    echo "      sudo iptables -I FORWARD -i br-hol1 -o br-hol1 -j ACCEPT"
  fi
fi

if ip netns exec hol1-a ping -c 2 -W 1 -q -M "do" -s 8972 10.10.0.2 >/dev/null 2>&1; then
  pass "9000-byte DF ping hol1-a -> hol1-b works (jumbo path consistent)"
else
  fail "9000-byte DF ping hol1-a -> hol1-b fails (MTU mismatch still present?)"
fi

if ns_exists hol1-r; then
  if ip netns exec hol1-a ping -c 2 -W 1 -q -M "do" -s 1472 10.20.0.1 >/dev/null 2>&1; then
    pass "Task 6: 1500-byte DF ping hol1-a -> hol1-c through router works"
  else
    fail "Task 6: 1500-byte DF ping hol1-a -> hol1-c through router fails"
  fi
else
  echo "INFO: hol1-r not found, skipping Task 6 checks"
fi

echo
if [[ $FAILS -eq 0 ]]; then
  echo "All checks passed."
else
  echo "$FAILS check(s) failed."
  exit 1
fi
