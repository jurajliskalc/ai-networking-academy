#!/usr/bin/env bash
# AI Networking Academy: install everything the hands-on labs need on Ubuntu 24.04.
#
# Idempotent: safe to run again; already-installed parts are skipped.
#
# Usage: ./setup-ubuntu.sh [--no-containerlab] [--no-rdma] [--no-docker]
#   (run as a normal user with sudo rights, or as root)
set -euo pipefail

WITH_CLAB=1
WITH_RDMA=1
WITH_DOCKER=1
for arg in "$@"; do
  case "$arg" in
    --no-containerlab) WITH_CLAB=0 ;;
    --no-rdma) WITH_RDMA=0 ;;
    --no-docker) WITH_DOCKER=0; WITH_CLAB=0 ;;
    -h|--help)
      sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [[ $EUID -eq 0 ]]; then SUDO=""; else SUDO="sudo"; fi
TARGET_USER=${SUDO_USER:-${USER:-root}}

step() { echo; echo "==> $*"; }
run() { echo "+ $*"; "$@"; }

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]]; then
    echo "WARNING: this script targets Ubuntu (found ${PRETTY_NAME:-unknown}); package names may differ."
  elif [[ "${VERSION_ID:-}" != "24.04" ]]; then
    echo "WARNING: tested target is Ubuntu 24.04 (found ${VERSION_ID:-unknown})."
  fi
fi

export DEBIAN_FRONTEND=noninteractive

step "Pre-answering package questions (no setuid dumpcap, no iperf3 daemon at boot)"
echo "wireshark-common wireshark-common/install-setuid boolean false" | run $SUDO debconf-set-selections
echo "iperf3 iperf3/start_daemon boolean false" | run $SUDO debconf-set-selections

step "Updating the package index"
run $SUDO apt-get update -y

BASE_PKGS=(iproute2 iputils-ping traceroute ethtool tcpdump tshark iperf3 jq python3 curl ca-certificates kmod)
step "Installing base networking tools: ${BASE_PKGS[*]}"
run $SUDO apt-get install -y "${BASE_PKGS[@]}"

EXTRA="linux-modules-extra-$(uname -r)"
step "Installing extra kernel modules for the running kernel ($EXTRA), if the package exists"
if apt-cache show "$EXTRA" >/dev/null 2>&1; then
  run $SUDO apt-get install -y "$EXTRA"
else
  echo "Package $EXTRA not found (cloud or custom kernel?). rdma_rxe/sch_netem may be unavailable."
fi

if [[ $WITH_RDMA -eq 1 ]]; then
  RDMA_PKGS=(rdma-core ibverbs-utils ibverbs-providers perftest rdmacm-utils)
  step "Installing RDMA user space: ${RDMA_PKGS[*]}"
  run $SUDO apt-get install -y "${RDMA_PKGS[@]}"
fi

if [[ $WITH_DOCKER -eq 1 ]]; then
  if command -v docker >/dev/null 2>&1; then
    step "Docker already installed: $(docker --version 2>/dev/null || echo unknown version)"
  else
    step "Installing Docker from the Ubuntu archive (docker.io)"
    run $SUDO apt-get install -y docker.io
  fi
  run $SUDO systemctl enable --now docker
  if [[ "$TARGET_USER" != "root" ]] && ! id -nG "$TARGET_USER" | grep -qw docker; then
    step "Adding $TARGET_USER to the docker group (log out and back in to take effect)"
    run $SUDO usermod -aG docker "$TARGET_USER"
  fi
fi

if [[ $WITH_CLAB -eq 1 ]]; then
  if command -v containerlab >/dev/null 2>&1; then
    step "containerlab already installed: $(containerlab version 2>/dev/null | grep -i '^ *version' | head -1 || echo)"
  else
    step "Installing containerlab with the official installer (https://get.containerlab.dev)"
    curl -sL https://get.containerlab.dev -o /tmp/install-containerlab.sh
    echo "+ bash /tmp/install-containerlab.sh   (review it first if you like: less /tmp/install-containerlab.sh)"
    run $SUDO bash /tmp/install-containerlab.sh
    rm -f /tmp/install-containerlab.sh
  fi
fi

step "Checking kernel modules used by the labs (availability, not loaded state)"
for m in rdma_rxe tcp_dctcp sch_htb sch_red sch_fq_codel sch_tbf sch_netem vxlan bridge veth; do
  if modinfo "$m" >/dev/null 2>&1; then
    printf '  %-14s available\n' "$m"
  else
    printf '  %-14s NOT FOUND (built in, or missing: some labs/tasks may not work)\n' "$m"
  fi
done

step "Done"
echo "Next: read labs/README.md, then open a lab in the course."
if [[ $WITH_DOCKER -eq 1 && "$TARGET_USER" != "root" ]]; then
  echo "If you were just added to the docker group, log out and back in (or run: newgrp docker)."
fi
