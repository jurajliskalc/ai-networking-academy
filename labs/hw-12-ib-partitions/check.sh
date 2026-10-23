#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-12-ib-partitions: verify the lab partitions in both ports' P_Key tables and that IPoIB traffic
# is allowed or denied according to membership (full-full and full-limited talk, limited-limited not).
# Run on host A as your normal user, with the SM started on the lab partitions and the child
# interfaces up on both hosts (Tasks 2-4):
#   ../hw-toolkit/aina-hw check hw-12-ib-partitions
# Read-only.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../hw-toolkit/lib.sh"
aina_load_env
. "$HERE/partitions.env"

need_cmd ping || aina_finish
check_ssh B || aina_finish

declare -A TABLE
for r in A B; do
  state=$(port_attr "$r" state)
  if [[ "$state" == *ACTIVE* ]]; then pass "host $r: $(rdma_of "$r")/$RDMA_PORT is ACTIVE"
  else fail "host $r: $(rdma_of "$r")/$RDMA_PORT is '${state:-missing}'"; fi
  TABLE[$r]=" $(on_host_sh "$r" "cat /sys/class/infiniband/$(rdma_of "$r")/ports/$RDMA_PORT/pkeys/* 2>/dev/null | grep -v '^0x0000$' | sort -u | tr '\n' ' '")"
  info "host $r P_Key table (non-empty entries):${TABLE[$r]}"
done

for p in "${PARTITIONS[@]}"; do
  IFS=: read -r pkey name ma mb octet <<<"$p"
  low=$(printf '0x%04x' $(( pkey & 0x7fff )))
  for r in A B; do
    want=$ma; [[ $r == B ]] && want=$mb
    expect=$pkey; [[ $want == limited ]] && expect=$low
    if [[ "${TABLE[$r]}" == *" $expect "* ]]; then pass "host $r: $name $expect in the P_Key table ($want member)"
    elif [[ "${TABLE[$r]}" == *" $pkey "* || "${TABLE[$r]}" == *" $low "* ]]; then fail "host $r: $name is in the table with the wrong membership (expected $want, $expect)"
    else fail "host $r: $name ($pkey) is not in the P_Key table (SM started with the lab partitions?)"; fi
  done
  child=$A_NETDEV.${pkey#0x}
  if ! ip -o link show dev "$child" >/dev/null 2>&1 || ! on_host B ip -o link show dev "$B_NETDEV.${pkey#0x}" >/dev/null 2>&1; then
    fail "$name: child interface missing on A or B (sudo ./pkey-children.sh up --role A|B)"; continue
  fi
  dst=$PKEY_NET.$octet.2
  if [[ $ma == limited && $mb == limited ]]; then
    if ping -c 2 -W 1 -q "$dst" >/dev/null 2>&1; then fail "$name: ping $dst works although both ports are limited members"
    else pass "$name: ping $dst is blocked (limited members cannot talk to each other)"; fi
  else
    if ping -c 2 -W 2 -q "$dst" >/dev/null 2>&1; then pass "$name: ping $dst over $child works ($ma/$mb members)"
    else fail "$name: ping $dst over $child fails although one side is a full member"; fi
  fi
done

aina_finish
