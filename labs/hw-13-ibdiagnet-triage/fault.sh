#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-13-ibdiagnet-triage: inject one recoverable fault on THIS host's InfiniBand port (host B), then
# diagnose it from host A. Every fault acts on the lab IB port only, through local SMPs (ibportstate
# over the direct route 0), and --restore undoes it.
#
# Usage (as root, on host B):
#   sudo ./fault.sh slow-link     enable only FDR (14.0625 Gb/s per lane) extended speed and retrain
#   sudo ./fault.sh port-disable  disable the port (physical state Disabled; the peer sees Polling)
#   sudo ./fault.sh link-reset    retrain the link once (with the SM stopped, it comes back as INIT)
#   sudo ./fault.sh --restore     re-enable the port and all supported speeds, retrain if needed
#        ./fault.sh --status
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../hw-toolkit/lib.sh"
aina_load_env >/dev/null
ROLE=${AINA_ROLE:-B}
DEV=$(rdma_of "$ROLE")
P=/sys/class/infiniband/$DEV/ports/$RDMA_PORT
STATE=$(aina_state_dir hw-13-ibdiagnet-triage)
PS=(ibportstate -C "$DEV" -P "$RDMA_PORT" -D 0 "$RDMA_PORT")

show() { "${PS[@]}" query 2>/dev/null | grep -E '^(LinkState|PhysLinkState|LinkSpeedExtActive|LinkSpeedExtEnabled):' | sed 's/:\.\.*/: /'; }
wait_for() {   # wait_for FIELD VALUE SECONDS : wait until the port's PortInfo FIELD reads VALUE (MAD query)
  for _ in $(seq 1 "$3"); do "${PS[@]}" query 2>/dev/null | grep -q "^$1:\.*$2" && return 0; sleep 1; done; return 1
}

[[ -r $P/link_layer ]] || die "no RDMA device $DEV port $RDMA_PORT (check ${ROLE}_RDMA_DEV in lab.env)"
[[ "$(cat "$P/link_layer")" == InfiniBand ]] || die "$DEV port $RDMA_PORT is not InfiniBand; this lab never touches Ethernet/RoCE ports"
case "${1:-}" in
  --status)
    echo "recorded fault: $(cat "$STATE/fault" 2>/dev/null || echo none)"
    echo "port: $(cat "$P/state"), $(cat "$P/phys_state"), rate $(cat "$P/rate")"
    exit 0 ;;
  slow-link|port-disable|link-reset)
    need_root
    command -v ibportstate >/dev/null 2>&1 || die "ibportstate is missing (infiniband-diags)"
    mkdir -p "$STATE"
    if [[ -f "$STATE/fault" ]]; then die "fault '$(cat "$STATE/fault")' is still injected: sudo $0 --restore first"; fi
    echo "$1" >"$STATE/fault"
    case "$1" in
      slow-link)
        echo "+ ibportstate ... espeed 1   (LinkSpeedExtEnabled = 14.0625 Gbps only)"
        "${PS[@]}" espeed 1 >/dev/null || die "ibportstate espeed failed"
        echo "+ ibportstate ... reset      (retrain the link)"
        "${PS[@]}" reset >/dev/null ;;
      port-disable)
        echo "+ ibportstate ... disable"
        "${PS[@]}" disable >/dev/null || die "ibportstate disable failed" ;;
      link-reset)
        echo "+ ibportstate ... reset"
        "${PS[@]}" reset >/dev/null || die "ibportstate reset failed"
        rm -f "$STATE/fault" ;;   # nothing to undo on the port itself
    esac
    echo "Fault '$1' injected on $DEV port $RDMA_PORT. Now diagnose it from host A." ;;
  --restore)
    need_root
    f=$(cat "$STATE/fault" 2>/dev/null || echo none)
    case "$f" in
      slow-link)
        echo "+ ibportstate ... espeed 31  (31 = enable every supported extended speed)"
        "${PS[@]}" espeed 31 >/dev/null
        echo "+ ibportstate ... reset      (retrain at the best common speed)"
        "${PS[@]}" reset >/dev/null ;;
      port-disable)
        echo "+ ibportstate ... enable"
        "${PS[@]}" enable >/dev/null ;;
      *) echo "No fault recorded; nothing to undo." ;;
    esac
    rm -f "$STATE/fault"
    if [[ "$f" != none ]]; then
      wait_for PhysLinkState LinkUp 40 || echo "the link has not trained after 40 s: check both ends with ibstat"
      # With an SM running, the port goes INIT -> ACTIVE within seconds after training.
      wait_for LinkState Active 20 || echo "the port is not ACTIVE after 20 s: is a subnet manager running?"
    fi
    show
    echo "driver view (sysfs): $(cat "$P/state"), rate $(cat "$P/rate")" ;;
  *) sed -n '8,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
