#!/usr/bin/env bash
# hw-08-nccl-two-nodes: run nccl-tests all_reduce_perf across host A and host B with Open MPI,
# using the values from lab.env, and keep the full NCCL log.
#
# Usage: ./run-allreduce.sh [--socket] [--wrong-hca] [--no-gid] [--min SIZE] [--max SIZE] [--log FILE] [-- EXTRA...]
#   --socket     set NCCL_IB_DISABLE=1 (force the TCP socket transport, for comparison)
#   --wrong-hca  point NCCL_IB_HCA at a device that does not exist (Task 6)
#   --no-gid     do not set NCCL_IB_GID_INDEX (let NCCL choose, on versions that can)
#   --min/--max  message size range (default 8M .. 1G), passed as -b/-e
#   --log FILE   log file (default results/nccl-allreduce-<time>.log next to the toolkit)
#   EXTRA        extra all_reduce_perf arguments after "--"
# Run on host A as the user that can SSH to host B (Open MPI launches the remote rank over SSH).
set -uo pipefail
. "$(dirname "$0")/../hw-toolkit/lib.sh"
aina_load_env >/dev/null

MODE=ib MIN=8M MAX=1G LOG="" SET_GID=1 EXTRA=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --socket) MODE=socket ;;
    --wrong-hca) MODE=wrong-hca ;;
    --no-gid) SET_GID=0 ;;
    --min) MIN=$2; shift ;;
    --max) MAX=$2; shift ;;
    --log) LOG=$2; shift ;;
    --) shift; EXTRA=("$@"); break ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

BIN="$NCCL_TESTS_DIR/all_reduce_perf"
command -v mpirun >/dev/null 2>&1 || { echo "mpirun not found (install Open MPI, see Task 1)" >&2; exit 2; }
[[ -x "$BIN" ]] || { echo "$BIN not found (build nccl-tests with MPI=1, see Task 1)" >&2; exit 2; }
if [[ -z "$LOG" ]]; then
  mkdir -p "${AINA_RESULTS:-$AINA_TOOLKIT/results}"
  LOG="${AINA_RESULTS:-$AINA_TOOLKIT/results}/nccl-allreduce-$MODE-$(date +%Y%m%dT%H%M%S).log"
fi

# NCCL settings, exported to both ranks with Open MPI's -x.
export NCCL_DEBUG=INFO
export NCCL_DEBUG_SUBSYS=INIT,NET
# Bootstrap/socket interface: the data netdevs (names may differ between the hosts; NCCL takes a list).
if [[ "$A_NETDEV" == "$B_NETDEV" ]]; then export NCCL_SOCKET_IFNAME="$A_NETDEV"; else export NCCL_SOCKET_IFNAME="$A_NETDEV,$B_NETDEV"; fi
# RDMA devices: "=" means exact names; each host uses the entries it has.
if [[ "$A_RDMA_DEV" == "$B_RDMA_DEV" ]]; then export NCCL_IB_HCA="=$A_RDMA_DEV:$RDMA_PORT"; else export NCCL_IB_HCA="=$A_RDMA_DEV:$RDMA_PORT,$B_RDMA_DEV:$RDMA_PORT"; fi
VARS=(NCCL_DEBUG NCCL_DEBUG_SUBSYS NCCL_SOCKET_IFNAME NCCL_IB_HCA)
if [[ "$FABRIC" == roce ]]; then
  export NCCL_IB_TC="$TCLASS"; VARS+=(NCCL_IB_TC)
  if [[ $SET_GID -eq 1 ]]; then
    ga=$(roce_gid A); gb=$(roce_gid B)
    if [[ "$ga" == "$gb" ]]; then
      export NCCL_IB_GID_INDEX="$ga"; VARS+=(NCCL_IB_GID_INDEX)
    else
      echo "NOTE: RoCE v2 GID index differs (A=$ga, B=$gb); NCCL_IB_GID_INDEX not set, NCCL chooses" >&2
    fi
  fi
fi
case "$MODE" in
  socket) export NCCL_IB_DISABLE=1; VARS+=(NCCL_IB_DISABLE) ;;
  wrong-hca) export NCCL_IB_HCA="=aina_no_such_hca:1" ;;
esac

MPI_X=()
for v in "${VARS[@]}" PATH LD_LIBRARY_PATH; do MPI_X+=(-x "$v"); done
export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}"

CMD=(mpirun -np 2 -H "$HOST_A:1,$HOST_B:1" --bind-to none "${MPI_X[@]}"
     "$BIN" -b "$MIN" -e "$MAX" -f 2 -g "$GPUS_PER_NODE" "${EXTRA[@]}")
{
  echo "# $(date -Is) mode=$MODE lab=$LAB_NAME"
  for v in "${VARS[@]}"; do echo "# $v=${!v}"; done
  echo "# ${CMD[*]}"
} | tee "$LOG"
"${CMD[@]}" 2>&1 | tee -a "$LOG"
rc=${PIPESTATUS[0]}
echo "# exit $rc" >>"$LOG"
echo "Log: $LOG" >&2
exit "$rc"
