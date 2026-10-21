#!/usr/bin/env bash
# hol-ecmp-entropy: verify the topology and the L3 vs L4 hashing behavior.
# The script temporarily changes leaf1's hash policy and restores it at the end.
#
# Usage: sudo ./check.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
FAILS=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILS=$((FAILS + 1)); }

if [[ $EUID -ne 0 ]]; then
  echo "FAIL: run as root (sudo $0)"
  exit 1
fi

for ns in ecmp-h1 ecmp-leaf1 ecmp-sp1 ecmp-sp2 ecmp-leaf2 ecmp-h2; do
  if ! ip netns list | grep -qw "$ns"; then
    echo "FAIL: namespace $ns missing (run sudo ./setup.sh)"
    exit 1
  fi
done
pass "all six namespaces exist"

nh=$(ip -n ecmp-leaf1 route show 10.5.2.0/24 | grep -c nexthop || true)
if [[ $nh -ge 2 ]]; then pass "leaf1 has an ECMP route with $nh next hops"; else fail "leaf1 ECMP route has $nh next hops, expected 2"; fi

if ip netns exec ecmp-h1 ping -c 2 -W 1 -q 10.5.2.10 >/dev/null 2>&1; then
  pass "h1 can ping h2"
else
  fail "h1 cannot ping h2"
fi

ctr() { ip netns exec "ecmp-$1" cat /sys/class/net/to-leaf1/statistics/rx_packets; }

# measure POLICY -> prints "sp1_pkts sp2_pkts" for 64 UDP flows x 20 packets
measure() {
  ip netns exec ecmp-leaf1 sysctl -q -w net.ipv4.fib_multipath_hash_policy="$1"
  local a0 b0
  a0=$(ctr sp1); b0=$(ctr sp2)
  ip netns exec ecmp-h1 python3 "$HERE/udp_flows.py" --dst 10.5.2.10 --flows 64 --pkts 20 >/dev/null
  echo "$(( $(ctr sp1) - a0 )) $(( $(ctr sp2) - b0 ))"
}

orig=$(ip netns exec ecmp-leaf1 sysctl -n net.ipv4.fib_multipath_hash_policy)

read -r a b < <(measure 0)
total=$((a + b))
if [[ $total -gt 0 && $(( 100 * (a > b ? a : b) / total )) -ge 95 ]]; then
  pass "policy 0 (L3): 64 flows between one IP pair use one spine (sp1=$a sp2=$b)"
else
  fail "policy 0 (L3): expected one spine to carry >=95% (sp1=$a sp2=$b)"
fi

read -r a b < <(measure 1)
total=$((a + b))
if [[ $total -gt 0 && $(( 100 * a / total )) -ge 10 && $(( 100 * b / total )) -ge 10 ]]; then
  pass "policy 1 (L4): 64 flows spread over both spines (sp1=$a sp2=$b)"
else
  fail "policy 1 (L4): expected both spines to carry >=10% (sp1=$a sp2=$b)"
fi

ip netns exec ecmp-leaf1 sysctl -q -w net.ipv4.fib_multipath_hash_policy="$orig"
echo "INFO: restored leaf1 fib_multipath_hash_policy=$orig"

echo
if [[ $FAILS -eq 0 ]]; then
  echo "All checks passed."
else
  echo "$FAILS check(s) failed."
  exit 1
fi
