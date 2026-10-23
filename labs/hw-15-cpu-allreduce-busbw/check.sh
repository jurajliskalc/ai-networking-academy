#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-15-cpu-allreduce-busbw: verify a validated MPI allreduce over UCX on the lab RDMA port, with 2 ranks
# (one per host) and 8 ranks (four per host, ring algorithm), and report algbw/busbw.
# Run on host A as your normal user after hw-14 (Open MPI with UCX, OSU on both hosts):
#   ../hw-toolkit/aina-hw check hw-15-cpu-allreduce-busbw
# One task only (resume):  ../hw-toolkit/aina-hw check hw-15-cpu-allreduce-busbw --task 2
# Read-only. OSU_PREFIX overrides the OSU install prefix (default ~/osu).
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../hw-toolkit/lib.sh"
aina_load_env
aina_tasks 1 2
OSU=${OSU_PREFIX:-$HOME/osu}/libexec/osu-micro-benchmarks/mpi
require 1 two-ranks "a validated 2-rank allreduce (one rank per host)"
require 2 eight-ranks "a validated 8-rank allreduce (four per host) with the ring algorithm"

need_cmd mpirun || aina_finish
check_ssh B || aina_finish
for r in A B; do
  if on_host "$r" test -x "$OSU/collective/osu_allreduce"; then pass "host $r: osu_allreduce present"
  else fail "host $r: $OSU/collective/osu_allreduce missing (hw-14: ./build-osu.sh)"; aina_finish; fi
done

DEVS="$A_RDMA_DEV:$RDMA_PORT"; [[ "$B_RDMA_DEV" != "$A_RDMA_DEV" ]] && DEVS+=",$B_RDMA_DEV:$RDMA_PORT"
out=$(mktemp)
run() {  # run KEY LABEL NRANKS HOSTS MPIRUN-ARGS...
  local key=$1 label=$2 n=$3 hosts=$4; shift 4
  if timeout 300 mpirun -np "$n" --host "$hosts" --map-by node --mca pml ucx -x UCX_NET_DEVICES="$DEVS" "$@" \
       "$OSU/collective/osu_allreduce" -m 8:16777216 -c >"$out" 2>&1; then
    rows=$(grep -cE '^[0-9]+ +[0-9.]+ +Pass' "$out"); bad=$(grep -cE '^[0-9]+ .*Fail' "$out")
    if (( rows > 0 && bad == 0 )); then pass_met "$key" "$label: $rows message sizes, every result validated (Pass)"
    else fail "$label: $bad size(s) failed validation, $rows passed"; fi
    "$HERE/osu-busbw.sh" allreduce "$n" <"$out" | awk -v l="$label" '$1 == 1048576 || $1 == 16777216 {printf "INFO: %s: %s B in %s us, algbw %s GB/s, busbw %s GB/s\n", l, $1, $2, $3, $4}'
  else
    fail "$label: mpirun osu_allreduce failed: $(excerpt "$out" 240)"
  fi
}

if task 1 "Two ranks, and what busbw means"; then
  run two-ranks "allreduce, 2 ranks (1 per host)" 2 "$HOST_A,$HOST_B"
fi

if task 2 "Eight ranks: algorithms and their crossover"; then
  cores=$(on_host B nproc)
  (( $(nproc) >= 4 && ${cores:-0} >= 4 )) || warn "fewer than 4 CPUs on a host: the 8-rank run oversubscribes"
  run eight-ranks "allreduce, 8 ranks (4 per host), tuned ring" 8 "$HOST_A:4,$HOST_B:4" \
    --mca coll '^han' --mca coll_tuned_use_dynamic_rules 1 --mca coll_tuned_allreduce_algorithm 4
fi
rm -f "$out"

aina_finish
