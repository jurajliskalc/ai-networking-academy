#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-11-ipoib: verify IPoIB between host A and host B (addresses, mode, MTU, reachability, throughput).
# Run on host A as your normal user, after ipoib.sh up on both hosts:
#   ../hw-toolkit/aina-hw check hw-11-ipoib
# One task only (resume):  ../hw-toolkit/aina-hw check hw-11-ipoib --task 3
# Read-only. Uses TCP port 18611 for a 5-second iperf3 run if iperf3 is installed on both hosts.
set -uo pipefail
. "$(dirname "$0")/../hw-toolkit/lib.sh"
aina_load_env
aina_tasks 1 2 3 5
require 1 ipoib-if "an IPoIB interface with its address on both hosts"
require 2 ping "ping over IPoIB A -> B"
require 3 mtu4k "IPoIB MTU 4092 on both hosts (4 KiB broadcast group) and a full-size DF ping"
require 5 iperf "TCP throughput over IPoIB measured with iperf3"

need_cmd ping ip || aina_finish
check_ssh B || aina_finish

declare -A MTUS LINK
for r in A B; do
  LINK[$r]=$(on_host "$r" ip -d -o link show dev "$(netdev_of "$r")" 2>/dev/null)
  MTUS[$r]=$(on_host "$r" cat "/sys/class/net/$(netdev_of "$r")/mtu" 2>/dev/null)
done

if task 1 "An IPoIB interface up close"; then
  f0=$AINA_FAILS
  for r in A B; do
    ifc=$(netdev_of "$r"); ipa=$(ip_of "$r"); d=${LINK[$r]}
    if [[ "$d" != *" ipoib "* ]]; then fail "host $r: $ifc is not an IPoIB interface (check ${r}_NETDEV)"; continue; fi
    if [[ "$d" == *LOWER_UP* ]]; then pass "host $r: $ifc is up with carrier"; else fail "host $r: $ifc is down or has no carrier (sudo ./ipoib.sh up --role $r)"; fi
    if on_host "$r" ip -o -4 addr show dev "$ifc" | grep -q " $ipa/"; then pass "host $r: $ipa is on $ifc"; else fail "host $r: $ipa is not on $ifc"; fi
    mode=$(sed -n 's/.* mode \([a-z]*\) .*/\1/p' <<<"$d")
    info "host $r: $ifc $(grep -o 'ipoib pkey [^ ]*' <<<"$d"), mode ${mode:-unknown}"
  done
  (( AINA_FAILS == f0 )) && met ipoib-if
fi

if task 2 "Bring it up with a subnet manager's defaults"; then
  for r in A B; do
    state=$(port_attr "$r" state)
    if [[ "$state" == *ACTIVE* ]]; then pass "host $r: InfiniBand port $(rdma_of "$r")/$RDMA_PORT is ACTIVE"
    else fail "host $r: InfiniBand port $(rdma_of "$r")/$RDMA_PORT is '${state:-missing}' (subnet manager running?)"; fi
  done
  if ping -c 3 -W 2 -q "$B_IP" >/dev/null 2>&1; then pass_met ping "ping $B_IP over IPoIB works"
  else fail "ping $B_IP from host A fails"; fi
fi

if task 3 "A 4 KiB broadcast group, and the MTU follows"; then
  big=0
  for r in A B; do
    case "${MTUS[$r]:-}" in
      4092) pass "host $r: $(netdev_of "$r") MTU 4092 (datagram mode, 4096-byte IB MTU minus the 4-byte IPoIB header)"; big=$((big + 1)) ;;
      2044) warn "host $r: $(netdev_of "$r") MTU 2044: the IPoIB broadcast group has a 2048-byte MTU (start the SM with partitions-mtu4k.conf, Task 3)" ;;
      *) info "host $r: $(netdev_of "$r") MTU ${MTUS[$r]:-unknown}" ;;
    esac
  done
  if [[ -n "${MTUS[A]:-}" && "${MTUS[A]}" == "${MTUS[B]:-}" ]]; then pass "both hosts use MTU ${MTUS[A]}"
  else fail "MTU differs: A=${MTUS[A]:-?} B=${MTUS[B]:-?}"; fi
  if [[ "${MTUS[A]:-}" =~ ^[0-9]+$ ]] && ping -c 2 -W 2 -q -M "do" -s $(( MTUS[A] - 28 )) "$B_IP" >/dev/null 2>&1; then
    pass "a full-size $((MTUS[A]))-byte IP packet (DF set) reaches $B_IP"
    (( big == 2 )) && met mtu4k
  else fail "full-size packets with DF set do not reach $B_IP"; fi
fi

if task 5 "TCP over IPoIB versus RDMA on the same link"; then
  if command -v iperf3 >/dev/null 2>&1 && on_host B command -v iperf3 >/dev/null 2>&1; then
    log=$(mktemp); out=$(mktemp)
    start_server B "$log" timeout 30 iperf3 -s -1 -p 18611
    if timeout 30 iperf3 -c "$B_IP" -p 18611 -t 5 -P 4 -f g >"$out" 2>&1; then
      stop_server
      gbps=$(awk '/SUM.*receiver/ {print $6}' "$out")
      pass_met iperf "iperf3 over IPoIB, 4 streams: ${gbps:-?} Gb/s (port rate $(port_attr A rate))"
    else
      kill_server
      warn "iperf3 to $B_IP failed: $(excerpt "$out")"
    fi
    rm -f "$log" "$out"
  else
    skip "iperf3 not installed on both hosts (sudo apt-get install iperf3)"
  fi
fi

aina_finish
