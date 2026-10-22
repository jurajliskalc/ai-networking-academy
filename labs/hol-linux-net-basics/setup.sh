#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hol-linux-net-basics: build the lab topology (Tasks 1-2) in one go.
#
#   hol1-a [a-eth0] ---- [a-br] \
#                                br-hol1 (Linux bridge in the host namespace)
#   hol1-b [b-eth0] ---- [b-br] /
#
#   10.10.0.0/24: hol1-a = 10.10.0.1, hol1-b = 10.10.0.2
#
# Usage: sudo ./setup.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

run() { echo "+ $*"; "$@"; }

if ip netns list | grep -qw hol1-a; then
  echo "Namespace hol1-a already exists. Run ./cleanup.sh first for a fresh start." >&2
  exit 1
fi

run ip netns add hol1-a
run ip netns add hol1-b

run ip link add br-hol1 type bridge
run ip link set br-hol1 up

# Docker loads br_netfilter (bridged IPv4 goes through iptables FORWARD) and sets
# the FORWARD policy to DROP; let frames switched by br-hol1 through.
if command -v iptables >/dev/null 2>&1; then
  run iptables -I FORWARD -i br-hol1 -o br-hol1 -j ACCEPT
fi

for n in a b; do
  run ip link add "${n}-br" type veth peer name "${n}-eth0"
  run ip link set "${n}-eth0" netns "hol1-${n}"
  run ip link set "${n}-br" master br-hol1
  run ip link set "${n}-br" up
  run ip -n "hol1-${n}" link set lo up
  run ip -n "hol1-${n}" link set "${n}-eth0" up
done

run ip -n hol1-a addr add 10.10.0.1/24 dev a-eth0
run ip -n hol1-b addr add 10.10.0.2/24 dev b-eth0

echo
echo "Done. Try: sudo ip netns exec hol1-a ping -c 3 10.10.0.2"
