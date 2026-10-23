#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-15-cpu-allreduce-busbw: add nccl-tests style algbw and busbw columns to OSU collective output.
#   mpirun ... osu_allreduce ... | ./osu-busbw.sh allreduce <ranks>
#   mpirun ... osu_allgather ... | ./osu-busbw.sh allgather <ranks>
# algbw = bytes / time, in GB/s (10^9 bytes, like nccl-tests). The byte count is the size of the
# result each rank ends up with: the OSU size for allreduce, size x ranks for allgather (OSU's size is
# the per-rank contribution there). busbw = algbw x 2(n-1)/n for allreduce and x (n-1)/n for allgather.
set -euo pipefail
coll=${1:-}; n=${2:-}
if ! [[ "$coll" == allreduce || "$coll" == allgather ]] || ! [[ "$n" =~ ^[0-9]+$ ]] || (( n < 2 )); then
  echo "usage: ... | $0 allreduce|allgather <ranks>" >&2; exit 2
fi
awk -v coll="$coll" -v n="$n" '
  BEGIN { f = (coll == "allreduce") ? 2 * (n - 1) / n : (n - 1) / n }
  /^#/ && !/Size/ { print; next }
  /^[0-9]+ +[0-9.]+/ {
    if (!hdr++) {
      printf "# %s, %d ranks, busbw = algbw x %.3f\n", coll, n, f
      printf "%12s %14s %12s %12s\n", "size(B)", "time(us)", "algbw(GB/s)", "busbw(GB/s)"
    }
    bytes = (coll == "allgather") ? $1 * n : $1
    alg = bytes / ($2 * 1000)
    printf "%12d %14.2f %12.3f %12.3f\n", $1, $2, alg, alg * f
  }'
