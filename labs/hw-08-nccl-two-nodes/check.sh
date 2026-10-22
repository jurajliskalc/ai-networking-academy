#!/usr/bin/env bash
# hw-08-nccl-two-nodes: verify a two-node NCCL all-reduce runs over RDMA (not sockets) with correct results.
# Run on host A (Open MPI starts the rank on host B over SSH):  ../hw-toolkit/aina-hw check hw-08-nccl-two-nodes
# Read-only: it changes no settings.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../hw-toolkit/lib.sh"
aina_load_env

need_cmd mpirun nvidia-smi || aina_finish
check_ssh B || aina_finish
for r in A B; do
  if on_host_sh $r "test -x $(printf '%q' "$NCCL_TESTS_DIR")/all_reduce_perf"; then
    pass "host $r: $NCCL_TESTS_DIR/all_reduce_perf exists"
  else
    fail "host $r: $NCCL_TESTS_DIR/all_reduce_perf missing (build nccl-tests with MPI=1 at the same path on both hosts)"
  fi
  n=$(on_host_sh $r "nvidia-smi -L 2>/dev/null | wc -l")
  if [[ "${n:-0}" -ge "$GPUS_PER_NODE" ]]; then pass "host $r: $n GPU(s), test uses $GPUS_PER_NODE"; else fail "host $r: ${n:-0} GPU(s) visible, GPUS_PER_NODE=$GPUS_PER_NODE"; fi
done
[[ $AINA_FAILS -eq 0 ]] || aina_finish

log=$(mktemp)
# timeout signals its whole process group (bash, mpirun, tee); mpirun then stops the remote rank
if timeout -k 15 300 bash "$HERE/run-allreduce.sh" --min 8M --max 256M --log "$log" >/dev/null 2>&1; then
  pass "all_reduce_perf completed across $HOST_A and $HOST_B"
else
  fail "all_reduce_perf failed or timed out: $(grep -E 'WARN|Error|error' "$log" | head -3 | tr '\n' ' ' | cut -c1-240)"
fi

# The selected network ("Using network IB|Socket") and the per-channel lines ("via NET/IB/0") both
# say which transport carried the data; exact wording varies a little between NCCL versions.
ib=$(grep -cE 'Using network IB|via NET/IB' "$log")
sock=$(grep -cE 'Using network Socket|via NET/Socket' "$log")
if [[ "$sock" -gt 0 ]]; then
  fail "NCCL used the socket transport (TCP) on $sock log line(s), not RDMA: see Task 4 and Task 6"
elif [[ "$ib" -gt 0 ]]; then
  pass "NCCL used the IB verbs transport (NET/IB: InfiniBand or RoCE)"
  grep -m1 'NET/IB : Using' "$log" | sed 's/.*NET\/IB : /INFO: NCCL devices: /' | cut -c1-200
else
  warn "could not find the network transport in the NCCL log (NCCL_DEBUG=INFO output missing?)"
fi
if grep -q 'GDRDMA' "$log"; then info "network channels report GDRDMA (GPUDirect RDMA in use)"; else info "no GDRDMA on network channels: data is staged through host memory (see hw-07)"; fi

# Data rows: size count type redop root time algbw busbw #wrong time algbw busbw #wrong (13 columns).
wrong=$(awk '$1 ~ /^[0-9]+$/ && NF >= 13 { if ($9 ~ /^[0-9]+$/) w += $9; if ($13 ~ /^[0-9]+$/) w += $13 } END { print w + 0 }' "$log")
rows=$(awk '$1 ~ /^[0-9]+$/ && NF >= 13' "$log" | wc -l)
if [[ "$rows" -eq 0 ]]; then
  fail "no result rows in the all_reduce_perf output"
elif [[ "$wrong" -eq 0 ]]; then
  pass "$rows message sizes, #wrong = 0 (results verified)"
else
  fail "#wrong = $wrong: the all-reduce produced incorrect data"
fi
avg=$(awk -F: '/Avg bus bandwidth/ {gsub(/ /, "", $2); print $2}' "$log" | tail -1)
[[ -n "$avg" ]] && info "average bus bandwidth over 8M..256M: $avg GB/s (compare with Task 5)"
largest=$(awk '$1 ~ /^[0-9]+$/ && NF >= 13 {s=$1; b=$8} END {if (s) print s " bytes: busbw " b " GB/s"}' "$log")
[[ -n "$largest" ]] && info "largest size $largest (out-of-place)"
rm -f "$log"

aina_finish
