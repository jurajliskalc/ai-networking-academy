#!/usr/bin/env bash
# hw-03-host-qos-pfc-ecn: verify host-side lossless QoS on host A and host B.
# Run on host A:  ../hw-toolkit/aina-hw check hw-03-host-qos-pfc-ecn
# Read-only. Runs a 5-second ib_write_bw A -> B with --tclass=$TCLASS on TCP port 18602.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../hw-toolkit/lib.sh"
aina_load_env
. "$HERE/qos-lib.sh"

need_cmd ib_write_bw ethtool || aina_finish
check_ssh B || aina_finish
info "expecting PFC on priority $ROCE_PRIO only, DSCP $ROCE_DSCP -> priority $ROCE_PRIO, traffic class $TCLASS"

for r in A B; do
  nd=$(netdev_of $r)
  tool=$(qos_tool $r)
  if [[ -z "$tool" ]]; then fail "host $r: neither mlnx_qos nor dcb installed, cannot read QoS"; continue; fi
  raw=$(qos_raw $r "$nd")
  if [[ "$tool" == mlnx_qos ]]; then
    trust=$(parse_trust <<<"$raw")
    if [[ "$trust" == dscp ]]; then pass "host $r: $nd trusts DSCP"
    elif [[ -n "$trust" ]]; then fail "host $r: $nd trust is '$trust', expected dscp (sudo ./apply-qos.sh on host $r)"
    else skip "host $r: trust state not readable from mlnx_qos output"; fi
  else
    info "host $r: dcb has no portable trust read-out; on mlx5 a DSCP APP entry implies DSCP trust"
  fi
  pfc=$(parse_pfc <<<"$raw")
  if [[ "$pfc" == "$ROCE_PRIO" ]]; then pass "host $r: PFC enabled on priority $ROCE_PRIO only"
  elif [[ -z "$pfc" ]]; then fail "host $r: could not read PFC state with $tool"
  else fail "host $r: PFC enabled on [$pfc], expected exactly [$ROCE_PRIO]"; fi
  prio=$(parse_dscp_prio "$ROCE_DSCP" <<<"$raw")
  if [[ "$prio" == "$ROCE_PRIO" ]]; then pass "host $r: DSCP $ROCE_DSCP maps to priority $ROCE_PRIO"
  elif [[ -n "$prio" ]]; then fail "host $r: DSCP $ROCE_DSCP maps to priority $prio, expected $ROCE_PRIO"
  else fail "host $r: no DSCP $ROCE_DSCP -> priority mapping shown by $tool"; fi
  ecn=$(ecn_state $r "$nd" "$ROCE_PRIO")
  case "$ecn" in
    absent) info "host $r: per-priority ECN switches not exposed by this driver stack (DCQCN defaults apply)" ;;
    "np=1 rp=1") pass "host $r: ECN (notification and reaction point) enabled on priority $ROCE_PRIO" ;;
    *) warn "host $r: ECN switches on priority $ROCE_PRIO are '$ecn' (expected np=1 rp=1)" ;;
  esac
done

# Traffic proof: per-priority counters must move during a test with the lab's traffic class.
k_tx=tx_prio${ROCE_PRIO}_bytes k_rx=rx_prio${ROCE_PRIO}_bytes
tx0=$(counter A "$A_NETDEV" "$k_tx"); rx0=$(counter B "$B_NETDEV" "$k_rx")
p0=$(counter B "$B_NETDEV" "tx_prio${ROCE_PRIO}_pause")
GA=$(roce_gid A); GB=$(roce_gid B)
log=$(mktemp); outf=$(mktemp)
start_server B "$log" timeout 40 ib_write_bw -d "$B_RDMA_DEV" -i "$RDMA_PORT" -x "$GB" -q 4 -D 5 -F --report_gbits --tclass="$TCLASS" -p 18602
if timeout 40 ib_write_bw -d "$A_RDMA_DEV" -i "$RDMA_PORT" -x "$GA" -q 4 -D 5 -F --report_gbits --tclass="$TCLASS" -p 18602 "$B_IP" >"$outf" 2>&1; then
  stop_server
  info "ib_write_bw --tclass=$TCLASS: $(bw_average "$outf") Gb/s average"
else
  fail "ib_write_bw --tclass=$TCLASS A -> B failed: $(tail -3 "$outf" | tr '\n' ' ' | cut -c1-200)"
  kill_server
fi
rm -f "$log" "$outf"
tx1=$(counter A "$A_NETDEV" "$k_tx"); rx1=$(counter B "$B_NETDEV" "$k_rx")
p1=$(counter B "$B_NETDEV" "tx_prio${ROCE_PRIO}_pause")
if [[ -z "$rx0" || -z "$rx1" ]]; then
  skip "this driver has no $k_rx counter in ethtool -S; check the priority counters your NIC exposes"
else
  d=$(( rx1 - rx0 ))
  if (( d > 100000000 )); then pass "host B received $((d / 1000000)) MB on priority $ROCE_PRIO during the test"
  else fail "host B counted only $d bytes on priority $ROCE_PRIO: the test traffic is not classified into the lossless priority"; fi
fi
if [[ -n "$tx0" && -n "$tx1" ]]; then
  info "host A sent $(( (tx1 - tx0) / 1000000 )) MB on priority $ROCE_PRIO"
fi
[[ -n "$p0" && -n "$p1" ]] && info "host B sent $((p1 - p0)) PFC pause frames on priority $ROCE_PRIO (zero is normal on an uncongested link)"

aina_finish
