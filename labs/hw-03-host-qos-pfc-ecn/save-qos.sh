#!/usr/bin/env bash
# hw-03-host-qos-pfc-ecn: save this host's current QoS state so restore-qos.sh can put it back.
# Usage: sudo ./save-qos.sh [--force] [A|B|C]   (role auto-detected from the data IPs in lab.env)
# Saves to /var/lib/aina/state/hw-03-host-qos-pfc-ecn/<role>/. Refuses to overwrite unless --force.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../hw-toolkit/lib.sh"
aina_load_env >/dev/null
. "$HERE/qos-lib.sh"
need_root

FORCE=0 ROLE=""
for a in "$@"; do case "$a" in --force) FORCE=1 ;; A|B|C) ROLE=$a ;; *) die "unknown argument $a" ;; esac; done
[[ -n "$ROLE" ]] || ROLE=$(local_role) || die "cannot tell which host this is: none of A_IP/B_IP/C_IP is configured here (pass A, B or C)"
NETDEV=$(netdev_of "$ROLE")
[[ -d /sys/class/net/$NETDEV ]] || die "netdev $NETDEV (${ROLE}_NETDEV) does not exist on this host"

DIR=$(aina_state_dir hw-03-host-qos-pfc-ecn)/$ROLE
if [[ -f $DIR/saved && $FORCE -eq 0 ]]; then
  echo "State already saved in $DIR on $(cat "$DIR/saved"); not overwriting (use --force)."
  exit 0
fi
mkdir -p "$DIR"
rm -f "$DIR"/*.txt
# "A" here means "this host": the lib's on_host runs role A locally.
TOOL=$(qos_tool A)
echo "$TOOL" >"$DIR/tool"
echo "$NETDEV" >"$DIR/netdev"
cat "/sys/class/net/$NETDEV/mtu" >"$DIR/mtu"
case "$TOOL" in
  mlnx_qos) mlnx_qos -i "$NETDEV" >"$DIR/mlnx_qos.txt" 2>&1 || true ;;
  dcb)
    dcb pfc show dev "$NETDEV" prio-pfc >"$DIR/dcb-pfc.txt" 2>&1 || true
    dcb app show dev "$NETDEV" dscp-prio >"$DIR/dcb-app.txt" 2>&1 || true ;;
  *) echo "WARNING: neither mlnx_qos nor dcb is installed; only MTU and ECN state are saved." ;;
esac
: >"$DIR/ecn.txt"
for side in roce_np roce_rp; do
  for p in 0 1 2 3 4 5 6 7; do
    f=/sys/class/net/$NETDEV/ecn/$side/enable/$p
    [[ -r $f ]] && echo "$side $p $(cat "$f")" >>"$DIR/ecn.txt"
  done
done
date -u +%FT%TZ >"$DIR/saved"
echo "Saved QoS state of $NETDEV (host $ROLE, tool: ${TOOL:-none}) to $DIR:"
ls -1 "$DIR" | sed 's/^/  /'
