#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-11-ipoib: bring the IPoIB interface of THIS host up with its lab address, and undo exactly that.
#
# Usage (as root):
#   sudo ./ipoib.sh up --role A|B       save the interface state, add <ROLE>_IP/PREFIX_LEN, set it up
#   sudo ./ipoib.sh restore --role A|B  remove the address and restore the saved up/down state
#        ./ipoib.sh status --role A|B
# The interface is <ROLE>_NETDEV from the profile (an IPoIB netdev such as ibs64f1 or ib0). The
# script refuses to touch an interface that is not IPoIB or that carries the default route.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../hw-toolkit/lib.sh"
aina_load_env >/dev/null
cmd=${1:-}; ROLE=""
[[ "${2:-}" == --role ]] && ROLE=${3:-}
[[ "$ROLE" == A || "$ROLE" == B ]] || { echo "usage: sudo $0 up|restore|status --role A|B"; exit 2; }
IF=$(netdev_of "$ROLE"); IP=$(ip_of "$ROLE")
STATE=$(aina_state_dir hw-11-ipoib)

[[ -d /sys/class/net/$IF ]] || die "no interface $IF (set ${ROLE}_NETDEV to the IPoIB netdev: ip -br link | grep ^ib)"
ip -d link show dev "$IF" | grep -q ' ipoib ' || die "$IF is not an IPoIB interface (${ROLE}_NETDEV must be the ib* netdev of the InfiniBand port)"
ip -o -4 route show to default | grep -qw "dev $IF" && die "$IF carries the default route; not touching it"

case "$cmd" in
  up)
    need_root
    mkdir -p "$STATE"
    if [[ ! -f "$STATE/$IF.up" ]]; then
      ip -o link show dev "$IF" | grep -q '[<,]UP[,>]' && echo yes >"$STATE/$IF.up" || echo no >"$STATE/$IF.up"
      ip -o -4 addr show dev "$IF" | grep -q " $IP/" && echo yes >"$STATE/$IF.addr" || echo no >"$STATE/$IF.addr"
    fi
    if ! ip -o -4 addr show dev "$IF" | grep -q " $IP/"; then
      echo "+ ip addr add $IP/$PREFIX_LEN dev $IF"; ip addr add "$IP/$PREFIX_LEN" dev "$IF" || die "ip addr add failed"
    fi
    echo "+ ip link set $IF up"; ip link set "$IF" up
    sleep 2
    ip -br addr show dev "$IF"
    ;;
  restore)
    need_root
    [[ -f "$STATE/$IF.up" ]] || { echo "No saved state for $IF; nothing to restore."; exit 0; }
    if [[ "$(cat "$STATE/$IF.addr")" == no ]] && ip -o -4 addr show dev "$IF" | grep -q " $IP/"; then
      echo "+ ip addr del $IP/$PREFIX_LEN dev $IF"; ip addr del "$IP/$PREFIX_LEN" dev "$IF"
    fi
    if [[ "$(cat "$STATE/$IF.up")" == no ]]; then echo "+ ip link set $IF down"; ip link set "$IF" down; fi
    rm -f "$STATE/$IF.up" "$STATE/$IF.addr"
    ip -br addr show dev "$IF"
    ;;
  status)
    ip -br addr show dev "$IF"; ip -d link show dev "$IF" | grep -o 'ipoib pkey [^ ]* mode [^ ]*'
    echo "mtu $(cat "/sys/class/net/$IF/mtu"), mode $(cat "/sys/class/net/$IF/mode" 2>/dev/null)"
    ;;
  *) echo "usage: sudo $0 up|restore|status --role A|B"; exit 2 ;;
esac
