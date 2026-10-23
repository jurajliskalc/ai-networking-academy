#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-11-ipoib: verify IPoIB between host A and host B (addresses, mode, MTU, reachability, throughput).
# Run on host A as your normal user, after ipoib.sh up on both hosts:
#   ../hw-toolkit/aina-hw check hw-11-ipoib
# Read-only. Uses TCP port 18611 for a 5-second iperf3 run if iperf3 is installed on both hosts.
set -uo pipefail
. "$(dirname "$0")/../hw-toolkit/lib.sh"
aina_load_env

need_cmd ping ip || aina_finish
check_ssh B || aina_finish

declare -A MTUS
for r in A B; do
  ifc=$(netdev_of "$r"); ipa=$(ip_of "$r")
  state=$(port_attr "$r" state)
  if [[ "$state" == *ACTIVE* ]]; then pass "host $r: InfiniBand port $(rdma_of "$r")/$RDMA_PORT is ACTIVE"
  else fail "host $r: InfiniBand port $(rdma_of "$r")/$RDMA_PORT is '${state:-missing}' (subnet manager running?)"; fi
  d=$(on_host "$r" ip -d -o link show dev "$ifc" 2>/dev/null)
  if [[ "$d" != *" ipoib "* ]]; then fail "host $r: $ifc is not an IPoIB interface (check ${r}_NETDEV)"; continue; fi
  if [[ "$d" == *LOWER_UP* ]]; then pass "host $r: $ifc is up with carrier"; else fail "host $r: $ifc is down or has no carrier (sudo ./ipoib.sh up --role $r)"; fi
  if on_host "$r" ip -o -4 addr show dev "$ifc" | grep -q " $ipa/"; then pass "host $r: $ipa is on $ifc"; else fail "host $r: $ipa is not on $ifc"; fi
  mode=$(sed -n 's/.* mode \([a-z]*\) .*/\1/p' <<<"$d")
  info "host $r: $ifc $(grep -o 'ipoib pkey [^ ]*' <<<"$d"), mode ${mode:-unknown}"
  MTUS[$r]=$(on_host "$r" cat "/sys/class/net/$ifc/mtu")
  case "${MTUS[$r]}" in
    4092) pass "host $r: $ifc MTU 4092 (datagram mode, 4096-byte IB MTU minus the 4-byte IPoIB header)" ;;
    2044) warn "host $r: $ifc MTU 2044: the IPoIB broadcast group has a 2048-byte MTU (start the SM with partitions-mtu4k.conf, Task 3)" ;;
    *) info "host $r: $ifc MTU ${MTUS[$r]}" ;;
  esac
done
if [[ -n "${MTUS[A]:-}" && "${MTUS[A]}" == "${MTUS[B]:-}" ]]; then pass "both hosts use MTU ${MTUS[A]}"
else fail "MTU differs: A=${MTUS[A]:-?} B=${MTUS[B]:-?}"; fi

if ping -c 3 -W 2 -q "$B_IP" >/dev/null 2>&1; then pass "ping $B_IP over IPoIB works"
else fail "ping $B_IP from host A fails"; fi
if [[ -n "${MTUS[A]:-}" ]] && ping -c 2 -W 2 -q -M "do" -s $(( MTUS[A] - 28 )) "$B_IP" >/dev/null 2>&1; then
  pass "a full-size $((MTUS[A]))-byte IP packet (DF set) reaches $B_IP"
else fail "full-size packets with DF set do not reach $B_IP"; fi

if command -v iperf3 >/dev/null 2>&1 && on_host B command -v iperf3 >/dev/null 2>&1; then
  log=$(mktemp); out=$(mktemp)
  start_server B "$log" timeout 30 iperf3 -s -1 -p 18611
  if timeout 30 iperf3 -c "$B_IP" -p 18611 -t 5 -P 4 -f g >"$out" 2>&1; then
    stop_server
    gbps=$(awk '/SUM.*receiver/ {print $6}' "$out")
    pass "iperf3 over IPoIB, 4 streams: ${gbps:-?} Gb/s (port rate $(port_attr A rate))"
  else
    kill_server
    warn "iperf3 to $B_IP failed: $(excerpt "$out")"
  fi
  rm -f "$log" "$out"
else
  skip "iperf3 not installed on both hosts (sudo apt-get install iperf3)"
fi

aina_finish
