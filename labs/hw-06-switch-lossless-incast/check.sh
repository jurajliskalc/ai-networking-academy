#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-06-switch-lossless-incast: prove the switched fabric is lossless for RoCE under 2 -> 1 incast.
# Run on host A:  ../hw-toolkit/aina-hw check hw-06-switch-lossless-incast
# Read-only. Runs a 10-second incast (A and C into B) on TCP ports 18610 and 18611.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../hw-toolkit/lib.sh"
aina_load_env
. "$HERE/incast-lib.sh"

[[ "$HOST_COUNT" == 3 ]] && pass "profile has three hosts" || { fail "HOST_COUNT is $HOST_COUNT; this lab needs 3 (set it on the Connect page)"; aina_finish; }
[[ "$SWITCH_OS" != none ]] && pass "profile has a switch ($SWITCH, $SWITCH_OS)" || warn "SWITCH_OS is 'none' in the profile; this lab needs a switch between the hosts"
need_cmd ib_write_bw ethtool || aina_finish
check_ssh B C || aina_finish
need_cmd_on B ib_write_bw ethtool || aina_finish
need_cmd_on C ib_write_bw || aina_finish

for r in A B C; do
  s=$(port_attr $r state)
  [[ "$s" == *ACTIVE* ]] && pass "host $r: $(rdma_of $r)/$RDMA_PORT is ACTIVE" || fail "host $r: port state '${s:-missing}'"
done

run_incast 10
P=$ROCE_PRIO
if [[ $INCAST_OK -eq 1 ]]; then pass "both senders completed the 10 s incast"; else fail "a sender failed during the incast: ${INCAST_ERR:-}"; fi
info "bandwidth into B: A ${INCAST_BW_A:-?} Gb/s + C ${INCAST_BW_C:-?} Gb/s"

ecn=0; pfc=0
for k in B:np_ecn_marked_roce_packets B:np_cnp_sent A:rp_cnp_handled C:rp_cnp_handled; do
  v=${DELTA[$k]:-}; [[ -n "$v" ]] && info "$k +$v"; [[ -n "$v" && $v -gt 0 ]] && ecn=1
done
for k in A:rx_prio${P}_pause C:rx_prio${P}_pause B:tx_prio${P}_pause; do
  v=${DELTA[$k]:-}; [[ -n "$v" ]] && info "$k +$v"; [[ -n "$v" && $v -gt 0 ]] && pfc=1
done
if (( ecn || pfc )); then
  pass "congestion control is visibly active (ECN/CNP: $([[ $ecn -eq 1 ]] && echo yes || echo no), PFC pauses on priority $P: $([[ $pfc -eq 1 ]] && echo yes || echo no))"
else
  fail "no ECN marks, CNPs or PFC pauses during incast: the switch is not treating priority $P as a lossless, ECN-marked class (or traffic is not in it)"
fi

ooo=${DELTA[B:out_of_sequence]:-}; pse=${DELTA[B:packet_seq_err]:-}
if [[ -z "$ooo$pse" ]]; then
  skip "sequence-error counters not exposed by this driver"
elif (( ${ooo:-0} + ${pse:-0} == 0 )); then
  pass "no sequence errors at host B: no RoCE packets were dropped"
else
  fail "host B counted $(( ${ooo:-0} + ${pse:-0} )) sequence errors: packets were dropped on the path (fabric is not lossless)"
fi

aina_finish
