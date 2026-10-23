#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-01-inventory-baseline: verify both hosts are inventoried and look sane.
# Run on host A (it reaches host B over SSH):  ../hw-toolkit/aina-hw check hw-01-inventory-baseline
# One task only (resume):                      ../hw-toolkit/aina-hw check hw-01-inventory-baseline --task 4
# Read-only: it changes no settings.
set -uo pipefail
. "$(dirname "$0")/../hw-toolkit/lib.sh"
aina_load_env
aina_tasks 2 3 4 7 8

need_cmd rdma ibv_devinfo ethtool python3 || aina_finish
check_ssh B || aina_finish

# Hosts whose lab port exists; the later tasks only look at these.
HOSTS=()
for r in A B; do
  if [[ -n "$(port_attr "$r" state)" ]]; then HOSTS+=("$r")
  else fail "host $r: no RDMA device $(rdma_of "$r") port $RDMA_PORT (check ${r}_RDMA_DEV and RDMA_PORT in lab.env)"; fi
done

if task 2 "Port state, link layer and rate"; then
  for r in "${HOSTS[@]}"; do
    dev=$(rdma_of "$r"); state=$(port_attr "$r" state)
    if [[ "$state" == *ACTIVE* ]]; then pass "host $r: $dev/$RDMA_PORT is ACTIVE ($(port_attr "$r" link_layer), $(port_attr "$r" rate))"
    else fail "host $r: $dev/$RDMA_PORT state is '$state'"; fi
  done
fi

if task 3 "NIC model and firmware"; then
  declare -A FW TYPE
  for r in "${HOSTS[@]}"; do
    dev=$(rdma_of "$r")
    FW[$r]=$(on_host_sh "$r" "cat /sys/class/infiniband/$dev/fw_ver 2>/dev/null")
    TYPE[$r]=$(on_host_sh "$r" "cat /sys/class/infiniband/$dev/hca_type /sys/class/infiniband/$dev/board_id 2>/dev/null | head -1")
    info "host $r: $dev type '${TYPE[$r]:-unknown}' firmware '${FW[$r]:-unknown}'"
  done
  if [[ -n "${FW[A]:-}" && -n "${FW[B]:-}" ]]; then
    if [[ "${TYPE[A]:-}" != "${TYPE[B]:-}" ]]; then
      info "hosts have different NIC models ('${TYPE[A]:-?}' vs '${TYPE[B]:-?}'); firmware comparison skipped"
    elif [[ "${FW[A]}" == "${FW[B]}" ]]; then
      pass "same NIC model on both hosts runs the same firmware (${FW[A]})"
    else
      warn "same NIC model, different firmware: A ${FW[A]}, B ${FW[B]}"
    fi
  else
    skip "firmware version not readable on both hosts"
  fi
fi

if task 4 "The PCIe link: capability versus reality"; then
  for r in "${HOSTS[@]}"; do
    dev=$(rdma_of "$r")
    # PCIe: negotiated speed/width against the device's maximum.
    read -r cs cw ms mw < <(on_host_sh "$r" "d=/sys/class/infiniband/$dev/device
      echo \$(cut -d' ' -f1 \$d/current_link_speed 2>/dev/null) \$(cat \$d/current_link_width 2>/dev/null) \$(cut -d' ' -f1 \$d/max_link_speed 2>/dev/null) \$(cat \$d/max_link_width 2>/dev/null)")
    if [[ -z "${mw:-}" ]]; then
      skip "host $r: PCIe link attributes not readable for $dev"
    elif [[ "$cs" == "$ms" && "$cw" == "$mw" ]]; then
      pass "host $r: PCIe link at maximum ($cs GT/s x$cw)"
    else
      warn "host $r: PCIe link downgraded: $cs GT/s x$cw, device supports $ms GT/s x$mw (slot, riser or BIOS bifurcation?)"
    fi
  done
fi

if task 7 "Software stack, limits and CPU policy"; then
  for r in A B; do
    ml=$(on_host_sh "$r" "ulimit -l")
    if [[ "$ml" == unlimited ]]; then pass "host $r: memlock unlimited"
    else warn "host $r: memlock limit is ${ml:-unknown} KiB (large registrations may fail; setup-rdma-host.sh --set-memlock)"; fi
  done
fi

if task 8 "Collect everything automatically and run the health review"; then
  REPORT=${AINA_RESULTS:-$AINA_TOOLKIT/results}/aina-report.json
  if [[ ! -f "$REPORT" ]]; then
    fail "no inventory report at $REPORT: run ./hw-toolkit/aina-hw collect-all on host A (Task 8)"
  elif [[ -z "$(find "$REPORT" -mtime -7 2>/dev/null)" ]]; then
    fail "inventory report $REPORT is older than 7 days: rerun ./hw-toolkit/aina-hw collect-all"
  else
    n=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1])).get("hosts", [])))' "$REPORT" 2>/dev/null || echo 0)
    if (( n >= 2 )); then pass "inventory report is recent and covers $n hosts"
    elif (( n == 1 )); then warn "inventory report covers only 1 host: use collect-all, not collect"; pass "inventory report is recent"
    else fail "inventory report $REPORT is not a valid aina-hw report"; fi
  fi
fi

aina_finish
