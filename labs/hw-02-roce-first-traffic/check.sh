#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-02-roce-first-traffic: verify RoCEv2 works between host A and host B.
# Run on host A (it reaches host B over SSH):  ../hw-toolkit/aina-hw check hw-02-roce-first-traffic
# Read-only: it changes no settings. Uses TCP ports 18600 and 18601 for the test handshakes.
set -uo pipefail
. "$(dirname "$0")/../hw-toolkit/lib.sh"
aina_load_env
MIN_PCT=${AINA_MIN_BW_PCT:-60}

need_cmd rdma ibv_devinfo ibv_rc_pingpong ib_write_bw ping || aina_finish
check_ssh B || aina_finish
on_host B command -v ib_write_bw >/dev/null 2>&1 && pass "perftest installed on host B" || fail "perftest missing on host B"

for r in A B; do
  dev=$(rdma_of $r)
  state=$(port_attr $r state); ll=$(port_attr $r link_layer)
  if [[ -z "$state" ]]; then fail "host $r: no RDMA device $dev port $RDMA_PORT (check ${r}_RDMA_DEV in lab.env)"; continue; fi
  [[ "$state" == *ACTIVE* ]] && pass "host $r: $dev/$RDMA_PORT is ACTIVE" || fail "host $r: $dev/$RDMA_PORT state is '$state'"
  [[ "$ll" == Ethernet ]] && pass "host $r: link layer Ethernet (RoCE)" || fail "host $r: link layer '$ll' (this lab needs RoCE; InfiniBand has its own lab)"
done

mtu_a=$(cat "/sys/class/net/$A_NETDEV/mtu" 2>/dev/null || echo "?")
mtu_b=$(on_host_sh B "cat /sys/class/net/$B_NETDEV/mtu 2>/dev/null" || echo "?")
if [[ "$mtu_a" == "$mtu_b" && "$mtu_a" != "?" ]]; then pass "netdev MTU matches on both hosts ($mtu_a)"; else fail "netdev MTU differs: A $A_NETDEV=$mtu_a, B $B_NETDEV=$mtu_b"; fi
[[ "$mtu_a" == "$MTU" ]] || warn "netdev MTU $mtu_a differs from the profile's MTU=$MTU"

if [[ "$mtu_a" =~ ^[0-9]+$ ]] && ping -M do -s $((mtu_a - 28)) -c 3 -W 2 "$B_IP" >/dev/null 2>&1; then
  pass "don't-fragment ping of $((mtu_a - 28)) bytes reaches $B_IP"
else
  fail "full-size don't-fragment ping to $B_IP failed (IP path or MTU problem: see Task 1)"
fi

GA=$(roce_gid A); GB=$(roce_gid B)
for r in A B; do
  g=$GA; [[ $r == B ]] && g=$GB
  t=$(port_attr $r "gid_attrs/types/$g")
  v=$(port_attr $r "gids/$g")
  if [[ "$t" == *v2* && "$v" == 0000:0000:0000:0000:0000:ffff:* ]]; then
    pass "host $r: RoCE v2 IPv4 GID at index $g"
  else
    fail "host $r: index $g is not a RoCE v2 IPv4 GID ('$t' $v); is $(ip_of $r) configured on $(netdev_of $r)?"
  fi
done
[[ "$GA" == "$GID_INDEX" && "$GB" == "$GID_INDEX" ]] || info "GID indexes A=$GA B=$GB (profile GID_INDEX=$GID_INDEX); the check uses the detected ones"

amtu=$(ibv_devinfo -d "$A_RDMA_DEV" -i "$RDMA_PORT" 2>/dev/null | awk '/active_mtu/ {print $2; exit}')
if [[ "$amtu" == 4096 ]]; then pass "active RDMA MTU 4096 on host A"; else warn "active RDMA MTU on host A is ${amtu:-unknown} (4096 needs a netdev MTU of about 4200 or more)"; fi

# Functional test 1: RC ping-pong.
log=$(mktemp)
start_server B "$log" timeout 25 ibv_rc_pingpong -d "$B_RDMA_DEV" -i "$RDMA_PORT" -g "$GB" -p 18600 -n 100
if timeout 25 ibv_rc_pingpong -d "$A_RDMA_DEV" -i "$RDMA_PORT" -g "$GA" -p 18600 -n 100 "$B_IP" >/dev/null 2>&1; then
  pass "ibv_rc_pingpong: 100 iterations A -> B"
  stop_server
else
  fail "ibv_rc_pingpong A -> B failed (firewall on TCP 18600? GID? server said: $(excerpt "$log"))"
  kill_server
fi
rm -f "$log"

# Functional test 2: perftest bandwidth, 4 QPs for 5 seconds; receiver sequence errors must not move.
ooo0=$(hw_counter B out_of_sequence); pse0=$(hw_counter B packet_seq_err)
log=$(mktemp); out=$(mktemp)
start_server B "$log" timeout 40 ib_write_bw -d "$B_RDMA_DEV" -i "$RDMA_PORT" -x "$GB" -q 4 -D 5 -F --report_gbits -p 18601
if timeout 40 ib_write_bw -d "$A_RDMA_DEV" -i "$RDMA_PORT" -x "$GA" -q 4 -D 5 -F --report_gbits -p 18601 "$B_IP" >"$out" 2>&1; then
  stop_server
  bw=$(bw_average "$out")
  rate=$(port_attr A rate | awk '{print $1}')
  if [[ -n "$bw" && -n "$rate" ]]; then
    pct=$(awk -v b="$bw" -v r="$rate" 'BEGIN {printf "%d", 100 * b / r}')
    if (( pct >= MIN_PCT )); then pass "ib_write_bw: $bw Gb/s average = $pct% of the $rate Gb/s port rate"
    else warn "ib_write_bw: $bw Gb/s is only $pct% of the $rate Gb/s port rate (check PCIe width/speed, NUMA, CPU governor)"; fi
  else
    pass "ib_write_bw completed"
  fi
else
  fail "ib_write_bw A -> B failed: $(tail -3 "$out" | tr '\n' ' ' | cut -c1-200)"
  kill_server
fi
rm -f "$log" "$out"
ooo1=$(hw_counter B out_of_sequence); pse1=$(hw_counter B packet_seq_err)
if [[ -n "$ooo0" && -n "$ooo1" ]]; then
  d=$(( ooo1 - ooo0 + ${pse1:-0} - ${pse0:-0} ))
  if (( d == 0 )); then pass "no sequence errors on host B during the test"; else warn "host B counted $d sequence errors during the test: packets were lost on the path"; fi
else
  skip "sequence-error counters not exposed by this driver"
fi

aina_finish
