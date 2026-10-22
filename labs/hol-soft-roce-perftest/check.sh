#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hol-soft-roce-perftest: verify Soft-RoCE works on this host.
# Runs a short ibv_rc_pingpong and ib_write_bw over the rxe device (single-host
# loopback mode, client and server on the same device).
#
# Usage: sudo ./check.sh [rxe-name]
set -euo pipefail

RXE=${1:-rxe0}
HERE=$(cd "$(dirname "$0")" && pwd)
FAILS=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILS=$((FAILS + 1)); }

if [[ $EUID -ne 0 ]]; then
  echo "FAIL: run as root (sudo $0)"
  exit 1
fi

for tool in rdma ibv_devices ibv_devinfo ibv_rc_pingpong ib_write_bw ib_send_lat; do
  if command -v "$tool" >/dev/null 2>&1; then pass "$tool is installed"; else fail "$tool is missing"; fi
done

if [[ -d /sys/module/rdma_rxe ]]; then pass "rdma_rxe module loaded"; else fail "rdma_rxe module not loaded"; fi

if rdma link show "$RXE/1" 2>/dev/null | grep -q "state ACTIVE"; then
  pass "$RXE port 1 is ACTIVE"
else
  fail "$RXE port 1 missing or not ACTIVE (run sudo ./setup.sh)"
fi

if ibv_devices 2>/dev/null | grep -qw "$RXE"; then
  pass "ibv_devices lists $RXE"
else
  fail "ibv_devices does not list $RXE"
fi

if ibv_devinfo -d "$RXE" 2>/dev/null | grep -q "link_layer:.*Ethernet"; then
  pass "$RXE link_layer is Ethernet (RoCE)"
else
  fail "$RXE link_layer is not Ethernet"
fi

GID=$(bash "$HERE/find_gid.sh" -q "$RXE" 2>/dev/null || true)
if [[ -n "$GID" ]]; then
  pass "IPv4-mapped GID found at index $GID"
else
  fail "no IPv4-mapped GID on $RXE"
  GID=0
fi

# Functional test 1: RC send/recv ping-pong on a non-default TCP port.
srv_log=$(mktemp)
timeout 20 ibv_rc_pingpong -d "$RXE" -g "$GID" -p 18600 -n 100 >"$srv_log" 2>&1 &
srv_pid=$!
sleep 1
if timeout 20 ibv_rc_pingpong -d "$RXE" -g "$GID" -p 18600 -n 100 127.0.0.1 >/dev/null 2>&1 && wait "$srv_pid"; then
  pass "ibv_rc_pingpong completed 100 iterations"
else
  fail "ibv_rc_pingpong failed (server log: $(tr '\n' ' ' <"$srv_log" | cut -c1-200))"
  kill "$srv_pid" 2>/dev/null || true
  wait "$srv_pid" 2>/dev/null || true
fi
rm -f "$srv_log"

# Functional test 2: perftest RDMA WRITE bandwidth, short run.
srv_log=$(mktemp)
timeout 30 ib_write_bw -d "$RXE" -x "$GID" -F -p 18601 -s 65536 -n 500 >"$srv_log" 2>&1 &
srv_pid=$!
sleep 1
if timeout 30 ib_write_bw -d "$RXE" -x "$GID" -F -p 18601 -s 65536 -n 500 127.0.0.1 >/dev/null 2>&1 && wait "$srv_pid"; then
  pass "ib_write_bw completed"
else
  fail "ib_write_bw failed (server log: $(tr '\n' ' ' <"$srv_log" | cut -c1-200))"
  kill "$srv_pid" 2>/dev/null || true
  wait "$srv_pid" 2>/dev/null || true
fi
rm -f "$srv_log"

echo
if [[ $FAILS -eq 0 ]]; then
  echo "All checks passed."
else
  echo "$FAILS check(s) failed."
  exit 1
fi
