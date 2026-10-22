# shellcheck shell=bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-06-switch-lossless-incast: 2 -> 1 incast (A and C send RDMA WRITEs to B at the same time).
# Source after ../hw-toolkit/lib.sh and aina_load_env, then: run_incast SECONDS
# Results: INCAST_BW_A, INCAST_BW_C (Gb/s), INCAST_OK (1 if both senders completed), and the
# counter deltas in the associative array DELTA (keys "B:np_cnp_sent", "A:rx_prio3_pause", ...).

declare -A DELTA=()
INCAST_BW_A="" INCAST_BW_C="" INCAST_OK=0

# Counter set: RDMA hw_counters (mlx5 names) and per-priority ethtool counters. Missing ones read as empty.
_incast_snapshot() {
  local tag=$1 r k p=$ROCE_PRIO
  for k in np_ecn_marked_roce_packets np_cnp_sent out_of_sequence packet_seq_err; do
    SNAP["$tag:B:$k"]=$(hw_counter B "$k")
  done
  for r in A C; do
    SNAP["$tag:$r:rp_cnp_handled"]=$(hw_counter "$r" rp_cnp_handled)
    SNAP["$tag:$r:rx_prio${p}_pause"]=$(counter "$r" "$(netdev_of "$r")" "rx_prio${p}_pause")
  done
  SNAP["$tag:B:tx_prio${p}_pause"]=$(counter B "$B_NETDEV" "tx_prio${p}_pause")
}

run_incast() {
  local secs=${1:-10} ga gb gc logb1 logb2 outa outc pid_b1 pid_b2 pid_c key
  declare -gA SNAP=()
  DELTA=()
  ga=$(roce_gid A); gb=$(roce_gid B); gc=$(roce_gid C)
  logb1=$(mktemp); logb2=$(mktemp); outa=$(mktemp); outc=$(mktemp)
  _incast_snapshot before
  # Two servers on B (one per sender), each on its own TCP port.
  ssh -n -o BatchMode=yes -o ConnectTimeout=8 "$(_ssh_target B)" -- \
    "$(printf '%q ' timeout $((secs + 30)) ib_write_bw -d "$B_RDMA_DEV" -i "$RDMA_PORT" -x "$gb" -q 4 -D "$secs" -F --report_gbits --tclass="$TCLASS" -p 18610)" >"$logb1" 2>&1 &
  pid_b1=$!
  ssh -n -o BatchMode=yes -o ConnectTimeout=8 "$(_ssh_target B)" -- \
    "$(printf '%q ' timeout $((secs + 30)) ib_write_bw -d "$B_RDMA_DEV" -i "$RDMA_PORT" -x "$gb" -q 4 -D "$secs" -F --report_gbits --tclass="$TCLASS" -p 18611)" >"$logb2" 2>&1 &
  pid_b2=$!
  sleep 2
  # Sender C (remote) and sender A (local) start together.
  ssh -n -o BatchMode=yes -o ConnectTimeout=8 "$(_ssh_target C)" -- \
    "$(printf '%q ' timeout $((secs + 30)) ib_write_bw -d "$C_RDMA_DEV" -i "$RDMA_PORT" -x "$gc" -q 4 -D "$secs" -F --report_gbits --tclass="$TCLASS" -p 18611 "$B_IP")" >"$outc" 2>&1 &
  pid_c=$!
  INCAST_OK=1
  timeout $((secs + 30)) ib_write_bw -d "$A_RDMA_DEV" -i "$RDMA_PORT" -x "$ga" -q 4 -D "$secs" -F --report_gbits --tclass="$TCLASS" -p 18610 "$B_IP" >"$outa" 2>&1 || INCAST_OK=0
  wait "$pid_c" || INCAST_OK=0
  wait "$pid_b1" 2>/dev/null; wait "$pid_b2" 2>/dev/null
  INCAST_BW_A=$(bw_average "$outa"); INCAST_BW_C=$(bw_average "$outc")
  if [[ $INCAST_OK -eq 0 ]]; then
    # shellcheck disable=SC2034  # read by incast.sh and check.sh
    INCAST_ERR="A: $(tail -2 "$outa" | tr '\n' ' ' | cut -c1-120) C: $(tail -2 "$outc" | tr '\n' ' ' | cut -c1-120)"
  fi
  _incast_snapshot after
  for key in "${!SNAP[@]}"; do
    [[ $key == before:* ]] || continue
    key=${key#before:}
    if [[ -n "${SNAP[before:$key]}" && -n "${SNAP[after:$key]:-}" ]]; then
      DELTA[$key]=$(( ${SNAP[after:$key]} - ${SNAP[before:$key]} ))
    fi
  done
  rm -f "$logb1" "$logb2" "$outa" "$outc"
}

print_incast() {
  local key
  printf '%-34s %s\n' "counter (host:name)" "delta"
  for key in $(printf '%s\n' "${!DELTA[@]}" | sort); do printf '%-34s %s\n' "$key" "${DELTA[$key]}"; done
  printf '%-34s %s\n' "A -> B bandwidth (Gb/s)" "${INCAST_BW_A:-?}"
  printf '%-34s %s\n' "C -> B bandwidth (Gb/s)" "${INCAST_BW_C:-?}"
}
