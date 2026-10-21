#!/usr/bin/env bash
# hol-evpn-vxlan: create the VXLAN data plane on both leaves (what ifupdown2/NVUE/SONiC
# would do on a real switch). FRR's zebra notices the new devices and starts advertising
# VNI 100 in EVPN.
#
# On each leaf:  br100 (Linux bridge) with two ports:
#                  eth2      access port towards the host
#                  vxlan100  VNI 100, local VTEP = leaf loopback, UDP 4789, no data-plane learning
#
# Uses the host's iproute2 inside each container's network namespace (nsenter), because
# the minimal tools inside the FRR image may not support every option.
#
# Usage: sudo ./vxlan-setup.sh
set -euo pipefail

LAB=hol-evpn
if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi
command -v docker >/dev/null 2>&1 || { echo "docker not found" >&2; exit 1; }

cnet() { # node command...
  local pid
  pid=$(docker inspect -f '{{.State.Pid}}' "clab-${LAB}-$1")
  nsenter -t "$pid" -n "${@:2}"
}
run() { echo "+ [$1] ${*:2}"; cnet "$@"; }

for pair in "leaf1 10.0.0.11" "leaf2 10.0.0.12"; do
  # shellcheck disable=SC2086
  set -- $pair
  leaf=$1 vtep=$2

  if cnet "$leaf" ip link show vxlan100 >/dev/null 2>&1; then
    echo "[$leaf] vxlan100 already exists, skipping"
    continue
  fi

  run "$leaf" ip link add br100 type bridge
  run "$leaf" ip link add vxlan100 type vxlan id 100 local "$vtep" dstport 4789 nolearning
  # Overlay MTU 1500 (the underlay links have containerlab's default 9500, so the
  # 50 bytes of VXLAN/UDP/IP/Ethernet overhead fit easily).
  run "$leaf" ip link set vxlan100 mtu 1500
  run "$leaf" ip link set vxlan100 master br100
  # Remote MACs come from EVPN type-2 routes, not from flooding-and-learning.
  run "$leaf" bridge link set dev vxlan100 learning off
  run "$leaf" ip link set eth2 master br100
  run "$leaf" ip link set vxlan100 up
  run "$leaf" ip link set br100 up
done

echo
echo "Done. Give BGP a few seconds, then: docker exec clab-${LAB}-h1 ping -c 3 192.168.100.12"
