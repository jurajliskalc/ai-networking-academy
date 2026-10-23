#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-03-host-qos-pfc-ecn: configure host-side lossless RoCE QoS on this host's RDMA netdev.
#   trust DSCP, PFC on ROCE_PRIO only, DSCP ROCE_DSCP -> ROCE_PRIO, ECN on ROCE_PRIO (if exposed).
# Usage: sudo ./apply-qos.sh [--dry-run] [A|B|C]    (role auto-detected from the data IPs in lab.env)
# Saves the current state first (once). Idempotent. Runtime only: settings do not survive a reboot.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../hw-toolkit/lib.sh"
aina_load_env >/dev/null
. "$HERE/qos-lib.sh"
need_root

DRY=0 ROLE=""
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; A|B|C) ROLE=$a ;; *) die "unknown argument $a" ;; esac; done
[[ -n "$ROLE" ]] || ROLE=$(local_role) || die "cannot tell which host this is (pass A, B or C)"
NETDEV=$(netdev_of "$ROLE")
[[ -d /sys/class/net/$NETDEV ]] || die "netdev $NETDEV does not exist on this host"
run() { echo "+ $*" >&2; [[ $DRY -eq 1 ]] || "$@"; }

[[ $DRY -eq 1 ]] || bash "$HERE/save-qos.sh" "$ROLE" || die "could not save the current state; nothing was changed"
TOOL=$(qos_tool A)
echo "Host $ROLE, netdev $NETDEV, tool ${TOOL:-none}: lossless priority $ROCE_PRIO, DSCP $ROCE_DSCP -> priority $ROCE_PRIO"

case "$TOOL" in
  mlnx_qos)
    run mlnx_qos -i "$NETDEV" --trust dscp
    run mlnx_qos -i "$NETDEV" --pfc "$(pfc_csv "$ROCE_PRIO")"
    # --dscp2prio syntax as documented by NVIDIA (set,<dscp>,<prio>); older releases may lack it.
    if ! run mlnx_qos -i "$NETDEV" --dscp2prio "set,$ROCE_DSCP,$ROCE_PRIO" >/dev/null; then
      echo "WARNING: --dscp2prio not accepted by this mlnx_qos; check the default map below (DSCP 26 usually maps to priority 3)."
    fi
    ;;
  dcb)
    run dcb pfc set dev "$NETDEV" prio-pfc all:off "$ROCE_PRIO:on"
    # On mlx5, the first DSCP APP entry also switches the port to DSCP trust (driver behaviour; other drivers differ).
    run dcb app replace dev "$NETDEV" dscp-prio "$ROCE_DSCP:$ROCE_PRIO"
    ;;
  *) die "install mlnx_qos (NVIDIA OFED/DOCA) or iproute2 with dcb, then run again" ;;
esac

ECN=/sys/class/net/$NETDEV/ecn
if [[ -d $ECN/roce_np/enable || -d $ECN/roce_rp/enable ]]; then
  for side in roce_np roce_rp; do
    f=$ECN/$side/enable/$ROCE_PRIO
    if [[ -w $f ]]; then echo "+ echo 1 > $f"; [[ $DRY -eq 1 ]] || echo 1 >"$f"; fi
  done
else
  echo "Per-priority ECN switches are not exposed by this driver stack; DCQCN defaults apply (see Task 5)."
fi

echo
echo "Result:"
case "$TOOL" in
  mlnx_qos) mlnx_qos -i "$NETDEV" | sed 's/^/  /' ;;
  dcb) { dcb pfc show dev "$NETDEV" prio-pfc; dcb -N app show dev "$NETDEV" dscp-prio; } | sed 's/^/  /' ;;
esac
# On mlx5, enabling PFC switches 802.3x global pause off, and a later "ethtool -A <if> rx on tx on" silently
# clears PFC again: show the global pause state so a leftover tuning script is easy to spot.
if command -v ethtool >/dev/null 2>&1; then
  echo "Global pause (should read off while PFC is on):"
  ethtool -a "$NETDEV" 2>/dev/null | grep -E '^(RX|TX):' | sed 's/^/  /'
fi
