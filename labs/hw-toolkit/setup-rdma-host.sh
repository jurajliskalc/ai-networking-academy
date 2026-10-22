#!/usr/bin/env bash
# AI Networking Academy: prepare a real RDMA host for the hardware labs.
#
# Installs the user-space RDMA and diagnostic tools, then audits the host (drivers, RDMA devices,
# memlock limit, CPU governor, IOMMU flags, GPU stack) and prints what to fix. Idempotent.
# It never changes NIC, switch, firmware or kernel settings.
#
# Usage: ./setup-rdma-host.sh [--check] [--opensm] [--no-lldp] [--set-memlock]
#   --check        audit only, install nothing
#   --opensm       also install the OpenSM subnet manager (InfiniBand labs without a managed switch)
#   --no-lldp      do not install lldpd
#   --set-memlock  write /etc/security/limits.d/90-aina-rdma.conf (memlock unlimited) if needed
# Supported: Ubuntu/Debian (apt) and RHEL/Rocky/Alma/Fedora (dnf). Run as a user with sudo rights.
set -euo pipefail

CHECK_ONLY=0 WITH_OPENSM=0 WITH_LLDP=1 SET_MEMLOCK=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --opensm) WITH_OPENSM=1 ;;
    --no-lldp) WITH_LLDP=0 ;;
    --set-memlock) SET_MEMLOCK=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [[ $EUID -eq 0 ]]; then SUDO=""; else SUDO="sudo"; fi
step() { echo; echo "==> $*"; }
run() { echo "+ $*"; "$@"; }
ok() { printf '  [ ok ] %s\n' "$*"; }
todo() { printf '  [todo] %s\n' "$*"; TODO=$((TODO + 1)); }
note() { printf '  [info] %s\n' "$*"; }
TODO=0

# shellcheck disable=SC1091
. /etc/os-release 2>/dev/null || true
FAMILY=unknown
case " ${ID:-} ${ID_LIKE:-} " in
  *" ubuntu "*|*" debian "*) FAMILY=apt ;;
  *" rhel "*|*" fedora "*|*" centos "*|*" rocky "*|*" almalinux "*) FAMILY=dnf ;;
esac
echo "Host: $(hostname)  OS: ${PRETTY_NAME:-unknown}  kernel: $(uname -r)  package family: $FAMILY"

# NVIDIA's MLNX_OFED / DOCA-Host stacks ship their own rdma-core, perftest and diagnostics. Installing
# the distribution's packages next to them can conflict, so only generic tools are added then.
OFED=""
if command -v ofed_info >/dev/null 2>&1; then OFED=$(ofed_info -s 2>/dev/null | tr -d ':' || true); fi

if [[ $CHECK_ONLY -eq 0 ]]; then
  if [[ $FAMILY == apt ]]; then
    export DEBIAN_FRONTEND=noninteractive
    GENERIC=(iproute2 ethtool pciutils numactl tcpdump python3 jq iperf3)
    RDMA=(rdma-core ibverbs-utils ibverbs-providers rdmacm-utils perftest infiniband-diags)
    step "Installing packages (apt)"
    echo "iperf3 iperf3/start_daemon boolean false" | run $SUDO debconf-set-selections
    run $SUDO apt-get update -y
    run $SUDO apt-get install -y "${GENERIC[@]}"
    if [[ -n "$OFED" ]]; then
      note "NVIDIA OFED/DOCA detected ($OFED): leaving its RDMA packages alone"
    else
      run $SUDO apt-get install -y "${RDMA[@]}"
    fi
    [[ $WITH_LLDP -eq 1 ]] && run $SUDO apt-get install -y lldpd
    [[ $WITH_OPENSM -eq 1 ]] && run $SUDO apt-get install -y opensm
  elif [[ $FAMILY == dnf ]]; then
    GENERIC=(iproute ethtool pciutils numactl tcpdump python3 jq iperf3)
    RDMA=(rdma-core libibverbs-utils librdmacm-utils perftest infiniband-diags)
    step "Installing packages (dnf)"
    run $SUDO dnf install -y "${GENERIC[@]}"
    if [[ -n "$OFED" ]]; then
      note "NVIDIA OFED/DOCA detected ($OFED): leaving its RDMA packages alone"
    else
      run $SUDO dnf install -y "${RDMA[@]}"
    fi
    # lldpd lives in EPEL on RHEL-family systems; do not fail if it is unavailable.
    [[ $WITH_LLDP -eq 1 ]] && { run $SUDO dnf install -y lldpd || note "lldpd not available (enable EPEL to get it)"; }
    [[ $WITH_OPENSM -eq 1 ]] && run $SUDO dnf install -y opensm
  else
    note "Unknown distribution: install rdma-core, the ibverbs utilities, perftest, infiniband-diags, ethtool, pciutils, numactl, tcpdump and python3 by hand."
  fi
  if [[ $WITH_LLDP -eq 1 ]] && command -v lldpd >/dev/null 2>&1; then
    run $SUDO systemctl enable --now lldpd || true
  fi
fi

step "Tools"
for t in python3 rdma ibv_devinfo ibv_rc_pingpong ib_write_bw rping ibstat ethtool lspci numactl tcpdump; do
  if command -v "$t" >/dev/null 2>&1; then ok "$t"; else todo "$t missing"; fi
done
for t in dcb mlnx_qos show_gids mlxlink lldpcli nvidia-smi mpirun; do
  if command -v "$t" >/dev/null 2>&1; then ok "$t (optional)"; else note "$t not found (optional; some lab tasks use it)"; fi
done
[[ -n "$OFED" ]] && note "driver stack: $OFED" || note "driver stack: inbox kernel drivers + distribution rdma-core"

step "Kernel modules"
for m in ib_core ib_uverbs rdma_ucm; do
  if [[ -d /sys/module/$m ]]; then ok "$m loaded"; else todo "$m not loaded (sudo modprobe $m)"; fi
done
VENDOR=""
for m in mlx5_ib irdma bnxt_re ib_qib rdma_rxe; do [[ -d /sys/module/$m ]] && VENDOR="$VENDOR $m"; done
if [[ -n "$VENDOR" ]]; then ok "RDMA provider driver(s):$VENDOR"; else todo "no RDMA provider driver loaded (mlx5_ib, irdma, bnxt_re, ...)"; fi
if [[ -d /sys/module/rdma_rxe ]]; then note "rdma_rxe (Soft-RoCE) is loaded: fine for Tier 0, but use the hardware device for these labs"; fi

step "RDMA devices"
if command -v rdma >/dev/null 2>&1 && [[ -n "$(rdma link show 2>/dev/null)" ]]; then
  rdma link show | sed 's/^/  /'
  if rdma link show | grep -q 'state ACTIVE'; then ok "at least one RDMA port is ACTIVE"; else todo "no RDMA port is ACTIVE (cable, peer, or no subnet manager on InfiniBand)"; fi
else
  todo "no RDMA devices found"
fi

step "Locked-memory limit (RDMA registers pinned memory)"
ML=$(ulimit -l)
if [[ "$ML" == "unlimited" ]]; then
  ok "memlock unlimited"
else
  todo "memlock is ${ML} KiB: large perftest or NCCL runs can fail to register memory"
  if [[ $SET_MEMLOCK -eq 1 ]]; then
    printf '* soft memlock unlimited\n* hard memlock unlimited\n' | run $SUDO tee /etc/security/limits.d/90-aina-rdma.conf >/dev/null
    note "written; log out and back in (services need LimitMEMLOCK=infinity in their systemd unit instead)"
  else
    note "rerun with --set-memlock, or add 'memlock unlimited' entries under /etc/security/limits.d/"
  fi
fi

step "CPU and platform"
GOV=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null || echo n/a)
if [[ "$GOV" == performance || "$GOV" == n/a ]]; then ok "CPU governor: $GOV"; else note "CPU governor is '$GOV': perftest warns about CPU frequency; 'performance' gives steadier latency numbers"; fi
note "NUMA nodes: $(ls -d /sys/devices/system/node/node[0-9]* 2>/dev/null | wc -l)"
note "kernel IOMMU flags: $(tr ' ' '\n' </proc/cmdline | grep -E 'iommu' | tr '\n' ' ' || true)(none means platform default; see the Host setup guide before changing them)"

step "GPU stack (Tier 3 only)"
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=index,name,pci.bus_id --format=csv,noheader 2>/dev/null | sed 's/^/  /' || true
  if [[ -d /sys/module/nvidia_peermem ]]; then ok "nvidia_peermem loaded (GPUDirect RDMA via peer memory)"; else note "nvidia_peermem not loaded: sudo modprobe nvidia_peermem (or use a DMA-BUF capable stack; see the GPUDirect lab)"; fi
else
  note "no nvidia-smi: GPU labs (Tier 3) will be skipped"
fi

step "Summary"
if [[ $TODO -eq 0 ]]; then
  echo "Host looks ready. Next: generate lab.env on the academy's Connect page, then: ./aina-hw collect-all"
else
  echo "$TODO item(s) to fix above. Re-run with --check after fixing."
fi
