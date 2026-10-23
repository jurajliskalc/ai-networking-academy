#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-09-infiniband-bringup: verify an InfiniBand subnet between host A and host B.
# Run on host A as your normal user (it reaches host B over SSH with your keys):
#   sudo -v && ../hw-toolkit/aina-hw check hw-09-infiniband-bringup
# sminfo needs root (MAD access); unless the check already runs as root it uses `sudo -n sminfo`.
# Read-only: it changes no settings (start the SM with start-sm.sh first). Uses TCP port 18609.
set -uo pipefail
. "$(dirname "$0")/../hw-toolkit/lib.sh"
aina_load_env

need_cmd ibstat sminfo ib_write_bw || aina_finish
check_ssh B || aina_finish
need_cmd_on B ib_write_bw ibstat || aina_finish

declare -A SMLID
for r in A B; do
  dev=$(rdma_of "$r")
  state=$(port_attr "$r" state); ll=$(port_attr "$r" link_layer)
  if [[ -z "$state" ]]; then fail "host $r: no RDMA device $dev port $RDMA_PORT (check lab.env)"; continue; fi
  if [[ "$ll" == InfiniBand ]]; then pass "host $r: $dev/$RDMA_PORT link layer InfiniBand"
  else fail "host $r: $dev/$RDMA_PORT link layer is '$ll' (VPI adapter in Ethernet mode? see Before you start)"; fi
  if [[ "$state" == *ACTIVE* ]]; then pass "host $r: port is ACTIVE"
  elif [[ "$state" == *INIT* ]]; then fail "host $r: port is INIT: no subnet manager has configured it (sudo ./start-sm.sh)"
  else fail "host $r: port state is '$state'"; fi
  lid=$(port_attr "$r" lid); SMLID[$r]=$(port_attr "$r" sm_lid)
  if [[ -n "$lid" ]] && (( lid > 0 && lid < 0xc000 )); then pass "host $r: unicast LID $((lid)) assigned"
  else fail "host $r: no valid LID (${lid:-none})"; fi
done

if [[ -n "${SMLID[A]:-}" ]] && (( SMLID[A] > 0 )) && [[ "${SMLID[A]}" == "${SMLID[B]:-}" ]]; then
  pass "both hosts see the same subnet manager (SM LID $((SMLID[A])))"
else
  fail "SM LID A='${SMLID[A]:-}' B='${SMLID[B]:-}': hosts must see the same non-zero SM LID"
fi
SMINFO=(sminfo -C "$A_RDMA_DEV" -P "$RDMA_PORT"); [[ $EUID -eq 0 ]] || SMINFO=(sudo -n "${SMINFO[@]}")
if s=$("${SMINFO[@]}" 2>/dev/null) && [[ "$s" == *MASTER* ]]; then pass "$s"
else fail "sminfo finds no master subnet manager (or could not run it as root: run 'sudo -v' first)"; fi

log=$(mktemp); out=$(mktemp)
start_server B "$log" timeout 40 ib_write_bw -d "$B_RDMA_DEV" -i "$RDMA_PORT" -D 5 -F --report_gbits -p 18609
if timeout 40 ib_write_bw -d "$A_RDMA_DEV" -i "$RDMA_PORT" -D 5 -F --report_gbits -p 18609 "$HOST_B" >"$out" 2>&1; then
  stop_server
  pass "ib_write_bw over InfiniBand A -> B: $(bw_average "$out") Gb/s average (port rate $(port_attr A rate))"
else
  kill_server
  fail "ib_write_bw A -> B failed (TCP 18609 to $HOST_B open? server said: $(excerpt "$log")) $(tail -2 "$out" | tr '\n' ' ' | cut -c1-160)"
fi
rm -f "$log" "$out"

aina_finish
