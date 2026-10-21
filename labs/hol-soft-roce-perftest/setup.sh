#!/usr/bin/env bash
# hol-soft-roce-perftest: load rdma_rxe and create a Soft-RoCE device on a netdev.
#
# Usage: sudo ./setup.sh [netdev] [rxe-name]
#   netdev   defaults to the interface of the IPv4 default route
#   rxe-name defaults to rxe0
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0 [netdev] [rxe-name]" >&2
  exit 1
fi

NETDEV=${1:-$(ip -o -4 route show to default | awk '{print $5; exit}')}
RXE=${2:-rxe0}

if [[ -z "$NETDEV" ]]; then
  echo "Could not detect a default-route interface; pass one explicitly." >&2
  exit 1
fi
if ! ip link show dev "$NETDEV" >/dev/null 2>&1; then
  echo "Interface $NETDEV does not exist." >&2
  exit 1
fi
if ! ip -o -4 addr show dev "$NETDEV" | grep -q inet; then
  echo "WARNING: $NETDEV has no IPv4 address; you will only get IPv6 GIDs." >&2
fi

for tool in rdma ibv_devinfo ibv_rc_pingpong ib_write_bw; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing $tool. Install: sudo apt-get install -y iproute2 rdma-core ibverbs-utils ibverbs-providers perftest" >&2
    exit 1
  fi
done

echo "+ modprobe rdma_rxe"
if ! modprobe rdma_rxe; then
  echo "rdma_rxe module not found. On Ubuntu try: sudo apt-get install -y linux-modules-extra-\$(uname -r)" >&2
  exit 1
fi

if rdma link show "$RXE/1" >/dev/null 2>&1; then
  echo "$RXE already exists:"
else
  echo "+ rdma link add $RXE type rxe netdev $NETDEV"
  rdma link add "$RXE" type rxe netdev "$NETDEV"
fi
rdma link show "$RXE/1"

echo
echo "GID table (look for the ::ffff:<IPv4> entry):"
bash "$(dirname "$0")/find_gid.sh" "$RXE" || true
