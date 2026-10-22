#!/usr/bin/env bash
# hw-07-gpudirect-numa: verify the GPU/NIC layout and GPUDirect RDMA between host A and host B.
# Run on host A (it reaches host B over SSH):  ../hw-toolkit/aina-hw check hw-07-gpudirect-numa
# Read-only: it changes no settings. Uses TCP ports 18610 and 18611 for the test handshakes.
set -uo pipefail
. "$(dirname "$0")/../hw-toolkit/lib.sh"
aina_load_env

need_cmd nvidia-smi ib_write_bw || aina_finish
check_ssh B || aina_finish

# GPU and NUMA layout on each host.
for r in A B; do
  dev=$(rdma_of $r)
  if ! on_host $r command -v nvidia-smi >/dev/null 2>&1; then fail "host $r: nvidia-smi not found (GPU driver missing)"; continue; fi
  bus=$(on_host_sh $r "nvidia-smi --query-gpu=index,pci.bus_id --format=csv,noheader 2>/dev/null" | awk -F', *' -v i="$GPU_INDEX" '$1 == i {print $2}')
  if [[ -z "$bus" ]]; then fail "host $r: no GPU with index $GPU_INDEX (set GPU_INDEX in lab.env)"; continue; fi
  pass "host $r: GPU $GPU_INDEX present at $bus"
  addr=$(echo "${bus: -12}" | tr 'A-F' 'a-f')
  gnode=$(on_host_sh $r "cat /sys/bus/pci/devices/$addr/numa_node 2>/dev/null")
  nnode=$(on_host_sh $r "cat /sys/class/infiniband/$dev/device/numa_node 2>/dev/null")
  if [[ -z "$nnode" ]]; then fail "host $r: RDMA device $dev not found"; continue; fi
  if [[ "$gnode" == "-1" || "$nnode" == "-1" ]]; then
    info "host $r: NUMA node not reported (GPU $gnode, NIC $nnode); use nvidia-smi topo -m instead"
  elif [[ "$gnode" == "$nnode" ]]; then
    pass "host $r: GPU $GPU_INDEX and $dev share NUMA node $nnode"
  else
    warn "host $r: GPU $GPU_INDEX is on NUMA node $gnode but $dev is on $nnode (cross-socket path)"
  fi
  if on_host_sh $r "test -d /sys/module/nvidia_peermem"; then
    pass "host $r: nvidia_peermem loaded"
  else
    warn "host $r: nvidia_peermem not loaded (fine only if your stack uses DMA-BUF; see Task 3)"
  fi
done

# GID selection: RoCE needs an explicit index, InfiniBand does not.
GA=(); GB=()
if [[ "$FABRIC" == roce ]]; then GA=(-x "$(roce_gid A)"); GB=(-x "$(roce_gid B)"); fi

# run_bw LABEL PORT [extra perftest options...]: 5-second ib_write_bw A -> B; prints the average.
run_bw() {
  local label=$1 port=$2; shift 2
  local log out bw
  log=$(mktemp); out=$(mktemp)
  start_server B "$log" timeout 40 ib_write_bw -d "$B_RDMA_DEV" -i "$RDMA_PORT" "${GB[@]}" -D 5 -F --report_gbits -p "$port" "$@"
  if timeout 40 ib_write_bw -d "$A_RDMA_DEV" -i "$RDMA_PORT" "${GA[@]}" -D 5 -F --report_gbits -p "$port" "$@" "$B_IP" >"$out" 2>&1; then
    stop_server
    bw=$(bw_average "$out")
    pass "$label: ib_write_bw completed${bw:+ at $bw Gb/s average}"
  else
    kill_server
    fail "$label: ib_write_bw failed: $(tail -3 "$out" | tr '\n' ' ' | cut -c1-200) / server: $(tail -2 "$log" | tr '\n' ' ' | cut -c1-120)"
  fi
  rm -f "$log" "$out"
}

run_bw "host memory" 18610

cuda_a=$(ib_write_bw --help 2>&1 | grep -c use_cuda)
cuda_b=$(on_host_sh B "ib_write_bw --help 2>&1 | grep -c use_cuda")
if [[ "${cuda_a:-0}" -gt 0 && "${cuda_b:-0}" -gt 0 ]]; then
  run_bw "GPU $GPU_INDEX memory" 18611 "--use_cuda=$GPU_INDEX"
else
  skip "GPU-memory test: perftest on host A and/or B was built without CUDA (ib_write_bw --help has no --use_cuda; see Task 4)"
fi

aina_finish
