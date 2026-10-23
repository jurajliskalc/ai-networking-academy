#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-04-break-fix-roce: verify the incident is closed: fault diagnosed, restored, and host B healthy.
# Run on host A:  ../hw-toolkit/aina-hw check hw-04-break-fix-roce
# Read-only. Uses TCP port 18603 for the ping-pong handshake.
set -uo pipefail
. "$(dirname "$0")/../hw-toolkit/lib.sh"
aina_load_env
STATE=${AINA_STATE:-/var/lib/aina/state}/hw-04-break-fix-roce

need_cmd ibv_rc_pingpong rdma || aina_finish
check_ssh B || aina_finish
need_cmd_on B ibv_rc_pingpong || aina_finish

status=$(on_host_sh B "cat $STATE/status 2>/dev/null")
diag=$(on_host_sh B "cut -d' ' -f1,4 $STATE/diagnosed 2>/dev/null")
case "$status" in
  "") fail "no incident on host B yet: run 'sudo ./inject.sh --random' there first" ;;
  injected) fail "the fault on host B is still active: fix it, then run 'sudo ./inject.sh --restore' on host B" ;;
  restored) pass "the injected fault on host B was restored" ;;
  *) fail "unexpected incident status '$status' on host B" ;;
esac
if [[ "$diag" == correct* ]]; then pass "root cause diagnosed correctly (${diag#correct })"
else fail "no correct diagnosis recorded yet: on host B run 'sudo ./inject.sh --answer <fault-id>'"; fi

state=$(port_attr B state)
[[ "$state" == *ACTIVE* ]] && pass "host B: $B_RDMA_DEV/$RDMA_PORT is ACTIVE" || fail "host B: $B_RDMA_DEV/$RDMA_PORT state is '${state:-missing}'"
oper=$(on_host_sh B "cat /sys/class/net/$B_NETDEV/operstate 2>/dev/null")
[[ "$oper" == up ]] && pass "host B: $B_NETDEV is up" || fail "host B: $B_NETDEV operstate '${oper:-missing}'"

mtu_a=$(cat "/sys/class/net/$A_NETDEV/mtu" 2>/dev/null); mtu_b=$(on_host_sh B "cat /sys/class/net/$B_NETDEV/mtu 2>/dev/null")
[[ -n "$mtu_a" && "$mtu_a" == "$mtu_b" ]] && pass "MTU matches on both hosts ($mtu_a)" || fail "MTU differs: A $mtu_a, B ${mtu_b:-?}"

if on_host_sh B "ip -o -4 addr show dev $B_NETDEV" | grep -q " $B_IP/"; then pass "host B: $B_IP is configured on $B_NETDEV"
else fail "host B: $B_IP is missing from $B_NETDEV"; fi

GB=$(roce_gid B); GA=$(roce_gid A)
t=$(port_attr B "gid_attrs/types/$GB"); v=$(port_attr B "gids/$GB")
if [[ "$t" == *v2* && "$v" == 0000:0000:0000:0000:0000:ffff:* ]]; then pass "host B: RoCE v2 IPv4 GID at index $GB"
else fail "host B: no RoCE v2 IPv4 GID (index $GB is '$t' $v)"; fi

if [[ "$mtu_a" =~ ^[0-9]+$ ]] && ping -M "do" -s $((mtu_a - 28)) -c 2 -W 2 "$B_IP" >/dev/null 2>&1; then pass "full-size don't-fragment ping to $B_IP works"
else fail "full-size don't-fragment ping to $B_IP fails"; fi

log=$(mktemp)
start_server B "$log" timeout 25 ibv_rc_pingpong -d "$B_RDMA_DEV" -i "$RDMA_PORT" -g "$GB" -p 18603 -n 100
if timeout 25 ibv_rc_pingpong -d "$A_RDMA_DEV" -i "$RDMA_PORT" -g "$GA" -p 18603 -n 100 "$B_IP" >/dev/null 2>&1; then
  pass "ibv_rc_pingpong A -> B works again"; stop_server
else
  fail "ibv_rc_pingpong A -> B fails: $(tr '\n' ' ' <"$log" | cut -c1-160)"; kill_server
fi
rm -f "$log"

if command -v mlnx_qos >/dev/null 2>&1 || on_host B command -v mlnx_qos >/dev/null 2>&1; then
  qa=$(mlnx_qos -i "$A_NETDEV" 2>/dev/null | awk -F: 'tolower($0) ~ /trust state/ {gsub(/[ \t]/,"",$2); print $2}')
  qb=$(on_host_sh B "mlnx_qos -i $B_NETDEV 2>/dev/null" | awk -F: 'tolower($0) ~ /trust state/ {gsub(/[ \t]/,"",$2); print $2}')
  if [[ -n "$qa" && -n "$qb" ]]; then
    [[ "$qa" == "$qb" ]] && pass "trust mode matches on both hosts ($qa)" || fail "trust mode differs: A $qa, B $qb"
  fi
fi

aina_finish
