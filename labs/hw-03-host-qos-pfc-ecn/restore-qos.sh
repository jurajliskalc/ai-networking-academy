#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-03-host-qos-pfc-ecn: restore the QoS state saved by save-qos.sh (or apply-qos.sh).
# Usage: sudo ./restore-qos.sh [A|B|C]
# Restores trust mode, PFC-enabled priorities, the lab's DSCP->priority entry and the ECN switches.
# What it cannot restore exactly it says so (for example other DSCP entries you changed by hand).
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../hw-toolkit/lib.sh"
aina_load_env >/dev/null
. "$HERE/qos-lib.sh"
need_root

ROLE=${1:-}
[[ -n "$ROLE" ]] || ROLE=$(local_role) || die "cannot tell which host this is (pass A, B or C)"
DIR=$(aina_state_dir hw-03-host-qos-pfc-ecn)/$ROLE
[[ -f $DIR/saved ]] || die "nothing saved in $DIR (did you run apply-qos.sh or save-qos.sh on this host?)"
NETDEV=$(cat "$DIR/netdev"); TOOL=$(cat "$DIR/tool")
run() { echo "+ $*"; "$@"; }
echo "Restoring $NETDEV (host $ROLE) to the state saved on $(cat "$DIR/saved")"

case "$TOOL" in
  mlnx_qos)
    trust=$(parse_trust <"$DIR/mlnx_qos.txt")
    pfc=$(parse_pfc <"$DIR/mlnx_qos.txt")
    prio=$(parse_dscp_prio "$ROCE_DSCP" <"$DIR/mlnx_qos.txt")
    [[ -n "$trust" ]] && run mlnx_qos -i "$NETDEV" --trust "$trust"
    if [[ -n "$pfc" ]]; then
      csv=(0 0 0 0 0 0 0 0)
      [[ "$pfc" != none ]] && for p in $pfc; do csv[p]=1; done
      run mlnx_qos -i "$NETDEV" --pfc "$(IFS=,; echo "${csv[*]}")"
    fi
    if [[ -n "$prio" ]]; then
      run mlnx_qos -i "$NETDEV" --dscp2prio "set,$ROCE_DSCP,$prio" >/dev/null || echo "WARNING: could not restore DSCP $ROCE_DSCP -> priority $prio"
    fi
    ;;
  dcb)
    saved_pfc=$(grep -o 'prio-pfc.*' "$DIR/dcb-pfc.txt" 2>/dev/null)
    if [[ -n "$saved_pfc" ]]; then
      # shellcheck disable=SC2086
      run dcb pfc set dev "$NETDEV" $saved_pfc
    fi
    prio=$(parse_dscp_prio "$ROCE_DSCP" <"$DIR/dcb-app.txt")
    if [[ -n "$prio" ]]; then
      run dcb app replace dev "$NETDEV" dscp-prio "$ROCE_DSCP:$prio"
    else
      run dcb app del dev "$NETDEV" dscp-prio "$ROCE_DSCP:$ROCE_PRIO" || true
    fi
    ;;
  *) echo "No QoS tool was present when the state was saved; nothing to restore on the QoS side." ;;
esac

while read -r side p v; do
  f=/sys/class/net/$NETDEV/ecn/$side/enable/$p
  [[ -w $f ]] && { echo "+ echo $v > $f"; echo "$v" >"$f"; }
done <"$DIR/ecn.txt"

mv "$DIR" "$DIR.restored.$(date -u +%Y%m%dT%H%M%SZ)"
echo "Done. The saved state was kept as $DIR.restored.* for reference."
