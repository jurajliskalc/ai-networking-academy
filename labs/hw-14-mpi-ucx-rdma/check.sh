#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-14-mpi-ucx-rdma: verify Open MPI over UCX on the lab RDMA port between host A and host B:
# the UCX PML, OSU binaries on both hosts, an RDMA transport chosen for inter-node traffic, latency
# and bandwidth in the expected range for the port.
# Run on host A as your normal user (mpirun starts the remote rank over SSH):
#   ../hw-toolkit/aina-hw check hw-14-mpi-ucx-rdma
# One task only (resume):  ../hw-toolkit/aina-hw check hw-14-mpi-ucx-rdma --task 4
# Read-only. OSU_PREFIX overrides the OSU install prefix (default ~/osu).
set -uo pipefail
. "$(dirname "$0")/../hw-toolkit/lib.sh"
aina_load_env
aina_tasks 1 2 4
OSU=${OSU_PREFIX:-$HOME/osu}/libexec/osu-micro-benchmarks/mpi
require 2 transport "UCX chose an RDMA transport (rc, dc or ud) for inter-node traffic"
require 4 latency "osu_latency 8 B over UCX measured, target under 5 us"
require 4 bw "osu_bw 1-4 MiB over UCX measured, target at least 60% of the port rate"

need_cmd mpirun ompi_info ucx_info || aina_finish
check_ssh B || aina_finish
need_cmd_on B mpirun || aina_finish

if task 1 "Install Open MPI with UCX and build the OSU benchmarks"; then
  if grep -q 'MCA pml: ucx' <<<"$(ompi_info 2>/dev/null)"; then pass "Open MPI has the UCX PML (ompi_info: MCA pml: ucx)"
  else fail "Open MPI has no UCX PML: this build cannot use UCX (DOCA's openmpi package is built without it; use the distribution's openmpi-bin)"; fi
  for r in A B; do
    if on_host "$r" test -x "$OSU/pt2pt/osu_bw"; then pass "host $r: OSU Micro-Benchmarks in $OSU"
    else fail "host $r: $OSU/pt2pt/osu_bw missing (run ./build-osu.sh on host $r)"; fi
  done
fi

DEVS="$A_RDMA_DEV:$RDMA_PORT"; [[ "$B_RDMA_DEV" != "$A_RDMA_DEV" ]] && DEVS+=",$B_RDMA_DEV:$RDMA_PORT"
MPI=(timeout 120 mpirun -np 2 --host "$HOST_A,$HOST_B" --mca pml ucx -x UCX_NET_DEVICES="$DEVS")
out=$(mktemp)
# One osu_latency run with UCX_PROTO_INFO serves Task 2 (the transport) and Task 4 (the latency).
LAT_OK=0
if task_selected 2 4; then
  if "${MPI[@]}" -x UCX_PROTO_INFO=y "$OSU/pt2pt/osu_latency" -m 8:8 >"$out" 2>&1; then LAT_OK=1; else LAT_ERR=$(excerpt "$out" 240); fi
  LAT_OUT=$(cat "$out")
fi

if task 2 "What UCX sees, and a first multi-host run"; then
  for r in A B; do
    dev=$(rdma_of "$r")
    # Capture first: with pipefail, grep -q closing the pipe early would fail the pipeline.
    devs=$(on_host "$r" ucx_info -d 2>/dev/null)
    if grep -qE "Device: ${dev}:${RDMA_PORT}[[:space:]]*$" <<<"$devs"; then pass "host $r: UCX sees $dev:$RDMA_PORT"
    else fail "host $r: ucx_info -d does not list $dev:$RDMA_PORT"; fi
  done
  if (( LAT_OK )); then
    tl=$(grep -A3 'inter-node' <<<"$LAT_OUT" | grep -oE '(rc_mlx5|rc_verbs|dc_mlx5|ud_mlx5|ud_verbs|tcp)/[^ |]+' | sort -u | tr '\n' ' ')
    if [[ "$tl" =~ (rc|dc|ud)_ ]]; then pass_met transport "UCX inter-node transport: $tl"; else fail "UCX inter-node transport is '${tl:-unknown}', not RDMA"; fi
  else
    fail "mpirun osu_latency failed: ${LAT_ERR:-}"
  fi
fi

if task 4 "MPI latency, bandwidth and protocol switching"; then
  if (( LAT_OK )); then
    lat=$(awk '$1 == 8 {print $2}' <<<"$LAT_OUT" | tail -1)
    if [[ -n "$lat" ]] && awk -v l="$lat" 'BEGIN {exit !(l < 5)}'; then perf_ok latency "osu_latency 8 B over UCX: $lat us"
    elif [[ -n "$lat" ]]; then perf_low latency "osu_latency 8 B: $lat us, above the 5 us target (expected a few microseconds or less over RDMA)"
    else fail "osu_latency printed no result: $(head -c 240 <<<"$LAT_OUT")"; fi
  else
    fail "mpirun osu_latency failed: ${LAT_ERR:-}"
  fi
  if "${MPI[@]}" "$OSU/pt2pt/osu_bw" -m 1048576:4194304 >"$out" 2>&1; then
    bw=$(awk '/^[0-9]+ +[0-9.]+$/ {s += $2; n++} END {if (n) printf "%.0f", s / n}' "$out")
    rate=$(port_attr A rate | awk '{print $1}')
    gbps=$(awk -v b="${bw:-0}" 'BEGIN {printf "%.1f", b * 8 / 1000}')
    if [[ -z "$bw" ]]; then fail "osu_bw printed no result: $(excerpt "$out")"
    elif awk -v g="$gbps" -v r="${rate:-0}" 'BEGIN {exit !(r > 0 && g >= 0.6 * r)}'; then perf_ok bw "osu_bw 1-4 MiB: $bw MB/s = $gbps Gb/s (port rate ${rate:-?} Gb/s)"
    else perf_low bw "osu_bw 1-4 MiB: $bw MB/s = $gbps Gb/s, below the 60% target of the ${rate:-?} Gb/s port rate (repeat; check transport, PCIe and CPU binding)"; fi
  else
    fail "mpirun osu_bw failed: $(excerpt "$out" 240)"
  fi
fi
rm -f "$out"

aina_finish
