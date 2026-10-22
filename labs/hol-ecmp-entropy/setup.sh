#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hol-ecmp-entropy: build a tiny two-path "fabric" from network namespaces.
#
#                    +-- ecmp-sp1 --+
#   ecmp-h1 -- ecmp-leaf1          ecmp-leaf2 -- ecmp-h2
#                    +-- ecmp-sp2 --+
#
#   h1 10.5.1.10/24 (gw 10.5.1.1)            h2 10.5.2.10/24 (gw 10.5.2.1)
#   leaf1-sp1 10.5.11.0/31  leaf1-sp2 10.5.12.0/31
#   sp1-leaf2 10.5.21.0/31  sp2-leaf2 10.5.22.0/31   (.0 = leaf side, .1 = spine side)
#
# leaf1 and leaf2 have static ECMP routes over both spines.
# Usage: sudo ./setup.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

run() { echo "+ $*"; "$@"; }

NSS="ecmp-h1 ecmp-leaf1 ecmp-sp1 ecmp-sp2 ecmp-leaf2 ecmp-h2"
for ns in $NSS; do
  if ip netns list | grep -qw "$ns"; then
    echo "Namespace $ns already exists. Run ./cleanup.sh first." >&2
    exit 1
  fi
done

for ns in $NSS; do
  run ip netns add "$ns"
  run ip -n "$ns" link set lo up
  # No IPv6 in this lab: keeps router solicitations / ND out of the packet counters
  run ip netns exec "$ns" sysctl -q -w net.ipv6.conf.all.disable_ipv6=1
  run ip netns exec "$ns" sysctl -q -w net.ipv6.conf.default.disable_ipv6=1
done

# link NS1 IF1 ADDR1 NS2 IF2 ADDR2: veth pair between two namespaces
link() {
  local ns1=$1 if1=$2 a1=$3 ns2=$4 if2=$5 a2=$6
  ip link del ecmptmp1 2>/dev/null || true
  run ip link add ecmptmp1 type veth peer name ecmptmp2
  run ip link set ecmptmp1 netns "$ns1"
  run ip link set ecmptmp2 netns "$ns2"
  run ip -n "$ns1" link set ecmptmp1 name "$if1"
  run ip -n "$ns2" link set ecmptmp2 name "$if2"
  run ip -n "$ns1" addr add "$a1" dev "$if1"
  run ip -n "$ns2" addr add "$a2" dev "$if2"
  run ip -n "$ns1" link set "$if1" up
  run ip -n "$ns2" link set "$if2" up
}

link ecmp-h1    eth0     10.5.1.10/24  ecmp-leaf1 to-h1    10.5.1.1/24
link ecmp-leaf1 to-sp1   10.5.11.0/31  ecmp-sp1   to-leaf1 10.5.11.1/31
link ecmp-leaf1 to-sp2   10.5.12.0/31  ecmp-sp2   to-leaf1 10.5.12.1/31
link ecmp-sp1   to-leaf2 10.5.21.1/31  ecmp-leaf2 to-sp1   10.5.21.0/31
link ecmp-sp2   to-leaf2 10.5.22.1/31  ecmp-leaf2 to-sp2   10.5.22.0/31
link ecmp-leaf2 to-h2    10.5.2.1/24   ecmp-h2    eth0     10.5.2.10/24

for ns in ecmp-leaf1 ecmp-sp1 ecmp-sp2 ecmp-leaf2; do
  run ip netns exec "$ns" sysctl -q -w net.ipv4.ip_forward=1
  run ip netns exec "$ns" sysctl -q -w net.ipv4.conf.all.rp_filter=0
done

run ip -n ecmp-h1 route add default via 10.5.1.1
run ip -n ecmp-h2 route add default via 10.5.2.1

# ECMP on the leaves
run ip -n ecmp-leaf1 route add 10.5.2.0/24 \
  nexthop via 10.5.11.1 dev to-sp1 weight 1 \
  nexthop via 10.5.12.1 dev to-sp2 weight 1
run ip -n ecmp-leaf2 route add 10.5.1.0/24 \
  nexthop via 10.5.21.1 dev to-sp1 weight 1 \
  nexthop via 10.5.22.1 dev to-sp2 weight 1

# Spines: one path each way
for s in 1 2; do
  run ip -n "ecmp-sp$s" route add 10.5.1.0/24 via "10.5.1${s}.0"
  run ip -n "ecmp-sp$s" route add 10.5.2.0/24 via "10.5.2${s}.0"
done

# Start with the kernel default: L3 hash
run ip netns exec ecmp-leaf1 sysctl -w net.ipv4.fib_multipath_hash_policy=0
run ip netns exec ecmp-leaf2 sysctl -w net.ipv4.fib_multipath_hash_policy=0

echo
echo "Done. Try: sudo ip netns exec ecmp-h1 ping -c 3 10.5.2.10"
