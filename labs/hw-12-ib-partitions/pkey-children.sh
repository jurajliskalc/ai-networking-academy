#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-12-ib-partitions: create (or remove) one IPoIB child interface per lab partition on THIS host.
#   sudo ./pkey-children.sh up --role A|B       <NETDEV>.8001 ... with PKEY_NET.<n>.1 (A) or .2 (B)
#   sudo ./pkey-children.sh restore --role A|B  delete the child interfaces this script created
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../hw-toolkit/lib.sh"
aina_load_env >/dev/null
. "$HERE/partitions.env"
cmd=${1:-}; ROLE=""
[[ "${2:-}" == --role ]] && ROLE=${3:-}
[[ "$ROLE" == A || "$ROLE" == B ]] || { echo "usage: sudo $0 up|restore --role A|B"; exit 2; }
need_root
PARENT=$(netdev_of "$ROLE"); HOSTNUM=1; [[ "$ROLE" == B ]] && HOSTNUM=2
ip -d link show dev "$PARENT" 2>/dev/null | grep -q ' ipoib ' || die "$PARENT is not an IPoIB interface (${ROLE}_NETDEV)"
for p in "${PARTITIONS[@]}"; do
  IFS=: read -r pkey _ _ _ octet <<<"$p"
  child=$PARENT.${pkey#0x}
  case "$cmd" in
    up)
      if [[ ! -d /sys/class/net/$child ]]; then
        echo "+ ip link add link $PARENT name $child type ipoib pkey $pkey"
        ip link add link "$PARENT" name "$child" type ipoib pkey "$pkey" || die "could not create $child"
      fi
      ip -o -4 addr show dev "$child" | grep -q " $PKEY_NET.$octet.$HOSTNUM/" \
        || { echo "+ ip addr add $PKEY_NET.$octet.$HOSTNUM/24 dev $child"; ip addr add "$PKEY_NET.$octet.$HOSTNUM/24" dev "$child"; }
      ip link set "$child" up ;;
    restore)
      if [[ -d /sys/class/net/$child ]]; then echo "+ ip link del $child"; ip link del "$child"; fi ;;
    *) echo "usage: sudo $0 up|restore --role A|B"; exit 2 ;;
  esac
done
[[ "$cmd" == up ]] && { sleep 3; ip -br addr show | grep "^$PARENT\." || true; }
exit 0
