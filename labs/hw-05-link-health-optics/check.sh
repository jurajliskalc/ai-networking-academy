#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-05-link-health-optics: verify the A<->B link is up, consistent and error-free under load.
# Run on host A (it reaches host B over SSH):  ../hw-toolkit/aina-hw check hw-05-link-health-optics
# Read-only: it changes no settings. Uses TCP port 18605 for the perftest handshake.
set -uo pipefail
. "$(dirname "$0")/../hw-toolkit/lib.sh"
aina_load_env
DURATION=${AINA_LOAD_SECONDS:-20}

# Physical-layer error counters (mlx5 ethtool names, generic RDMA sysfs names). Missing ones are ignored.
ERR_RE='crc_errors_phy|symbol_err_phy|link_down_events_phy|symbol_error|link_downed|port_rcv_errors|link_error_recovery'
INFO_RE='corrected_bits_phy'

# snapshot ROLE : "name value" lines for every error/info counter on that host's netdev and RDMA port.
snapshot() {
  local r=$1 nd dev
  nd=$(netdev_of "$r"); dev=$(rdma_of "$r")
  on_host_sh "$r" "ethtool -S $nd 2>/dev/null | awk -F': *' '{gsub(/^ +/, \"\", \$1); print \$1, \$2}' | grep -E '$ERR_RE|$INFO_RE'
    for f in symbol_error link_downed link_error_recovery port_rcv_errors; do
      v=\$(cat /sys/class/infiniband/$dev/ports/$RDMA_PORT/counters/\$f 2>/dev/null) && echo ib_\$f \$v
    done"
}

need_cmd ethtool ib_write_bw || aina_finish
check_ssh B || aina_finish

LL=$(port_attr A link_layer)
declare -A RATE
for r in A B; do
  state=$(port_attr "$r" phys_state); RATE[$r]=$(port_attr "$r" rate)
  if [[ "$state" == *LinkUp* ]]; then pass "host $r: $(rdma_of "$r")/$RDMA_PORT physical link is up (${RATE[$r]})"
  else fail "host $r: $(rdma_of "$r")/$RDMA_PORT physical state is '${state:-unknown}'"; fi
done
if [[ -n "${RATE[A]}" && "${RATE[A]}" == "${RATE[B]}" ]]; then pass "both ends report the same rate (${RATE[A]})"
elif [[ "$SWITCH_OS" != none ]]; then warn "rates differ: A '${RATE[A]}', B '${RATE[B]}' (two separate links through the switch; fine only if the hosts are meant to run at different speeds)"
else fail "rates differ: A '${RATE[A]}', B '${RATE[B]}' (cable, optic or a forced speed on one side)"; fi

if [[ "$LL" == Ethernet ]]; then
  for r in A B; do
    nd=$(netdev_of "$r")
    fec=$(on_host_sh "$r" "ethtool --show-fec $nd 2>/dev/null | awk -F': *' '/Active FEC encoding/ {print \$2}'")
    if [[ -n "$fec" ]]; then pass "host $r: active FEC on $nd is '$fec'"; else warn "host $r: could not read the active FEC mode of $nd"; fi
    # ethtool -m needs root on current kernels (non-root: "netlink error: Operation not permitted"), and its
    # lines start with a tab. sudo -n never prompts; without passwordless sudo the check says so.
    mod=$(on_host_sh "$r" "{ ethtool -m $nd 2>/dev/null || sudo -n ethtool -m $nd 2>/dev/null; } | awk -F': *' '/^[[:space:]]*Identifier[[:space:]]/ {print \$2; exit}'")
    if [[ -n "$mod" ]]; then pass "host $r: module information readable ($mod)"
    elif on_host_sh "$r" "ethtool -m $nd 2>&1 | grep -q 'Operation not permitted'" && ! on_host_sh "$r" "sudo -n true 2>/dev/null"; then
      skip "host $r: reading the module EEPROM of $nd needs root (run: sudo ethtool -m $nd)"
    else skip "host $r: no module EEPROM for $nd (not exposed by the driver or module)"; fi
  done
  fa=$(on_host_sh A "ethtool --show-fec $A_NETDEV 2>/dev/null | awk -F': *' '/Active FEC encoding/ {print \$2}'")
  fb=$(on_host_sh B "ethtool --show-fec $B_NETDEV 2>/dev/null | awk -F': *' '/Active FEC encoding/ {print \$2}'")
  [[ -n "$fa" && -n "$fb" && "$fa" != "$fb" ]] && warn "active FEC differs (A '$fa', B '$fb'): fine only if a switch sits in between"
else
  skip "FEC and module checks via ethtool apply to Ethernet ports (link layer is '$LL')"
fi

# Load test with counter deltas on both hosts.
XA=(); XB=()
if [[ "$LL" == Ethernet ]]; then XA=(-x "$(roce_gid A)"); XB=(-x "$(roce_gid B)"); fi
declare -A BEFORE AFTER
for r in A B; do BEFORE[$r]=$(snapshot "$r"); done
log=$(mktemp); out=$(mktemp)
start_server B "$log" timeout $((DURATION + 30)) ib_write_bw -d "$B_RDMA_DEV" -i "$RDMA_PORT" "${XB[@]}" -q 4 -D "$DURATION" -F --report_gbits -p 18605
if timeout $((DURATION + 30)) ib_write_bw -d "$A_RDMA_DEV" -i "$RDMA_PORT" "${XA[@]}" -q 4 -D "$DURATION" -F --report_gbits -p 18605 "$B_IP" >"$out" 2>&1; then
  stop_server
  pass "${DURATION}s ib_write_bw load A -> B completed ($(bw_average "$out") Gb/s average)"
else
  kill_server
  fail "ib_write_bw A -> B failed: $(tail -3 "$out" | tr '\n' ' ' | cut -c1-200)"
fi
rm -f "$log" "$out"
for r in A B; do AFTER[$r]=$(snapshot "$r"); done

for r in A B; do
  if [[ -z "${BEFORE[$r]}" ]]; then skip "host $r: no physical-layer error counters exposed"; continue; fi
  deltas=$(join <(sort <<<"${BEFORE[$r]}") <(sort <<<"${AFTER[$r]}") | awk '$3 - $2 != 0 {print $1 "+" ($3 - $2)}')
  errs=$(grep -Ev "$INFO_RE" <<<"$deltas" | tr '\n' ' ')
  corr=$(grep -E "$INFO_RE" <<<"$deltas" | tr '\n' ' ')
  if [[ -z "${errs// /}" ]]; then pass "host $r: no physical-layer error counter moved during the load"
  else warn "host $r: error counters rose during the load: $errs(clean and reseat, then retest: Task 7)"; fi
  [[ -n "${corr// /}" ]] && info "host $r: FEC corrected bits during the load: $corr(normal at low rates; compare with healthy links)"
done

aina_finish
